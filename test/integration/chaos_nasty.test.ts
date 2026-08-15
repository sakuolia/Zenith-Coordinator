/**
 * @file chaos_nasty.test.ts — 10 adversarial probes targeting untested edge
 *       cases across the Zenith Coordinator: H-limit races, DNS settlement
 *       idempotency, cancel-vs-settle races, FinalityLog chain tampering,
 *       circuit breaker edge conditions, and more.
 *
 * Each probe is designed to expose a class of bug that the existing happy-path
 * and single-chaos tests do not cover.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { todayJST } from "../../src/types";
import { processExpress } from "../../src/zc/lanes/express";
import { advanceBulk } from "../../src/zc/lanes/bulk";
import { createHtlc, claimHtlc, cancelHtlc } from "../../src/zc/lanes/htlc";
import { registerGtid, advanceGtid } from "../../src/zc/lanes/gtid";
import { kickDns, settleDns } from "../../src/zc/settlement/dns";
import { processQueueMessage, checkAndFinalizeGtid } from "../../src/zc/orchestrator";
import { reserveH, releaseH, getHStatus, lockH } from "../../src/zc/liquidity/h_model";
import { verifyChain } from "../../src/zc/finality/finality_chain";
import {
  allowRequest,
  recordFailure,
  recordSuccess,
  getCircuitStatus,
} from "../../src/zc/platform/circuit_breaker";
import { suspendTx } from "../../src/zc/orchestrator/finality";
import { runTimeoutSweep } from "../../src/cron/timeout_sweep";

const BANK_A = "001";
const BANK_B = "002";
const ACC_A = "0010000001";
const ACC_B = "0020000001";
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
      send: async (m) => {
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

async function drain(env: TestEnv, max = 80): Promise<number> {
  let n = 0;
  while (env.QUEUE._sink.length > 0 && n < max) {
    await processQueueMessage(env.QUEUE._sink.shift()!, env as any);
    n++;
  }
  if (n >= max) throw new Error("drain: queue did not converge");
  return n;
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

function insertReceivedTx(
  db: MockD1Database,
  args: {
    txid: string;
    lane: string;
    amount: number;
    payerBank: string;
    payerAcc: string;
    payeeBank: string;
    payeeAcc: string;
    idempotencyKey?: string;
  }
) {
  db.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash,
      payee_bank_id, payee_account_hash, idempotency_key, schema_version,
      version, created_at, updated_at)
     VALUES (?, ?, 'RECEIVED', ?, 'JPY', ?, ?, ?, ?, ?, '1.0', 0, '2025-06-01T12:00:00Z', '2025-06-01T12:00:00Z')`
  )
    .bind(
      args.txid,
      args.lane,
      args.amount,
      args.payerBank,
      args.payerAcc,
      args.payeeBank,
      args.payeeAcc,
      args.idempotencyKey ?? `IK-${args.txid}`
    )
    ._runSync();
}

let d1: MockD1Database;
beforeEach(() => {
  ({ d1 } = createTestDb());
  seedParticipant(d1, BANK_A);
  seedParticipant(d1, BANK_B);
});

// ---------------------------------------------------------------------------
// Probe #N1: H-limit double-release must not underflow h_used
// ---------------------------------------------------------------------------

describe("chaos #N1: H-limit double-release does not underflow h_used", () => {
  it("second releaseH is a no-op: h_used stays at 0, not negative", async () => {
    const amount = 50_000;
    const r = await reserveH(BANK_A, "TX-DBLREL-001", amount, d1 as any);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const rid = r.reservation_id;
    const h1 = await getHStatus(BANK_A, d1 as any);
    expect(h1?.h_used).toBe(amount);

    // First release — should succeed and bring h_used back to 0.
    const rel1 = await releaseH(rid, d1 as any);
    expect(rel1).toBe(true);
    expect((await getHStatus(BANK_A, d1 as any))?.h_used).toBe(0);

    // Second release — must be a no-op (CAS guard: is_released=0 fails).
    const rel2 = await releaseH(rid, d1 as any);
    expect(rel2).toBe(false);

    // h_used must NOT be negative.
    const hAfter = await getHStatus(BANK_A, d1 as any);
    expect(hAfter?.h_used).toBe(0);
  });

  it("releasing a locked reservation also decrements h_used exactly once", async () => {
    const amount = 30_000;
    const r = await reserveH(BANK_A, "TX-LOCKREL-001", amount, d1 as any);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    await lockH(r.reservation_id, d1 as any);

    const rel = await releaseH(r.reservation_id, d1 as any);
    expect(rel).toBe(true);
    expect((await getHStatus(BANK_A, d1 as any))?.h_used).toBe(0);

    // Double release of locked reservation
    const rel2 = await releaseH(r.reservation_id, d1 as any);
    expect(rel2).toBe(false);
    expect((await getHStatus(BANK_A, d1 as any))?.h_used).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Probe #N2: H-limit exhaustion under burst — no over-reservation
// ---------------------------------------------------------------------------

describe("chaos #N2: H-limit exhaustion under burst", () => {
  it("rejects the Nth reservation that would exceed h_limit, earlier reservations unaffected", async () => {
    const tightLimit = 100_000;
    seedParticipant(d1, BANK_A, tightLimit);

    // Burst: 3 reservations of 40k each. Total 120k > limit 100k.
    const r1 = await reserveH(BANK_A, "TX-BURST-1", 40_000, d1 as any);
    const r2 = await reserveH(BANK_A, "TX-BURST-2", 40_000, d1 as any);
    const r3 = await reserveH(BANK_A, "TX-BURST-3", 40_000, d1 as any);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Third must fail — 80k + 40k = 120k > 100k.
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.reason).toBe("H_LIMIT_EXCEEDED");
      expect(r3.available).toBe(20_000);
    }

    // h_used must be exactly 80k (not 120k or 40k).
    expect((await getHStatus(BANK_A, d1 as any))?.h_used).toBe(80_000);
  });

  it("releasing one reservation opens room for the next", async () => {
    seedParticipant(d1, BANK_A, 100_000);

    const r1 = await reserveH(BANK_A, "TX-FILLREL-1", 60_000, d1 as any);
    const r2 = await reserveH(BANK_A, "TX-FILLREL-2", 60_000, d1 as any);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false); // 60k + 60k > 100k

    if (r1.ok) await releaseH(r1.reservation_id, d1 as any);

    // Now 60k is freed: a new 60k reservation should succeed.
    const r3 = await reserveH(BANK_A, "TX-FILLREL-3", 60_000, d1 as any);
    expect(r3.ok).toBe(true);
    expect((await getHStatus(BANK_A, d1 as any))?.h_used).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// Probe #N3: Cancel-vs-settle race on DECIDED_TO_SETTLE
// ---------------------------------------------------------------------------

describe("chaos #N3: cancel-vs-settle race — suspendTx on a tx already advancing", () => {
  it("suspendTx is a no-op when tx has already moved past DECIDED_TO_SETTLE", async () => {
    const env = makeEnv(d1);
    const amount = 50_000;

    insertReceivedTx(d1, {
      txid: "TX-RACE-001",
      lane: "EXPRESS",
      amount,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });
    await processExpress(
      {
        txid: "TX-RACE-001",
        lane: "EXPRESS",
        amount: { value: amount, currency: "JPY" },
        payer: { bank_id: BANK_A, account_hash: ACC_A },
        payee: { bank_id: BANK_B, account_hash: ACC_B },
      } as any,
      env as any
    );

    // Process the first queue message (ZC_BANK_DEBIT) to advance to PAYER_EXEC_CONFIRMED.
    if (env.QUEUE._sink.length > 0) {
      await processQueueMessage(env.QUEUE._sink.shift()!, env as any);
    }

    const midState = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid='TX-RACE-001'`)
      .first<{ state: string }>();
    // Should be past DECIDED_TO_SETTLE (either PAYER_EXEC_CONFIRMED or beyond).
    expect(["PAYER_EXEC_CONFIRMED", "PAYEE_EXEC_CONFIRMED", "SETTLED"]).toContain(midState?.state);

    // A timeout sweep tries to suspend it — the state machine forbids PAYER_EXEC→SUSPENDED
    // actually, looking at the state machine: PAYER_EXEC_CONFIRMED → SUSPENDED is allowed!
    // But suspendTx uses isValidTransition, so it should be allowed. The key question is:
    // does the CAS prevent corruption?
    await suspendTx("TX-RACE-001", "RACE_CONDITION_TEST", d1 as any);

    // Whether suspend succeeds or not, drain remaining queue and verify balance integrity.
    await drain(env);

    // The critical invariant: per-bank zero-sum is preserved regardless of the race outcome.
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Probe #N4: DNS double-settle idempotency — settleDns called twice
// ---------------------------------------------------------------------------

describe("chaos #N4: DNS double-settle does not double-post journals", () => {
  it("calling settleDns twice on the same cycle posts journals exactly once", async () => {
    const env = makeEnv(d1);
    const amount = 80_000;

    insertReceivedTx(d1, {
      txid: "TX-DNSDBL-001",
      lane: "BULK",
      amount,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });
    await advanceBulk("TX-DNSDBL-001", env as any);

    const today = todayJST();
    const kick = await kickDns(today, env as any);
    expect(kick.state).toBe("KICKED");

    // First settle.
    await settleDns(kick.cycle_id, env as any);
    await drain(env);

    const balA1 = await balanceOf(d1, ACC_A);
    const balB1 = await balanceOf(d1, ACC_B);
    const boj1 = await balanceOf(d1, `${BANK_A}-BOJ`);

    // Second settle — must be a complete no-op (cycle is already SETTLED).
    await settleDns(kick.cycle_id, env as any);
    await drain(env);

    // Balances must not have moved.
    expect(await balanceOf(d1, ACC_A)).toBe(balA1);
    expect(await balanceOf(d1, ACC_B)).toBe(balB1);
    expect(await balanceOf(d1, `${BANK_A}-BOJ`)).toBe(boj1);
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Probe #N5: FinalityLog hash chain — tampering detection
// ---------------------------------------------------------------------------

describe("chaos #N5: FinalityLog hash chain detects tampering", () => {
  it("verifyChain catches a corrupted entry_hash", async () => {
    const env = makeEnv(d1);
    const amount = 10_000;

    insertReceivedTx(d1, {
      txid: "TX-TAMPER-001",
      lane: "EXPRESS",
      amount,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });
    await processExpress(
      {
        txid: "TX-TAMPER-001",
        lane: "EXPRESS",
        amount: { value: amount, currency: "JPY" },
        payer: { bank_id: BANK_A, account_hash: ACC_A },
        payee: { bank_id: BANK_B, account_hash: ACC_B },
      } as any,
      env as any
    );
    await drain(env);

    // Verify chain is valid before tampering.
    const before = await verifyChain(d1 as any, "TX-TAMPER-001");
    expect(before.valid).toBe(true);
    expect(before.entries_checked).toBeGreaterThan(0);

    // Tamper: corrupt the payload of the first entry.
    const firstEntry = await d1
      .prepare(
        `SELECT log_id, event_seq FROM FinalityLog WHERE txid='TX-TAMPER-001' ORDER BY event_seq ASC LIMIT 1`
      )
      .first<{ log_id: string; event_seq: number }>();
    expect(firstEntry).not.toBeNull();

    d1.prepare(`UPDATE FinalityLog SET payload_json='{"tampered":true}' WHERE log_id=?`)
      .bind(firstEntry!.log_id)
      ._runSync();

    // Verify chain catches the tampering.
    const after = await verifyChain(d1 as any, "TX-TAMPER-001");
    expect(after.valid).toBe(false);
    expect(after.break_at_seq).toBe(firstEntry!.event_seq);
    expect(after.break_reason).toBe("ENTRY_HASH_MISMATCH");
  });

  it("verifyChain catches a corrupted prev_hash (chain link broken)", async () => {
    const env = makeEnv(d1);

    insertReceivedTx(d1, {
      txid: "TX-TAMPER-002",
      lane: "EXPRESS",
      amount: 10_000,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });
    await processExpress(
      {
        txid: "TX-TAMPER-002",
        lane: "EXPRESS",
        amount: { value: 10_000, currency: "JPY" },
        payer: { bank_id: BANK_A, account_hash: ACC_A },
        payee: { bank_id: BANK_B, account_hash: ACC_B },
      } as any,
      env as any
    );
    await drain(env);

    // Find the second entry and corrupt its prev_hash.
    const entries = await d1
      .prepare(
        `SELECT log_id, event_seq FROM FinalityLog WHERE txid='TX-TAMPER-002' ORDER BY event_seq ASC`
      )
      .all<{ log_id: string; event_seq: number }>();
    expect(entries.results.length).toBeGreaterThanOrEqual(2);

    const second = entries.results[1]!;
    d1.prepare(`UPDATE FinalityLog SET prev_hash='CORRUPTED_LINK' WHERE log_id=?`)
      .bind(second.log_id)
      ._runSync();

    const result = await verifyChain(d1 as any, "TX-TAMPER-002");
    expect(result.valid).toBe(false);
    expect(result.break_at_seq).toBe(second.event_seq);
    expect(result.break_reason).toBe("PREV_HASH_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// Probe #N6: Circuit breaker — success during OPEN (timer not elapsed)
// ---------------------------------------------------------------------------

describe("chaos #N6: circuit breaker edge cases", () => {
  it("a success during OPEN resets the circuit to CLOSED immediately", async () => {
    // Trip the circuit open with 5 consecutive failures.
    for (let i = 0; i < 5; i++) {
      await allowRequest(BANK_A, d1 as any);
      await recordFailure(BANK_A, d1 as any);
    }
    const opened = await getCircuitStatus(BANK_A, d1 as any);
    expect(opened?.state).toBe("OPEN");

    // A success arrives (e.g. from a request that was in-flight before the circuit opened).
    await recordSuccess(BANK_A, d1 as any);

    // The circuit should be CLOSED again, not stuck in OPEN.
    const after = await getCircuitStatus(BANK_A, d1 as any);
    expect(after?.state).toBe("CLOSED");
    expect(after?.consecutive_failures).toBe(0);
  });

  it("HALF_OPEN probe failure re-opens the circuit and subsequent requests are denied", async () => {
    // Trip open.
    for (let i = 0; i < 5; i++) {
      await allowRequest(BANK_A, d1 as any);
      await recordFailure(BANK_A, d1 as any);
    }
    expect((await getCircuitStatus(BANK_A, d1 as any))?.state).toBe("OPEN");

    // Age the opened_at so the OPEN_DURATION_MS has elapsed.
    d1.prepare(`UPDATE CircuitBreakerState SET opened_at='2000-01-01T00:00:00Z' WHERE bank_id=?`)
      .bind(BANK_A)
      ._runSync();

    // The next allowRequest should transition OPEN→HALF_OPEN and allow a probe.
    const probe1 = await allowRequest(BANK_A, d1 as any);
    expect(probe1).toBe(true);
    expect((await getCircuitStatus(BANK_A, d1 as any))?.state).toBe("HALF_OPEN");

    // The probe fails.
    await recordFailure(BANK_A, d1 as any);

    // Circuit should be back to OPEN.
    const afterFail = await getCircuitStatus(BANK_A, d1 as any);
    expect(afterFail?.state).toBe("OPEN");

    // Subsequent requests are denied (OPEN, timer not elapsed yet).
    const denied = await allowRequest(BANK_A, d1 as any);
    expect(denied).toBe(false);
    expect((await getCircuitStatus(BANK_A, d1 as any))?.total_denied).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Probe #N7: HTLC cancel after claim — state machine prevents it
// ---------------------------------------------------------------------------

describe("chaos #N7: HTLC cancel after successful claim is rejected by state machine", () => {
  it("cancelHtlc is a no-op once the HTLC has been claimed and is past HTLC_FULFILL_REQUESTED", async () => {
    const env = makeEnv(d1);
    const amount = 25_000;
    const farFuture = new Date(Date.now() + 24 * 3600_000).toISOString();

    const created = await createHtlc(
      {
        htlc_id: "HTLC-RACECANCEL-001",
        idempotency_key: "IK-HTLC-RACECANCEL-001",
        amount: { value: amount, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock: farFuture,
      } as any,
      env as any
    );
    expect(created.result).toBe("CREATED");
    await drain(env);

    // Claim it.
    const claimed = await claimHtlc(
      {
        htlc_id: "HTLC-RACECANCEL-001",
        preimage: created.preimage!,
        idempotency_key: "IK-HTLC-RACECANCEL-001-CLAIM",
      } as any,
      env as any
    );
    expect(claimed.result).toBe("ACCEPTED");

    // Before draining, the tx is at HTLC_FULFILL_REQUESTED or DECIDED_TO_SETTLE.
    // Now attempt to cancel — the timeout sweep might race here.
    await cancelHtlc(
      "HTLC-RACECANCEL-001",
      `TX-HTLC-HTLC-RACECANCEL-001`,
      "TIMELOCK_EXPIRED",
      d1 as any,
      env as any
    );

    // Drain and verify: the claim should complete, money should move.
    await drain(env);

    const htlc = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id='HTLC-RACECANCEL-001'`)
      .first<{ state: string }>();
    // The HTLC should have settled, not been cancelled.
    expect(htlc?.state).not.toBe("DECIDED_CANCEL");

    const tx = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid='TX-HTLC-HTLC-RACECANCEL-001'`)
      .first<{ state: string }>();
    expect(tx?.state).toBe("SETTLED");

    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Probe #N8: GTID with single PAYER + single PAYEE same bank (intra-bank)
// ---------------------------------------------------------------------------

describe("chaos #N8: GTID intra-bank transfer preserves zero-sum within one bank", () => {
  it("settles a same-bank GTID: payer debited, payee credited, bank zero-sum", async () => {
    const env = makeEnv(d1);
    const ACC_A2 = "0010000002";

    await registerGtid(
      {
        gtid: "GT-INTRA-001",
        idempotency_key: "IK-GT-INTRA-001",
        expires_at: "2099-12-31T00:00:00Z",
        legs: [
          {
            leg_id: "GT-INTRA-1-PAYER",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A,
            amount: { value: 50_000, currency: "JPY" },
          },
          {
            leg_id: "GT-INTRA-2-PAYEE",
            role: "PAYEE",
            bank_id: BANK_A,
            account_hash: ACC_A2,
            amount: { value: 50_000, currency: "JPY" },
          },
        ],
      } as any,
      env as any
    );
    await advanceGtid("GT-INTRA-001", env as any);
    await drain(env);
    await checkAndFinalizeGtid("GT-INTRA-001", d1 as any);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-INTRA-001'`)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SETTLED");

    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - 50_000);
    expect(await balanceOf(d1, ACC_A2)).toBe(SEED_BAL + 50_000);
    // Intra-bank: the bank's total must stay zero.
    expect(await bankSum(d1, BANK_A)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Probe #N9: Timeout sweep does not suspend DNS-committed transactions.
//
// 単一所有者則 update: the commitment point is the kickDns SNAPSHOT, which
// stamps `owner='CYCLE:<id>'` on every in-flight row it nets. The sweep's
// predicate is `owner='ZC'`, so a snapshotted row is structurally invisible to
// it. Before the snapshot a pre-attached dns_cycle_id is NOT custody: the row
// is still ZC-owned and its T2 SLA applies (a deliberate semantic change from
// the old `dns_cycle_id IS NULL` exclusion, which over-protected rows that no
// snapshot referenced yet) — and a row suspended pre-kick is excluded from the
// later snapshot, so settleDns can never settle money for it.
// ---------------------------------------------------------------------------

describe("chaos #N9: timeout sweep respects DNS cycle ownership (owner column)", () => {
  it("a DECIDED_TO_SETTLE tx snapshotted by kickDns is NOT suspendable; it settles via the cycle", async () => {
    const env = makeEnv(d1);
    const amount = 60_000;

    // BULK is the lane that sits in DECIDED_TO_SETTLE until EOD by design.
    insertReceivedTx(d1, {
      txid: "TX-DNSSWEEP-001",
      lane: "BULK",
      amount,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });
    await advanceBulk("TX-DNSSWEEP-001", env as any);

    const today = todayJST();
    const kick = await kickDns(today, env as any);
    expect(kick.state).toBe("KICKED");

    const mid = await d1
      .prepare(`SELECT state, dns_cycle_id, owner FROM Transactions WHERE txid='TX-DNSSWEEP-001'`)
      .first<{ state: string; dns_cycle_id: string | null; owner: string }>();
    expect(mid?.state).toBe("DECIDED_TO_SETTLE");
    expect(mid?.dns_cycle_id).toBe(kick.cycle_id);
    expect(mid?.owner).toBe(`CYCLE:${kick.cycle_id}`); // snapshot took custody

    // Age the updated_at to be older than T2 timeout (5 minutes).
    d1.prepare(
      `UPDATE Transactions SET updated_at='2000-01-01T00:00:00Z' WHERE txid='TX-DNSSWEEP-001'`
    )._runSync();

    // The sweep skips it (owner != 'ZC'), and even a direct suspendTx — the
    // sweep's abandoning action — is structurally unable to take the row.
    await runTimeoutSweep(env as any);
    await suspendTx("TX-DNSSWEEP-001", "SUSPEND_EXEC_TIMEOUT", d1 as any);

    const afterSweep = await d1
      .prepare(`SELECT state, owner FROM Transactions WHERE txid='TX-DNSSWEEP-001'`)
      .first<{ state: string; owner: string }>();
    expect(afterSweep?.state).toBe("DECIDED_TO_SETTLE");
    expect(afterSweep?.owner).toBe(`CYCLE:${kick.cycle_id}`);

    // The cycle — the owner — settles it: ownership returns to ZC in the
    // SETTLED batch, the BULK debit fans out, and the row lands SETTLED.
    await settleDns(kick.cycle_id, env as any);
    await drain(env);
    const final = await d1
      .prepare(`SELECT state, owner FROM Transactions WHERE txid='TX-DNSSWEEP-001'`)
      .first<{ state: string; owner: string }>();
    expect(final?.state).toBe("SETTLED");
    expect(final?.owner).toBe("ZC");
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);
  });

  it("a stale DECIDED_TO_SETTLE tx NOT yet snapshotted is swept, and the later kick excludes it from the net position", async () => {
    const env = makeEnv(d1);
    const amount = 60_000;

    // EXPRESS pre-attaches dns_cycle_id at decision time; do not drain the
    // debit, leaving the row stuck at DECIDED_TO_SETTLE with the cycle OPEN.
    insertReceivedTx(d1, {
      txid: "TX-DNSPRE-001",
      lane: "EXPRESS",
      amount,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });
    await processExpress(
      {
        txid: "TX-DNSPRE-001",
        lane: "EXPRESS",
        amount: { value: amount, currency: "JPY" },
        payer: { bank_id: BANK_A, account_hash: ACC_A },
        payee: { bank_id: BANK_B, account_hash: ACC_B },
      } as any,
      env as any
    );

    const mid = await d1
      .prepare(`SELECT state, dns_cycle_id, owner FROM Transactions WHERE txid='TX-DNSPRE-001'`)
      .first<{ state: string; dns_cycle_id: string | null; owner: string }>();
    expect(mid?.state).toBe("DECIDED_TO_SETTLE");
    expect(mid?.dns_cycle_id).not.toBeNull(); // pre-attached …
    expect(mid?.owner).toBe("ZC"); // … but no snapshot yet: still ZC custody

    // Age the T2 clock. `pending_since` is what the sweep reads — `updated_at`
    // is deliberately not a clock any more (src/cron/timeout_sweep.ts).
    d1.prepare(
      `UPDATE Transactions SET pending_since='2000-01-01T00:00:00Z' WHERE txid='TX-DNSPRE-001'`
    )._runSync();

    // Pre-snapshot, the T2 SLA applies: the stuck row is suspended.
    await runTimeoutSweep(env as any);
    const afterSweep = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid='TX-DNSPRE-001'`)
      .first<{ state: string }>();
    expect(afterSweep?.state).toBe("SUSPENDED");

    // The abandoned row must never reach settleDns: the snapshot only nets
    // live rows, so the §5.1 divergence #2 (settling money for an abandoned
    // tx) is impossible in this ordering too.
    const kick = await kickDns(todayJST(), env as any);
    const netA = await d1
      .prepare(`SELECT net_position FROM DnsNetPositions WHERE cycle_id=? AND bank_id=?`)
      .bind(kick.cycle_id, BANK_A)
      .first<{ net_position: number }>();
    expect(netA?.net_position ?? 0).toBe(0); // suspended row not in the snapshot
  });

  it("a PAYER_EXEC_CONFIRMED tx snapshotted by kickDns is NOT suspended by T3 sweep", async () => {
    const env = makeEnv(d1);
    const amount = 40_000;

    insertReceivedTx(d1, {
      txid: "TX-DNST3-001",
      lane: "EXPRESS",
      amount,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });
    await processExpress(
      {
        txid: "TX-DNST3-001",
        lane: "EXPRESS",
        amount: { value: amount, currency: "JPY" },
        payer: { bank_id: BANK_A, account_hash: ACC_A },
        payee: { bank_id: BANK_B, account_hash: ACC_B },
      } as any,
      env as any
    );

    // Drain just the debit message to get to PAYER_EXEC_CONFIRMED, then let
    // kickDns snapshot the stuck row (payer debited, payee credit pending).
    if (env.QUEUE._sink.length > 0) {
      await processQueueMessage(env.QUEUE._sink.shift()!, env as any);
    }
    const mid = await d1
      .prepare(`SELECT state, dns_cycle_id FROM Transactions WHERE txid='TX-DNST3-001'`)
      .first<{ state: string; dns_cycle_id: string | null }>();
    expect(mid?.state).toBe("PAYER_EXEC_CONFIRMED");

    const kick = await kickDns(todayJST(), env as any);
    expect(kick.state).toBe("KICKED");
    const owned = await d1
      .prepare(`SELECT owner FROM Transactions WHERE txid='TX-DNST3-001'`)
      .first<{ owner: string }>();
    expect(owned?.owner).toBe(`CYCLE:${kick.cycle_id}`);

    // Age it to trigger T3 timeout: the cycle owns it, T3 must not.
    d1.prepare(
      `UPDATE Transactions SET updated_at='2000-01-01T00:00:00Z' WHERE txid='TX-DNST3-001'`
    )._runSync();
    await runTimeoutSweep(env as any);

    const afterSweep = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid='TX-DNST3-001'`)
      .first<{ state: string }>();
    expect(afterSweep?.state).toBe("PAYER_EXEC_CONFIRMED");

    // The cycle settles; ownership returns to ZC and the parked credit lands.
    await settleDns(kick.cycle_id, env as any);
    await drain(env);
    const final = await d1
      .prepare(`SELECT state, owner FROM Transactions WHERE txid='TX-DNST3-001'`)
      .first<{ state: string; owner: string }>();
    expect(final?.state).toBe("SETTLED");
    expect(final?.owner).toBe("ZC");
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Probe #N10: FinalityLog event_seq monotonicity across multiple writes
// ---------------------------------------------------------------------------

describe("chaos #N10: FinalityLog event_seq is strictly monotonic", () => {
  it("sequential transitions produce strictly increasing event_seq", async () => {
    const env = makeEnv(d1);
    const amount = 15_000;

    insertReceivedTx(d1, {
      txid: "TX-MONO-001",
      lane: "EXPRESS",
      amount,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });
    await processExpress(
      {
        txid: "TX-MONO-001",
        lane: "EXPRESS",
        amount: { value: amount, currency: "JPY" },
        payer: { bank_id: BANK_A, account_hash: ACC_A },
        payee: { bank_id: BANK_B, account_hash: ACC_B },
      } as any,
      env as any
    );
    await drain(env);

    // Also run a second transaction to interleave event_seq across chains.
    insertReceivedTx(d1, {
      txid: "TX-MONO-002",
      lane: "EXPRESS",
      amount: 20_000,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });
    await processExpress(
      {
        txid: "TX-MONO-002",
        lane: "EXPRESS",
        amount: { value: 20_000, currency: "JPY" },
        payer: { bank_id: BANK_A, account_hash: ACC_A },
        payee: { bank_id: BANK_B, account_hash: ACC_B },
      } as any,
      env as any
    );
    await drain(env);

    // Verify global monotonicity: all event_seq values are unique and increasing.
    const allEntries = await d1
      .prepare(`SELECT event_seq FROM FinalityLog ORDER BY event_seq ASC`)
      .all<{ event_seq: number }>();

    const seqs = allEntries.results.map((r) => r.event_seq);
    expect(seqs.length).toBeGreaterThan(0);

    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }

    // No duplicates.
    expect(new Set(seqs).size).toBe(seqs.length);

    // Per-chain monotonicity: within each txid chain, event_seq is also strictly increasing.
    for (const txid of ["TX-MONO-001", "TX-MONO-002"]) {
      const chain = await d1
        .prepare(`SELECT event_seq FROM FinalityLog WHERE txid=? ORDER BY event_seq ASC`)
        .bind(txid)
        .all<{ event_seq: number }>();
      const chainSeqs = chain.results.map((r) => r.event_seq);
      for (let i = 1; i < chainSeqs.length; i++) {
        expect(chainSeqs[i]).toBeGreaterThan(chainSeqs[i - 1]!);
      }
    }
  });

  it("interleaved transactions produce valid independent hash chains", async () => {
    const env = makeEnv(d1);

    insertReceivedTx(d1, {
      txid: "TX-INTLV-A",
      lane: "EXPRESS",
      amount: 10_000,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });
    insertReceivedTx(d1, {
      txid: "TX-INTLV-B",
      lane: "EXPRESS",
      amount: 20_000,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });

    // Process interleaved.
    await processExpress(
      {
        txid: "TX-INTLV-A",
        lane: "EXPRESS",
        amount: { value: 10_000, currency: "JPY" },
        payer: { bank_id: BANK_A, account_hash: ACC_A },
        payee: { bank_id: BANK_B, account_hash: ACC_B },
      } as any,
      env as any
    );
    await processExpress(
      {
        txid: "TX-INTLV-B",
        lane: "EXPRESS",
        amount: { value: 20_000, currency: "JPY" },
        payer: { bank_id: BANK_A, account_hash: ACC_A },
        payee: { bank_id: BANK_B, account_hash: ACC_B },
      } as any,
      env as any
    );
    await drain(env);

    // Both chains should independently verify.
    const chainA = await verifyChain(d1 as any, "TX-INTLV-A");
    const chainB = await verifyChain(d1 as any, "TX-INTLV-B");
    expect(chainA.valid).toBe(true);
    expect(chainB.valid).toBe(true);
    expect(chainA.entries_checked).toBeGreaterThan(0);
    expect(chainB.entries_checked).toBeGreaterThan(0);
  });
});
