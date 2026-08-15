/**
 * @file htlc_auth_canonical.test.ts — Tests that HTLC_AUTH approval enters the
 *       canonical state machine at RECEIVED (with a PaymentInitiated
 *       FinalityLog entry) before advancing to HTLC_LOCKED, rather than
 *       inserting Transactions directly at HTLC_LOCKED.
 *
 * The pre-refactor behavior bypassed `ALLOWED_TRANSITIONS` validation and
 * skipped the PaymentInitiated event. This test pins the new canonical
 * entry so any regression is loud.
 */
import { beforeEach, describe, expect, it } from "vitest";
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
  seedAccount(PAYER_BANK, PAYER_ACCOUNT, 2_000_000);
  seedAccount(PAYEE_BANK, PAYEE_ACCOUNT);
  seedAccount(PAYER_BANK, `${PAYER_BANK}-ZCS`);
  seedAccount(PAYEE_BANK, `${PAYEE_BANK}-ZCS`);
  seedAccount(PAYER_BANK, `${PAYER_BANK}0000000`);
});

describe("HTLC_AUTH approve — canonical state machine entry", () => {
  async function setupAndApprove(authId: string): Promise<void> {
    const env = makeEnv();
    await registerAuthWhitelist(
      {
        payee_bank_id: PAYEE_BANK,
        payee_account_hash: PAYEE_ACCOUNT,
        allowed_payer_bank_id: PAYER_BANK,
        max_amount: 1_000_000,
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
        auth_expires_at: "2099-12-31T12:00:00Z",
        capture_expires_at: "2099-12-31T18:00:00Z",
        idempotency_key: `IK-AUTH-${authId}`,
      },
      env
    );
    const r = await approveAuthRequest(authId, { idempotency_key: `IK-APPROVE-${authId}` }, env);
    expect(r.result).toBe("APPROVED");
  }

  it("writes a PaymentInitiated FinalityLog event before the HtlcAuthApproved transition", async () => {
    await setupAndApprove("AUTH-CAN-001");
    const txid = "TX-HAUTH-AUTH-CAN-001";

    const events = await d1
      .prepare(
        `SELECT event_type, state_from, state_to, event_seq
       FROM FinalityLog WHERE txid = ? ORDER BY event_seq ASC`
      )
      .bind(txid)
      .all<{
        event_type: string;
        state_from: string | null;
        state_to: string;
        event_seq: number;
      }>();

    const types = events.results.map((e) => e.event_type);
    expect(types).toContain("PaymentInitiated");
    expect(types).toContain("HtlcAuthApproved");

    const init = events.results.find((e) => e.event_type === "PaymentInitiated");
    const approved = events.results.find((e) => e.event_type === "HtlcAuthApproved");
    expect(init?.state_from).toBeNull();
    expect(init?.state_to).toBe("RECEIVED");
    expect(approved?.state_from).toBe("RECEIVED");
    expect(approved?.state_to).toBe("HTLC_LOCKED");
    // PaymentInitiated must precede the canonical transition.
    expect(init!.event_seq).toBeLessThan(approved!.event_seq);
  });

  it("Transactions advances RECEIVED → HTLC_LOCKED through ALLOWED_TRANSITIONS", async () => {
    await setupAndApprove("AUTH-CAN-002");
    const txid = "TX-HAUTH-AUTH-CAN-002";
    const tx = await d1
      .prepare(`SELECT state, version FROM Transactions WHERE txid = ?`)
      .bind(txid)
      .first<{ state: string; version: number }>();
    expect(tx?.state).toBe("HTLC_LOCKED");
    // version=1 confirms exactly one canonical transition (RECEIVED → HTLC_LOCKED).
    expect(tx?.version).toBe(1);
  });

  it("refuses to approve again if the row is already past RECEIVED (idempotency safety)", async () => {
    const env = makeEnv();
    await registerAuthWhitelist(
      {
        payee_bank_id: PAYEE_BANK,
        payee_account_hash: PAYEE_ACCOUNT,
        allowed_payer_bank_id: PAYER_BANK,
        max_amount: 1_000_000,
      },
      d1 as unknown as D1Database
    );
    const authId = "AUTH-CAN-003";
    await createAuthRequest(
      {
        auth_id: authId,
        payee_bank_id: PAYEE_BANK,
        payee_account_hash: PAYEE_ACCOUNT,
        payer_bank_id: PAYER_BANK,
        payer_account_hash: PAYER_ACCOUNT,
        amount: { value: 30_000, currency: "JPY" },
        auth_expires_at: "2099-12-31T12:00:00Z",
        capture_expires_at: "2099-12-31T18:00:00Z",
        idempotency_key: `IK-AUTH-${authId}`,
      },
      env
    );
    const first = await approveAuthRequest(
      authId,
      { idempotency_key: `IK-APPROVE-${authId}-A` },
      env
    );
    expect(first.result).toBe("APPROVED");

    // Second approve should fail because HtlcAuthRequests is no longer
    // AUTH_REQUESTED (it's AUTH_APPROVED). Even if a future code path bypassed
    // that guard, the canonical state machine entry would also reject because
    // Transactions is no longer at RECEIVED.
    const second = await approveAuthRequest(
      authId,
      { idempotency_key: `IK-APPROVE-${authId}-B` },
      env
    );
    expect(second.result).toBe("ERROR");
  });
});
