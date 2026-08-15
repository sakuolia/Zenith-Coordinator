/**
 * @file account_verify.test.ts — coverage for the Confirmation-of-Payee /
 *       name-check module (zc/directory/account_verify.ts), previously
 *       exercised by no test. Focuses on the deterministic, fetch-free paths:
 *       the bank-response mapping, caching, idempotency, and lookup.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  buildBankAccountVerifyPayload,
  handleBankVerifyResponse,
  getVerificationResult,
  requestAccountVerification,
} from "../../src/zc/directory/account_verify";
import { bankAccountVerify } from "../../src/bank/ingress/verify";

let d1: MockD1Database;
const env: any = { DB: null, ZC_HMAC_SECRET: "test-secret" }; // no BANK_BASE_URL → fetch paths avoided

function insertPending(id: string, bankId = "002", acct = "0020000001", idem = `idem-${id}`) {
  d1.prepare(
    `INSERT INTO AccountVerifications
       (verification_id, request_bank_id, target_bank_id, target_account_hash, status, name_provided, fraud_warning, idempotency_key, created_at)
     VALUES (?, '001', ?, ?, 'PENDING', 'サトウ ハナコ', 0, ?, '2026-06-30T00:00:00.000Z')`
  )
    .bind(id, bankId, acct, idem)
    ._runSync();
}

function seedPayeeAccount(accountId: string, name: string, bankId = "002") {
  d1.prepare(
    `INSERT INTO BankAccounts
       (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
     VALUES (?, ?, ?, ?, 'SAVINGS', 'NORMAL', '2026-06-30T00:00:00.000Z')`
  )
    .bind(accountId, bankId, `cust-${accountId}`, name)
    ._runSync();
}

function secondsBetween(aIso: string, bIso: string): number {
  return Math.round((new Date(aIso).getTime() - new Date(bIso).getTime()) / 1000);
}

beforeEach(() => {
  ({ d1 } = createTestDb());
  env.DB = d1;
});

describe("handleBankVerifyResponse mapping", () => {
  it("MATCHED stores score, fraud flag, and a ~24h cache window", async () => {
    insertPending("V-M");
    await handleBankVerifyResponse(d1 as any, "V-M", {
      result: "MATCHED",
      match_score: 1.0,
      name_provided: "サトウ ハナコ",
      fraud_warning: true,
    });
    const row = await getVerificationResult(d1 as any, "V-M");
    expect(row?.status).toBe("MATCHED");
    expect(row?.name_provided).toBe("サトウ ハナコ");
    // The bank never returns the name it holds on file, so ZC has none to store.
    expect(row?.target_account_name).toBeNull();
    expect(row?.match_score).toBe(1.0);
    expect(row?.fraud_warning).toBe(1);
    expect(secondsBetween(row!.cached_until!, row!.responded_at!)).toBe(86400);
  });

  it("MISMATCHED maps to UNMATCHED with a ~24h cache window", async () => {
    insertPending("V-U");
    await handleBankVerifyResponse(d1 as any, "V-U", {
      result: "MISMATCHED",
      match_score: 0.0,
      name_provided: "別名 別人",
      fraud_warning: false,
    });
    const row = await getVerificationResult(d1 as any, "V-U");
    expect(row?.status).toBe("UNMATCHED");
    expect(row?.match_score).toBe(0.0);
    expect(secondsBetween(row!.cached_until!, row!.responded_at!)).toBe(86400);
  });

  it("NOT_FOUND caches for only ~1h and carries no name/score", async () => {
    insertPending("V-N");
    await handleBankVerifyResponse(d1 as any, "V-N", {
      result: "NOT_FOUND",
      match_score: 0.0,
      name_provided: null,
      fraud_warning: false,
    });
    const row = await getVerificationResult(d1 as any, "V-N");
    expect(row?.status).toBe("NOT_FOUND");
    expect(row?.target_account_name).toBeNull();
    expect(row?.match_score).toBeNull();
    expect(secondsBetween(row!.cached_until!, row!.responded_at!)).toBe(3600);
  });
});

/**
 * The seam itself. The caller and the handler used to declare the command's
 * body twice under different field names, so `account-verify` could not resolve
 * an account at all: the handler read `target_account_hash` from a body that
 * carried `account_id`, answered NOT_FOUND, and the caller — expecting an
 * `UNMATCHED`/`account_name` shape the handler never emits — filed it as ERROR.
 * Drive the real handler with the real payload so the two ends stay married.
 */
describe("account-verify seam: ZC payload → bank handler → ZC mapping", () => {
  it("resolves an exact name match end to end", async () => {
    seedPayeeAccount("0029900001", "サトウ ハナコ");
    insertPending("V-SEAM");

    const payload = buildBankAccountVerifyPayload(
      {
        verification_id: "V-SEAM",
        request_bank_id: "001",
        target_bank_id: "002",
        target_account_id: "0029900001",
        name_to_verify: "サトウ ハナコ",
        idempotency_key: "idem-seam",
      },
      "0029900001",
      "AV-V-SEAM"
    );

    const resp = await bankAccountVerify("002", payload, env);
    expect(resp.result).toBe("MATCHED");
    expect(resp.match_score).toBe(1.0);

    await handleBankVerifyResponse(d1 as any, "V-SEAM", resp);
    const row = await getVerificationResult(d1 as any, "V-SEAM");
    expect(row?.status).toBe("MATCHED");
    expect(row?.match_score).toBe(1.0);
  });

  it("reports a wrong name as UNMATCHED rather than ERROR", async () => {
    seedPayeeAccount("0029900002", "サトウ ハナコ");
    insertPending("V-SEAM-U", "002", "0029900002", "idem-seam-u");

    const payload = buildBankAccountVerifyPayload(
      {
        verification_id: "V-SEAM-U",
        request_bank_id: "001",
        target_bank_id: "002",
        target_account_id: "0029900002",
        name_to_verify: "まったく別の名義",
        idempotency_key: "idem-seam-u",
      },
      "0029900002",
      "AV-V-SEAM-U"
    );

    const resp = await bankAccountVerify("002", payload, env);
    expect(resp.result).toBe("MISMATCHED");

    await handleBankVerifyResponse(d1 as any, "V-SEAM-U", resp);
    expect((await getVerificationResult(d1 as any, "V-SEAM-U"))?.status).toBe("UNMATCHED");
  });
});

describe("requestAccountVerification — cache & idempotency (no bank call)", () => {
  it("returns the existing id for a replayed idempotency_key", async () => {
    insertPending("V-EXIST", "002", "0020000001", "idem-shared");
    const id = await requestAccountVerification(
      d1 as any,
      {
        verification_id: "V-NEW",
        request_bank_id: "001",
        target_bank_id: "002",
        target_account_id: "0020000001",
        name_to_verify: "サトウ ハナコ",
        idempotency_key: "idem-shared",
      },
      env
    );
    expect(id).toBe("V-EXIST"); // replay returns the prior verification, no new row
  });

  it("copies a still-valid cached result instead of calling the bank", async () => {
    // Seed a MATCHED, in-cache result for (002, 0020000001).
    d1.prepare(
      `INSERT INTO AccountVerifications
         (verification_id, request_bank_id, target_bank_id, target_account_hash, target_account_name,
          status, match_score, fraud_warning, cached_until, idempotency_key, created_at, responded_at)
       VALUES ('V-CACHED','001','002','0020000001','サトウ ハナコ','MATCHED',95,0,'2999-01-01T00:00:00.000Z','idem-cached','2026-06-30T00:00:00.000Z','2026-06-30T00:00:00.000Z')`
    )._runSync();

    const newId = await requestAccountVerification(
      d1 as any,
      {
        verification_id: "V-FROM-CACHE",
        request_bank_id: "001",
        target_bank_id: "002",
        target_account_id: "0020000001",
        name_to_verify: "サトウ ハナコ",
        idempotency_key: "idem-fresh",
      },
      env
    );
    expect(newId).toBe("V-FROM-CACHE");
    const row = await getVerificationResult(d1 as any, "V-FROM-CACHE");
    expect(row?.status).toBe("MATCHED"); // copied from cache, not PENDING/ERROR (no bank fetch happened)
    expect(row?.match_score).toBe(95);
    expect(row?.target_account_name).toBe("サトウ ハナコ");
  });
});
