/**
 * @file quorum.test.ts — Design-principle-10 quorum health + enforced read-only
 *       degradation.
 *
 * Covers:
 *   - evaluateQuorum: strict-majority math; unknown/duplicate ids cannot
 *     manufacture quorum.
 *   - reconcileQuorum: degrade on quorum loss, restore on recovery, idempotent,
 *     and never override an operator-declared BCP_READONLY.
 *   - deactivateBcpReadOnly refuses to clear a QUORUM_LOSS_READONLY degradation.
 *   - Write enforcement: while QUORUM_LOSS_READONLY, the lane write primitives
 *     and suspendTx fast-fail with SYSTEM_QUORUM_LOSS_READ_ONLY (DOWNSTREAM →
 *     retryable), while reads keep working; once restored, writes resume.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { evaluateQuorum, quorumMembership, reconcileQuorum } from "../../src/zc/platform/quorum";
import {
  assertWritable,
  deactivateBcpReadOnly,
  degradeToQuorumLossReadOnly,
  getSystemMode,
  restoreFromQuorumLoss,
  activateBcpReadOnly,
} from "../../src/zc/platform/system_mode";
import { transitionWithLog, insertTxWithLog, cancelInFlightTx } from "../../src/zc/lanes/_helpers";
import { suspendTx } from "../../src/zc/orchestrator/finality";
import { type DomainError, isDomainError } from "../../src/shared/errors";

function makeEnv(db: MockD1Database, replicas?: string): any {
  return { DB: db, ZC_QUORUM_REPLICAS: replicas };
}

function insertTx(db: MockD1Database, txid: string, state = "RECEIVED") {
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

let d1: MockD1Database;
beforeEach(() => {
  d1 = createTestDb().d1;
});

// ---------------------------------------------------------------------------
// evaluateQuorum
// ---------------------------------------------------------------------------

describe("evaluateQuorum", () => {
  it("requires a strict majority (3/3 healthy, 2/3 healthy, 1/3 lost)", () => {
    const m = ["r1", "r2", "r3"];
    expect(evaluateQuorum(m, ["r1", "r2", "r3"]).hasQuorum).toBe(true);
    expect(evaluateQuorum(m, ["r1", "r2"]).hasQuorum).toBe(true);
    const lost = evaluateQuorum(m, ["r1"]);
    expect(lost.hasQuorum).toBe(false);
    expect(lost.required).toBe(2);
    expect(lost.reachable).toBe(1);
    expect(lost.total).toBe(3);
  });

  it("ignores unknown and duplicate ids when counting reachability", () => {
    const m = ["r1", "r2", "r3"];
    // 'r9' is not a member; 'r1' repeated must not double-count.
    const h = evaluateQuorum(m, ["r1", "r1", "r9"]);
    expect(h.reachable).toBe(1);
    expect(h.hasQuorum).toBe(false);
    expect(h.reachableIds.sort()).toEqual(["r1"]);
  });

  it("computes majority for a 5-replica membership", () => {
    const m = ["a", "b", "c", "d", "e"];
    expect(evaluateQuorum(m, ["a", "b", "c"]).hasQuorum).toBe(true); // 3/5
    expect(evaluateQuorum(m, ["a", "b"]).hasQuorum).toBe(false); // 2/5
    expect(evaluateQuorum(m, ["a", "b"]).required).toBe(3);
  });
});

describe("quorumMembership", () => {
  it("defaults to a three-replica set when env is unset", () => {
    expect(quorumMembership(makeEnv(d1))).toEqual(["r1", "r2", "r3"]);
  });

  it("parses a comma-separated replica list from env", () => {
    expect(quorumMembership(makeEnv(d1, "tokyo, osaka , sapporo"))).toEqual([
      "tokyo",
      "osaka",
      "sapporo",
    ]);
  });
});

// ---------------------------------------------------------------------------
// reconcileQuorum
// ---------------------------------------------------------------------------

describe("reconcileQuorum", () => {
  it("degrades to QUORUM_LOSS_READONLY on quorum loss and restores on recovery", async () => {
    const env = makeEnv(d1);

    const lost = await reconcileQuorum(env, ["r1"]); // 1/3 reachable
    expect(lost.action).toBe("DEGRADED");
    expect(lost.mode.mode).toBe("QUORUM_LOSS_READONLY");
    expect((await getSystemMode(d1 as any)).mode).toBe("QUORUM_LOSS_READONLY");

    const recovered = await reconcileQuorum(env, ["r1", "r2", "r3"]);
    expect(recovered.action).toBe("RESTORED");
    expect(recovered.mode.mode).toBe("NORMAL");
    expect((await getSystemMode(d1 as any)).mode).toBe("NORMAL");
  });

  it("is idempotent: repeated loss reports do not re-degrade", async () => {
    const env = makeEnv(d1);
    await reconcileQuorum(env, ["r1"]);
    const again = await reconcileQuorum(env, ["r1"]);
    expect(again.action).toBe("NO_CHANGE");
    expect(again.mode.mode).toBe("QUORUM_LOSS_READONLY");

    // Exactly one degradation audit entry was written.
    const count = await d1
      .prepare(
        `SELECT COUNT(*) AS n FROM FinalityLog WHERE event_type = 'SystemQuorumLossActivated'`
      )
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("does not override an operator-declared BCP_READONLY", async () => {
    const env = makeEnv(d1);
    await activateBcpReadOnly(env, "vendor outage");

    // Quorum loss while in BCP: leave the operator's mode untouched.
    const r1 = await reconcileQuorum(env, ["r1"]);
    expect(r1.action).toBe("NO_CHANGE");
    expect(r1.mode.mode).toBe("BCP_READONLY");

    // Quorum recovery must NOT silently clear the operator's BCP_READONLY.
    const r2 = await reconcileQuorum(env, ["r1", "r2", "r3"]);
    expect(r2.action).toBe("NO_CHANGE");
    expect((await getSystemMode(d1 as any)).mode).toBe("BCP_READONLY");
  });
});

// ---------------------------------------------------------------------------
// deactivateBcpReadOnly guard
// ---------------------------------------------------------------------------

describe("deactivateBcpReadOnly", () => {
  it("refuses to clear a QUORUM_LOSS_READONLY degradation", async () => {
    const env = makeEnv(d1);
    await degradeToQuorumLossReadOnly(env, "quorum lost");
    await expect(deactivateBcpReadOnly(env)).rejects.toMatchObject({
      reason_code: "SYSTEM_QUORUM_LOSS_READ_ONLY",
    });
    expect((await getSystemMode(d1 as any)).mode).toBe("QUORUM_LOSS_READONLY");
  });
});

// ---------------------------------------------------------------------------
// assertWritable
// ---------------------------------------------------------------------------

describe("assertWritable", () => {
  it("passes in NORMAL and throws the right reason_code per read-only mode", () => {
    expect(() =>
      assertWritable({ mode: "NORMAL", reason: null, activated_at: null, updated_at: "x" })
    ).not.toThrow();

    try {
      assertWritable({ mode: "BCP_READONLY", reason: "x", activated_at: "t", updated_at: "x" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as DomainError).reason_code).toBe("SYSTEM_BCP_READ_ONLY");
    }

    try {
      assertWritable({
        mode: "QUORUM_LOSS_READONLY",
        reason: "x",
        activated_at: "t",
        updated_at: "x",
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as DomainError).reason_code).toBe("SYSTEM_QUORUM_LOSS_READ_ONLY");
      expect((e as DomainError).category).toBe("DOWNSTREAM"); // retryable
    }
  });
});

// ---------------------------------------------------------------------------
// Write enforcement at the lane primitives
// ---------------------------------------------------------------------------

describe("write enforcement under QUORUM_LOSS_READONLY", () => {
  it("transitionWithLog throws SYSTEM_QUORUM_LOSS_READ_ONLY while degraded, resumes after restore", async () => {
    const env = makeEnv(d1);
    const txid = "TX-Q-001";
    insertTx(d1, txid, "RECEIVED");

    await degradeToQuorumLossReadOnly(env, "quorum lost");

    let threw: unknown;
    try {
      await transitionWithLog(d1 as any, {
        txid,
        fromState: "RECEIVED",
        toState: "PRECHECKED",
        eventType: "PreCheckPassed",
      });
    } catch (e) {
      threw = e;
    }
    expect(isDomainError(threw)).toBe(true);
    expect((threw as DomainError).reason_code).toBe("SYSTEM_QUORUM_LOSS_READ_ONLY");

    // The row did not advance and no FinalityLog entry was written for it.
    const row = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind(txid)
      .first<{ state: string }>();
    expect(row!.state).toBe("RECEIVED");
    const fl = await d1
      .prepare(`SELECT COUNT(*) AS n FROM FinalityLog WHERE txid = ?`)
      .bind(txid)
      .first<{ n: number }>();
    expect(fl!.n).toBe(0);

    // Reads still work while degraded.
    expect((await getSystemMode(d1 as any)).mode).toBe("QUORUM_LOSS_READONLY");

    // After quorum recovery, the same transition succeeds.
    await restoreFromQuorumLoss(env);
    const ok = await transitionWithLog(d1 as any, {
      txid,
      fromState: "RECEIVED",
      toState: "PRECHECKED",
      eventType: "PreCheckPassed",
    });
    expect(ok.applied).toBe(true);
    expect(
      (await d1
        .prepare(`SELECT state FROM Transactions WHERE txid=?`)
        .bind(txid)
        .first<{ state: string }>())!.state
    ).toBe("PRECHECKED");
  });

  it("insertTxWithLog, cancelInFlightTx and suspendTx are all refused while degraded", async () => {
    const env = makeEnv(d1);
    const existing = "TX-Q-002";
    insertTx(d1, existing, "RECEIVED");
    await degradeToQuorumLossReadOnly(env, "quorum lost");

    await expect(
      insertTxWithLog(d1 as any, {
        txid: "TX-Q-NEW",
        lane: "EXPRESS",
        initialState: "RECEIVED",
        amount: { value: 1000, currency: "JPY" },
        payerBankId: "001",
        payerAccountHash: "0010000001",
        payeeBankId: "002",
        payeeAccountHash: "0020000001",
        idempotencyKey: "IK-Q-NEW",
        eventType: "PaymentInitiated",
      })
    ).rejects.toMatchObject({ reason_code: "SYSTEM_QUORUM_LOSS_READ_ONLY" });

    await expect(
      cancelInFlightTx(d1 as any, { txid: existing, reasonCode: "TEST_CANCEL" })
    ).rejects.toMatchObject({ reason_code: "SYSTEM_QUORUM_LOSS_READ_ONLY" });

    await expect(suspendTx(existing, "TEST_SUSPEND", d1 as any)).rejects.toMatchObject({
      reason_code: "SYSTEM_QUORUM_LOSS_READ_ONLY",
    });

    // The new row was never created.
    const newRow = await d1
      .prepare(`SELECT COUNT(*) AS n FROM Transactions WHERE txid = 'TX-Q-NEW'`)
      .first<{ n: number }>();
    expect(newRow!.n).toBe(0);
  });
});
