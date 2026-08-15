/**
 * @file HTLC_AUTH regression tests.
 *
 * B5 regression: approveAuthRequest stored preimage in Vault with
 * data_type='AML_EVAL' (wrong). The correct value is 'HTLC_PREIMAGE'.
 * captureHtlcAuth later fetches the preimage by data_type filter; using the
 * wrong type would cause captures to fail silently (preimage not found).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  registerAuthWhitelist,
  createAuthRequest,
  approveAuthRequest,
} from "../../src/zc/lanes/htlc_auth";
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

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  seedParticipant(PAYER_BANK);
  seedParticipant(PAYEE_BANK);
  // Payer needs account + balance for reserve-funds
  seedAccount(PAYER_BANK, PAYER_ACCOUNT, 2_000_000);
  seedAccount(PAYEE_BANK, PAYEE_ACCOUNT);
  seedAccount(PAYER_BANK, `${PAYER_BANK}-ZCS`);
  seedAccount(PAYEE_BANK, `${PAYEE_BANK}-ZCS`);
  seedAccount(PAYER_BANK, `${PAYER_BANK}0000000`); // suspense account
});

// ---------------------------------------------------------------------------
// B5: Vault data_type must be 'HTLC_PREIMAGE', not 'AML_EVAL'
// ---------------------------------------------------------------------------

describe("approveAuthRequest — Vault data_type is HTLC_PREIMAGE (B5 regression)", () => {
  it("stores the preimage in Vault with data_type=HTLC_PREIMAGE", async () => {
    const env = makeEnv();
    const authId = "AUTH-B5-001";

    // Register whitelist entry
    await registerAuthWhitelist(
      {
        payee_bank_id: PAYEE_BANK,
        payee_account_hash: PAYEE_ACCOUNT,
        allowed_payer_bank_id: PAYER_BANK,
        max_amount: 1_000_000,
      },
      d1 as unknown as D1Database
    );

    // Create auth request (payee-initiated)
    const authResult = await createAuthRequest(
      {
        auth_id: authId,
        payee_bank_id: PAYEE_BANK,
        payee_account_hash: PAYEE_ACCOUNT,
        payer_bank_id: PAYER_BANK,
        payer_account_hash: PAYER_ACCOUNT,
        amount: { value: 50_000, currency: "JPY" },
        auth_expires_at: "2099-12-31T12:00:00Z",
        capture_expires_at: "2099-12-31T18:00:00Z",
        idempotency_key: "IK-AUTH-B5-001",
      },
      env
    );
    expect(authResult.result).toBe("AUTH_REQUESTED");

    // Approve (payer-side): this creates the preimage and stores it in Vault
    const approveResult = await approveAuthRequest(
      authId,
      { idempotency_key: "IK-APPROVE-B5-001" },
      env
    );
    expect(approveResult.result).toBe("APPROVED");

    // Verify that the Vault entry uses data_type='HTLC_PREIMAGE' (not 'AML_EVAL')
    const vaultRow = await d1
      .prepare(`SELECT data_type FROM Vault WHERE vault_ref LIKE 'VLT-AUTH-%'`)
      .first<{ data_type: string }>();

    expect(vaultRow).not.toBeNull();
    expect(vaultRow?.data_type).toBe("HTLC_PREIMAGE");
    expect(vaultRow?.data_type).not.toBe("AML_EVAL");
  });
});
