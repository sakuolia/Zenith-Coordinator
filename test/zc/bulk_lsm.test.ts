/**
 * @file bulk_lsm.test.ts — Bulk LSM optimiser (docs/specs/30_internal_design.md 第14章).
 *
 * Covers the optimiser, its audit trail, and the fallback path:
 *   - lexicographic selection under the per-payer H budget (due_at → fairness →
 *     throughput) with overflow deferred (not rejected)
 *   - LsmRuns + LsmRunCommitted audit (input snapshot / constraints / execution
 *     set / trace digests, objective metrics)
 *   - fallback (FIFO / THROTTLE) records LsmRunFallback + degraded metrics
 *
 * The default test DB seeds banks 001/002 with savings accounts 001000000{1,2} /
 * 002000000{1,2} (1,000,000 balance each) and h_limit 100,000,000.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { runBulkLsm } from "../../src/zc/liquidity/bulk_lsm";

function makeEnv(db: MockD1Database): any {
  return { DB: db, QUEUE: { send: async () => {} }, ZC_HMAC_SECRET: "test-secret" };
}

let d1: MockD1Database;

function setHLimit(db: MockD1Database, bankId: string, hLimit: number, hUsed = 0) {
  db.prepare(`UPDATE Participants SET h_limit=?, h_used=? WHERE bank_id=?`)
    .bind(hLimit, hUsed, bankId)
    ._runSync();
}

function insertBulkTx(
  db: MockD1Database,
  txid: string,
  opts: {
    amount?: number;
    payer?: string;
    payerAcc?: string;
    createdAt?: string;
    dueAt?: string | null;
  } = {}
) {
  const amount = opts.amount ?? 100_000;
  const payer = opts.payer ?? "001";
  const payerAcc = opts.payerAcc ?? "0010000001";
  const createdAt = opts.createdAt ?? "2025-06-18T09:00:00Z";
  const dueAt = opts.dueAt === undefined ? null : opts.dueAt;
  db.prepare(
    `INSERT INTO Transactions
       (txid, lane, state, amount_value, amount_currency,
        payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
        idempotency_key, schema_version, expires_at, created_at, updated_at, version)
     VALUES (?, 'BULK', 'RECEIVED', ?, 'JPY', ?, ?, '002', '0020000001',
             ?, '1.0', ?, ?, ?, 0)`
  )
    .bind(txid, amount, payer, payerAcc, `IK-${txid}`, dueAt, createdAt, createdAt)
    ._runSync();
}

async function stateOf(db: MockD1Database, txid: string): Promise<string | undefined> {
  const row = await db
    .prepare(`SELECT state FROM Transactions WHERE txid=?`)
    .bind(txid)
    .first<{ state: string }>();
  return row?.state;
}

beforeEach(() => {
  ({ d1 } = createTestDb());
});

// ---------------------------------------------------------------------------
// Happy path: select all within budget
// ---------------------------------------------------------------------------

describe("runBulkLsm — within budget", () => {
  it("commits every candidate and records an OPTIMIZED run with audit digests", async () => {
    insertBulkTx(d1, "TX-1", { amount: 100_000 });
    insertBulkTx(d1, "TX-2", { amount: 200_000 });

    const res = await runBulkLsm(makeEnv(d1), { businessDate: "2025-06-18" });

    expect(res.mode).toBe("OPTIMIZED");
    expect(res.is_fallback).toBe(false);
    expect(res.committed.sort()).toEqual(["TX-1", "TX-2"]);
    expect(res.deferred).toEqual([]);
    expect(await stateOf(d1, "TX-1")).toBe("DECIDED_TO_SETTLE");
    expect(await stateOf(d1, "TX-2")).toBe("DECIDED_TO_SETTLE");

    const run = await d1
      .prepare(`SELECT * FROM LsmRuns WHERE run_id=?`)
      .bind(res.run_id)
      .first<any>();
    expect(run.mode).toBe("OPTIMIZED");
    expect(run.is_fallback).toBe(0);
    expect(run.input_snapshot_id).toMatch(/^LSMSNAP-[0-9a-f]{16}$/);
    expect(run.constraints_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(run.execution_set_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.trace_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(run.selected_count).toBe(2);

    const log = await d1
      .prepare(`SELECT 1 FROM FinalityLog WHERE event_type='LsmRunCommitted' AND gtid=?`)
      .bind(res.run_id)
      .first();
    expect(log).toBeTruthy();
  });

  it("records an empty run when there are no candidates", async () => {
    const res = await runBulkLsm(makeEnv(d1), { businessDate: "2025-06-18" });
    expect(res.committed).toEqual([]);
    expect(res.deferred).toEqual([]);
    const run = await d1
      .prepare(`SELECT candidate_count FROM LsmRuns WHERE run_id=?`)
      .bind(res.run_id)
      .first<{ candidate_count: number }>();
    expect(run?.candidate_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// H constraint: overflow is deferred, not rejected
// ---------------------------------------------------------------------------

describe("runBulkLsm — H budget constraint", () => {
  it("defers candidates that do not fit the payer's remaining H budget", async () => {
    setHLimit(d1, "001", 150_000, 0); // budget = 150,000
    insertBulkTx(d1, "TX-A", { amount: 100_000, createdAt: "2025-06-18T09:00:00Z" });
    insertBulkTx(d1, "TX-B", { amount: 100_000, createdAt: "2025-06-18T09:01:00Z" });

    const res = await runBulkLsm(makeEnv(d1), { businessDate: "2025-06-18" });

    // Only one 100k tx fits; the other is deferred (left in RECEIVED).
    expect(res.committed.length).toBe(1);
    expect(res.deferred.length).toBe(1);
    const deferredTxid = res.deferred[0]!;
    expect(await stateOf(d1, deferredTxid)).toBe("RECEIVED");

    const run = await d1
      .prepare(`SELECT objective_metrics FROM LsmRuns WHERE run_id=?`)
      .bind(res.run_id)
      .first<{ objective_metrics: string }>();
    const metrics = JSON.parse(run!.objective_metrics);
    expect(metrics.selected).toBe(1);
    expect(metrics.deferred).toBe(1);
    expect(metrics.degraded).toBe(false);
  });

  it("prefers the earlier-due candidate under a tight budget (due_at adherence)", async () => {
    setHLimit(d1, "001", 100_000, 0); // only one 100k tx fits
    // EARLY arrived later but is due sooner; LATE arrived first but is due later.
    insertBulkTx(d1, "TX-LATE", {
      amount: 100_000,
      createdAt: "2025-06-18T09:00:00Z",
      dueAt: "2025-06-30T00:00:00Z",
    });
    insertBulkTx(d1, "TX-EARLY", {
      amount: 100_000,
      createdAt: "2025-06-18T09:05:00Z",
      dueAt: "2025-06-19T00:00:00Z",
    });

    const res = await runBulkLsm(makeEnv(d1), { businessDate: "2025-06-18" });
    expect(res.committed).toEqual(["TX-EARLY"]);
    expect(res.deferred).toEqual(["TX-LATE"]);
  });
});

// ---------------------------------------------------------------------------
// Fallback (§14.3)
// ---------------------------------------------------------------------------

describe("runBulkLsm — fallback", () => {
  it("forceFallback=FIFO records a degraded LsmRunFallback run", async () => {
    insertBulkTx(d1, "TX-1", { amount: 100_000 });
    insertBulkTx(d1, "TX-2", { amount: 100_000 });

    const res = await runBulkLsm(makeEnv(d1), {
      businessDate: "2025-06-18",
      forceFallback: "FIFO",
    });

    expect(res.mode).toBe("FIFO");
    expect(res.is_fallback).toBe(true);
    expect(res.committed.length).toBe(2);

    const run = await d1
      .prepare(`SELECT is_fallback, mode, objective_metrics FROM LsmRuns WHERE run_id=?`)
      .bind(res.run_id)
      .first<{ is_fallback: number; mode: string; objective_metrics: string }>();
    expect(run?.is_fallback).toBe(1);
    expect(run?.mode).toBe("FIFO");
    const metrics = JSON.parse(run!.objective_metrics);
    expect(metrics.degraded).toBe(true);
    expect(metrics.fallback_mode).toBe("FIFO");

    const log = await d1
      .prepare(`SELECT 1 FROM FinalityLog WHERE event_type='LsmRunFallback' AND gtid=?`)
      .bind(res.run_id)
      .first();
    expect(log).toBeTruthy();
  });

  it("THROTTLE fallback caps a payer at half its budget", async () => {
    setHLimit(d1, "001", 300_000, 0); // half = 150,000 → only one 100k fits
    insertBulkTx(d1, "TX-A", { amount: 100_000, createdAt: "2025-06-18T09:00:00Z" });
    insertBulkTx(d1, "TX-B", { amount: 100_000, createdAt: "2025-06-18T09:01:00Z" });

    const res = await runBulkLsm(makeEnv(d1), {
      businessDate: "2025-06-18",
      forceFallback: "THROTTLE",
    });
    expect(res.mode).toBe("THROTTLE");
    expect(res.committed.length).toBe(1);
    expect(res.deferred.length).toBe(1);
  });
});
