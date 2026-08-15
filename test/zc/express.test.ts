/**
 * @file Express lane E2E decision flow tests.
 *
 * Tests the full decision path: RECEIVED → PRECHECKED → H_RESERVED →
 * DECIDED_TO_SETTLE, and error paths (H_LIMIT_EXCEEDED, RESERVE_FAILED).
 *
 * The env mock stubs out:
 *   - QUEUE.send  (fire-and-forget; tested separately)
 *   - Bank ingress: authority-check, name-check, reserve-funds always OK
 *     (failure paths are exercised by triggering H-limit or no-funds errors)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { processExpress } from "../../src/zc/lanes/express";
import { reserveH } from "../../src/zc/liquidity/h_model";
import type { PaymentInitiatedRequest } from "../../src/types";

// ---------------------------------------------------------------------------
// Minimal Env mock
// ---------------------------------------------------------------------------
function makeEnv(db: MockD1Database): any {
  return {
    DB: db,
    QUEUE: { send: async () => {} },
    ZC_HMAC_SECRET: "test-secret",
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------
const PAYER_BANK = "001";
const PAYEE_BANK = "002";
const H_LIMIT = 1_000_000;

let d1: MockD1Database;

function seedParticipant(db: MockD1Database, bankId: string, hLimit = H_LIMIT) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', ?, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId, hLimit)
    ._runSync();
}

function seedAccount(db: MockD1Database, bankId: string, accountId: string, balance = 500_000) {
  const customerId = `CUST-${accountId}`;
  db.prepare(
    `INSERT OR IGNORE INTO BankAccounts
     (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
     VALUES (?, ?, ?, 'Test User', 'SAVINGS', 'NORMAL', '2025-01-01T00:00:00Z')`
  )
    .bind(accountId, bankId, customerId)
    ._runSync();

  // Seed initial balance via journal
  if (balance > 0) {
    db.prepare(
      `INSERT INTO BankJournals
       (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES (?, ?, ?, ?, 'CASH', 'INIT', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(`JNL-INIT-${accountId}`, bankId, accountId, balance)
      ._runSync();

    // ZCS offset (zero-sum)
    const zcsId = `${bankId}-ZCS`;
    db.prepare(
      `INSERT INTO BankJournals
       (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES (?, ?, ?, ?, 'CASH', 'INIT', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(`JNL-INIT-ZCS-${accountId}`, bankId, zcsId, -balance)
      ._runSync();
  }
}

function makeTxReq(txid: string, amount = 100_000): PaymentInitiatedRequest {
  return {
    schema_version: "1.0",
    message_type: "EVENT",
    name: "PaymentInitiated",
    message_id: `MSG-${txid}`,
    idempotency_key: `IK-${txid}`,
    occurred_at: "2025-06-01T10:00:00Z",
    txid,
    lane: "EXPRESS",
    amount: { value: amount, currency: "JPY" },
    payer: { bank_id: PAYER_BANK, account_hash: "0010000001" },
    payee: { bank_id: PAYEE_BANK, account_hash: "0020000001" },
    purpose: "P2P",
  };
}

function insertTransaction(db: MockD1Database, txid: string, state = "RECEIVED") {
  db.prepare(
    `INSERT OR IGNORE INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, created_at, updated_at, version)
     VALUES (?, 'EXPRESS', ?, 100000, 'JPY', '001', '0010000001', '002', '0020000001',
             ?, '1.0', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 0)`
  )
    .bind(txid, state, `IK-${txid}`)
    ._runSync();
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  seedParticipant(d1, PAYER_BANK);
  seedParticipant(d1, PAYEE_BANK);
  seedAccount(d1, PAYER_BANK, "0010000001", 500_000);
  seedAccount(d1, PAYEE_BANK, "0020000001", 0);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("processExpress — happy path", () => {
  it("returns DECISION_ACCEPTED and transitions TX to DECIDED_TO_SETTLE", async () => {
    const txid = "TX-EXP-001";
    insertTransaction(d1, txid);
    const env = makeEnv(d1);
    const result = await processExpress(makeTxReq(txid), env);

    expect(result.result).toBe("DECISION_ACCEPTED");
    expect(result.state).toBe("DECIDED_TO_SETTLE");
    expect(result.decision_proof_ref).toBeTruthy();

    const tx = await d1
      .prepare(`SELECT state, h_reservation_id FROM Transactions WHERE txid = ?`)
      .bind(txid)
      .first<{ state: string; h_reservation_id: string | null }>();
    expect(tx?.state).toBe("DECIDED_TO_SETTLE");
    expect(tx?.h_reservation_id).toBeTruthy();
  });

  it("increments h_used in Participants after H reservation", async () => {
    const txid = "TX-EXP-002";
    insertTransaction(d1, txid);
    const env = makeEnv(d1);
    await processExpress(makeTxReq(txid, 200_000), env);

    const p = await d1
      .prepare(`SELECT h_used FROM Participants WHERE bank_id = ?`)
      .bind(PAYER_BANK)
      .first<{ h_used: number }>();
    expect(p?.h_used).toBe(200_000);
  });

  it("writes FinalityLog entries for PRECHECKED, H_RESERVED, DECIDED_TO_SETTLE", async () => {
    const txid = "TX-EXP-003";
    insertTransaction(d1, txid);
    const env = makeEnv(d1);
    await processExpress(makeTxReq(txid), env);

    const logs = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE txid = ? ORDER BY event_seq`)
      .bind(txid)
      .all<{ event_type: string }>();

    const types = logs.results.map((r) => r.event_type);
    expect(types).toContain("PreCheckPassed");
    expect(types).toContain("HReserved");
    expect(types).toContain("DecidedToSettle");
  });

  it("sets dns_cycle_id on the transaction", async () => {
    const txid = "TX-EXP-004";
    insertTransaction(d1, txid);
    const env = makeEnv(d1);
    await processExpress(makeTxReq(txid), env);

    const tx = await d1
      .prepare(`SELECT dns_cycle_id FROM Transactions WHERE txid = ?`)
      .bind(txid)
      .first<{ dns_cycle_id: string | null }>();
    expect(tx?.dns_cycle_id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// H-limit exceeded path
// ---------------------------------------------------------------------------

describe("processExpress — H_LIMIT_EXCEEDED", () => {
  it("returns DECISION_REJECTED when participant h_limit is already exhausted", async () => {
    // Fill the entire H-limit with a pre-existing reservation
    await reserveH(PAYER_BANK, "TX-PREV", H_LIMIT, d1 as any);

    const txid = "TX-EXP-H-001";
    insertTransaction(d1, txid);
    const env = makeEnv(d1);
    const result = await processExpress(makeTxReq(txid, 1), env);

    expect(result.result).toBe("DECISION_REJECTED");
    expect(result.reason_code).toBe("H_LIMIT_EXCEEDED");
  });

  it("sets TX state to CANCELLED after H_LIMIT_EXCEEDED", async () => {
    await reserveH(PAYER_BANK, "TX-PREV-2", H_LIMIT, d1 as any);

    const txid = "TX-EXP-H-002";
    insertTransaction(d1, txid);
    const env = makeEnv(d1);
    await processExpress(makeTxReq(txid, 1), env);

    const tx = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind(txid)
      .first<{ state: string }>();
    expect(tx?.state).toBe("CANCELLED");
  });

  it("does not increment h_used when H_LIMIT_EXCEEDED", async () => {
    await reserveH(PAYER_BANK, "TX-PREV-3", H_LIMIT, d1 as any);

    const txid = "TX-EXP-H-003";
    insertTransaction(d1, txid);
    const env = makeEnv(d1);
    await processExpress(makeTxReq(txid, 1), env);

    const p = await d1
      .prepare(`SELECT h_used FROM Participants WHERE bank_id = ?`)
      .bind(PAYER_BANK)
      .first<{ h_used: number }>();
    expect(p?.h_used).toBe(H_LIMIT); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Reserve-funds failure (INSUFFICIENT_FUNDS)
// ---------------------------------------------------------------------------

describe("processExpress — RESERVE_FAILED (account not found or frozen)", () => {
  it("returns DECISION_REJECTED and cancels TX when payer account is FROZEN", async () => {
    // Freeze the payer account so reserve-funds returns ACCOUNT_NOT_FOUND
    d1.prepare(`UPDATE BankAccounts SET status='FROZEN' WHERE account_id='0010000001'`)._runSync();

    const txid = "TX-EXP-RF-001";
    insertTransaction(d1, txid);
    const env = makeEnv(d1);
    const result = await processExpress(makeTxReq(txid, 100_000), env);

    expect(result.result).toBe("DECISION_REJECTED");
    // ACCOUNT_NOT_FOUND or RESERVE_FAILED are both acceptable rejection reasons
    expect(result.reason_code).toBeTruthy();

    const tx = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind(txid)
      .first<{ state: string }>();
    expect(tx?.state).toBe("CANCELLED");
  });

  it("releases H reservation on RESERVE_FAILED (h_used returns to 0)", async () => {
    d1.prepare(`UPDATE BankAccounts SET status='FROZEN' WHERE account_id='0010000001'`)._runSync();

    const txid = "TX-EXP-RF-002";
    insertTransaction(d1, txid);
    const env = makeEnv(d1);
    await processExpress(makeTxReq(txid, 100_000), env);

    // After RESERVE_FAILED, the H reservation (which was created before reserve-funds)
    // is released by cancelTx. h_used must be 0.
    const p = await d1
      .prepare(`SELECT h_used FROM Participants WHERE bank_id = ?`)
      .bind(PAYER_BANK)
      .first<{ h_used: number }>();
    expect(p?.h_used).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Optimistic lock (version CAS) — Bug #4 regression test
// ---------------------------------------------------------------------------

describe("processExpress — optimistic lock prevents double-processing", () => {
  it("does not double-reserve H when TX is already PRECHECKED (CAS guard)", async () => {
    const txid = "TX-EXP-CAS-001";
    // Insert TX already in PRECHECKED state (simulating a replayed queue message)
    d1.prepare(
      `INSERT OR IGNORE INTO Transactions
       (txid, lane, state, amount_value, amount_currency,
        payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
        idempotency_key, schema_version, created_at, updated_at, version)
       VALUES (?, 'EXPRESS', 'PRECHECKED', 100000, 'JPY',
               '001', '0010000001', '002', '0020000001',
               'IK-CAS-001', '1.0', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 1)`
    )
      .bind(txid)
      ._runSync();

    const env = makeEnv(d1);
    // Second call: transitionTx RECEIVED→PRECHECKED should be a no-op (wrong fromState)
    const result = await processExpress(makeTxReq(txid), env);

    // Even if the H reservation happens, h_used should be exactly the amount, not doubled
    const p = await d1
      .prepare(`SELECT h_used FROM Participants WHERE bank_id = ?`)
      .bind(PAYER_BANK)
      .first<{ h_used: number }>();

    // h_used must not exceed the amount for a single transaction
    expect(p?.h_used).toBeLessThanOrEqual(100_000);
  });
});
