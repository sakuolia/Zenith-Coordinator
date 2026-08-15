/**
 * @file EXPRESS lane integration tests for Theme E (counterparty operating
 * window).
 *
 * When the payee bank's operating window is closed at precheck time,
 * processExpress suspends the transaction (PRECHECKED_SUSPENDED +
 * reason_code='COUNTERPARTY_WINDOW_CLOSED') instead of failing outright, and
 * snapshots the original request to `pending_request_json`. Once the window
 * reopens, `resumeSuspendedExpress` resumes the flow from PRECHECKED through
 * to DECIDED_TO_SETTLE.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { processExpress, resumeSuspendedExpress } from "../../src/zc/lanes/express";
import type { PaymentInitiatedRequest } from "../../src/types";

function makeEnv(db: MockD1Database): any {
  return {
    DB: db,
    QUEUE: { send: async () => {} },
    ZC_HMAC_SECRET: "test-secret",
  };
}

const PAYER_BANK = "001";
const PAYEE_BANK = "002";

let d1: MockD1Database;

function seedParticipant(
  db: MockD1Database,
  bankId: string,
  windowStart: string | null = null,
  windowEnd: string | null = null
) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at,
      operating_window_start, operating_window_end)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 1000000, 0, 1, '2025-01-01T00:00:00Z', ?, ?)`
  )
    .bind(bankId, windowStart, windowEnd)
    ._runSync();
}

function setOperatingWindow(db: MockD1Database, bankId: string, start: string, end: string) {
  db.prepare(
    `UPDATE Participants SET operating_window_start = ?, operating_window_end = ? WHERE bank_id = ?`
  )
    .bind(start, end, bankId)
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

/** Format minutes-since-midnight (UTC) as 'HH:MM'. */
function fmt(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// Operating windows are JST (the system timezone), so build the window around
// `now`'s JST minutes-of-day, not its UTC minutes-of-day.
function jstMin(now: Date): number {
  return (now.getUTCHours() * 60 + now.getUTCMinutes() + 9 * 60) % 1440;
}

/** Returns a 1-hour window that excludes "now". */
function closedWindow(now: Date): { start: string; end: string } {
  const nowMin = jstMin(now);
  return { start: fmt(nowMin + 120), end: fmt(nowMin + 180) };
}

/** Returns a 1-hour window that includes "now". */
function openWindow(now: Date): { start: string; end: string } {
  const nowMin = jstMin(now);
  return { start: fmt(nowMin - 30), end: fmt(nowMin + 30) };
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  seedParticipant(d1, PAYER_BANK);
  seedParticipant(d1, PAYEE_BANK);
  seedAccount(d1, PAYER_BANK, "0010000001", 500_000);
  seedAccount(d1, PAYEE_BANK, "0020000001", 0);
});

describe("processExpress — counterparty operating window (Theme E)", () => {
  it("regression: NULL/NULL window (default) behaves as always-open", async () => {
    const txid = "TX-WIN-001";
    insertTransaction(d1, txid);
    const env = makeEnv(d1);
    const result = await processExpress(makeTxReq(txid), env);

    expect(result.result).toBe("DECISION_ACCEPTED");
    expect(result.state).toBe("DECIDED_TO_SETTLE");
  });

  it("suspends with PRECHECKED_SUSPENDED + COUNTERPARTY_WINDOW_CLOSED when payee bank is closed", async () => {
    const txid = "TX-WIN-002";
    insertTransaction(d1, txid);
    const now = new Date();
    const { start, end } = closedWindow(now);
    setOperatingWindow(d1, PAYEE_BANK, start, end);

    const env = makeEnv(d1);
    const req = makeTxReq(txid);
    const result = await processExpress(req, env);

    expect(result.result).toBe("DECISION_REJECTED");
    expect(result.state).toBe("PRECHECKED_SUSPENDED");
    expect(result.reason_code).toBe("COUNTERPARTY_WINDOW_CLOSED");

    const tx = await d1
      .prepare(`SELECT state, reason_code, pending_request_json FROM Transactions WHERE txid = ?`)
      .bind(txid)
      .first<{ state: string; reason_code: string | null; pending_request_json: string | null }>();
    expect(tx?.state).toBe("PRECHECKED_SUSPENDED");
    expect(tx?.reason_code).toBe("COUNTERPARTY_WINDOW_CLOSED");
    expect(tx?.pending_request_json).toBeTruthy();
    expect(JSON.parse(tx!.pending_request_json!)).toEqual(req);

    const logs = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE txid = ? ORDER BY event_seq`)
      .bind(txid)
      .all<{ event_type: string }>();
    expect(logs.results.map((r) => r.event_type)).toContain("CounterpartyWindowClosed");
  });
});

describe("resumeSuspendedExpress (Theme E)", () => {
  async function suspendOnClosedWindow(txid: string, env: any) {
    insertTransaction(d1, txid);
    const now = new Date();
    const { start, end } = closedWindow(now);
    setOperatingWindow(d1, PAYEE_BANK, start, end);
    const result = await processExpress(makeTxReq(txid), env);
    expect(result.state).toBe("PRECHECKED_SUSPENDED");
  }

  it("resumes through to DECIDED_TO_SETTLE once the payee bank's window reopens", async () => {
    const txid = "TX-WIN-RESUME-001";
    const env = makeEnv(d1);
    await suspendOnClosedWindow(txid, env);

    // Window reopens
    const now = new Date();
    const { start, end } = openWindow(now);
    setOperatingWindow(d1, PAYEE_BANK, start, end);

    const resumed = await resumeSuspendedExpress(txid, env);
    expect(resumed.ok).toBe(true);
    expect(resumed.state).toBe("DECIDED_TO_SETTLE");

    const tx = await d1
      .prepare(
        `SELECT state, reason_code, pending_request_json, h_reservation_id FROM Transactions WHERE txid = ?`
      )
      .bind(txid)
      .first<{
        state: string;
        reason_code: string | null;
        pending_request_json: string | null;
        h_reservation_id: string | null;
      }>();
    expect(tx?.state).toBe("DECIDED_TO_SETTLE");
    expect(tx?.reason_code).toBeNull();
    expect(tx?.pending_request_json).toBeNull();
    expect(tx?.h_reservation_id).toBeTruthy();

    const logs = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE txid = ? ORDER BY event_seq`)
      .bind(txid)
      .all<{ event_type: string }>();
    expect(logs.results.map((r) => r.event_type)).toContain("CounterpartyWindowReopened");
    expect(logs.results.map((r) => r.event_type)).toContain("DecidedToSettle");
  });

  it("returns ok:false with no state change while the payee bank is still closed", async () => {
    const txid = "TX-WIN-RESUME-002";
    const env = makeEnv(d1);
    await suspendOnClosedWindow(txid, env);

    const resumed = await resumeSuspendedExpress(txid, env);
    expect(resumed.ok).toBe(false);
    expect(resumed.state).toBe("PRECHECKED_SUSPENDED");

    const tx = await d1
      .prepare(`SELECT state, reason_code FROM Transactions WHERE txid = ?`)
      .bind(txid)
      .first<{ state: string; reason_code: string | null }>();
    expect(tx?.state).toBe("PRECHECKED_SUSPENDED");
    expect(tx?.reason_code).toBe("COUNTERPARTY_WINDOW_CLOSED");
  });

  it("returns ok:false / NOT_FOUND for an unknown txid", async () => {
    const env = makeEnv(d1);
    const resumed = await resumeSuspendedExpress("TX-DOES-NOT-EXIST", env);
    expect(resumed.ok).toBe(false);
    expect(resumed.state).toBe("NOT_FOUND");
  });
});
