/**
 * @file precheck_timeout.test.ts — the T_precheck sweep (§3.3.1).
 *
 * A row that never leaves RECEIVED is one nothing picked up: the queue message
 * was lost, or the lane rejected it before advancing. Every other timer starts
 * at DECIDED_TO_SETTLE or later, so until this step existed the very first hop
 * had no clock — the transfer sat accepted-but-not-moving forever, which is the
 * state design principle 4 forbids ("説明できない状態は禁止").
 */
import { beforeEach, describe, expect, it } from "vitest";
import { runTimeoutSweep } from "../../src/cron/timeout_sweep";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";

let d1: MockD1Database;
let env: any;

const OLD = "2020-01-01T00:00:00.000Z";
const NOW = new Date().toISOString();

function seed(txid: string, state: string, updatedAt: string, lane = "STANDARD") {
  d1.prepare(
    `INSERT INTO Transactions
       (txid, lane, state, amount_value, payer_bank_id, payer_account_hash,
        payee_bank_id, payee_account_hash, idempotency_key, owner, created_at, updated_at)
     VALUES (?, ?, ?, 1000, '001', 'h:p', '002', 'h:q', ?, 'ZC', ?, ?)`
  )
    .bind(txid, lane, state, `idem-${txid}`, updatedAt, updatedAt)
    ._runSync();
}

const stateOf = async (txid: string) =>
  (await d1
    .prepare(`SELECT state, reason_code FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: string; reason_code: string | null }>())!;

beforeEach(() => {
  ({ d1 } = createTestDb());
  env = { DB: d1, QUEUE: { send: async () => {} } };
});

describe("T_precheck: RECEIVED rows nothing advanced", () => {
  it("cancels a stale RECEIVED row with CANCEL_PRECHECK_TIMEOUT", async () => {
    seed("TX-STALE", "RECEIVED", OLD);
    await runTimeoutSweep(env);
    const row = await stateOf("TX-STALE");
    // Cancelled, not suspended: no Decision exists yet, so there is nothing to
    // compensate — cancelling is the honest terminal, and it releases H. The
    // row lands on the terminal CANCELLED via the DecidedCancel decision, which
    // is the §3.2.1 path (`DECIDED_CANCEL --> CANCELLED: 終端`).
    expect(row.state).toBe("CANCELLED");
    expect(row.reason_code).toBe("CANCEL_PRECHECK_TIMEOUT");
  });

  it("leaves a freshly received row alone", async () => {
    seed("TX-FRESH", "RECEIVED", NOW);
    await runTimeoutSweep(env);
    expect((await stateOf("TX-FRESH")).state).toBe("RECEIVED");
  });

  it("exempts HTLC — its abandonment clock is the timelock, not T_precheck", async () => {
    seed("TX-HTLC", "RECEIVED", OLD, "HTLC");
    await runTimeoutSweep(env);
    expect((await stateOf("TX-HTLC")).state).toBe("RECEIVED");
  });

  it("exempts BULK / DEFERRED, which wait by design", async () => {
    seed("TX-BULK", "RECEIVED", OLD, "BULK");
    seed("TX-DEF", "RECEIVED", OLD, "DEFERRED");
    await runTimeoutSweep(env);
    expect((await stateOf("TX-BULK")).state).toBe("RECEIVED");
    expect((await stateOf("TX-DEF")).state).toBe("RECEIVED");
  });

  it("does not touch a row owned by someone else", async () => {
    seed("TX-OWNED", "RECEIVED", OLD);
    d1.prepare(`UPDATE Transactions SET owner='CYCLE:DNS-1' WHERE txid='TX-OWNED'`)._runSync();
    await runTimeoutSweep(env);
    expect((await stateOf("TX-OWNED")).state).toBe("RECEIVED");
  });

  it("is idempotent — a second sweep does not re-cancel", async () => {
    seed("TX-ONCE", "RECEIVED", OLD);
    const first = await runTimeoutSweep(env);
    const second = await runTimeoutSweep(env);
    expect(first.swept).toBeGreaterThan(0);
    expect(second.swept).toBe(0);
  });

  it("records the cancellation in the FinalityLog", async () => {
    seed("TX-LOG", "RECEIVED", OLD);
    await runTimeoutSweep(env);
    const log = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE txid = ? ORDER BY event_seq`)
      .bind("TX-LOG")
      .all<{ event_type: string }>();
    // The decision itself is on the record, not just the terminal state.
    expect(log.results.map((r) => r.event_type)).toContain("DecidedCancel");
  });
});
