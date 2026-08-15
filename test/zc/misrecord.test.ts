/**
 * @file misrecord.test.ts — MisrecordCorrected (§13.4), the only record correction.
 *
 * Covers the four-eyes + evidence + time-window controls, the b-irreversibility
 * money-safety gate, the PAYER_EXEC_CONFIRMED → SUSPENDED correction, the
 * SUSPENDED-with-a-in-history append, CASE convergence, and idempotency.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { correctMisrecord } from "../../src/zc/finality/misrecord";
import { writeFinalityLog } from "../../src/zc/orchestrator";

let d1: MockD1Database;
const VALID = {
  approver_1: "ops-alice",
  approver_2: "ops-bob",
  evidence_type: "LEDGER_RECON_HASH",
  evidence_ref: "recon:abc123",
};

/** Seed a tx in the given state with an idempotency key. */
function seedTx(db: MockD1Database, txid: string, state: string) {
  db.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, created_at, updated_at, version)
     VALUES (?, 'HIGH_VALUE', ?, 100000, 'JPY', '001', 'payerAcc', '002', 'payeeAcc',
             ?, '1.0', '2025-06-01T09:00:00Z', '2025-06-01T09:00:00Z', 0)`
  )
    .bind(txid, state, `IK-${txid}`)
    ._runSync();
}

/** Record an `a` (PayerExecConfirmed) in the FinalityLog at a chosen time. */
async function recordA(db: MockD1Database, txid: string, occurredAt?: string) {
  if (occurredAt) {
    // Direct insert to control occurred_at (for the time-window test).
    db.prepare(
      `INSERT INTO FinalityLog
       (log_id, txid, gtid, event_type, state_from, state_to, payload_json, event_seq, occurred_at, prev_hash, entry_hash)
       VALUES (?, ?, NULL, 'PayerExecConfirmed', 'DECIDED_TO_SETTLE', 'PAYER_EXEC_CONFIRMED', '{}', ?, ?, 'GENESIS', ?)`
    )
      .bind(`FL-A-${txid}`, txid, Math.floor(Math.random() * 1e9), occurredAt, `hash-${txid}`)
      ._runSync();
  } else {
    await writeFinalityLog(db as any, {
      txid,
      event_type: "PayerExecConfirmed",
      state_from: "DECIDED_TO_SETTLE",
      state_to: "PAYER_EXEC_CONFIRMED",
      payload_json: "{}",
      txid_or_gtid: txid,
    });
  }
}

beforeEach(() => {
  ({ d1 } = createTestDb());
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("correctMisrecord — happy path", () => {
  it("corrects a live PAYER_EXEC_CONFIRMED a-misrecord to SUSPENDED + CASE", async () => {
    seedTx(d1, "TX-MR-1", "PAYER_EXEC_CONFIRMED");
    await recordA(d1, "TX-MR-1");

    const res = await correctMisrecord(d1 as any, "TX-MR-1", VALID);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state_from).toBe("PAYER_EXEC_CONFIRMED");
      expect(res.state_to).toBe("SUSPENDED");
      expect(res.case_id).toMatch(/^CASE-/);
    }

    const tx = await d1
      .prepare(`SELECT state, reason_code, case_id FROM Transactions WHERE txid='TX-MR-1'`)
      .first<{ state: string; reason_code: string; case_id: string }>();
    expect(tx?.state).toBe("SUSPENDED");
    expect(tx?.reason_code).toBe("MISRECORD_CORRECTED");
    expect(tx?.case_id).toBeTruthy();

    const log = await d1
      .prepare(
        `SELECT payload_json FROM FinalityLog WHERE txid='TX-MR-1' AND event_type='MisrecordCorrected'`
      )
      .first<{ payload_json: string }>();
    expect(log).toBeTruthy();
    expect(log!.payload_json).toContain("ops-alice");
    expect(log!.payload_json).toContain("recon:abc123");
  });

  it("appends a correction when the a-misrecord already aged into SUSPENDED", async () => {
    seedTx(d1, "TX-MR-2", "SUSPENDED");
    await recordA(d1, "TX-MR-2");

    const res = await correctMisrecord(d1 as any, "TX-MR-2", VALID);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state_from).toBe("SUSPENDED");
      expect(res.state_to).toBe("SUSPENDED");
    }
    const log = await d1
      .prepare(`SELECT 1 FROM FinalityLog WHERE txid='TX-MR-2' AND event_type='MisrecordCorrected'`)
      .first();
    expect(log).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Controls + gates
// ---------------------------------------------------------------------------

describe("correctMisrecord — controls and gates", () => {
  it("rejects without two distinct approvers", async () => {
    seedTx(d1, "TX-MR-3", "PAYER_EXEC_CONFIRMED");
    await recordA(d1, "TX-MR-3");
    const res = await correctMisrecord(d1 as any, "TX-MR-3", { ...VALID, approver_2: "ops-alice" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("FOUR_EYES_REQUIRED");
  });

  it("rejects without evidence", async () => {
    seedTx(d1, "TX-MR-4", "PAYER_EXEC_CONFIRMED");
    await recordA(d1, "TX-MR-4");
    const res = await correctMisrecord(d1 as any, "TX-MR-4", { ...VALID, evidence_ref: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("EVIDENCE_REQUIRED");
  });

  it("rejects when no a was ever recorded (nothing to correct)", async () => {
    seedTx(d1, "TX-MR-5", "DECIDED_TO_SETTLE");
    const res = await correctMisrecord(d1 as any, "TX-MR-5", VALID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("NO_MISRECORD");
  });

  it("rejects after b (irreversible) — use Reversal", async () => {
    seedTx(d1, "TX-MR-6", "SETTLED");
    await recordA(d1, "TX-MR-6");
    const res = await correctMisrecord(d1 as any, "TX-MR-6", VALID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("B_CONFIRMED");
  });

  it("rejects b found in FinalityLog history even if current state hides it", async () => {
    seedTx(d1, "TX-MR-7", "SUSPENDED");
    await recordA(d1, "TX-MR-7");
    await writeFinalityLog(d1 as any, {
      txid: "TX-MR-7",
      event_type: "PayeeExecConfirmed",
      state_from: "PAYER_EXEC_CONFIRMED",
      state_to: "PAYEE_EXEC_CONFIRMED",
      payload_json: "{}",
      txid_or_gtid: "TX-MR-7",
    });
    const res = await correctMisrecord(d1 as any, "TX-MR-7", VALID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("B_CONFIRMED");
  });

  it("rejects when the erroneous a is past the correction window", async () => {
    seedTx(d1, "TX-MR-8", "PAYER_EXEC_CONFIRMED");
    await recordA(d1, "TX-MR-8", "2000-01-01T00:00:00Z"); // ancient
    const res = await correctMisrecord(d1 as any, "TX-MR-8", VALID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("WINDOW_EXPIRED");
  });

  it("is idempotent — a second correction is rejected", async () => {
    seedTx(d1, "TX-MR-9", "PAYER_EXEC_CONFIRMED");
    await recordA(d1, "TX-MR-9");
    const first = await correctMisrecord(d1 as any, "TX-MR-9", VALID);
    expect(first.ok).toBe(true);
    const second = await correctMisrecord(d1 as any, "TX-MR-9", VALID);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("ALREADY_CORRECTED");
  });
});
