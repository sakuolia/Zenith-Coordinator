/**
 * @file auth_timeout.test.ts — the T_auth clock (§3.3.1), from the moment the
 *       Authority Check fails to answer to the moment the wait is suspended.
 *
 * Two properties, and the first one is the reason the timer exists at all:
 *
 *  1. **A screening step that cannot reach the bank must not pass the payment.**
 *     Every lane tested `result === "NG"` and fell through on anything else, so
 *     a payer bank behind an OPEN circuit produced the same outcome as a clean
 *     sanctions pass. AML screening is fail-closed by definition.
 *  2. **Not answering is not the same as failing.** A transient outage must not
 *     cancel a legitimate transfer, so the wait is bounded rather than resolved:
 *     the row parks in PRECHECKED and T_auth suspends it if no verdict arrives.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runTimeoutSweep } from "../../src/cron/timeout_sweep";
import { advanceStandard } from "../../src/zc/lanes/standard";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";

let d1: MockD1Database;
let env: any;

const OLD = "2020-01-01T00:00:00.000Z";
const NOW = new Date().toISOString();

function seed(txid: string, state: string, updatedAt: string, reasonCode: string | null = null) {
  d1.prepare(
    `INSERT INTO Transactions
       (txid, lane, state, amount_value, payer_bank_id, payer_account_hash,
        payee_bank_id, payee_account_hash, idempotency_key, reason_code, owner,
        created_at, updated_at)
     VALUES (?, 'STANDARD', ?, 1000, '001', 'h:p', '002', 'h:q', ?, ?, 'ZC', ?, ?)`
  )
    .bind(txid, state, `idem-${txid}`, reasonCode, updatedAt, updatedAt)
    ._runSync();
}

const rowOf = async (txid: string) =>
  (await d1
    .prepare(`SELECT state, reason_code, updated_at FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: string; reason_code: string | null; updated_at: string }>())!;

beforeEach(() => {
  ({ d1 } = createTestDb());
  env = { DB: d1, QUEUE: { send: async () => {} } };
});

describe("T_auth: a PRECHECKED row waiting for an Authority Check verdict", () => {
  it("suspends with SUSPEND_AUTHORITY_PENDING once the wait exceeds the deadline", async () => {
    seed("TX-AUTH-OLD", "PRECHECKED", OLD, "SUSPEND_AUTHORITY_PENDING");
    await runTimeoutSweep(env);
    const row = await rowOf("TX-AUTH-OLD");
    expect(row.state).toBe("PRECHECKED_SUSPENDED");
    expect(row.reason_code).toBe("SUSPEND_AUTHORITY_PENDING");
  });

  it("leaves a wait that is still inside the deadline alone", async () => {
    seed("TX-AUTH-FRESH", "PRECHECKED", NOW, "SUSPEND_AUTHORITY_PENDING");
    await runTimeoutSweep(env);
    expect((await rowOf("TX-AUTH-FRESH")).state).toBe("PRECHECKED");
  });

  it("does not touch a PRECHECKED row that is not waiting on the Authority Check", async () => {
    // The marker is what scopes this step. Without it, any row that stalled in
    // PRECHECKED for an unrelated reason would be suspended and mislabelled as
    // an AML wait — a reason_code the counter reads out loud.
    seed("TX-OTHER", "PRECHECKED", OLD, null);
    await runTimeoutSweep(env);
    expect((await rowOf("TX-OTHER")).state).toBe("PRECHECKED");
  });

  it("does not touch a row owned by someone else", async () => {
    seed("TX-OWNED", "PRECHECKED", OLD, "SUSPEND_AUTHORITY_PENDING");
    d1.prepare(`UPDATE Transactions SET owner='CYCLE:DNS-1' WHERE txid='TX-OWNED'`)._runSync();
    await runTimeoutSweep(env);
    expect((await rowOf("TX-OWNED")).state).toBe("PRECHECKED");
  });

  it("is idempotent — a second sweep finds nothing left to suspend", async () => {
    seed("TX-ONCE", "PRECHECKED", OLD, "SUSPEND_AUTHORITY_PENDING");
    const first = await runTimeoutSweep(env);
    const second = await runTimeoutSweep(env);
    expect(first.swept).toBeGreaterThan(0);
    expect(second.swept).toBe(0);
  });

  it("records the suspension in the FinalityLog", async () => {
    seed("TX-LOG", "PRECHECKED", OLD, "SUSPEND_AUTHORITY_PENDING");
    await runTimeoutSweep(env);
    const log = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE txid = ? ORDER BY event_seq`)
      .bind("TX-LOG")
      .all<{ event_type: string }>();
    expect(log.results.map((r) => r.event_type)).toContain("PreCheckSuspended");
  });
});

describe("a bank that returns no verdict starts the clock instead of passing the payment", () => {
  /** Seed a payer bank whose circuit breaker is OPEN, so authority-check fast-fails. */
  function tripCircuit(bankId: string) {
    d1.prepare(
      `INSERT INTO CircuitBreakerState (bank_id, state, consecutive_failures, opened_at, updated_at)
       VALUES (?, 'OPEN', 5, ?, ?)`
    )
      .bind(bankId, NOW, NOW)
      ._runSync();
  }

  it("parks the transaction in PRECHECKED with the pending marker, and does not settle it", async () => {
    seed("TX-CIRCUIT", "RECEIVED", NOW);
    tripCircuit("001");

    await advanceStandard("TX-CIRCUIT", env);

    const row = await rowOf("TX-CIRCUIT");
    // The regression: this used to walk straight past the screening into
    // H_RESERVED and on to settlement.
    expect(row.state).toBe("PRECHECKED");
    expect(row.reason_code).toBe("SUSPEND_AUTHORITY_PENDING");
  });

  it("hands that row to T_auth, which suspends it once the deadline passes", async () => {
    seed("TX-CIRCUIT-2", "RECEIVED", NOW);
    tripCircuit("001");
    await advanceStandard("TX-CIRCUIT-2", env);

    // The marker was stamped just now, so the wait is still inside the window…
    await runTimeoutSweep(env);
    expect((await rowOf("TX-CIRCUIT-2")).state).toBe("PRECHECKED");

    // …and the sweep resolves it once the clock (pending_since) is old enough.
    d1.prepare(`UPDATE Transactions SET pending_since=? WHERE txid='TX-CIRCUIT-2'`)
      .bind(OLD)
      ._runSync();
    await runTimeoutSweep(env);
    const row = await rowOf("TX-CIRCUIT-2");
    expect(row.state).toBe("PRECHECKED_SUSPENDED");
    expect(row.reason_code).toBe("SUSPEND_AUTHORITY_PENDING");
  });

  it("still cancels on an explicit NG — a verdict is not a wait", async () => {
    seed("TX-NG", "RECEIVED", NOW);
    const verify = await import("../../src/bank/ingress/verify");
    const spy = vi
      .spyOn(verify, "bankAuthorityCheck")
      .mockResolvedValue({ result: "NG", reason_code: "SANCTIONS_MATCH" });

    await advanceStandard("TX-NG", env);
    const row = await rowOf("TX-NG");
    expect(row.state).toBe("CANCELLED");
    expect(row.reason_code).toBe("SANCTIONS_MATCH");
    spy.mockRestore();
  });
});
