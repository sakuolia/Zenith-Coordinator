/**
 * @file igs_hold.test.ts — DNS_HOLD igs_mode hierarchy (docs/specs/20_method_design.md §2.4 類型B).
 *
 * Covers the DNS_HOLD igs_mode hierarchy:
 *   - computeDnsRecoveryReserve: deterministic reserve + explain hash + confidence
 *   - promoteRingfencePlus: RINGFENCED → RINGFENCED_PLUS gated on reserve+confidence
 *   - checkIgsAdmission: STOP / RINGFENCED / RINGFENCED_PLUS + fairness throttle
 *   - the priority Defer queue and the per-participant throttle budget
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  computeDnsRecoveryReserve,
  promoteRingfencePlus,
  checkIgsAdmission,
} from "../../src/zc/settlement/dns";
import {
  deferIgs,
  getDueDeferredIgs,
  markDeferResumed,
  consumeThrottleBudget,
  wouldExceedThrottle,
  getThrottleConsumed,
  IGS_DEFER_PRIORITY_THROTTLED,
  IGS_DEFER_PRIORITY_RINGFENCED,
} from "../../src/zc/settlement/igs_hold";
import { IGS_THROTTLE_BUDGET_JPY } from "../../src/shared/constants";

function makeEnv(db: MockD1Database): any {
  return { DB: db, QUEUE: { send: async () => {} } };
}

let d1: MockD1Database;
const NOW = "2025-06-18T10:00:00Z";
const TODAY = "2025-06-18";
const CYCLE = "DNS-2025-06-18";

/** Seed a held, ring-fenced JPY cycle plus a net-debtor shortfall on bank 001. */
function seedHeldCycle(
  db: MockD1Database,
  opts: { igsMode?: string; debtorNet?: number; cause?: string[] } = {}
) {
  const igsMode = opts.igsMode ?? "RINGFENCED";
  const debtorNet = opts.debtorNet ?? -15_000_000; // 001 owes 15M; BOJ seed is −10M → 5M short
  const cause = opts.cause ?? ["001"];
  db.prepare(
    `INSERT INTO DnsCycles (cycle_id, business_date, state, igs_mode, currency, intraday_seq, hold_causing_participants, created_at)
     VALUES (?, ?, 'HOLD_ACTIVE', ?, 'JPY', 1, ?, ?)`
  )
    .bind(CYCLE, TODAY, igsMode, JSON.stringify(cause), NOW)
    ._runSync();
  db.prepare(
    `INSERT INTO DnsNetPositions (id, cycle_id, bank_id, gross_send, gross_receive, net_position, is_settled)
     VALUES (?, ?, '001', ?, 0, ?, 0)`
  )
    .bind(`DNSNET-${CYCLE}-001`, CYCLE, -debtorNet, debtorNet)
    ._runSync();
  db.prepare(
    `INSERT INTO DnsNetPositions (id, cycle_id, bank_id, gross_send, gross_receive, net_position, is_settled)
     VALUES (?, ?, '002', 0, ?, ?, 0)`
  )
    .bind(`DNSNET-${CYCLE}-002`, CYCLE, -debtorNet, -debtorNet)
    ._runSync();
}

beforeEach(() => {
  ({ d1 } = createTestDb());
});

// ---------------------------------------------------------------------------
// computeDnsRecoveryReserve
// ---------------------------------------------------------------------------

describe("computeDnsRecoveryReserve", () => {
  it("computes reserve = shortfall + 10% buffer with full confidence and a stable hash", async () => {
    seedHeldCycle(d1); // 001 short by 5,000,000
    const r = await computeDnsRecoveryReserve(d1 as any, CYCLE, "JPY");
    expect(r.inputs.total_shortfall).toBe(5_000_000);
    expect(r.reserve).toBe(5_000_000 + Math.ceil(5_000_000 * 0.1)); // 5,500,000
    expect(r.confidence).toBe(1);
    expect(r.explain_hash).toMatch(/^[0-9a-f]{64}$/);

    // Deterministic: same inputs → same digest.
    const r2 = await computeDnsRecoveryReserve(d1 as any, CYCLE, "JPY");
    expect(r2.explain_hash).toBe(r.explain_hash);
  });

  it("yields a zero reserve and zero confidence when there is no shortfall", async () => {
    // Debtor net well within the −10M BOJ prefund → no shortfall.
    seedHeldCycle(d1, { debtorNet: -1_000_000 });
    const r = await computeDnsRecoveryReserve(d1 as any, CYCLE, "JPY");
    expect(r.reserve).toBe(0);
    expect(r.confidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// promoteRingfencePlus
// ---------------------------------------------------------------------------

describe("promoteRingfencePlus", () => {
  it("promotes RINGFENCED → RINGFENCED_PLUS and records the reserve evidence", async () => {
    seedHeldCycle(d1);
    const res = await promoteRingfencePlus(CYCLE, makeEnv(d1));
    expect(res.promoted).toBe(true);

    const cyc = await d1
      .prepare(
        `SELECT igs_mode, dns_recovery_reserve, reserve_explain_hash, reserve_confidence FROM DnsCycles WHERE cycle_id=?`
      )
      .bind(CYCLE)
      .first<{
        igs_mode: string;
        dns_recovery_reserve: number;
        reserve_explain_hash: string;
        reserve_confidence: number;
      }>();
    expect(cyc?.igs_mode).toBe("RINGFENCED_PLUS");
    expect(cyc?.dns_recovery_reserve).toBe(5_500_000);
    expect(cyc?.reserve_explain_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cyc?.reserve_confidence).toBe(1);

    const log = await d1
      .prepare(`SELECT 1 FROM FinalityLog WHERE event_type='DnsRingfencePromoted' AND gtid=?`)
      .bind(CYCLE)
      .first();
    expect(log).toBeTruthy();
  });

  it("is idempotent — a second call does not re-promote", async () => {
    seedHeldCycle(d1);
    await promoteRingfencePlus(CYCLE, makeEnv(d1));
    const second = await promoteRingfencePlus(CYCLE, makeEnv(d1));
    expect(second.promoted).toBe(false);
    expect(second.reason).toBe("NOT_RINGFENCED"); // already RINGFENCED_PLUS
  });

  it("does not promote when the shortfall has cleared (reserve 0)", async () => {
    seedHeldCycle(d1, { debtorNet: -1_000_000 });
    const res = await promoteRingfencePlus(CYCLE, makeEnv(d1));
    expect(res.promoted).toBe(false);
    expect(res.reason).toBe("NO_SHORTFALL");
    const cyc = await d1
      .prepare(`SELECT igs_mode FROM DnsCycles WHERE cycle_id=?`)
      .bind(CYCLE)
      .first<{ igs_mode: string }>();
    expect(cyc?.igs_mode).toBe("RINGFENCED");
  });
});

// ---------------------------------------------------------------------------
// checkIgsAdmission
// ---------------------------------------------------------------------------

describe("checkIgsAdmission", () => {
  it("admits NORMAL when no cycle is held", async () => {
    const d = await checkIgsAdmission(d1 as any, "001", "002", 1000, NOW);
    expect(d.admit).toBe(true);
    expect(d.igs_mode).toBe("NORMAL");
  });

  it("STOP halts all IGS", async () => {
    seedHeldCycle(d1, { igsMode: "STOP", cause: [] });
    const d = await checkIgsAdmission(d1 as any, "003", "004", 1000, NOW);
    expect(d.admit).toBe(false);
    expect(d.reason_code).toBe("DNS_HOLD_IGS_STOPPED");
  });

  it("RINGFENCED blocks a touched leg but admits non-causing banks", async () => {
    seedHeldCycle(d1, { igsMode: "RINGFENCED", cause: ["001"] });
    const touched = await checkIgsAdmission(d1 as any, "001", "002", 1000, NOW);
    expect(touched.admit).toBe(false);
    expect(touched.reason_code).toBe("DNS_RINGFENCED");

    const clear = await checkIgsAdmission(d1 as any, "003", "004", 1000, NOW);
    expect(clear.admit).toBe(true);
    expect(clear.igs_mode).toBe("RINGFENCED");
  });

  it("RINGFENCED_PLUS defers a non-causing payer that is over its fairness budget", async () => {
    seedHeldCycle(d1, { igsMode: "RINGFENCED_PLUS", cause: ["001"] });
    // Under budget → admitted.
    const under = await checkIgsAdmission(d1 as any, "003", "004", 1000, NOW);
    expect(under.admit).toBe(true);

    // Spend the whole budget for 003, then a further IGS is Deferred (not rejected).
    await consumeThrottleBudget(d1 as any, CYCLE, "003", IGS_THROTTLE_BUDGET_JPY);
    const over = await checkIgsAdmission(d1 as any, "003", "004", 1000, NOW);
    expect(over.admit).toBe(false);
    expect(over.defer).toBe(true);
    expect(over.reason_code).toBe("DNS_IGS_THROTTLED");
    expect(over.cycle_id).toBe(CYCLE);
  });

  // Isolation and fairness throttling share one priority queue; that shared queue
  // is what makes their order defined. Isolation used not to be enqueued at all
  // (park + per-minute rescan), which left the two incomparable and in practice
  // retried the transfer that *cannot* be admitted ahead of the one that can.
  it("RINGFENCED defers a touched leg to the last queue position, behind a throttled one", async () => {
    seedHeldCycle(d1, { igsMode: "RINGFENCED_PLUS", cause: ["001"] });

    const isolated = await checkIgsAdmission(d1 as any, "001", "002", 1000, NOW);
    expect(isolated.admit).toBe(false);
    expect(isolated.defer).toBe(true);
    expect(isolated.priority).toBe(IGS_DEFER_PRIORITY_RINGFENCED);

    await consumeThrottleBudget(d1 as any, CYCLE, "003", IGS_THROTTLE_BUDGET_JPY);
    const throttled = await checkIgsAdmission(d1 as any, "003", "004", 1000, NOW);
    expect(throttled.priority).toBe(IGS_DEFER_PRIORITY_THROTTLED);

    // The admissible-but-over-budget transfer resumes first.
    expect(throttled.priority!).toBeLessThan(isolated.priority!);
  });
});

// ---------------------------------------------------------------------------
// Throttle budget
// ---------------------------------------------------------------------------

describe("igs_throttle_budget", () => {
  it("accumulates consumed budget per (cycle, bank)", async () => {
    await consumeThrottleBudget(d1 as any, CYCLE, "001", 1000);
    await consumeThrottleBudget(d1 as any, CYCLE, "001", 2000);
    expect(await getThrottleConsumed(d1 as any, CYCLE, "001")).toBe(3000);
    // Independent per bank.
    expect(await getThrottleConsumed(d1 as any, CYCLE, "002")).toBe(0);
  });

  it("flags an over-budget admission", async () => {
    await consumeThrottleBudget(d1 as any, CYCLE, "001", IGS_THROTTLE_BUDGET_JPY - 500);
    expect(await wouldExceedThrottle(d1 as any, CYCLE, "001", 499)).toBe(false);
    expect(await wouldExceedThrottle(d1 as any, CYCLE, "001", 501)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Defer queue
// ---------------------------------------------------------------------------

describe("IgsDeferQueue", () => {
  it("enqueues idempotently per txid and orders due items by priority", async () => {
    await deferIgs(d1 as any, {
      txid: "TX-A",
      cycle_id: CYCLE,
      payer_bank_id: "001",
      payee_bank_id: "002",
      amount_value: 1000,
      reason_code: "DNS_IGS_THROTTLED",
      priority: 200,
    });
    // Duplicate enqueue for the same txid is ignored.
    await deferIgs(d1 as any, {
      txid: "TX-A",
      cycle_id: CYCLE,
      payer_bank_id: "001",
      payee_bank_id: "002",
      amount_value: 1000,
      reason_code: "DNS_IGS_THROTTLED",
      priority: 50,
    });
    await deferIgs(d1 as any, {
      txid: "TX-B",
      cycle_id: CYCLE,
      payer_bank_id: "003",
      payee_bank_id: "004",
      amount_value: 1000,
      reason_code: "DNS_RINGFENCED",
      priority: 50,
    });

    const count = await d1
      .prepare(`SELECT COUNT(*) AS n FROM IgsDeferQueue`)
      .first<{ n: number }>();
    expect(count?.n).toBe(2); // TX-A enqueued once

    // Window is in the future by default; nothing is due "now".
    expect((await getDueDeferredIgs(d1 as any, NOW)).length).toBe(0);

    // Far-future query time → both due, higher priority (TX-B, 50) first.
    const due = await getDueDeferredIgs(d1 as any, "2099-01-01T00:00:00Z");
    expect(due.map((d) => d.txid)).toEqual(["TX-B", "TX-A"]);
  });

  it("marks a deferral RESUMED", async () => {
    await deferIgs(d1 as any, {
      txid: "TX-C",
      cycle_id: CYCLE,
      payer_bank_id: "001",
      payee_bank_id: "002",
      amount_value: 1000,
      reason_code: "DNS_IGS_THROTTLED",
    });
    await markDeferResumed(d1 as any, "TX-C");
    const row = await d1
      .prepare(`SELECT status, resumed_at FROM IgsDeferQueue WHERE txid='TX-C'`)
      .first<{ status: string; resumed_at: string | null }>();
    expect(row?.status).toBe("RESUMED");
    expect(row?.resumed_at).toBeTruthy();
    // No longer returned as due.
    expect((await getDueDeferredIgs(d1 as any, "2099-01-01T00:00:00Z")).length).toBe(0);
  });
});
