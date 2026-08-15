/**
 * @file HTLC lane cancel TOCTOU regression tests.
 *
 * Verifies Bug #1 fix: H reservation must NOT be released if the state guard
 * UPDATE returns 0 changes (the contract is already in DECIDED_TO_SETTLE or
 * SETTLED).
 *
 * Also covers:
 * - Normal cancel path (HTLC_RECEIVED → DECIDED_CANCEL → CANCELLED)
 * - cancelHtlc idempotency
 * - lockHtlc: HTLC_RECEIVED → HTLC_LOCKED with H reservation
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { lockHtlc, cancelHtlc } from "../../src/zc/lanes/htlc";
import { reserveH, getHStatus } from "../../src/zc/liquidity/h_model";

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
// Test setup helpers
// ---------------------------------------------------------------------------

let d1: MockD1Database;
const PAYER_BANK = "001";
const PAYEE_BANK = "002";
const H_LIMIT = 1_000_000;

function seedParticipant(db: MockD1Database, bankId: string) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', ?, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId, H_LIMIT)
    ._runSync();
}

function seedAccount(db: MockD1Database, bankId: string, accountId: string, balance = 500_000) {
  db.prepare(
    `INSERT OR IGNORE INTO BankAccounts
     (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
     VALUES (?, ?, 'CUST-TEST', 'Test User', 'SAVINGS', 'NORMAL', '2025-01-01T00:00:00Z')`
  )
    .bind(accountId, bankId)
    ._runSync();

  if (balance > 0) {
    db.prepare(
      `INSERT INTO BankJournals
       (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES (?, ?, ?, ?, 'CASH', 'INIT', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(`JNL-INIT-${accountId}`, bankId, accountId, balance)
      ._runSync();
    db.prepare(
      `INSERT INTO BankJournals
       (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES (?, ?, ?, ?, 'CASH', 'INIT', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(`JNL-INIT-ZCS-${accountId}`, bankId, `${bankId}-ZCS`, -balance)
      ._runSync();
  }
}

function insertHtlcReceived(
  db: MockD1Database,
  htlcId: string,
  amount = 100_000,
  timelockISO = "2099-12-31T00:00:00Z"
) {
  const txid = `TX-HTLC-${htlcId}`;
  const hashlock = "a".repeat(64); // mock hashlock

  db.prepare(
    `INSERT OR IGNORE INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, created_at, updated_at, version)
     VALUES (?, 'HTLC', 'RECEIVED', ?, 'JPY', ?, '0010000001', ?, '0020000001',
             ?, '1.0', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 0)`
  )
    .bind(txid, amount, PAYER_BANK, PAYEE_BANK, `IK-${htlcId}`)
    ._runSync();

  db.prepare(
    `INSERT OR IGNORE INTO HtlcContracts
     (htlc_id, txid, state, hashlock, timelock, amount_value,
      payer_bank_id, payee_bank_id, secret_verified, authority_recheck_required,
      version, created_at, updated_at)
     VALUES (?, ?, 'HTLC_RECEIVED', ?, ?, ?, ?, ?, 0, 0, 0,
             '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`
  )
    .bind(htlcId, txid, hashlock, timelockISO, amount, PAYER_BANK, PAYEE_BANK)
    ._runSync();

  return txid;
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
// lockHtlc: HTLC_RECEIVED → HTLC_LOCKED
// ---------------------------------------------------------------------------

describe("lockHtlc", () => {
  it("transitions HtlcContracts and Transactions to HTLC_LOCKED", async () => {
    const htlcId = "HTLC-LOCK-001";
    insertHtlcReceived(d1, htlcId);
    const env = makeEnv(d1);
    await lockHtlc(htlcId, env);

    const htlc = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ state: string }>();
    expect(htlc?.state).toBe("HTLC_LOCKED");

    const tx = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind(`TX-HTLC-${htlcId}`)
      .first<{ state: string }>();
    expect(tx?.state).toBe("HTLC_LOCKED");
  });

  it("creates an H reservation when locking", async () => {
    const htlcId = "HTLC-LOCK-002";
    insertHtlcReceived(d1, htlcId, 150_000);
    const env = makeEnv(d1);
    await lockHtlc(htlcId, env);

    const status = await getHStatus(PAYER_BANK, d1 as any);
    expect(status?.h_used).toBe(150_000);
  });

  it("cancels with TIMELOCK_EXPIRED when timelock is in the past", async () => {
    const htlcId = "HTLC-LOCK-EXP";
    insertHtlcReceived(d1, htlcId, 100_000, "2000-01-01T00:00:00Z"); // past timelock
    const env = makeEnv(d1);
    await lockHtlc(htlcId, env);

    const htlc = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ state: string }>();
    expect(htlc?.state).toBe("DECIDED_CANCEL");
  });

  it("cancels with H_LIMIT_EXCEEDED when h_limit is exhausted", async () => {
    // Exhaust the H-limit with a pre-existing reservation
    await reserveH(PAYER_BANK, "TX-PRE", H_LIMIT, d1 as any);

    const htlcId = "HTLC-LOCK-HL";
    insertHtlcReceived(d1, htlcId, 1);
    const env = makeEnv(d1);
    await lockHtlc(htlcId, env);

    const htlc = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ state: string }>();
    expect(htlc?.state).toBe("DECIDED_CANCEL");
  });
});

// ---------------------------------------------------------------------------
// cancelHtlc: TOCTOU regression (Bug #1)
// ---------------------------------------------------------------------------

describe("cancelHtlc — TOCTOU regression (Bug #1)", () => {
  it("releases H when cancelling an HTLC_RECEIVED contract", async () => {
    const htlcId = "HTLC-CANCEL-001";
    const txid = insertHtlcReceived(d1, htlcId);

    // Manually reserve H (simulating what lockHtlc would do)
    const hResult = await reserveH(PAYER_BANK, txid, 100_000, d1 as any);
    expect(hResult.ok).toBe(true);
    const rid = hResult.ok ? hResult.reservation_id : "";

    // Set h_reservation_id on the TX
    d1.prepare(`UPDATE Transactions SET h_reservation_id = ? WHERE txid = ?`)
      .bind(rid, txid)
      ._runSync();

    await cancelHtlc(htlcId, txid, "MANUAL_CANCEL", d1 as any);

    // H should be released
    const status = await getHStatus(PAYER_BANK, d1 as any);
    expect(status?.h_used).toBe(0);
  });

  it("does NOT release H when the HTLC is already DECIDED_TO_SETTLE (state guard)", async () => {
    const htlcId = "HTLC-CANCEL-TOCTOU";
    const txid = insertHtlcReceived(d1, htlcId);

    // Reserve H
    const hResult = await reserveH(PAYER_BANK, txid, 100_000, d1 as any);
    const rid = hResult.ok ? hResult.reservation_id : "";
    d1.prepare(`UPDATE Transactions SET h_reservation_id = ? WHERE txid = ?`)
      .bind(rid, txid)
      ._runSync();
    // Lock H (simulating DECIDED_TO_SETTLE flow)
    d1.prepare(`UPDATE HReservations SET mode = 'LOCKED' WHERE reservation_id = ?`)
      .bind(rid)
      ._runSync();

    // Advance to DECIDED_TO_SETTLE (simulating concurrent settlement)
    d1.prepare(
      `UPDATE HtlcContracts SET state = 'DECIDED_TO_SETTLE', version = version + 1 WHERE htlc_id = ?`
    )
      .bind(htlcId)
      ._runSync();
    d1.prepare(
      `UPDATE Transactions SET state = 'DECIDED_TO_SETTLE', version = version + 1 WHERE txid = ?`
    )
      .bind(txid)
      ._runSync();

    // Now attempt to cancel — the state guard should prevent this
    await cancelHtlc(htlcId, txid, "TIMELOCK_EXPIRED", d1 as any);

    // H must NOT have been released (h_used stays 100_000)
    const status = await getHStatus(PAYER_BANK, d1 as any);
    expect(status?.h_used).toBe(100_000);

    // Contract state must remain DECIDED_TO_SETTLE
    const htlc = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ state: string }>();
    expect(htlc?.state).toBe("DECIDED_TO_SETTLE");
  });

  it("is idempotent: cancelling twice does not double-release H", async () => {
    const htlcId = "HTLC-CANCEL-IDEM";
    const txid = insertHtlcReceived(d1, htlcId);

    const hResult = await reserveH(PAYER_BANK, txid, 100_000, d1 as any);
    const rid = hResult.ok ? hResult.reservation_id : "";
    d1.prepare(`UPDATE Transactions SET h_reservation_id = ? WHERE txid = ?`)
      .bind(rid, txid)
      ._runSync();

    await cancelHtlc(htlcId, txid, "MANUAL_CANCEL", d1 as any);
    const statusAfterFirst = await getHStatus(PAYER_BANK, d1 as any);
    expect(statusAfterFirst?.h_used).toBe(0);

    // Second cancel — must be a no-op (already CANCELLED)
    await cancelHtlc(htlcId, txid, "MANUAL_CANCEL", d1 as any);
    const statusAfterSecond = await getHStatus(PAYER_BANK, d1 as any);
    // h_used must never go below 0
    expect(statusAfterSecond?.h_used).toBeGreaterThanOrEqual(0);
  });

  it("transitions HTLC contract to DECIDED_CANCEL and writes FinalityLog", async () => {
    const htlcId = "HTLC-CANCEL-LOG";
    const txid = insertHtlcReceived(d1, htlcId);

    await cancelHtlc(htlcId, txid, "TIMELOCK_EXPIRED", d1 as any);

    const htlc = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ state: string }>();
    expect(htlc?.state).toBe("DECIDED_CANCEL");

    const log = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE txid = ? AND event_type = 'HtlcCancelled'`)
      .bind(txid)
      .first<{ event_type: string }>();
    expect(log).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cancelHtlc — bank SuspenseDetails released via actual suspense_id (B6 regression)
// ---------------------------------------------------------------------------

describe("cancelHtlc — bank suspense released with correct suspense_id (B6)", () => {
  it("sets SuspenseDetails status to RETURNED when cancelling an HTLC_LOCKED contract", async () => {
    const htlcId = "HTLC-SUSP-B6-001";
    insertHtlcReceived(d1, htlcId, 100_000);
    const env = makeEnv(d1);

    // Lock: creates H reservation + bank SuspenseDetails (status=RESERVED)
    await lockHtlc(htlcId, env);

    const txid = `TX-HTLC-${htlcId}`;
    const suspenseBefore = await d1
      .prepare(`SELECT status FROM SuspenseDetails WHERE txid=? AND bank_id=? AND direction='PAY'`)
      .bind(txid, PAYER_BANK)
      .first<{ status: string }>();
    expect(suspenseBefore?.status).toBe("RESERVED");

    // Cancel with env so bank release-reserve is called
    await cancelHtlc(htlcId, txid, "TIMELOCK_EXPIRED", d1 as any, env);

    // Bank suspense must be RETURNED, not left as RESERVED
    const suspenseAfter = await d1
      .prepare(`SELECT status FROM SuspenseDetails WHERE txid=? AND bank_id=? AND direction='PAY'`)
      .bind(txid, PAYER_BANK)
      .first<{ status: string }>();
    expect(suspenseAfter?.status).toBe("RETURNED");
  });

  it("H reservation is also released when cancelling HTLC_LOCKED", async () => {
    const htlcId = "HTLC-SUSP-B6-002";
    insertHtlcReceived(d1, htlcId, 150_000);
    const env = makeEnv(d1);

    await lockHtlc(htlcId, env);
    const txid = `TX-HTLC-${htlcId}`;

    const hBefore = await getHStatus(PAYER_BANK, d1 as any);
    expect(hBefore?.h_used).toBe(150_000);

    await cancelHtlc(htlcId, txid, "TIMELOCK_EXPIRED", d1 as any, env);

    const hAfter = await getHStatus(PAYER_BANK, d1 as any);
    expect(hAfter?.h_used).toBe(0);
  });
});
