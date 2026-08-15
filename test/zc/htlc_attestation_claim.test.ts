/**
 * @file Tests for fulfilling an HTLC via a signed Attestation against its
 * whitelisted `condition_template_id` (Theme C: programmability generalization).
 *
 * Covers:
 *  - createHtlc: condition_template_id is stored on HtlcContracts
 *  - claimHtlcByAttestation: HTLC_LOCKED -> ... -> PAYER_EXEC_CONFIRMED via a
 *    PASS attestation against the whitelisted template
 *  - CONDITION_TEMPLATE_NOT_SET when the HTLC has no condition_template_id
 *  - TEMPLATE_MISMATCH when req.template_id != HtlcContracts.condition_template_id
 *  - TEMPLATE_NOT_WHITELISTED / ATTESTER_UNAUTHORIZED propagated from recordAttestation
 *  - ATTESTATION_NOT_PASS when verified_result === 'FAIL'
 *  - ATTESTATION_EXPIRED when occurred_at is outside the freshness window
 *  - TIMELOCK_EXPIRED cancellation
 *  - INVALID_STATE / HTLC_NOT_FOUND rejections
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { createHtlc, claimHtlcByAttestation } from "../../src/zc/lanes/htlc";
import { processQueueMessage } from "../../src/zc/orchestrator";
import {
  buildAttestationMessage,
  ATTESTATION_DEFAULT_TTL_SECONDS,
  ATTESTATION_SIGNATURE_SKEW_MS,
} from "../../src/shared/attestation";
import { exportVerificationKey, SIGNATURE_SKEW_MS } from "../../src/shared/external_signature";
import { sha256hex } from "../../src/shared/hmac";
import { DomainError } from "../../src/shared/errors";

const BANK_A = "001";
const BANK_B = "002";
const ACC_A = "0010000001"; // payer (seeded with 1,000,000)
const ACC_B = "0020000001"; // payee

let d1: MockD1Database;

interface TestEnv {
  DB: MockD1Database;
  QUEUE: { _sink: any[]; send: (m: any) => Promise<void> };
  ZC_HMAC_SECRET: string;
}

function makeEnv(db: MockD1Database): TestEnv {
  const sink: any[] = [];
  return {
    DB: db,
    QUEUE: {
      _sink: sink,
      send: async (m: any) => {
        sink.push(m);
      },
    },
    ZC_HMAC_SECRET: "test-secret",
  };
}

async function drain(env: TestEnv, max = 20): Promise<void> {
  let n = 0;
  while (env.QUEUE._sink.length > 0 && n < max) {
    const msg = env.QUEUE._sink.shift()!;
    await processQueueMessage(msg, env as any);
    n++;
  }
  if (n >= max) throw new Error("drain: queue did not converge");
}

function seedParticipant(db: MockD1Database, bankId: string) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 10000000, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId)
    ._runSync();
}

function b64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
}

async function registerKey(
  db: MockD1Database,
  keyId: string,
  publicKey: CryptoKey,
  ownerType: string,
  ownerRef: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
       VALUES (?, ?, ?, ?, 'ED25519', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
    )
    .bind(keyId, ownerType, ownerRef, await exportVerificationKey(publicKey))
    .run();
}

async function registerTemplate(
  db: MockD1Database,
  templateId: string,
  scope: object,
  status = "ACTIVE"
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ConditionTemplate (template_id, predicate_kind, allowed_attester_scope, status, description, registered_at)
       VALUES (?, 'INSPECTION_COMPLETE', ?, ?, 'test template', '2020-01-01T00:00:00.000Z')`
    )
    .bind(templateId, JSON.stringify(scope), status)
    .run();
}

async function signAttestation(
  privateKey: CryptoKey,
  templateId: string,
  subjectRef: string,
  statementHash: string,
  verifiedResult: "PASS" | "FAIL",
  attesterKeyId: string,
  nonce: string,
  occurredAt: string
): Promise<string> {
  const message = buildAttestationMessage(
    templateId,
    subjectRef,
    statementHash,
    verifiedResult,
    attesterKeyId,
    nonce,
    occurredAt
  );
  return b64(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message));
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  seedParticipant(d1, BANK_A);
  seedParticipant(d1, BANK_B);
});

async function createAndLockHtlc(
  htlcId: string,
  overrides: { timelock?: string; condition_template_id?: string } = {}
) {
  const env = makeEnv(d1);
  const timelock = overrides.timelock ?? new Date(Date.now() + 24 * 3600_000).toISOString();

  const created = await createHtlc(
    {
      htlc_id: htlcId,
      idempotency_key: `IK-${htlcId}`,
      amount: { value: 10_000, currency: "JPY" },
      payer_bank_id: BANK_A,
      payer_account_hash: ACC_A,
      payee_bank_id: BANK_B,
      payee_account_hash: ACC_B,
      timelock,
      condition_template_id: overrides.condition_template_id,
    } as any,
    env as any
  );
  expect(created.result).toBe("CREATED");
  await drain(env);

  const locked = await d1
    .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id = ?`)
    .bind(htlcId)
    .first<{ state: string }>();
  expect(locked?.state).toBe("HTLC_LOCKED");

  return { env };
}

// ---------------------------------------------------------------------------
// createHtlc: condition_template_id storage
// ---------------------------------------------------------------------------

describe("createHtlc condition_template_id", () => {
  it("stores condition_template_id on HtlcContracts when provided", async () => {
    const htlcId = "HTLC-ATT-CREATE";
    await registerTemplate(d1, "TPL-INSPECT", { owner_types: ["ATTESTER"] });
    await createAndLockHtlc(htlcId, { condition_template_id: "TPL-INSPECT" });

    const row = await d1
      .prepare(`SELECT condition_template_id FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ condition_template_id: string | null }>();
    expect(row?.condition_template_id).toBe("TPL-INSPECT");
  });

  it("leaves condition_template_id null when not provided", async () => {
    const htlcId = "HTLC-ATT-NOTPL";
    await createAndLockHtlc(htlcId);

    const row = await d1
      .prepare(`SELECT condition_template_id FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ condition_template_id: string | null }>();
    expect(row?.condition_template_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// claimHtlcByAttestation
// ---------------------------------------------------------------------------

describe("claimHtlcByAttestation", () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  beforeEach(async () => {
    ({ privateKey, publicKey } = await generateKeyPair());
    await registerKey(d1, "KEY-ATTESTER-1", publicKey, "ATTESTER", "attester-001");
  });

  it("settles HTLC_LOCKED -> PAYER_EXEC_CONFIRMED via a PASS attestation", async () => {
    const htlcId = "HTLC-ATT-001";
    await registerTemplate(d1, "TPL-INSPECT-1", { owner_types: ["ATTESTER"] });
    const { env } = await createAndLockHtlc(htlcId, { condition_template_id: "TPL-INSPECT-1" });

    const statementHash = await sha256hex("inspection passed");
    const occurredAt = new Date().toISOString();
    const signature = await signAttestation(
      privateKey,
      "TPL-INSPECT-1",
      `TX-HTLC-${htlcId}`,
      statementHash,
      "PASS",
      "KEY-ATTESTER-1",
      "nonce-att-1",
      occurredAt
    );

    const result = await claimHtlcByAttestation(
      {
        htlc_id: htlcId,
        template_id: "TPL-INSPECT-1",
        statement_hash: statementHash,
        verified_result: "PASS",
        attester_key_id: "KEY-ATTESTER-1",
        nonce: "nonce-att-1",
        occurred_at: occurredAt,
        signature,
        idempotency_key: `IK-ATTCLAIM-${htlcId}`,
      },
      env as any
    );

    expect(result.result).toBe("ACCEPTED");
    expect(result.state).toBe("PAYER_EXEC_CONFIRMED");

    const txRow = await d1
      .prepare(
        `SELECT t.state FROM Transactions t JOIN HtlcContracts h ON h.txid = t.txid WHERE h.htlc_id = ?`
      )
      .bind(htlcId)
      .first<{ state: string }>();
    expect(txRow?.state).toBe("PAYER_EXEC_CONFIRMED");

    const htlcRow = await d1
      .prepare(`SELECT state, secret_verified FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ state: string; secret_verified: number }>();
    expect(htlcRow?.state).toBe("DECIDED_TO_SETTLE");
    expect(htlcRow?.secret_verified).toBe(1);
  });

  it("rejects with CONDITION_TEMPLATE_NOT_SET when the HTLC has no condition_template_id", async () => {
    const htlcId = "HTLC-ATT-NOSET";
    await registerTemplate(d1, "TPL-INSPECT-2", { owner_types: ["ATTESTER"] });
    const { env } = await createAndLockHtlc(htlcId); // no condition_template_id

    const statementHash = await sha256hex("inspection passed");
    const occurredAt = new Date().toISOString();
    const signature = await signAttestation(
      privateKey,
      "TPL-INSPECT-2",
      `TX-HTLC-${htlcId}`,
      statementHash,
      "PASS",
      "KEY-ATTESTER-1",
      "nonce-att-2",
      occurredAt
    );

    const result = await claimHtlcByAttestation(
      {
        htlc_id: htlcId,
        template_id: "TPL-INSPECT-2",
        statement_hash: statementHash,
        verified_result: "PASS",
        attester_key_id: "KEY-ATTESTER-1",
        nonce: "nonce-att-2",
        occurred_at: occurredAt,
        signature,
        idempotency_key: `IK-ATTCLAIM-${htlcId}`,
      },
      env as any
    );

    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("CONDITION_TEMPLATE_NOT_SET");
  });

  it("rejects with TEMPLATE_MISMATCH when req.template_id differs from condition_template_id", async () => {
    const htlcId = "HTLC-ATT-MISMATCH";
    await registerTemplate(d1, "TPL-INSPECT-3", { owner_types: ["ATTESTER"] });
    await registerTemplate(d1, "TPL-OTHER", { owner_types: ["ATTESTER"] });
    const { env } = await createAndLockHtlc(htlcId, { condition_template_id: "TPL-INSPECT-3" });

    const statementHash = await sha256hex("inspection passed");
    const occurredAt = new Date().toISOString();
    const signature = await signAttestation(
      privateKey,
      "TPL-OTHER",
      `TX-HTLC-${htlcId}`,
      statementHash,
      "PASS",
      "KEY-ATTESTER-1",
      "nonce-att-3",
      occurredAt
    );

    const result = await claimHtlcByAttestation(
      {
        htlc_id: htlcId,
        template_id: "TPL-OTHER",
        statement_hash: statementHash,
        verified_result: "PASS",
        attester_key_id: "KEY-ATTESTER-1",
        nonce: "nonce-att-3",
        occurred_at: occurredAt,
        signature,
        idempotency_key: `IK-ATTCLAIM-${htlcId}`,
      },
      env as any
    );

    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("TEMPLATE_MISMATCH");
  });

  it("propagates TEMPLATE_NOT_WHITELISTED when condition_template_id is not an ACTIVE ConditionTemplate", async () => {
    const htlcId = "HTLC-ATT-NOTWL";
    // Note: condition_template_id is stored without a corresponding (active) ConditionTemplate row.
    const { env } = await createAndLockHtlc(htlcId, { condition_template_id: "TPL-GHOST" });

    const statementHash = await sha256hex("inspection passed");
    const occurredAt = new Date().toISOString();
    const signature = await signAttestation(
      privateKey,
      "TPL-GHOST",
      `TX-HTLC-${htlcId}`,
      statementHash,
      "PASS",
      "KEY-ATTESTER-1",
      "nonce-att-4",
      occurredAt
    );

    await expect(
      claimHtlcByAttestation(
        {
          htlc_id: htlcId,
          template_id: "TPL-GHOST",
          statement_hash: statementHash,
          verified_result: "PASS",
          attester_key_id: "KEY-ATTESTER-1",
          nonce: "nonce-att-4",
          occurred_at: occurredAt,
          signature,
          idempotency_key: `IK-ATTCLAIM-${htlcId}`,
        },
        env as any
      )
    ).rejects.toMatchObject({
      reason_code: "TEMPLATE_NOT_WHITELISTED",
    } satisfies Partial<DomainError>);
  });

  it("propagates ATTESTER_UNAUTHORIZED when the attester key is out of the template's scope", async () => {
    const htlcId = "HTLC-ATT-UNAUTH";
    await registerTemplate(d1, "TPL-INSPECT-5", { owner_types: ["AGENT"] }); // ATTESTER not in scope
    const { env } = await createAndLockHtlc(htlcId, { condition_template_id: "TPL-INSPECT-5" });

    const statementHash = await sha256hex("inspection passed");
    const occurredAt = new Date().toISOString();
    const signature = await signAttestation(
      privateKey,
      "TPL-INSPECT-5",
      `TX-HTLC-${htlcId}`,
      statementHash,
      "PASS",
      "KEY-ATTESTER-1",
      "nonce-att-5",
      occurredAt
    );

    await expect(
      claimHtlcByAttestation(
        {
          htlc_id: htlcId,
          template_id: "TPL-INSPECT-5",
          statement_hash: statementHash,
          verified_result: "PASS",
          attester_key_id: "KEY-ATTESTER-1",
          nonce: "nonce-att-5",
          occurred_at: occurredAt,
          signature,
          idempotency_key: `IK-ATTCLAIM-${htlcId}`,
        },
        env as any
      )
    ).rejects.toMatchObject({
      reason_code: "ATTESTER_UNAUTHORIZED",
    } satisfies Partial<DomainError>);
  });

  it("rejects with ATTESTATION_NOT_PASS when verified_result is FAIL", async () => {
    const htlcId = "HTLC-ATT-FAIL";
    await registerTemplate(d1, "TPL-INSPECT-6", { owner_types: ["ATTESTER"] });
    const { env } = await createAndLockHtlc(htlcId, { condition_template_id: "TPL-INSPECT-6" });

    const statementHash = await sha256hex("inspection failed");
    const occurredAt = new Date().toISOString();
    const signature = await signAttestation(
      privateKey,
      "TPL-INSPECT-6",
      `TX-HTLC-${htlcId}`,
      statementHash,
      "FAIL",
      "KEY-ATTESTER-1",
      "nonce-att-6",
      occurredAt
    );

    const result = await claimHtlcByAttestation(
      {
        htlc_id: htlcId,
        template_id: "TPL-INSPECT-6",
        statement_hash: statementHash,
        verified_result: "FAIL",
        attester_key_id: "KEY-ATTESTER-1",
        nonce: "nonce-att-6",
        occurred_at: occurredAt,
        signature,
        idempotency_key: `IK-ATTCLAIM-${htlcId}`,
      },
      env as any
    );

    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("ATTESTATION_NOT_PASS");

    // State unchanged — still HTLC_LOCKED.
    const htlcRow = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ state: string }>();
    expect(htlcRow?.state).toBe("HTLC_LOCKED");
  });

  it("cancels with TIMELOCK_EXPIRED when the ZC-side timelock has passed", async () => {
    const htlcId = "HTLC-ATT-TIMEOUT";
    await registerTemplate(d1, "TPL-INSPECT-8", { owner_types: ["ATTESTER"] });
    const { env } = await createAndLockHtlc(htlcId, { condition_template_id: "TPL-INSPECT-8" });

    // Backdate the timelock so it's already expired.
    d1.prepare(`UPDATE HtlcContracts SET timelock = ? WHERE htlc_id = ?`)
      .bind("2000-01-01T00:00:00Z", htlcId)
      ._runSync();

    const statementHash = await sha256hex("inspection passed");
    const occurredAt = new Date().toISOString();
    const signature = await signAttestation(
      privateKey,
      "TPL-INSPECT-8",
      `TX-HTLC-${htlcId}`,
      statementHash,
      "PASS",
      "KEY-ATTESTER-1",
      "nonce-att-8",
      occurredAt
    );

    const result = await claimHtlcByAttestation(
      {
        htlc_id: htlcId,
        template_id: "TPL-INSPECT-8",
        statement_hash: statementHash,
        verified_result: "PASS",
        attester_key_id: "KEY-ATTESTER-1",
        nonce: "nonce-att-8",
        occurred_at: occurredAt,
        signature,
        idempotency_key: `IK-ATTCLAIM-${htlcId}`,
      },
      env as any
    );

    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("TIMELOCK_EXPIRED");
    expect(result.state).toBe("DECIDED_CANCEL");

    const txRow = await d1
      .prepare(
        `SELECT t.state, t.reason_code FROM Transactions t JOIN HtlcContracts h ON h.txid = t.txid WHERE h.htlc_id = ?`
      )
      .bind(htlcId)
      .first<{ state: string; reason_code: string }>();
    expect(txRow?.state).toBe("CANCELLED");
    expect(txRow?.reason_code).toBe("TIMELOCK_EXPIRED");
  });

  it("rejects with INVALID_STATE when the HTLC is not HTLC_LOCKED", async () => {
    const htlcId = "HTLC-ATT-WRONGSTATE";
    await registerTemplate(d1, "TPL-INSPECT-9", { owner_types: ["ATTESTER"] });
    const env = makeEnv(d1);
    const timelock = new Date(Date.now() + 24 * 3600_000).toISOString();

    const created = await createHtlc(
      {
        htlc_id: htlcId,
        idempotency_key: `IK-${htlcId}`,
        amount: { value: 10_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock,
        condition_template_id: "TPL-INSPECT-9",
      } as any,
      env as any
    );
    expect(created.result).toBe("CREATED");
    // Do NOT drain — HTLC is still HTLC_RECEIVED, not HTLC_LOCKED.

    const statementHash = await sha256hex("inspection passed");
    const occurredAt = new Date().toISOString();
    const signature = await signAttestation(
      privateKey,
      "TPL-INSPECT-9",
      `TX-HTLC-${htlcId}`,
      statementHash,
      "PASS",
      "KEY-ATTESTER-1",
      "nonce-att-9",
      occurredAt
    );

    const result = await claimHtlcByAttestation(
      {
        htlc_id: htlcId,
        template_id: "TPL-INSPECT-9",
        statement_hash: statementHash,
        verified_result: "PASS",
        attester_key_id: "KEY-ATTESTER-1",
        nonce: "nonce-att-9",
        occurred_at: occurredAt,
        signature,
        idempotency_key: `IK-ATTCLAIM-${htlcId}`,
      },
      env as any
    );

    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("INVALID_STATE");
  });

  it("rejects with HTLC_NOT_FOUND for an unknown htlc_id", async () => {
    const env = makeEnv(d1);
    const statementHash = await sha256hex("inspection passed");
    const occurredAt = new Date().toISOString();
    const signature = await signAttestation(
      privateKey,
      "TPL-NOPE",
      `TX-HTLC-HTLC-ATT-NOPE`,
      statementHash,
      "PASS",
      "KEY-ATTESTER-1",
      "nonce-att-10",
      occurredAt
    );

    const result = await claimHtlcByAttestation(
      {
        htlc_id: "HTLC-ATT-NOPE",
        template_id: "TPL-NOPE",
        statement_hash: statementHash,
        verified_result: "PASS",
        attester_key_id: "KEY-ATTESTER-1",
        nonce: "nonce-att-10",
        occurred_at: occurredAt,
        signature,
        idempotency_key: "IK-ATTCLAIM-HTLC-ATT-NOPE",
      },
      env as any
    );

    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("HTLC_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// Adversarial probe (chaos series, T19): is ATTESTATION_EXPIRED reachable?
//
// docs/specs/32_api_contracts.md documents claim-by-attestation's check order as two
// distinct, sequential freshness checks on the same `occurred_at` field:
//   1. recordAttestation's external-signature verification, whose own table
//      lists `TIMESTAMP_SKEW` as "occurred_at が許容スキューを超過".
//   2. A *separate*, later step: "アテステーションの鮮度切れ（docs/specs/30_internal_design.md §11.2-b, 60分）:
//      ATTESTATION_EXPIRED" — i.e. a dedicated 60-minute staleness window
//      (ATTESTATION_DEFAULT_TTL_SECONDS), intentionally wider than #1 so that
//      an attestation signed somewhat in the past can still be presented
//      ("対象取引の終端＋60分、following the HTLC preimage retention norm" —
//      src/shared/attestation.ts's own doc comment on the constant).
//
// FOUND: recordAttestation used the generic SIGNATURE_SKEW_MS (5 minutes)
// for its TIMESTAMP_SKEW check, which is tighter than the 60-minute window
// step 2 is supposed to police — so step 1 always fired first and
// ATTESTATION_EXPIRED was dead code on every call path that produces it.
//
// FIXED: recordAttestation now passes a wider, attestation-specific
// `maxSkewMs` (`ATTESTATION_SIGNATURE_SKEW_MS` = the 60-minute TTL + the
// generic 5-minute clock-skew tolerance) to verifyExternalSignature. The
// generic check is now an outer sanity bound against grossly stale or
// clock-bogus timestamps; `assertAttestationFresh`'s 60-minute rule is the
// narrower, operative, and now genuinely reachable gate. The other 4
// verifyExternalSignature call sites (mandate, watcher, finality_anchor,
// proof) are untouched and keep the strict 5-minute default — none of them
// has its own dedicated freshness rule to defer to.
// ---------------------------------------------------------------------------
describe("ATTESTATION_EXPIRED reachability — adversarial probe (chaos T19, fixed)", () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  beforeEach(async () => {
    ({ privateKey, publicKey } = await generateKeyPair());
    await registerKey(d1, "KEY-ATTESTER-1", publicKey, "ATTESTER", "attester-001");
  });

  it("structural precondition: the attestation-specific skew bound is wider than its own documented TTL (so the TTL rule is the operative one)", () => {
    expect(ATTESTATION_SIGNATURE_SKEW_MS).toBeGreaterThan(ATTESTATION_DEFAULT_TTL_SECONDS * 1000);
    // The generic default (still used by the other 4 call sites) remains
    // tight — only the attestation-specific bound was widened.
    expect(SIGNATURE_SKEW_MS).toBeLessThan(ATTESTATION_DEFAULT_TTL_SECONDS * 1000);
  });

  it("a 10-minute-old attestation — squarely inside the documented 60-minute TTL — is now evaluated for PASS/FAIL instead of being falsely rejected with TIMESTAMP_SKEW", async () => {
    const htlcId = "HTLC-ATT-SKEW-10";
    await registerTemplate(d1, "TPL-SKEW-10", { owner_types: ["ATTESTER"] });
    const { env } = await createAndLockHtlc(htlcId, { condition_template_id: "TPL-SKEW-10" });

    const statementHash = await sha256hex("inspection passed");
    // Real wall clock, no injected `now` anywhere in this test: the attester
    // genuinely signed 10 minutes ago and the claimant submits it now — well
    // within the spec's documented 60-minute attestation freshness budget.
    const occurredAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const signature = await signAttestation(
      privateKey,
      "TPL-SKEW-10",
      `TX-HTLC-${htlcId}`,
      statementHash,
      "PASS",
      "KEY-ATTESTER-1",
      "nonce-skew-10",
      occurredAt
    );

    const result = await claimHtlcByAttestation(
      {
        htlc_id: htlcId,
        template_id: "TPL-SKEW-10",
        statement_hash: statementHash,
        verified_result: "PASS",
        attester_key_id: "KEY-ATTESTER-1",
        nonce: "nonce-skew-10",
        occurred_at: occurredAt,
        signature,
        idempotency_key: `IK-ATTCLAIM-${htlcId}`,
      },
      env as any
    );

    // A legitimate, in-window PASS attestation now settles the HTLC.
    expect(result.result).toBe("ACCEPTED");
    expect(result.state).toBe("PAYER_EXEC_CONFIRMED");
    const attRow = await d1
      .prepare(
        `SELECT COUNT(*) AS n FROM Attestation WHERE template_id = ? AND verified_result = 'PASS'`
      )
      .bind("TPL-SKEW-10")
      .first<{ n: number }>();
    expect(attRow?.n).toBe(1);
  });

  it("a 62-minute-old attestation (past the 60-minute TTL, inside the 65-minute outer bound) now correctly reaches and fails with ATTESTATION_EXPIRED, not TIMESTAMP_SKEW", async () => {
    const htlcId = "HTLC-ATT-SKEW-62";
    await registerTemplate(d1, "TPL-SKEW-62", { owner_types: ["ATTESTER"] });
    const { env } = await createAndLockHtlc(htlcId, { condition_template_id: "TPL-SKEW-62" });

    const statementHash = await sha256hex("inspection passed");
    // Genuinely stale by the spec's own 60-minute yardstick — this is the
    // case ATTESTATION_EXPIRED exists to name. Still inside the wider outer
    // ATTESTATION_SIGNATURE_SKEW_MS sanity bound (65 minutes), so
    // recordAttestation succeeds and the 60-minute rule gets to apply.
    const occurredAt = new Date(Date.now() - 62 * 60_000).toISOString();
    const signature = await signAttestation(
      privateKey,
      "TPL-SKEW-62",
      `TX-HTLC-${htlcId}`,
      statementHash,
      "PASS",
      "KEY-ATTESTER-1",
      "nonce-skew-62",
      occurredAt
    );

    let caught: unknown;
    try {
      await claimHtlcByAttestation(
        {
          htlc_id: htlcId,
          template_id: "TPL-SKEW-62",
          statement_hash: statementHash,
          verified_result: "PASS",
          attester_key_id: "KEY-ATTESTER-1",
          nonce: "nonce-skew-62",
          occurred_at: occurredAt,
          signature,
          idempotency_key: `IK-ATTCLAIM-${htlcId}`,
        },
        env as any
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).reason_code).toBe("ATTESTATION_EXPIRED");
    expect((caught as DomainError).reason_code).not.toBe("TIMESTAMP_SKEW");
    // The Attestation row IS persisted this time — recordAttestation's
    // signature check passed; only the *use* of it (assertAttestationFresh)
    // was rejected, matching the doc comment: "the Attestation row itself is
    // retained indefinitely as an audit record regardless of freshness."
    const attRow = await d1
      .prepare(`SELECT COUNT(*) AS n FROM Attestation WHERE template_id = ?`)
      .bind("TPL-SKEW-62")
      .first<{ n: number }>();
    expect(attRow?.n).toBe(1);
  });

  it("a 200-minute-old attestation is far beyond even the widened outer bound and is correctly rejected with TIMESTAMP_SKEW (the outer sanity check still works)", async () => {
    const htlcId = "HTLC-ATT-SKEW-200";
    await registerTemplate(d1, "TPL-SKEW-200", { owner_types: ["ATTESTER"] });
    const { env } = await createAndLockHtlc(htlcId, { condition_template_id: "TPL-SKEW-200" });

    const statementHash = await sha256hex("inspection passed");
    const occurredAt = new Date(Date.now() - 200 * 60_000).toISOString();
    const signature = await signAttestation(
      privateKey,
      "TPL-SKEW-200",
      `TX-HTLC-${htlcId}`,
      statementHash,
      "PASS",
      "KEY-ATTESTER-1",
      "nonce-skew-200",
      occurredAt
    );

    await expect(
      claimHtlcByAttestation(
        {
          htlc_id: htlcId,
          template_id: "TPL-SKEW-200",
          statement_hash: statementHash,
          verified_result: "PASS",
          attester_key_id: "KEY-ATTESTER-1",
          nonce: "nonce-skew-200",
          occurred_at: occurredAt,
          signature,
          idempotency_key: `IK-ATTCLAIM-${htlcId}`,
        },
        env as any
      )
    ).rejects.toMatchObject({ reason_code: "TIMESTAMP_SKEW" } satisfies Partial<DomainError>);

    // No Attestation row this time — the outer bound rejected before INSERT.
    const attRow = await d1
      .prepare(`SELECT COUNT(*) AS n FROM Attestation WHERE template_id = ?`)
      .bind("TPL-SKEW-200")
      .first<{ n: number }>();
    expect(attRow?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Adversarial probe (chaos series, T20): combined-guard-violation precedence.
//
// docs/specs/32_api_contracts.md documents claimHtlcByAttestation's check order as a
// strict sequence: HTLC_NOT_FOUND -> CONDITION_TEMPLATE_NOT_SET ->
// TEMPLATE_MISMATCH -> INVALID_STATE -> TIMELOCK_EXPIRED -> recordAttestation
// (signature/whitelist/scope) -> ATTESTATION_NOT_PASS. Every existing test
// violates exactly one guard at a time; the mean move is to violate two
// simultaneously and check that the *earlier* one in the documented order
// wins — and, for the timelock case, that the implementation never even
// attempts the (forged) signature verification once the contract is already
// dead.
// ---------------------------------------------------------------------------
describe("combined-guard-violation precedence — adversarial probe (chaos T20)", () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  beforeEach(async () => {
    ({ privateKey, publicKey } = await generateKeyPair());
    await registerKey(d1, "KEY-ATTESTER-1", publicKey, "ATTESTER", "attester-001");
  });

  it("TEMPLATE_MISMATCH wins over INVALID_STATE when both apply at once", async () => {
    const htlcId = "HTLC-ATT-COMBO-1";
    await registerTemplate(d1, "TPL-COMBO-1", { owner_types: ["ATTESTER"] });
    await registerTemplate(d1, "TPL-COMBO-1-OTHER", { owner_types: ["ATTESTER"] });

    // Create but deliberately do NOT drain the queue: the HTLC sits in
    // HTLC_RECEIVED, not HTLC_LOCKED (violates INVALID_STATE) — and the
    // claim below also presents the *wrong* template_id (violates
    // TEMPLATE_MISMATCH). Per the documented order, TEMPLATE_MISMATCH is
    // checked first and must win.
    const env = makeEnv(d1);
    const timelock = new Date(Date.now() + 24 * 3600_000).toISOString();
    const created = await createHtlc(
      {
        htlc_id: htlcId,
        idempotency_key: `IK-${htlcId}`,
        amount: { value: 10_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock,
        condition_template_id: "TPL-COMBO-1",
      } as any,
      env as any
    );
    expect(created.result).toBe("CREATED");
    // No drain(): state stays HTLC_RECEIVED.

    const statementHash = await sha256hex("inspection passed");
    const occurredAt = new Date().toISOString();
    const signature = await signAttestation(
      privateKey,
      "TPL-COMBO-1-OTHER", // wrong template_id: TEMPLATE_MISMATCH
      `TX-HTLC-${htlcId}`,
      statementHash,
      "PASS",
      "KEY-ATTESTER-1",
      "nonce-combo-1",
      occurredAt
    );

    const result = await claimHtlcByAttestation(
      {
        htlc_id: htlcId,
        template_id: "TPL-COMBO-1-OTHER",
        statement_hash: statementHash,
        verified_result: "PASS",
        attester_key_id: "KEY-ATTESTER-1",
        nonce: "nonce-combo-1",
        occurred_at: occurredAt,
        signature,
        idempotency_key: `IK-ATTCLAIM-${htlcId}`,
      },
      env as any
    );

    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("TEMPLATE_MISMATCH");
    expect(result.reason_code).not.toBe("INVALID_STATE");
  });

  it("TIMELOCK_EXPIRED wins over a forged signature — recordAttestation is never reached, so no Attestation row is inserted", async () => {
    const htlcId = "HTLC-ATT-COMBO-2";
    await registerTemplate(d1, "TPL-COMBO-2", { owner_types: ["ATTESTER"] });
    const { env } = await createAndLockHtlc(htlcId, { condition_template_id: "TPL-COMBO-2" });

    // Backdate the timelock so it's already expired.
    d1.prepare(`UPDATE HtlcContracts SET timelock = ? WHERE htlc_id = ?`)
      .bind("2000-01-01T00:00:00Z", htlcId)
      ._runSync();

    const statementHash = await sha256hex("inspection passed");
    const occurredAt = new Date().toISOString();
    // Deliberately garbage signature — not a valid Ed25519 signature over
    // anything. If the implementation reached recordAttestation, this would
    // throw EXTERNAL_SIGNATURE_INVALID, not TIMELOCK_EXPIRED.
    const forgedSignature =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    const result = await claimHtlcByAttestation(
      {
        htlc_id: htlcId,
        template_id: "TPL-COMBO-2",
        statement_hash: statementHash,
        verified_result: "PASS",
        attester_key_id: "KEY-ATTESTER-1",
        nonce: "nonce-combo-2",
        occurred_at: occurredAt,
        signature: forgedSignature,
        idempotency_key: `IK-ATTCLAIM-${htlcId}`,
      },
      env as any
    );

    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("TIMELOCK_EXPIRED");
    expect(result.state).toBe("DECIDED_CANCEL");

    // No Attestation row exists: the forged signature was never evaluated.
    const attRow = await d1
      .prepare(`SELECT COUNT(*) AS n FROM Attestation WHERE template_id = ?`)
      .bind("TPL-COMBO-2")
      .first<{ n: number }>();
    expect(attRow?.n).toBe(0);
    // The nonce was never consumed either (no idempotency claim on sig:*).
    const nonceRow = await d1
      .prepare(`SELECT COUNT(*) AS n FROM IdempotencyKeys WHERE key = ?`)
      .bind("sig:KEY-ATTESTER-1:nonce-combo-2")
      .first<{ n: number }>();
    expect(nonceRow?.n).toBe(0);
  });
});
