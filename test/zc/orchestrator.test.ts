/**
 * @file Tests for the ZC Orchestrator state machine.
 *
 * Covers:
 * - isValidTransition: verifies the ALLOWED_TRANSITIONS map is complete and
 *   sound (no invalid transitions accepted, all valid ones accepted)
 * - writeFinalityLog: verifies monotonic event_seq and log persistence
 * - finalizeCancelledTx: DECIDED_CANCEL → CANCELLED transition
 * - suspendTx: CAS guard prevents double-suspend
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  isValidTransition,
  writeFinalityLog,
  finalizeCancelledTx,
  suspendTx,
} from "../../src/zc/orchestrator";
import type { TxState } from "../../src/types";

let d1: MockD1Database;

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
});

// ---------------------------------------------------------------------------
// isValidTransition
// ---------------------------------------------------------------------------

describe("isValidTransition — valid paths", () => {
  const validPaths: [TxState, TxState][] = [
    ["RECEIVED", "PRECHECKED"],
    ["RECEIVED", "HTLC_LOCKED"],
    ["RECEIVED", "DECIDED_CANCEL"],
    ["PRECHECKED", "H_RESERVED"],
    ["PRECHECKED", "DECIDED_TO_SETTLE"],
    ["PRECHECKED", "DECIDED_CANCEL"],
    ["PRECHECKED", "PRECHECKED_SUSPENDED"],
    ["PRECHECKED_SUSPENDED", "PRECHECKED"],
    ["PRECHECKED_SUSPENDED", "DECIDED_CANCEL"],
    ["H_RESERVED", "DECIDED_TO_SETTLE"],
    ["H_RESERVED", "DECIDED_CANCEL"],
    ["DECIDED_TO_SETTLE", "PAYER_EXEC_CONFIRMED"],
    ["DECIDED_TO_SETTLE", "PAYEE_EXEC_CONFIRMED"],
    ["DECIDED_TO_SETTLE", "SUSPENDED"],
    ["DECIDED_CANCEL", "CANCELLED"],
    ["PAYER_EXEC_CONFIRMED", "PAYEE_EXEC_CONFIRMED"],
    ["PAYER_EXEC_CONFIRMED", "SUSPENDED"],
    ["PAYEE_EXEC_CONFIRMED", "SETTLED"],
    ["SUSPENDED", "PAYER_EXEC_CONFIRMED"],
    ["SUSPENDED", "PAYEE_EXEC_CONFIRMED"],
    ["SUSPENDED", "FAILED_EXECUTION"],
    ["HTLC_LOCKED", "HTLC_FULFILL_REQUESTED"],
    ["HTLC_LOCKED", "DECIDED_CANCEL"],
    ["HTLC_FULFILL_REQUESTED", "DECIDED_TO_SETTLE"],
    ["HTLC_FULFILL_REQUESTED", "FAILED_EXECUTION"],
  ];

  for (const [from, to] of validPaths) {
    it(`allows ${from} → ${to}`, () => {
      expect(isValidTransition(from, to)).toBe(true);
    });
  }
});

describe("isValidTransition — invalid paths (terminal / backward)", () => {
  const invalidPaths: [TxState, TxState][] = [
    ["SETTLED", "RECEIVED"],
    ["CANCELLED", "RECEIVED"],
    ["FAILED_EXECUTION", "RECEIVED"],
    ["SETTLED", "DECIDED_CANCEL"],
    ["RECEIVED", "SETTLED"],
    ["DECIDED_TO_SETTLE", "RECEIVED"],
    ["PAYER_EXEC_CONFIRMED", "RECEIVED"],
    ["HTLC_LOCKED", "RECEIVED"],
  ];

  for (const [from, to] of invalidPaths) {
    it(`rejects ${from} → ${to}`, () => {
      expect(isValidTransition(from, to)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// writeFinalityLog — monotonic event_seq and persistence
// ---------------------------------------------------------------------------

describe("writeFinalityLog", () => {
  it("writes a log entry that can be read back", async () => {
    await writeFinalityLog(d1 as any, {
      txid: "TX-TEST-001",
      event_type: "DecidedToSettle",
      state_from: "H_RESERVED",
      state_to: "DECIDED_TO_SETTLE",
      payload_json: '{"test":true}',
      txid_or_gtid: "TX-TEST-001",
    });

    const row = await d1
      .prepare(`SELECT * FROM FinalityLog WHERE txid = ? ORDER BY event_seq DESC LIMIT 1`)
      .bind("TX-TEST-001")
      .first<{ event_type: string; state_to: string; event_seq: number }>();

    expect(row).not.toBeNull();
    expect(row?.event_type).toBe("DecidedToSettle");
    expect(row?.state_to).toBe("DECIDED_TO_SETTLE");
    expect(typeof row?.event_seq).toBe("number");
  });

  it("produces strictly increasing event_seq for sequential writes", async () => {
    await writeFinalityLog(d1 as any, {
      txid: "TX-SEQ-001",
      event_type: "PreCheckPassed",
      state_from: "RECEIVED",
      state_to: "PRECHECKED",
      payload_json: "{}",
      txid_or_gtid: "TX-SEQ-001",
    });
    await writeFinalityLog(d1 as any, {
      txid: "TX-SEQ-001",
      event_type: "HReserved",
      state_from: "PRECHECKED",
      state_to: "H_RESERVED",
      payload_json: "{}",
      txid_or_gtid: "TX-SEQ-001",
    });
    await writeFinalityLog(d1 as any, {
      txid: "TX-SEQ-001",
      event_type: "DecidedToSettle",
      state_from: "H_RESERVED",
      state_to: "DECIDED_TO_SETTLE",
      payload_json: "{}",
      txid_or_gtid: "TX-SEQ-001",
    });

    const rows = await d1
      .prepare(`SELECT event_seq FROM FinalityLog WHERE txid = ? ORDER BY event_seq ASC`)
      .bind("TX-SEQ-001")
      .all<{ event_seq: number }>();

    expect(rows.results.length).toBe(3);
    const seqs = rows.results.map((r) => r.event_seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it("sets gtid column for GTID-prefixed txid_or_gtid", async () => {
    await writeFinalityLog(d1 as any, {
      txid: null,
      event_type: "GtidDecided",
      state_from: "GT_PRECHECKED",
      state_to: "GT_DECIDED_TO_SETTLE",
      payload_json: "{}",
      txid_or_gtid: "GTID-TEST-001",
    });

    const row = await d1
      .prepare(`SELECT gtid, txid FROM FinalityLog WHERE event_type = 'GtidDecided' LIMIT 1`)
      .first<{ gtid: string | null; txid: string | null }>();

    expect(row?.gtid).toBe("GTID-TEST-001");
    expect(row?.txid).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// finalizeCancelledTx
// ---------------------------------------------------------------------------

describe("finalizeCancelledTx", () => {
  function insertTx(txid: string, state: string) {
    d1.prepare(
      `INSERT INTO Transactions
       (txid, lane, state, amount_value, amount_currency,
        payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
        idempotency_key, schema_version, created_at, updated_at, version)
       VALUES (?, 'EXPRESS', ?, 100000, 'JPY', '001', '001ACC', '002', '002ACC',
               ?, '1.0', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 0)`
    )
      .bind(txid, state, `IK-${txid}`)
      ._runSync();
  }

  it("transitions DECIDED_CANCEL → CANCELLED and writes FinalityLog", async () => {
    insertTx("TX-CANCEL-001", "DECIDED_CANCEL");
    await finalizeCancelledTx("TX-CANCEL-001", d1 as any);

    const row = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind("TX-CANCEL-001")
      .first<{ state: string }>();
    expect(row?.state).toBe("CANCELLED");

    const log = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE txid = ? AND event_type = 'Cancelled'`)
      .bind("TX-CANCEL-001")
      .first<{ event_type: string }>();
    expect(log).not.toBeNull();
  });

  it("is idempotent: calling twice does not throw and CANCELLED stays CANCELLED", async () => {
    insertTx("TX-CANCEL-002", "DECIDED_CANCEL");
    await finalizeCancelledTx("TX-CANCEL-002", d1 as any);
    await expect(finalizeCancelledTx("TX-CANCEL-002", d1 as any)).resolves.toBeUndefined();

    const row = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind("TX-CANCEL-002")
      .first<{ state: string }>();
    expect(row?.state).toBe("CANCELLED");
  });

  it("does not transition a non-DECIDED_CANCEL state", async () => {
    insertTx("TX-CANCEL-003", "DECIDED_TO_SETTLE");
    await finalizeCancelledTx("TX-CANCEL-003", d1 as any);

    const row = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind("TX-CANCEL-003")
      .first<{ state: string }>();
    expect(row?.state).toBe("DECIDED_TO_SETTLE");
  });
});

// ---------------------------------------------------------------------------
// suspendTx — CAS guard
// ---------------------------------------------------------------------------

describe("suspendTx", () => {
  function insertTx(txid: string, state: string, version = 0) {
    d1.prepare(
      `INSERT INTO Transactions
       (txid, lane, state, amount_value, amount_currency,
        payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
        idempotency_key, schema_version, created_at, updated_at, version)
       VALUES (?, 'EXPRESS', ?, 100000, 'JPY', '001', '001ACC', '002', '002ACC',
               ?, '1.0', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', ?)`
    )
      .bind(txid, state, `IK-${txid}`, version)
      ._runSync();
  }

  it("transitions DECIDED_TO_SETTLE → SUSPENDED and writes FinalityLog", async () => {
    insertTx("TX-SUSP-001", "DECIDED_TO_SETTLE");
    await suspendTx("TX-SUSP-001", "EXEC_DEBIT_FAILED", d1 as any);

    const row = await d1
      .prepare(`SELECT state, reason_code FROM Transactions WHERE txid = ?`)
      .bind("TX-SUSP-001")
      .first<{ state: string; reason_code: string | null }>();
    expect(row?.state).toBe("SUSPENDED");
    expect(row?.reason_code).toBe("EXEC_DEBIT_FAILED");

    const log = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE txid = ? AND event_type = 'Suspended'`)
      .bind("TX-SUSP-001")
      .first<{ event_type: string }>();
    expect(log).not.toBeNull();
  });

  it("does not suspend a SETTLED transaction (invalid transition)", async () => {
    insertTx("TX-SUSP-002", "SETTLED");
    await suspendTx("TX-SUSP-002", "EXEC_DEBIT_FAILED", d1 as any);

    const row = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind("TX-SUSP-002")
      .first<{ state: string }>();
    expect(row?.state).toBe("SETTLED");
  });

  it("CAS guard prevents double-suspend (second call is no-op)", async () => {
    insertTx("TX-SUSP-003", "DECIDED_TO_SETTLE");
    await suspendTx("TX-SUSP-003", "EXEC_DEBIT_FAILED", d1 as any);
    // After first call, state = SUSPENDED; second call should be a no-op
    await expect(suspendTx("TX-SUSP-003", "EXEC_DEBIT_FAILED", d1 as any)).resolves.toBeUndefined();

    const logCount = await d1
      .prepare(
        `SELECT COUNT(*) AS cnt FROM FinalityLog WHERE txid = ? AND event_type = 'Suspended'`
      )
      .bind("TX-SUSP-003")
      .first<{ cnt: number }>();
    // Only one Suspended log should exist (second call finds invalid transition SUSPENDED→SUSPENDED)
    expect(logCount?.cnt).toBe(1);
  });
});
