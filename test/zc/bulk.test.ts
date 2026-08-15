/**
 * @file BULK lane decision flow tests.
 *
 * Exercises advanceBulk: RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE
 * plus the two cancel branches (H_LIMIT_EXCEEDED, RESERVE_FAILED). Covers the
 * Phase 1 helpers refactor (transitionWithLog / cancelInFlightTx) so that the
 * lane is no longer untested.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { advanceBulk } from "../../src/zc/lanes/bulk";

const PAYER_BANK = "001";
const PAYEE_BANK = "002";
const H_LIMIT = 1_000_000;

let d1: MockD1Database;

function makeEnv(db: MockD1Database): any {
  return {
    DB: db,
    QUEUE: { send: async () => {} },
    ZC_HMAC_SECRET: "test-secret",
  };
}

function seedParticipant(db: MockD1Database, bankId: string, hLimit = H_LIMIT, hUsed = 0) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', ?, ?, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId, hLimit, hUsed)
    ._runSync();
}

function seedAccount(
  db: MockD1Database,
  bankId: string,
  accountId: string,
  balance = 500_000,
  status = "NORMAL"
) {
  const customerId = `CUST-${accountId}`;
  db.prepare(
    `INSERT OR IGNORE INTO BankAccounts
     (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
     VALUES (?, ?, ?, 'Test User', 'SAVINGS', ?, '2025-01-01T00:00:00Z')`
  )
    .bind(accountId, bankId, customerId, status)
    ._runSync();

  if (balance > 0) {
    db.prepare(
      `INSERT INTO BankJournals
       (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES (?, ?, ?, ?, 'CASH', 'INIT', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(`JNL-INIT-${accountId}`, bankId, accountId, balance)
      ._runSync();

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

function insertBulkTx(db: MockD1Database, txid: string, amount = 100_000, state = "RECEIVED") {
  db.prepare(
    `INSERT OR IGNORE INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, created_at, updated_at, version)
     VALUES (?, 'BULK', ?, ?, 'JPY', ?, '0010000001', ?, '0020000001',
             ?, '1.0', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 0)`
  )
    .bind(txid, state, amount, PAYER_BANK, PAYEE_BANK, `IK-${txid}`)
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

describe("advanceBulk — happy path", () => {
  it("transitions RECEIVED → DECIDED_TO_SETTLE and stamps decision proofs", async () => {
    const txid = "TX-BULK-001";
    insertBulkTx(d1, txid);
    await advanceBulk(txid, makeEnv(d1));

    const tx = await d1
      .prepare(
        `SELECT state, h_reservation_id, decision_proof_ref, finality_log_ref
         FROM Transactions WHERE txid = ?`
      )
      .bind(txid)
      .first<{
        state: string;
        h_reservation_id: string | null;
        decision_proof_ref: string | null;
        finality_log_ref: string | null;
      }>();

    expect(tx?.state).toBe("DECIDED_TO_SETTLE");
    expect(tx?.h_reservation_id).toBeTruthy();
    expect(tx?.decision_proof_ref).toBeTruthy();
    expect(tx?.finality_log_ref).toBeTruthy();
  });

  it("writes FinalityLog entries for PreCheckPassed, HReserved, DecidedToSettle", async () => {
    const txid = "TX-BULK-002";
    insertBulkTx(d1, txid);
    await advanceBulk(txid, makeEnv(d1));

    const logs = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE txid = ? ORDER BY event_seq`)
      .bind(txid)
      .all<{ event_type: string }>();
    const types = logs.results.map((r) => r.event_type);
    expect(types).toContain("PreCheckPassed");
    expect(types).toContain("HReserved");
    expect(types).toContain("DecidedToSettle");
  });

  it("locks the H reservation (H_RESERVED → LOCKED) at decision", async () => {
    const txid = "TX-BULK-003";
    insertBulkTx(d1, txid, 250_000);
    await advanceBulk(txid, makeEnv(d1));

    const reservation = await d1
      .prepare(`SELECT mode, amount FROM HReservations WHERE txid = ?`)
      .bind(txid)
      .first<{ mode: string; amount: number }>();
    expect(reservation?.mode).toBe("LOCKED");
    expect(reservation?.amount).toBe(250_000);

    const p = await d1
      .prepare(`SELECT h_used FROM Participants WHERE bank_id = ?`)
      .bind(PAYER_BANK)
      .first<{ h_used: number }>();
    expect(p?.h_used).toBe(250_000);
  });

  it("does NOT set dns_cycle_id (kickDns is the sole assigner)", async () => {
    const txid = "TX-BULK-004";
    insertBulkTx(d1, txid);
    await advanceBulk(txid, makeEnv(d1));

    const tx = await d1
      .prepare(`SELECT dns_cycle_id FROM Transactions WHERE txid = ?`)
      .bind(txid)
      .first<{ dns_cycle_id: string | null }>();
    expect(tx?.dns_cycle_id).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Idempotency / state guard
// ---------------------------------------------------------------------------

describe("advanceBulk — state guard", () => {
  it("is a no-op when TX is not in RECEIVED state", async () => {
    const txid = "TX-BULK-NOOP";
    insertBulkTx(d1, txid, 100_000, "DECIDED_TO_SETTLE");
    await advanceBulk(txid, makeEnv(d1));

    const logs = await d1
      .prepare(`SELECT COUNT(*) AS n FROM FinalityLog WHERE txid = ?`)
      .bind(txid)
      .first<{ n: number }>();
    expect(logs?.n).toBe(0);
  });

  it("returns silently when the TX does not exist", async () => {
    await expect(advanceBulk("TX-BULK-MISSING", makeEnv(d1))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error path: H_LIMIT_EXCEEDED
// ---------------------------------------------------------------------------

describe("advanceBulk — H_LIMIT_EXCEEDED", () => {
  it("cancels with H_LIMIT_EXCEEDED when participant h_used is already at the cap", async () => {
    seedParticipant(d1, PAYER_BANK, 100_000, 100_000); // exhausted
    const txid = "TX-BULK-HLE-001";
    insertBulkTx(d1, txid, 50_000);
    await advanceBulk(txid, makeEnv(d1));

    const tx = await d1
      .prepare(`SELECT state, reason_code FROM Transactions WHERE txid = ?`)
      .bind(txid)
      .first<{ state: string; reason_code: string | null }>();
    expect(tx?.state).toBe("CANCELLED");
    expect(tx?.reason_code).toBe("H_LIMIT_EXCEEDED");
  });

  it("does not increment h_used when H_LIMIT_EXCEEDED", async () => {
    seedParticipant(d1, PAYER_BANK, 100_000, 100_000);
    const txid = "TX-BULK-HLE-002";
    insertBulkTx(d1, txid, 50_000);
    await advanceBulk(txid, makeEnv(d1));

    const p = await d1
      .prepare(`SELECT h_used FROM Participants WHERE bank_id = ?`)
      .bind(PAYER_BANK)
      .first<{ h_used: number }>();
    expect(p?.h_used).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// Error path: RESERVE_FAILED (frozen account triggers bank rejection)
// ---------------------------------------------------------------------------

describe("advanceBulk — RESERVE_FAILED", () => {
  it("cancels and releases H when payer account is FROZEN", async () => {
    d1.prepare(`UPDATE BankAccounts SET status = 'FROZEN' WHERE account_id = ?`)
      .bind("0010000001")
      ._runSync();
    const txid = "TX-BULK-RF-001";
    insertBulkTx(d1, txid, 50_000);
    await advanceBulk(txid, makeEnv(d1));

    const tx = await d1
      .prepare(`SELECT state, reason_code FROM Transactions WHERE txid = ?`)
      .bind(txid)
      .first<{ state: string; reason_code: string | null }>();
    expect(tx?.state).toBe("CANCELLED");
    expect(tx?.reason_code).toBeTruthy();

    const p = await d1
      .prepare(`SELECT h_used FROM Participants WHERE bank_id = ?`)
      .bind(PAYER_BANK)
      .first<{ h_used: number }>();
    expect(p?.h_used).toBe(0);
  });
});
