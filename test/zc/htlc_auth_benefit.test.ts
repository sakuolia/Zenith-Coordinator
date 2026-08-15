/**
 * @file htlc_auth_benefit.test.ts — Theme F (給付行政): benefit administration
 * as a composition of existing primitives, no new lane/state.
 *
 * Covers:
 *  - createAuthRequest: ELIGIBILITY_NOT_ATTESTED when the whitelist requires
 *    an eligibility ConditionTemplate but no/insufficient Attestation is given
 *  - createAuthRequest: accepts + records eligibility_attestation_id and
 *    writes a BenefitAttested FinalityLog event on a PASS Attestation
 *  - createAuthRequest: propagates ATTESTER_UNAUTHORIZED from recordAttestation
 *  - captureHtlcAuth: PURPOSE_VIOLATION + PurposeRestrictedCapture event when
 *    the whitelist's allowed_purposes no longer covers the request's purpose
 *  - captureHtlcAuth: PurposeRestrictedCapture(OK) + normal capture when the
 *    purpose is still allowed
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  registerAuthWhitelist,
  createAuthRequest,
  approveAuthRequest,
  captureHtlcAuth,
} from "../../src/zc/lanes/htlc_auth";
import { buildAttestationMessage } from "../../src/shared/attestation";
import { exportVerificationKey } from "../../src/shared/external_signature";
import type { Env } from "../../src/types";

let d1: MockD1Database;

const PAYER_BANK = "001";
const PAYEE_BANK = "002";
const PAYER_ACCOUNT = "0010000001";
const PAYEE_ACCOUNT = "0020000001";

function makeEnv(): Env {
  return {
    DB: d1 as unknown as D1Database,
    QUEUE: { send: async () => {} } as any,
    R2: {} as any,
    ZC_HMAC_SECRET: "",
    VAULT_URL: "",
    VAULT_TOKEN: "",
  } as unknown as Env;
}

function seedParticipant(bankId: string) {
  d1.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 5000000, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId)
    ._runSync();
}

function seedAccount(bankId: string, accountId: string, balance = 0) {
  d1.prepare(
    `INSERT OR IGNORE INTO BankAccounts
     (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
     VALUES (?, ?, 'CUST', 'Test User', 'SAVINGS', 'NORMAL', '2025-01-01T00:00:00Z')`
  )
    .bind(accountId, bankId)
    ._runSync();
  if (balance > 0) {
    d1.prepare(
      `INSERT INTO BankJournals
       (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES (?, ?, ?, ?, 'CASH', 'INIT', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(`JNL-${accountId}`, bankId, accountId, balance)
      ._runSync();
  }
}

function b64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
}

async function registerKey(
  keyId: string,
  publicKey: CryptoKey,
  ownerType: string,
  ownerRef: string
): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
       VALUES (?, ?, ?, ?, 'ED25519', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
    )
    .bind(keyId, ownerType, ownerRef, await exportVerificationKey(publicKey))
    .run();
}

async function registerTemplate(
  templateId: string,
  scope: object,
  status = "ACTIVE"
): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO ConditionTemplate (template_id, predicate_kind, allowed_attester_scope, status, description, registered_at)
       VALUES (?, 'ELIGIBILITY', ?, ?, 'benefit eligibility template', '2020-01-01T00:00:00.000Z')`
    )
    .bind(templateId, JSON.stringify(scope), status)
    .run();
}

async function signEligibility(
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
  seedParticipant(PAYER_BANK);
  seedParticipant(PAYEE_BANK);
  seedAccount(PAYER_BANK, PAYER_ACCOUNT, 2_000_000);
  seedAccount(PAYEE_BANK, PAYEE_ACCOUNT);
  seedAccount(PAYER_BANK, `${PAYER_BANK}-ZCS`);
  seedAccount(PAYEE_BANK, `${PAYEE_BANK}-ZCS`);
  seedAccount(PAYER_BANK, `${PAYER_BANK}0000000`);
});

// ---------------------------------------------------------------------------
// Eligibility attestation at createAuthRequest (P2 over HtlcAuthWhitelist)
// ---------------------------------------------------------------------------

describe("createAuthRequest — eligibility attestation (Theme F)", () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  beforeEach(async () => {
    ({ privateKey, publicKey } = await generateKeyPair());
    await registerKey("KEY-GOVT-1", publicKey, "ATTESTER", "registry-001");
  });

  it("ELIGIBILITY_NOT_ATTESTED when the whitelist requires eligibility but none is presented", async () => {
    await registerTemplate("TPL-BENEFIT-1", { owner_types: ["ATTESTER"] });
    const { whitelist_id } = await registerAuthWhitelist(
      {
        payee_bank_id: PAYEE_BANK,
        payee_account_hash: PAYEE_ACCOUNT,
        allowed_payer_bank_id: PAYER_BANK,
        max_amount: 1_000_000,
        eligibility_template_id: "TPL-BENEFIT-1",
      },
      d1 as unknown as D1Database
    );
    expect(whitelist_id).toMatch(/^WL-/);

    const result = await createAuthRequest(
      {
        auth_id: "AUTH-BEN-NOATT",
        payee_bank_id: PAYEE_BANK,
        payee_account_hash: PAYEE_ACCOUNT,
        payer_bank_id: PAYER_BANK,
        payer_account_hash: PAYER_ACCOUNT,
        amount: { value: 50_000, currency: "JPY" },
        auth_expires_at: "2099-12-31T12:00:00Z",
        capture_expires_at: "2099-12-31T18:00:00Z",
        idempotency_key: "IK-AUTH-BEN-NOATT",
      },
      makeEnv()
    );

    expect(result.result).toBe("ERROR");
    expect(result.reason_code).toBe("ELIGIBILITY_NOT_ATTESTED");
  });

  it("ELIGIBILITY_NOT_ATTESTED when the attestation verified_result is FAIL", async () => {
    await registerTemplate("TPL-BENEFIT-2", { owner_types: ["ATTESTER"] });
    await registerAuthWhitelist(
      {
        payee_bank_id: PAYEE_BANK,
        payee_account_hash: PAYEE_ACCOUNT,
        allowed_payer_bank_id: PAYER_BANK,
        max_amount: 1_000_000,
        eligibility_template_id: "TPL-BENEFIT-2",
      },
      d1 as unknown as D1Database
    );

    const authId = "AUTH-BEN-FAIL";
    const statementHash = "a".repeat(64);
    const occurredAt = new Date().toISOString();
    const signature = await signEligibility(
      privateKey,
      "TPL-BENEFIT-2",
      authId,
      statementHash,
      "FAIL",
      "KEY-GOVT-1",
      "nonce-ben-fail",
      occurredAt
    );

    const result = await createAuthRequest(
      {
        auth_id: authId,
        payee_bank_id: PAYEE_BANK,
        payee_account_hash: PAYEE_ACCOUNT,
        payer_bank_id: PAYER_BANK,
        payer_account_hash: PAYER_ACCOUNT,
        amount: { value: 50_000, currency: "JPY" },
        auth_expires_at: "2099-12-31T12:00:00Z",
        capture_expires_at: "2099-12-31T18:00:00Z",
        idempotency_key: `IK-${authId}`,
        eligibility_attestation: {
          statement_hash: statementHash,
          verified_result: "FAIL",
          attester_key_id: "KEY-GOVT-1",
          nonce: "nonce-ben-fail",
          occurred_at: occurredAt,
          signature,
        },
      },
      makeEnv()
    );

    expect(result.result).toBe("ERROR");
    expect(result.reason_code).toBe("ELIGIBILITY_NOT_ATTESTED");
  });

  it("propagates ATTESTER_UNAUTHORIZED when the attester key is out of the template's scope", async () => {
    await registerTemplate("TPL-BENEFIT-3", { owner_types: ["AGENT"] }); // ATTESTER not in scope
    await registerAuthWhitelist(
      {
        payee_bank_id: PAYEE_BANK,
        payee_account_hash: PAYEE_ACCOUNT,
        allowed_payer_bank_id: PAYER_BANK,
        max_amount: 1_000_000,
        eligibility_template_id: "TPL-BENEFIT-3",
      },
      d1 as unknown as D1Database
    );

    const authId = "AUTH-BEN-UNAUTH";
    const statementHash = "b".repeat(64);
    const occurredAt = new Date().toISOString();
    const signature = await signEligibility(
      privateKey,
      "TPL-BENEFIT-3",
      authId,
      statementHash,
      "PASS",
      "KEY-GOVT-1",
      "nonce-ben-unauth",
      occurredAt
    );

    const result = await createAuthRequest(
      {
        auth_id: authId,
        payee_bank_id: PAYEE_BANK,
        payee_account_hash: PAYEE_ACCOUNT,
        payer_bank_id: PAYER_BANK,
        payer_account_hash: PAYER_ACCOUNT,
        amount: { value: 50_000, currency: "JPY" },
        auth_expires_at: "2099-12-31T12:00:00Z",
        capture_expires_at: "2099-12-31T18:00:00Z",
        idempotency_key: `IK-${authId}`,
        eligibility_attestation: {
          statement_hash: statementHash,
          verified_result: "PASS",
          attester_key_id: "KEY-GOVT-1",
          nonce: "nonce-ben-unauth",
          occurred_at: occurredAt,
          signature,
        },
      },
      makeEnv()
    );

    expect(result.result).toBe("ERROR");
    expect(result.reason_code).toBe("ATTESTER_UNAUTHORIZED");
  });

  it("accepts the request, stores eligibility_attestation_id, and writes BenefitAttested on a PASS attestation", async () => {
    await registerTemplate("TPL-BENEFIT-4", { owner_types: ["ATTESTER"] });
    await registerAuthWhitelist(
      {
        payee_bank_id: PAYEE_BANK,
        payee_account_hash: PAYEE_ACCOUNT,
        allowed_payer_bank_id: PAYER_BANK,
        max_amount: 1_000_000,
        eligibility_template_id: "TPL-BENEFIT-4",
      },
      d1 as unknown as D1Database
    );

    const authId = "AUTH-BEN-PASS";
    const statementHash = "c".repeat(64);
    const occurredAt = new Date().toISOString();
    const signature = await signEligibility(
      privateKey,
      "TPL-BENEFIT-4",
      authId,
      statementHash,
      "PASS",
      "KEY-GOVT-1",
      "nonce-ben-pass",
      occurredAt
    );

    const result = await createAuthRequest(
      {
        auth_id: authId,
        payee_bank_id: PAYEE_BANK,
        payee_account_hash: PAYEE_ACCOUNT,
        payer_bank_id: PAYER_BANK,
        payer_account_hash: PAYER_ACCOUNT,
        amount: { value: 50_000, currency: "JPY" },
        auth_expires_at: "2099-12-31T12:00:00Z",
        capture_expires_at: "2099-12-31T18:00:00Z",
        idempotency_key: `IK-${authId}`,
        eligibility_attestation: {
          statement_hash: statementHash,
          verified_result: "PASS",
          attester_key_id: "KEY-GOVT-1",
          nonce: "nonce-ben-pass",
          occurred_at: occurredAt,
          signature,
        },
      },
      makeEnv()
    );

    expect(result.result).toBe("AUTH_REQUESTED");
    expect(result.auth_id).toBe(authId);

    const row = await d1
      .prepare(`SELECT eligibility_attestation_id FROM HtlcAuthRequests WHERE auth_id=?`)
      .bind(authId)
      .first<{ eligibility_attestation_id: string | null }>();
    expect(row?.eligibility_attestation_id).toMatch(/^ATT-/);

    const events = await d1
      .prepare(
        `SELECT event_type, payload_json FROM FinalityLog WHERE event_type='BenefitAttested'`
      )
      .all<{ event_type: string; payload_json: string }>();
    expect(events.results).toHaveLength(1);
    const payload = JSON.parse(events.results[0].payload_json);
    expect(payload.auth_id).toBe(authId);
    expect(payload.template_id).toBe("TPL-BENEFIT-4");
    expect(payload.attestation_id).toBe(row?.eligibility_attestation_id);
  });
});

// ---------------------------------------------------------------------------
// Purpose-restricted capture (allowed_purposes enforced at capture time)
// ---------------------------------------------------------------------------

describe("captureHtlcAuth — purpose-restricted capture (Theme F)", () => {
  async function setupApproved(
    authId: string,
    allowedPurposes: string[] | undefined
  ): Promise<{
    env: Env;
    whitelistId: string;
  }> {
    const env = makeEnv();
    const { whitelist_id } = await registerAuthWhitelist(
      {
        payee_bank_id: PAYEE_BANK,
        payee_account_hash: PAYEE_ACCOUNT,
        allowed_payer_bank_id: PAYER_BANK,
        max_amount: 1_000_000,
        allowed_purposes: allowedPurposes as any,
      },
      d1 as unknown as D1Database
    );

    await createAuthRequest(
      {
        auth_id: authId,
        payee_bank_id: PAYEE_BANK,
        payee_account_hash: PAYEE_ACCOUNT,
        payer_bank_id: PAYER_BANK,
        payer_account_hash: PAYER_ACCOUNT,
        amount: { value: 50_000, currency: "JPY" },
        purpose: "MERCHANT",
        auth_expires_at: "2099-12-31T12:00:00Z",
        capture_expires_at: "2099-12-31T18:00:00Z",
        idempotency_key: `IK-AUTH-${authId}`,
      },
      env
    );

    const approved = await approveAuthRequest(
      authId,
      { idempotency_key: `IK-APPROVE-${authId}` },
      env
    );
    expect(approved.result).toBe("APPROVED");

    return { env, whitelist_id };
  }

  it("captures normally and logs PurposeRestrictedCapture(OK) when purpose remains allowed", async () => {
    const authId = "AUTH-PURPOSE-OK";
    const { env } = await setupApproved(authId, ["MERCHANT", "BILL"]);

    const result = await captureHtlcAuth(
      `HAUTH-${authId}`,
      { idempotency_key: `IK-CAPTURE-${authId}` },
      env
    );
    expect(result.result).toBe("CAPTURED");

    const events = await d1
      .prepare(`SELECT payload_json FROM FinalityLog WHERE event_type='PurposeRestrictedCapture'`)
      .all<{ payload_json: string }>();
    expect(events.results).toHaveLength(1);
    const payload = JSON.parse(events.results[0].payload_json);
    expect(payload.purpose).toBe("MERCHANT");
    expect(payload.result).toBe("OK");
  });

  it("rejects with PURPOSE_VIOLATION and logs PurposeRestrictedCapture(REJECTED) when the whitelist no longer allows the request's purpose", async () => {
    const authId = "AUTH-PURPOSE-VIOLATION";
    const { env, whitelist_id } = await setupApproved(authId, ["MERCHANT"]);

    // Simulate the whitelist being tightened after the auth request was
    // accepted (capture-time enforcement is the last line of defense).
    d1.prepare(`UPDATE HtlcAuthWhitelist SET allowed_purposes=? WHERE whitelist_id=?`)
      .bind(JSON.stringify(["BILL"]), whitelist_id)
      ._runSync();

    const result = await captureHtlcAuth(
      `HAUTH-${authId}`,
      { idempotency_key: `IK-CAPTURE-${authId}` },
      env
    );
    expect(result.result).toBe("ERROR");
    expect(result.reason_code).toBe("PURPOSE_VIOLATION");

    const events = await d1
      .prepare(`SELECT payload_json FROM FinalityLog WHERE event_type='PurposeRestrictedCapture'`)
      .all<{ payload_json: string }>();
    expect(events.results).toHaveLength(1);
    const payload = JSON.parse(events.results[0].payload_json);
    expect(payload.purpose).toBe("MERCHANT");
    expect(payload.allowed_purposes).toEqual(["BILL"]);
    expect(payload.result).toBe("REJECTED");

    // HtlcAuthRequests/HtlcContracts unchanged — still AUTH_APPROVED / HTLC_LOCKED.
    const authRow = await d1
      .prepare(`SELECT status FROM HtlcAuthRequests WHERE auth_id=?`)
      .bind(authId)
      .first<{ status: string }>();
    expect(authRow?.status).toBe("AUTH_APPROVED");
  });

  it("does not write PurposeRestrictedCapture when the whitelist has no purpose restriction", async () => {
    const authId = "AUTH-PURPOSE-NONE";
    const { env } = await setupApproved(authId, undefined);

    const result = await captureHtlcAuth(
      `HAUTH-${authId}`,
      { idempotency_key: `IK-CAPTURE-${authId}` },
      env
    );
    expect(result.result).toBe("CAPTURED");

    const events = await d1
      .prepare(`SELECT payload_json FROM FinalityLog WHERE event_type='PurposeRestrictedCapture'`)
      .all<{ payload_json: string }>();
    expect(events.results).toHaveLength(0);
  });
});
