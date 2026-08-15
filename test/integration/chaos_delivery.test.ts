/**
 * @file chaos_delivery.test.ts — Adversarial queue-delivery harness.
 *
 * Motivation (see docs/specs/30_internal_design.md "提言アンサーソング" roadmap): every
 * existing end-to-end test (balance_invariants.test.ts) drives the orchestrator
 * with a *cooperative* `drain` helper — each produced message is delivered
 * exactly once, in FIFO order, with no duplicates, drops, or reordering. That
 * is a saint, not a real queue.
 *
 * Cloudflare Queues — and any real external settlement callback (IGS_BOJ /
 * onchain Watcher) — are **at-least-once**: the same message can be delivered
 * twice, out of order, or redelivered after a transient consumer failure. The
 * single most dangerous realistic failure for a payment system is a *duplicate*
 * `execute-credit` / `credit-notify` / IGS callback that double-applies money.
 *
 * This harness replaces the saint driver with an adversary and asserts that the
 * SAME invariants the cooperative tests rely on still hold:
 *   - payer Δ == -amount, payee Δ == +amount  (credited EXACTLY once)
 *   - per-bank ledger zero-sum
 *   - duplicate delivery is a benign no-op, NOT a throw (a throwing consumer on
 *     a duplicate would poison the queue / retry forever)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { processExpress } from "../../src/zc/lanes/express";
import { advanceHighValue } from "../../src/zc/lanes/highvalue";
import { registerGtid, advanceGtid } from "../../src/zc/lanes/gtid";
import { processQueueMessage, checkAndFinalizeGtid } from "../../src/zc/orchestrator";
import { runTimeoutSweep } from "../../src/cron/timeout_sweep";

const BANK_A = "001";
const BANK_B = "002";
const ACC_A = "0010000001";
const ACC_B = "0020000001";
const ACC_A2 = "0010000002";
const ACC_B2 = "0020000002";
const SEED_BAL = 1_000_000;

interface TestEnv {
  DB: MockD1Database;
  QUEUE: { _sink: any[]; send: (m: any) => Promise<void> };
  ZC_HMAC_SECRET: string;
}

function makeEnv(db: MockD1Database): TestEnv {
  const sink: any[] = [];
  return {
    DB: db,
    QUEUE: {
      _sink: sink,
      send: async (m: any) => {
        sink.push(m);
      },
    },
    ZC_HMAC_SECRET: "test-secret",
  };
}

function seedParticipant(db: MockD1Database, bankId: string, hLimit = 100_000_000) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', ?, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId, hLimit)
    ._runSync();
}

function insertReceivedTx(db: MockD1Database, txid: string, amount: number, lane = "EXPRESS") {
  db.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash,
      payee_bank_id, payee_account_hash, pspr_ref, idempotency_key, schema_version,
      version, created_at, updated_at)
     VALUES (?, ?, 'RECEIVED', ?, 'JPY', ?, ?, ?, ?, NULL, ?, '1.0', 0,
             '2025-06-01T12:00:00Z', '2025-06-01T12:00:00Z')`
  )
    .bind(txid, lane, amount, BANK_A, ACC_A, BANK_B, ACC_B, `IK-${txid}`)
    ._runSync();
}

async function balanceOf(db: MockD1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ?`)
    .bind(accountId)
    .first<{ b: number }>();
  return row?.b ?? 0;
}

async function bankSum(db: MockD1Database, bankId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE bank_id = ?`)
    .bind(bankId)
    .first<{ b: number }>();
  return row?.b ?? 0;
}

type DeliveryPolicy = (batch: any[]) => any[];

/**
 * Adversarial drain. Each "round" takes every currently-queued message and runs
 * it through `policy` to produce a (possibly duplicated/reordered) delivery
 * schedule. Throws raised by `processQueueMessage` are collected, not swallowed
 * into a hard failure — a duplicate that throws is itself a finding the caller
 * asserts on.
 */
async function drainChaos(
  env: TestEnv,
  policy: DeliveryPolicy,
  max = 400
): Promise<{ processed: number; errors: Error[] }> {
  let processed = 0;
  const errors: Error[] = [];
  while (env.QUEUE._sink.length > 0 && processed < max) {
    const batch = env.QUEUE._sink.splice(0);
    for (const msg of policy(batch)) {
      try {
        await processQueueMessage(msg, env as any);
      } catch (e) {
        errors.push(e as Error);
      }
      processed++;
      if (processed >= max) break;
    }
  }
  if (processed >= max)
    throw new Error("drainChaos: did not converge (likely a duplicate re-fanning out forever)");
  return { processed, errors };
}

/** Deliver every message twice, in original order — at-least-once. */
const atLeastOnce: DeliveryPolicy = (batch) => batch.flatMap((m) => [m, m]);

/** At-least-once AND reversed within each round — duplicates + reordering. */
const atLeastOnceReversed: DeliveryPolicy = (batch) => batch.flatMap((m) => [m, m]).reverse();

let d1: MockD1Database;
beforeEach(() => {
  ({ d1 } = createTestDb());
  seedParticipant(d1, BANK_A);
  seedParticipant(d1, BANK_B);
});

describe("chaos: at-least-once queue delivery (every message delivered twice)", () => {
  it("EXPRESS credits the payee exactly once and never throws on the duplicate", async () => {
    const env = makeEnv(d1);
    const amount = 50_000;
    insertReceivedTx(d1, "TX-CHAOS-DUP-001", amount);

    const res = await processExpress(
      {
        txid: "TX-CHAOS-DUP-001",
        lane: "EXPRESS",
        amount: { value: amount, currency: "JPY" },
        payer: { bank_id: BANK_A, account_hash: ACC_A },
        payee: { bank_id: BANK_B, account_hash: ACC_B },
      } as any,
      env as any
    );
    expect(res.result).toBe("DECISION_ACCEPTED");

    const { errors } = await drainChaos(env, atLeastOnce);

    // 1. A duplicate delivery must be a benign no-op, not a throw (a throwing
    //    consumer on a duplicate poisons the queue / retries forever).
    expect(errors, errors.map((e) => e.message).join("\n")).toEqual([]);

    // 2. Money moved exactly once despite every message arriving twice.
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);

    // 3. Per-bank double-entry zero-sum survives.
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);

    // 4. Exactly one positive settlement journal on the payee for this txid.
    const c = await d1
      .prepare(
        `SELECT COUNT(*) AS c FROM BankJournals WHERE account_id = ? AND txid = ? AND amount > 0`
      )
      .bind(ACC_B, "TX-CHAOS-DUP-001")
      .first<{ c: number }>();
    expect(c?.c).toBe(1);
  });
});

/**
 * Probe #4 — the (ハ) two-ledger in-doubt race.
 *
 * A HIGH_VALUE tx settles via IGS/BOJ: ZC_BANK_DEBIT moves it to
 * PAYER_EXEC_CONFIRMED with `external_settlement_status='REQUESTED'`, then the
 * BOJ settlement callback (ZC_IGS_CALLBACK = SETTLED) credits the payee and
 * reaches SETTLED.
 *
 * The cooperative driver fires that callback ~immediately, so the tx is never
 * observed *waiting* on BOJ while the clock advances. But RTGS settlement at a
 * real central bank can lag (queueing, throttling, an operational stall). If
 * the payee-proof timeout sweep fires DURING that window, ZC must not give up
 * on a tx whose money leg is still in flight at the central bank — otherwise
 * BOJ settles a tx that ZC has already abandoned: payer debited, BOJ moved,
 * payee never credited. That divergence is exactly the in-doubt failure the
 * whole "finality is external" design has to survive.
 */
describe("chaos: IGS/BOJ settlement lags past the payee-proof timeout (in-doubt)", () => {
  it("does not abandon a tx whose BOJ settlement is still in flight, then settles it on the late callback", async () => {
    const env = makeEnv(d1);
    const amount = 800_000; // < seeded BOJ pre-fund (10M each side)
    insertReceivedTx(d1, "TX-CHAOS-INDOUBT-001", amount, "HIGH_VALUE");

    // Drive to PAYER_EXEC_CONFIRMED + external_settlement_status='REQUESTED'.
    // Process ONLY the ZC_BANK_DEBIT so the ZC_IGS_CALLBACK stays parked in the
    // queue — simulating a BOJ callback that has not arrived yet.
    await advanceHighValue("TX-CHAOS-INDOUBT-001", env as any);
    const debit = env.QUEUE._sink.shift(); // ZC_BANK_DEBIT
    expect(debit?.type).toBe("ZC_BANK_DEBIT");
    await processQueueMessage(debit, env as any);

    const mid = await d1
      .prepare(`SELECT state, external_settlement_status FROM Transactions WHERE txid=?`)
      .bind("TX-CHAOS-INDOUBT-001")
      .first<{ state: string; external_settlement_status: string | null }>();
    expect(mid?.state).toBe("PAYER_EXEC_CONFIRMED");
    expect(mid?.external_settlement_status).toBe("REQUESTED");
    // The BOJ callback is sitting un-delivered (BOJ is slow).
    expect(env.QUEUE._sink.some((m) => m.type === "ZC_IGS_CALLBACK")).toBe(true);

    // BOJ takes longer than the 5-minute payee-proof timeout: age the row.
    d1.prepare(`UPDATE Transactions SET updated_at='2025-06-01T11:00:00Z' WHERE txid=?`)
      .bind("TX-CHAOS-INDOUBT-001")
      ._runSync();

    // The payee-proof timeout sweep fires while BOJ is still settling.
    await runTimeoutSweep(env as any);

    const afterSweep = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid=?`)
      .bind("TX-CHAOS-INDOUBT-001")
      .first<{ state: string }>();
    // A tx whose money leg is still in flight at BOJ must NOT be abandoned by
    // the payee-proof timeout — its lifecycle is governed by the IGS callback.
    expect(afterSweep?.state).not.toBe("SUSPENDED");

    // Now the lagging BOJ SETTLED callback finally arrives. It must complete the
    // settlement, not be rejected because ZC already moved the tx.
    let n = 0;
    while (env.QUEUE._sink.length > 0 && n < 50) {
      await processQueueMessage(env.QUEUE._sink.shift(), env as any);
      n++;
    }

    const final = await d1
      .prepare(`SELECT state, external_settlement_status FROM Transactions WHERE txid=?`)
      .bind("TX-CHAOS-INDOUBT-001")
      .first<{ state: string; external_settlement_status: string | null }>();
    expect(final?.state).toBe("SETTLED");
    expect(final?.external_settlement_status).toBe("SETTLED");

    // No divergence: BOJ settled AND the payee actually received the money.
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);
  });
});

/**
 * Probe #2 — GTID (取引連携型決済モデル) under at-least-once delivery.
 *
 * GTID is the proposal's flagship "transaction-linked" model: multiple legs
 * bound by one coordinated Decision, each leg settling through the standard
 * execute-debit/credit path. Two extra failure surfaces beyond a single tx:
 *   - a duplicated leg credit/debit could double-post that leg, and
 *   - GTID completion (`checkAndFinalizeGtid`) is re-entrant — it can be
 *     triggered by each leg's credit, so it must be idempotent under repeats.
 */
describe("chaos: GTID 1×1 under at-least-once delivery", () => {
  it("settles each leg exactly once and finalizes idempotently despite duplicate delivery", async () => {
    const env = makeEnv(d1);
    const amount = 60_000;

    await registerGtid(
      {
        gtid: "GT-CHAOS-001",
        idempotency_key: "IK-GT-CHAOS-001",
        expires_at: "2099-12-31T00:00:00Z",
        legs: [
          {
            leg_id: "GT-CHAOS-001-A",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A,
            amount: { value: amount, currency: "JPY" },
          },
          {
            leg_id: "GT-CHAOS-001-B",
            role: "PAYEE",
            bank_id: BANK_B,
            account_hash: ACC_B,
            amount: { value: amount, currency: "JPY" },
          },
        ],
      } as any,
      env as any
    );
    await advanceGtid("GT-CHAOS-001", env as any);

    // Every fanned-out leg message delivered twice.
    const { errors } = await drainChaos(env, atLeastOnce);
    expect(errors, errors.map((e) => e.message).join("\n")).toEqual([]);

    // GTID finalization is re-entrant in production (fired per leg credit);
    // calling it repeatedly must not double-anything.
    await checkAndFinalizeGtid("GT-CHAOS-001", d1 as any);
    await checkAndFinalizeGtid("GT-CHAOS-001", d1 as any);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-CHAOS-001")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SETTLED");

    // Money moved exactly once despite duplicate delivery + repeated finalize.
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);

    // Exactly one positive settlement journal on the payee leg.
    const c = await d1
      .prepare(
        `SELECT COUNT(*) AS c FROM BankJournals WHERE account_id=? AND amount>0 AND tx_group_id LIKE '%GT-CHAOS-001%'`
      )
      .bind(ACC_B)
      .first<{ c: number }>();
    expect(c?.c).toBe(1);
  });
});

/**
 * Probe #2b — GTID 2×2 under at-least-once AND reordered delivery.
 *
 * The 2×2 case carries the leg_id-sorted pairing contract (PAYER A↔PAYEE A,
 * PAYER B↔PAYEE B by leg_id rank, regardless of insertion order). Here we add
 * adversity on top: every leg message is delivered twice and in reversed order.
 * A mis-pairing or a duplicate leg credit would land money in the wrong account
 * or double it. Correct ending balances must be amount-exact under the chaos.
 */
describe("chaos: GTID 2×2 under at-least-once + reordered delivery", () => {
  it("preserves leg_id pairing and exact balances despite duplicates and reordering", async () => {
    const env = makeEnv(d1);
    const amtSmall = 10_000;
    const amtLarge = 90_000;

    // PAYEEs inserted in reverse leg_id order relative to PAYERs (same as the
    // pairing regression test), so the pairing fix is exercised under chaos.
    await registerGtid(
      {
        gtid: "GT-CHAOS-2X2",
        idempotency_key: "IK-GT-CHAOS-2X2",
        expires_at: "2099-12-31T00:00:00Z",
        legs: [
          {
            leg_id: "GT-C2-A",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A,
            amount: { value: amtSmall, currency: "JPY" },
          },
          {
            leg_id: "GT-C2-B",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A2,
            amount: { value: amtLarge, currency: "JPY" },
          },
          {
            leg_id: "GT-C2-Z-PAYEE-B",
            role: "PAYEE",
            bank_id: BANK_B,
            account_hash: ACC_B2,
            amount: { value: amtLarge, currency: "JPY" },
          },
          {
            leg_id: "GT-C2-A-PAYEE-A",
            role: "PAYEE",
            bank_id: BANK_B,
            account_hash: ACC_B,
            amount: { value: amtSmall, currency: "JPY" },
          },
        ],
      } as any,
      env as any
    );
    await advanceGtid("GT-CHAOS-2X2", env as any);

    const { errors } = await drainChaos(env, atLeastOnceReversed);
    expect(errors, errors.map((e) => e.message).join("\n")).toEqual([]);

    await checkAndFinalizeGtid("GT-CHAOS-2X2", d1 as any);
    await checkAndFinalizeGtid("GT-CHAOS-2X2", d1 as any);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-CHAOS-2X2")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SETTLED");

    // Pairing by leg_id rank must hold: small PAYER → small PAYEE (ACC_B),
    // large PAYER → large PAYEE (ACC_B2). Duplicates must not double-credit.
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amtSmall);
    expect(await balanceOf(d1, ACC_A2)).toBe(SEED_BAL - amtLarge);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amtSmall);
    expect(await balanceOf(d1, ACC_B2)).toBe(SEED_BAL + amtLarge);
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);
  });
});

/**
 * Probe #4c — contradictory BOJ callback after finality.
 *
 * Once an IGS/BOJ settlement is confirmed SETTLED and the tx reaches SETTLED,
 * a *contradictory* late callback (a duplicate that flips to FAILED — a buggy
 * or replayed BOJ message) must be ignored. If it were honoured it would
 * reverse or double a finalized settlement: the worst kind of two-ledger
 * divergence, one that happens AFTER the irreversible point. The status guard
 * (`IgsRequests.status != 'REQUESTED'`) is what has to hold.
 */
describe("chaos: contradictory BOJ callback after the tx is already SETTLED", () => {
  it("ignores a late FAILED that contradicts a finalized SETTLED", async () => {
    const env = makeEnv(d1);
    const amount = 800_000;
    insertReceivedTx(d1, "TX-CHAOS-CONTRA-001", amount, "HIGH_VALUE");

    await advanceHighValue("TX-CHAOS-CONTRA-001", env as any);
    const debit = env.QUEUE._sink.shift();
    await processQueueMessage(debit, env as any);

    // Grab the parked BOJ callback to learn its ext_instruction_id.
    const cb = env.QUEUE._sink.find((m) => m.type === "ZC_IGS_CALLBACK");
    expect(cb).toBeTruthy();
    const extId = cb.payload.ext_instruction_id as string;

    // Deliver the real SETTLED and drain the credit it fans out → SETTLED.
    let n = 0;
    while (env.QUEUE._sink.length > 0 && n < 50) {
      await processQueueMessage(env.QUEUE._sink.shift(), env as any);
      n++;
    }
    const mid = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid=?`)
      .bind("TX-CHAOS-CONTRA-001")
      .first<{ state: string }>();
    expect(mid?.state).toBe("SETTLED");
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);

    // Now a contradictory late callback for the same settlement: FAILED.
    await processQueueMessage(
      {
        type: "ZC_IGS_CALLBACK",
        payload: { ext_instruction_id: extId, result: "FAILED", reason: "BOJ_CONTRADICTION" },
        txid: "TX-CHAOS-CONTRA-001",
        attempt: 0,
        enqueued_at: "2025-06-01T13:00:00Z",
      } as any,
      env as any
    );

    // The finalized settlement is untouched: state, balances and IgsRequests
    // all stay SETTLED; the contradiction is a no-op.
    const fin = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid=?`)
      .bind("TX-CHAOS-CONTRA-001")
      .first<{ state: string }>();
    expect(fin?.state).toBe("SETTLED");
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);

    const igs = await d1
      .prepare(`SELECT status FROM IgsRequests WHERE ext_instruction_id=?`)
      .bind(extId)
      .first<{ status: string }>();
    expect(igs?.status).toBe("SETTLED");
  });
});
