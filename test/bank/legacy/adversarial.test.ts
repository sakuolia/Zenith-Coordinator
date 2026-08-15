/**
 * @file adversarial.test.ts — Adversarial-core conformance tests.
 *
 * Proves the LegacyAdapter can front an intentionally hostile legacy core
 * (`legacy_core.ts`): batch windows, non-idempotency, no reservation primitive,
 * no mid-batch query, timeouts, no push endpoint. Each block first demonstrates
 * that the core really is hostile, then that the adapter neutralises it — and
 * the reconciliation invariant is asserted throughout.
 *
 * The "concurrency" describe block additionally pins two races found during a
 * professional-standard review of an earlier version of this subsystem (see
 * docs/specs/30_internal_design.md § 監査で見つかった問題と是正): a check-then-act
 * idempotency window, and a drain path that posted to the core before its
 * ownership guard, so two concurrent drains of the same PENDING row could both
 * post. Both are interleaved via `Promise.all`, the same technique
 * `test/integration/concurrent_races.test.ts` uses to reproduce TOCTOU races
 * against the synchronous, single-threaded D1 mock.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  getProfile,
  isCoreOnlineAt,
  type LegacyAdapter,
  makeLegacyAdapter,
  recoverStaleClaims,
  upsertProfile,
} from "../../../src/bank/legacy/adapter";
import { LegacyCore, LegacyCoreError } from "../../../src/bank/legacy/legacy_core";
import {
  openDriftCount,
  reconcileAccount,
  reconcileBank,
} from "../../../src/bank/legacy/reconcile";
import { isDomainError } from "../../../src/shared/errors";
import { createTestDb, type MockD1Database } from "../../helpers/d1-mock";

// The D1 mock stands in for D1Database across the test tree; biome.json turns
// noExplicitAny off under test/** rather than repeating a suppression per cast.
const asDb = (d: MockD1Database) => d as any;

let d1: MockD1Database;
let core: LegacyCore;
let adapter: LegacyAdapter;

beforeEach(() => {
  d1 = createTestDb().d1;
  core = new LegacyCore(asDb(d1));
  adapter = makeLegacyAdapter(asDb(d1), core);
});

async function coreBalance(bank: string, acct: string): Promise<number> {
  // Read the core ledger table directly so the assertion is independent of the
  // core's availability/timeout toggles.
  const r = await asDb(d1)
    .prepare(`SELECT balance FROM LegacyCoreAccounts WHERE bank_id=? AND account_id=?`)
    .bind(bank, acct)
    .first();
  return r?.balance ?? 0;
}
async function shadowOf(bank: string, acct: string) {
  return (
    (await asDb(d1)
      .prepare(`SELECT available, reserved FROM AdapterShadow WHERE bank_id=? AND account_id=?`)
      .bind(bank, acct)
      .first()) ?? { available: 0, reserved: 0 }
  );
}
async function journalRows(bank: string, acct: string): Promise<number> {
  const r = await asDb(d1)
    .prepare(`SELECT COUNT(*) AS n FROM LegacyCoreJournal WHERE bank_id=? AND account_id=?`)
    .bind(bank, acct)
    .first();
  return r?.n ?? 0;
}
async function openCasesFor(reasonCode: string): Promise<number> {
  const r = await asDb(d1)
    .prepare(`SELECT COUNT(*) AS n FROM Cases WHERE reason_code=? AND state='OPEN'`)
    .bind(reasonCode)
    .first();
  return r?.n ?? 0;
}

// ===========================================================================
// The core really is hostile (baseline — without the adapter)
// ===========================================================================
describe("the legacy core is genuinely hostile", () => {
  it("is non-idempotent: a naive re-send double-applies", async () => {
    await core.injectDriftForTest("001", "A", 10_000);
    await core.applyNonIdempotent("001", "A", "DEBIT", 1_000, "req-1");
    await core.applyNonIdempotent("001", "A", "DEBIT", 1_000, "req-1"); // same request_id, ignored by core
    expect(await coreBalance("001", "A")).toBe(8_000); // debited TWICE
    expect(await journalRows("001", "A")).toBe(2);
  });

  it("goes offline during the batch window and refuses every call", async () => {
    core.setOnline(false);
    await expect(core.getBalance("001", "A")).rejects.toBeInstanceOf(LegacyCoreError);
    await expect(core.applyNonIdempotent("001", "A", "CREDIT", 1, "r")).rejects.toMatchObject({
      code: "CORE_OFFLINE",
    });
  });

  it("has no reservation primitive and rejects overdraft synchronously", async () => {
    await core.injectDriftForTest("001", "A", 500);
    await expect(core.applyNonIdempotent("001", "A", "DEBIT", 1_000, "r")).rejects.toMatchObject({
      code: "INSUFFICIENT_FUNDS",
    });
  });
});

// ===========================================================================
// #1 Capability profile — heterogeneity is configuration, not special-casing
// ===========================================================================
describe("#1 capability profile", () => {
  it("defaults to a FULL/DIRECT profile when none is registered", async () => {
    const p = await getProfile(asDb(d1), "999");
    expect(p.role).toBe("FULL");
    expect(p.settlement_mode).toBe("DIRECT");
  });

  it("a PAYEE_ONLY bank cleanly rejects a send instead of crashing", async () => {
    await upsertProfile(asDb(d1), { bank_id: "007", role: "PAYEE_ONLY" });
    await adapter.initAccount("007", "A", 10_000);
    const r = await adapter.reserveFunds({
      bank_id: "007",
      account_id: "A",
      amount: 1_000,
      request_id: "r1",
    });
    expect(r).toMatchObject({ result: "REJECTED", reason_code: "PARTICIPANT_CANNOT_SEND" });
    // …but it can still receive.
    const c = await adapter.executeCredit({
      bank_id: "007",
      account_id: "A",
      amount: 1_000,
      request_id: "r2",
    });
    expect(c.result).toBe("OK");
  });

  it("window math handles a batch window that wraps midnight", async () => {
    const p = await getProfile(asDb(d1), "x");
    const windowed = { ...p, window_open_hour: 5, window_close_hour: 23 }; // offline 23:00–05:00
    expect(isCoreOnlineAt(windowed, 12)).toBe(true);
    expect(isCoreOnlineAt(windowed, 2)).toBe(false);
    expect(isCoreOnlineAt(windowed, 23)).toBe(false);
    expect(isCoreOnlineAt(p, 3)).toBe(true); // null window = always online
  });
});

// ===========================================================================
// #2 Prefund shadow + store-and-forward across a batch window
// ===========================================================================
describe("#2 prefund shadow keeps ZC unblocked while the core is offline", () => {
  beforeEach(async () => {
    await upsertProfile(asDb(d1), { bank_id: "010", settlement_mode: "PREFUNDED_SHADOW" });
    await adapter.initAccount("010", "A", 10_000);
  });

  it("authorises a debit in real time while the core is down, then drains on window-open", async () => {
    core.setOnline(false); // batch window closed

    const r = await adapter.reserveFunds({
      bank_id: "010",
      account_id: "A",
      amount: 3_000,
      request_id: "rs",
    });
    expect(r.result).toBe("OK"); // ZC gets an immediate answer
    const d = await adapter.executeDebit({
      bank_id: "010",
      account_id: "A",
      amount: 3_000,
      request_id: "dr",
    });
    expect(d).toMatchObject({ result: "OK", settled: "DEFERRED" });

    // Core is untouched; the posting waits in the outbox.
    expect(await coreBalance("010", "A")).toBe(10_000);
    expect(await journalRows("010", "A")).toBe(0);

    // Window opens → drain applies exactly once.
    core.setOnline(true);
    const drain = await adapter.drainOutbox("010");
    expect(drain).toEqual({ applied: 1, deferred: 0, blocked: 0 });
    expect(await coreBalance("010", "A")).toBe(7_000);

    // Invariant holds after drain.
    expect(await reconcileAccount(asDb(d1), core, "010", "A")).toBeNull();
  });

  it("a second drain is a no-op (outbox already APPLIED)", async () => {
    core.setOnline(false);
    await adapter.reserveFunds({
      bank_id: "010",
      account_id: "A",
      amount: 1_000,
      request_id: "rs",
    });
    await adapter.executeDebit({
      bank_id: "010",
      account_id: "A",
      amount: 1_000,
      request_id: "dr",
    });
    core.setOnline(true);
    await adapter.drainOutbox("010");
    const again = await adapter.drainOutbox("010");
    expect(again).toEqual({ applied: 0, deferred: 0, blocked: 0 });
    expect(await coreBalance("010", "A")).toBe(9_000); // not double-applied
    expect(await journalRows("010", "A")).toBe(1);
  });
});

// ===========================================================================
// Idempotency — a non-idempotent core survives at-least-once redelivery
// ===========================================================================
describe("idempotency defends the non-idempotent core", () => {
  it("DIRECT: the same execute-credit request delivered twice (sequentially) applies once", async () => {
    await upsertProfile(asDb(d1), { bank_id: "020", settlement_mode: "DIRECT" });
    await adapter.initAccount("020", "A", 0);

    const first = await adapter.executeCredit({
      bank_id: "020",
      account_id: "A",
      amount: 5_000,
      request_id: "cr-1",
    });
    const dup = await adapter.executeCredit({
      bank_id: "020",
      account_id: "A",
      amount: 5_000,
      request_id: "cr-1",
    });
    expect(first).toEqual(dup); // cached result returned
    expect(await coreBalance("020", "A")).toBe(5_000); // credited ONCE despite two calls
    expect(await journalRows("020", "A")).toBe(1);
    expect(await reconcileAccount(asDb(d1), core, "020", "A")).toBeNull();
  });
});

// ===========================================================================
// #4 No-reserve profile + compensating reversal
// ===========================================================================
describe("#4 no-reserve profile compensates with a reversal", () => {
  it("reserve is a no-op; a failed downstream leg is undone by a reversal, netting zero", async () => {
    await upsertProfile(asDb(d1), {
      bank_id: "030",
      reservation_mode: "NONE",
      settlement_mode: "PREFUNDED_SHADOW",
    });
    await adapter.initAccount("030", "A", 10_000);

    const rs = await adapter.reserveFunds({
      bank_id: "030",
      account_id: "A",
      amount: 4_000,
      request_id: "rs",
    });
    expect(rs).toMatchObject({ result: "OK", reservation_mode: "NONE" });
    // No hold taken: reserved stays 0.
    expect((await shadowOf("030", "A")).reserved).toBe(0);

    // Debit goes through (payer money leaves).
    await adapter.executeDebit({
      bank_id: "030",
      account_id: "A",
      amount: 4_000,
      request_id: "dr",
      txid: "TX-030",
    });
    expect((await shadowOf("030", "A")).available).toBe(6_000);

    // Downstream (payee credit) fails → ZC orders a reversal of the payer debit.
    await adapter.compensateReversal({
      bank_id: "030",
      account_id: "A",
      amount: 4_000,
      request_id: "rev",
      txid: "TX-030",
    });
    expect((await shadowOf("030", "A")).available).toBe(10_000); // payer made whole

    // Drain: core sees debit then credit, netting to the opening balance.
    core.setOnline(true);
    await adapter.drainOutbox("030");
    expect(await coreBalance("030", "A")).toBe(10_000);
    expect(await reconcileAccount(asDb(d1), core, "030", "A")).toBeNull();

    // Traceability: both postings carry the originating txid (not just an
    // adapter-internal request_id), so the debit/reversal pair is auditable.
    const journalTxids = await asDb(d1)
      .prepare(`SELECT DISTINCT txid FROM LegacyCoreJournal WHERE bank_id='030' AND account_id='A'`)
      .all();
    expect(journalTxids.results.map((r: { txid: string }) => r.txid)).toEqual(["TX-030"]);
  });
});

// ===========================================================================
// #1/#4 sync_reserve — a core that cannot hold synchronously degrades to NONE
// ===========================================================================
describe("sync_reserve=false degrades a declared SUSPENSE to NONE", () => {
  it("takes no hold, and says the degradation happened", async () => {
    // The profile asks for SUSPENSE, but declares the core cannot hold and
    // return a reservation synchronously. Taking the hold anyway would leave
    // `reserved` in the shadow with nothing behind it.
    await upsertProfile(asDb(d1), {
      bank_id: "031",
      reservation_mode: "SUSPENSE",
      sync_reserve: false,
    });
    await adapter.initAccount("031", "A", 10_000);

    const rs = await adapter.reserveFunds({
      bank_id: "031",
      account_id: "A",
      amount: 4_000,
      request_id: "rs-031",
    });
    expect(rs).toMatchObject({
      result: "OK",
      reservation_mode: "NONE",
      degraded: "SYNC_RESERVE_UNSUPPORTED",
    });
    expect((await shadowOf("031", "A")).reserved).toBe(0);
  });

  it("debit takes the NONE path, so it does not look for a hold that was never made", async () => {
    await upsertProfile(asDb(d1), {
      bank_id: "032",
      reservation_mode: "SUSPENSE",
      sync_reserve: false,
      settlement_mode: "PREFUNDED_SHADOW",
    });
    await adapter.initAccount("032", "A", 10_000);
    await adapter.reserveFunds({
      bank_id: "032",
      account_id: "A",
      amount: 4_000,
      request_id: "rs-032",
    });

    // Under the declared SUSPENSE this would be NO_RESERVATION; under the
    // effective NONE it debits straight off available.
    const dr = await adapter.executeDebit({
      bank_id: "032",
      account_id: "A",
      amount: 4_000,
      request_id: "dr-032",
      txid: "TX-032",
    });
    expect(dr.result).toBe("OK");
    expect(await shadowOf("032", "A")).toMatchObject({ available: 6_000, reserved: 0 });

    // Release is a no-op for the same reason — it must not hand back a hold
    // the reserve never took.
    const rel = await adapter.releaseReserve({
      bank_id: "032",
      account_id: "A",
      amount: 4_000,
      request_id: "rl-032",
    });
    expect(rel).toMatchObject({ result: "OK", released: "NOOP" });
    expect((await shadowOf("032", "A")).available).toBe(6_000);
  });

  it("sync_reserve=true (the default) leaves SUSPENSE alone", async () => {
    await upsertProfile(asDb(d1), { bank_id: "033", reservation_mode: "SUSPENSE" });
    await adapter.initAccount("033", "A", 10_000);
    const rs = await adapter.reserveFunds({
      bank_id: "033",
      account_id: "A",
      amount: 4_000,
      request_id: "rs-033",
    });
    expect(rs).toMatchObject({ result: "OK", reservation_mode: "SUSPENSE" });
    expect(rs.degraded).toBeUndefined();
    expect(await shadowOf("033", "A")).toMatchObject({ available: 6_000, reserved: 4_000 });
  });
});

// ===========================================================================
// #5 Pull-based notification — the core needs no push endpoint
// ===========================================================================
describe("#5 pull-based credit notification", () => {
  it("stores a notification and lets the bank pull it exactly once", async () => {
    await upsertProfile(asDb(d1), { bank_id: "040", notify_mode: "PULL" });
    await adapter.creditNotify({
      bank_id: "040",
      account_id: "A",
      amount: 2_500,
      txid: "TX-1",
      request_id: "n1",
    });
    const first = await adapter.pullNotifications("040");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ txid: "TX-1", amount: 2_500 });
    const second = await adapter.pullNotifications("040"); // already read
    expect(second).toHaveLength(0);
  });

  it("credit-notify is idempotent under redelivery", async () => {
    await adapter.creditNotify({
      bank_id: "041",
      account_id: "A",
      amount: 1,
      txid: "TX-2",
      request_id: "n2",
    });
    await adapter.creditNotify({
      bank_id: "041",
      account_id: "A",
      amount: 1,
      txid: "TX-2",
      request_id: "n2",
    });
    expect(await adapter.pullNotifications("041")).toHaveLength(1); // not duplicated
  });
});

// ===========================================================================
// #6 Batch ingest — file-oriented cores take many credits at once
// ===========================================================================
describe("#6 batch ingest of credits", () => {
  it("ingests N credits offline, drains them all exactly once", async () => {
    await upsertProfile(asDb(d1), {
      bank_id: "050",
      settlement_mode: "PREFUNDED_SHADOW",
      batch_ingest: true,
    });
    for (const a of ["A", "B", "C"]) await adapter.initAccount("050", a, 0);
    core.setOnline(false);

    const res = await adapter.ingestBatchCredits("050", [
      { account_id: "A", amount: 100, txid: "T1", request_id: "b1" },
      { account_id: "B", amount: 200, txid: "T2", request_id: "b2" },
      { account_id: "C", amount: 300, txid: "T3", request_id: "b3" },
    ]);
    expect(res).toMatchObject({ result: "OK", accepted: 3, total: 3 });
    expect(await coreBalance("050", "A")).toBe(0); // nothing on core yet

    core.setOnline(true);
    const drain = await adapter.drainOutbox("050");
    expect(drain.applied).toBe(3);
    expect(await coreBalance("050", "A")).toBe(100);
    expect(await coreBalance("050", "B")).toBe(200);
    expect(await coreBalance("050", "C")).toBe(300);
    expect(await reconcileBank(asDb(d1), core, "050")).toEqual([]); // no drift
  });
});

// ===========================================================================
// #3 Reconciliation — drift converges into a real CASE
// ===========================================================================
describe("#3 reconciliation detects drift and opens a real Cases row", () => {
  beforeEach(async () => {
    await upsertProfile(asDb(d1), { bank_id: "060", settlement_mode: "PREFUNDED_SHADOW" });
    await adapter.initAccount("060", "A", 10_000);
  });

  it("clean flow reconciles to zero drift", async () => {
    await adapter.reserveFunds({
      bank_id: "060",
      account_id: "A",
      amount: 2_000,
      request_id: "rs",
    });
    await adapter.executeDebit({
      bank_id: "060",
      account_id: "A",
      amount: 2_000,
      request_id: "dr",
    });
    // invariant holds even with the posting still pending in the outbox
    expect(await reconcileAccount(asDb(d1), core, "060", "A")).toBeNull();
    core.setOnline(true);
    await adapter.drainOutbox("060");
    expect(await reconcileAccount(asDb(d1), core, "060", "A")).toBeNull();
    expect(await openDriftCount(asDb(d1), "060")).toBe(0);
  });

  it("an out-of-band core change (a lost posting) opens a real Cases row, not just a table nobody watches", async () => {
    // Someone/something moved the core balance the adapter did not authorise.
    await core.injectDriftForTest("060", "A", -1_500);
    const drift = await reconcileAccount(asDb(d1), core, "060", "A");
    expect(drift).not.toBeNull();
    expect(drift?.drift_amount).toBe(-1_500);
    expect(await openDriftCount(asDb(d1), "060")).toBe(1); // AdapterReconDrift row
    expect(drift?.case_id).toMatch(/^CASE-/);
    expect(await openCasesFor("LEGACY_ADAPTER_RECON_DRIFT")).toBe(1); // and a REAL Cases row
  });
});

// ===========================================================================
// Timeout mid-drain — no lost posting, no double posting
// ===========================================================================
describe("core timeout mid-drain is safe", () => {
  it("leaves the outbox PENDING on timeout, then applies exactly once on retry", async () => {
    await upsertProfile(asDb(d1), { bank_id: "070", settlement_mode: "PREFUNDED_SHADOW" });
    await adapter.initAccount("070", "A", 0);
    await adapter.executeCredit({ bank_id: "070", account_id: "A", amount: 800, request_id: "cr" });

    // First drain: core online but timing out → nothing committed.
    core.setOnline(true);
    core.setTimingOut(true);
    const d1res = await adapter.drainOutbox("070");
    expect(d1res).toEqual({ applied: 0, deferred: 1, blocked: 0 });
    expect(await coreBalance("070", "A")).toBe(0);

    // Recovery: timeout clears → applies once.
    core.setTimingOut(false);
    const d2res = await adapter.drainOutbox("070");
    expect(d2res).toEqual({ applied: 1, deferred: 0, blocked: 0 });
    expect(await coreBalance("070", "A")).toBe(800);
    expect(await journalRows("070", "A")).toBe(1); // exactly once
    expect(await reconcileAccount(asDb(d1), core, "070", "A")).toBeNull();
  });
});

// ===========================================================================
// name-check on a batch core degrades instead of failing the transfer
// ===========================================================================
describe("name-check degrades gracefully on a non-realtime core", () => {
  it("returns DEFERRED for a bank that cannot answer name-check in real time", async () => {
    await upsertProfile(asDb(d1), { bank_id: "080", realtime_name_check: false });
    const r = await adapter.accountVerify({ bank_id: "080", account_id: "A", request_id: "v" });
    expect(r).toMatchObject({ result: "DEFERRED", reason_code: "NAME_CHECK_DEFERRED" });
  });

  it("a realtime core that is mid-batch defers rather than throwing", async () => {
    await upsertProfile(asDb(d1), { bank_id: "081", realtime_name_check: true });
    await adapter.initAccount("081", "A", 100);
    core.setOnline(false);
    const r = await adapter.accountVerify({ bank_id: "081", account_id: "A", request_id: "v" });
    expect(r).toMatchObject({ result: "DEFERRED", reason_code: "CORE_OFFLINE" });
  });
});

// ===========================================================================
// Overdraft protection at drain time (a real core never goes negative)
// ===========================================================================
describe("drain-time overdraft protection", () => {
  it("blocks a DEBIT the core cannot cover, opens a CASE, and never lets the core go negative", async () => {
    await upsertProfile(asDb(d1), { bank_id: "090", settlement_mode: "PREFUNDED_SHADOW" });
    await adapter.initAccount("090", "A", 10_000);

    // Authorise a debit against the shadow (funds look sufficient there)…
    await adapter.reserveFunds({
      bank_id: "090",
      account_id: "A",
      amount: 6_000,
      request_id: "rs",
    });
    await adapter.executeDebit({
      bank_id: "090",
      account_id: "A",
      amount: 6_000,
      request_id: "dr",
      txid: "TX-090",
    });

    // …but something drained the REAL core funds out of band before the drain
    // runs (e.g. a manual correction, or drift from an earlier incident).
    await core.injectDriftForTest("090", "A", -8_000); // core now has 2_000, less than the 6_000 owed

    core.setOnline(true);
    const drain = await adapter.drainOutbox("090");
    expect(drain).toEqual({ applied: 0, deferred: 0, blocked: 1 });

    // The core balance must never go negative.
    expect(await coreBalance("090", "A")).toBe(2_000);
    expect(await journalRows("090", "A")).toBe(0); // no phantom posting recorded

    // The outbox row is visibly BLOCKED (not silently retried forever), and a
    // real Cases row exists so an operator sees it.
    const row = await asDb(d1)
      .prepare(`SELECT status FROM AdapterOutbox WHERE bank_id='090' AND account_id='A'`)
      .first();
    expect(row.status).toBe("BLOCKED");
    expect(await openCasesFor("LEGACY_CORE_INSUFFICIENT_FUNDS")).toBe(1);
  });
});

// ===========================================================================
// Concurrency — the races found during the audit, now fixed
// ===========================================================================
describe("concurrency: idempotency race (TOCTOU)", () => {
  it("two concurrent executeCredit calls with the SAME request_id apply the credit exactly once", async () => {
    await upsertProfile(asDb(d1), { bank_id: "100", settlement_mode: "DIRECT" });
    await adapter.initAccount("100", "A", 0);

    const cmd = { bank_id: "100", account_id: "A", amount: 1_000, request_id: "concurrent-1" };
    const results = await Promise.allSettled([
      adapter.executeCredit(cmd),
      adapter.executeCredit(cmd),
    ]);

    // Exactly one side effect: the core is credited once, not twice.
    expect(await coreBalance("100", "A")).toBe(1_000);
    expect(await journalRows("100", "A")).toBe(1);

    // The loser of the race either got the cached result (if it observed the
    // winner's completion) or a retryable in-flight error (if it raced the
    // winner mid-flight) — either way it must NOT have produced a second
    // credit, which the balance/journal assertions above already pin.
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    for (const r of rejected) {
      expect(isDomainError(r.reason)).toBe(true);
      expect(r.reason.reason_code).toBe("LEGACY_ADAPTER_REQUEST_IN_FLIGHT");
    }
  });
});

describe("concurrency: drain double-post race", () => {
  it("two concurrent drainOutbox calls apply the same PENDING row exactly once", async () => {
    await upsertProfile(asDb(d1), { bank_id: "101", settlement_mode: "PREFUNDED_SHADOW" });
    await adapter.initAccount("101", "A", 0);
    await adapter.executeCredit({ bank_id: "101", account_id: "A", amount: 500, request_id: "cr" });

    core.setOnline(true);
    // Two overlapping drains racing to claim the same PENDING outbox row.
    const [d1res, d2res] = await Promise.all([
      adapter.drainOutbox("101"),
      adapter.drainOutbox("101"),
    ]);

    // Exactly one of the two claimed and applied the row; the other found
    // nothing left to claim.
    const totalApplied = d1res.applied + d2res.applied;
    expect(totalApplied).toBe(1);

    // The core saw the credit exactly once — the bug this test targets would
    // have posted it twice (core balance 1000, two journal rows).
    expect(await coreBalance("101", "A")).toBe(500);
    expect(await journalRows("101", "A")).toBe(1);
    expect(await reconcileAccount(asDb(d1), core, "101", "A")).toBeNull();
  });
});

describe("concurrency: stale CLAIMED recovery", () => {
  it("recoverStaleClaims reverts an old CLAIMED row to PENDING so it can be retried", async () => {
    await upsertProfile(asDb(d1), { bank_id: "102", settlement_mode: "PREFUNDED_SHADOW" });
    await adapter.initAccount("102", "A", 0);
    await adapter.executeCredit({ bank_id: "102", account_id: "A", amount: 300, request_id: "cr" });

    // Simulate a drain that claimed the row and then crashed before applying
    // it (claimed_at set far in the past).
    await asDb(d1)
      .prepare(
        `UPDATE AdapterOutbox SET status='CLAIMED', claimed_at='2000-01-01T00:00:00.000Z' WHERE bank_id='102'`
      )
      .run();

    const recovered = await recoverStaleClaims(asDb(d1), 15 * 60 * 1000);
    expect(recovered).toBe(1);

    core.setOnline(true);
    const drain = await adapter.drainOutbox("102");
    expect(drain.applied).toBe(1);
    expect(await coreBalance("102", "A")).toBe(300);
    expect(await journalRows("102", "A")).toBe(1); // exactly once, not lost, not duplicated
  });
});

// ===========================================================================
// The documented, NOT-fixed limitation, proven empirically: for a core with
// genuinely zero idempotency, a crash between "core call succeeded" and "the
// outbox flip commits" is a real double-post that no adapter-side claim
// mechanism can prevent — and reconciliation (#3), not the claim mechanism,
// is what actually catches it. See docs/specs/20_method_design.md § ベンダー接続可否.
// ===========================================================================
describe("residual risk: crash between core-apply and outbox-flip (documented limitation)", () => {
  it("a crash in that window double-posts to a zero-idempotency core, and reconciliation is what catches it", async () => {
    await upsertProfile(asDb(d1), { bank_id: "110", settlement_mode: "PREFUNDED_SHADOW" });
    await adapter.initAccount("110", "A", 5_000);
    await adapter.reserveFunds({
      bank_id: "110",
      account_id: "A",
      amount: 2_000,
      request_id: "rs",
    });
    await adapter.executeDebit({
      bank_id: "110",
      account_id: "A",
      amount: 2_000,
      request_id: "dr",
      txid: "TX-CRASH",
    });

    core.setOnline(true);

    // Simulate a drain process that claimed the row, successfully called the
    // core (the exact call applyOutboxRow would make), and then crashed
    // BEFORE the outbox-flip statement committed. This is not a bug in the
    // test — it reproduces exactly what applyOutboxRow does up to the crash
    // point, using the same public core.postDebit call.
    await asDb(d1)
      .prepare(
        `UPDATE AdapterOutbox SET status='CLAIMED', claimed_at='2000-01-01T00:00:00.000Z' WHERE bank_id='110'`
      )
      .run();
    const firstPost = await core.postDebit("110", "A", 2_000, {
      requestId: "dr",
      txid: "TX-CRASH",
    });
    expect(firstPost.applied).toBe(true);
    expect(await coreBalance("110", "A")).toBe(3_000); // core already moved…
    // …but the outbox row is still CLAIMED, not APPLIED: the "crash" happened
    // before the flip the real applyOutboxRow would have done next.

    // Ops recovery sweep runs later and, seeing a stale CLAIMED row, reverts
    // it to PENDING so it gets retried — exactly as designed for the ordinary
    // "drain died, no core call was made yet" case. It cannot distinguish
    // that one from this case (core call DID succeed) without asking the core
    // "was request dr already applied", which this core cannot answer.
    const recovered = await recoverStaleClaims(asDb(d1), 15 * 60 * 1000);
    expect(recovered).toBe(1);

    // The retry re-claims the row and calls postDebit AGAIN. Against a real
    // zero-idempotency core, this is a genuine second debit.
    const drain = await adapter.drainOutbox("110");
    expect(drain.applied).toBe(1); // the adapter believes this succeeded (it did — twice)
    expect(await coreBalance("110", "A")).toBe(1_000); // 5000 - 2000 - 2000: DOUBLE-DEBITED
    expect(await journalRows("110", "A")).toBe(2); // two DEBIT journal rows for one logical transfer

    // The adapter's own bookkeeping (shadow) only ever recorded ONE debit —
    // it has no way to know the core was hit twice. Reconciliation is what
    // surfaces the gap: core (1000) is 2000 less than shadow expects (3000).
    const drift = await reconcileAccount(asDb(d1), core, "110", "A");
    expect(drift).not.toBeNull();
    expect(drift?.drift_amount).toBe(-2_000);
    expect(await openCasesFor("LEGACY_ADAPTER_RECON_DRIFT")).toBe(1);
  });
});

// ===========================================================================
// Commands added to close the 13-command coverage gap identified in
// docs/specs/10_requirements.md §3 (authority-check, name-check,
// debit-settled, cleanup-bank were previously entirely unmodeled).
// ===========================================================================
describe("authority-check(6): requests nothing from the core", () => {
  it("always returns OK, mirroring the greenfield mock", async () => {
    const r = await adapter.authorityCheck({ bank_id: "120", request_id: "ac1" });
    expect(r).toEqual({ result: "OK" });
  });
});

describe("name-check(7): distinct from account-verify(8), returns the holder name", () => {
  it("returns the customer_name on a known account", async () => {
    await adapter.initAccount("121", "A", 1_000, "山田太郎");
    const r = await adapter.nameCheck({ bank_id: "121", account_id: "A", request_id: "nc1" });
    expect(r).toEqual({ result: "OK", customer_name: "山田太郎" });
  });

  it("rejects an unknown account instead of fuzzy-matching (no scoring is requested of the core)", async () => {
    const r = await adapter.nameCheck({ bank_id: "121", account_id: "UNKNOWN", request_id: "nc2" });
    expect(r).toMatchObject({ result: "REJECTED", reason_code: "NAME_MISMATCH" });
  });

  it("degrades to DEFERRED for a non-realtime bank, same as account-verify", async () => {
    await upsertProfile(asDb(d1), { bank_id: "122", realtime_name_check: false });
    const r = await adapter.nameCheck({ bank_id: "122", account_id: "A", request_id: "nc3" });
    expect(r).toMatchObject({ result: "DEFERRED", reason_code: "NAME_CHECK_DEFERRED" });
  });
});

describe("debit-settled(11): passive acknowledgement, no core interaction", () => {
  it("acknowledges idempotently", async () => {
    const first = await adapter.debitSettled({ bank_id: "123", txid: "TX-DS", request_id: "ds1" });
    const dup = await adapter.debitSettled({ bank_id: "123", txid: "TX-DS", request_id: "ds1" });
    expect(first).toEqual({ result: "OK", txid: "TX-DS" });
    expect(dup).toEqual(first);
  });
});

describe("cleanup-bank(13): tears down a departing participant's data", () => {
  it("removes the core account, journal, and shadow for that account", async () => {
    await adapter.initAccount("124", "A", 5_000, "鈴木花子");
    await adapter.executeCredit({ bank_id: "124", account_id: "A", amount: 100, request_id: "cr" });
    expect(await coreBalance("124", "A")).toBe(5_100);

    await adapter.cleanupAccount("124", "A");

    expect(await coreBalance("124", "A")).toBe(0);
    expect(await journalRows("124", "A")).toBe(0);
    expect((await shadowOf("124", "A")).available).toBe(0);
  });
});

// ===========================================================================
// leg-ready-check(5) and rtp-notify(10): initially scoped OUT as requiring
// "GTID/RTP multi-leg semantics", corrected after review — the core-facing
// requirement is identical to reserve-funds/account-verify and credit-notify
// respectively (docs/specs/10_requirements.md §1 rows 5 and 10). These
// tests prove the delegation, not new core logic.
// ===========================================================================
describe("leg-ready-check(5): identical core requirement to reserve-funds/account-verify", () => {
  it("PAYER role reserves funds exactly like reserve-funds, keyed by the predicted GTID txid", async () => {
    await adapter.initAccount("130", "A", 10_000);
    const r = await adapter.legReadyCheck({
      bank_id: "130",
      account_id: "A",
      leg_id: "L1",
      role: "PAYER",
      amount: 4_000,
      request_id: "lrc1",
    });
    expect(r).toMatchObject({ result: "OK", reservation_mode: "SUSPENSE" });
    expect((await shadowOf("130", "A")).reserved).toBe(4_000);
    expect((await shadowOf("130", "A")).available).toBe(6_000);
  });

  it("PAYER role rejects insufficient funds exactly like reserve-funds", async () => {
    await adapter.initAccount("131", "A", 1_000);
    const r = await adapter.legReadyCheck({
      bank_id: "131",
      account_id: "A",
      leg_id: "L2",
      role: "PAYER",
      amount: 5_000,
      request_id: "lrc2",
    });
    expect(r).toMatchObject({ result: "REJECTED", reason_code: "INSUFFICIENT_FUNDS" });
  });

  it("PAYEE role only verifies account existence, exactly like account-verify", async () => {
    await adapter.initAccount("132", "A", 0);
    const r = await adapter.legReadyCheck({
      bank_id: "132",
      account_id: "A",
      leg_id: "L3",
      role: "PAYEE",
      amount: 4_000,
      request_id: "lrc3",
    });
    expect(r).toMatchObject({ result: "OK" });
    // No reservation was taken — PAYEE legs never touch the shadow's reserved.
    expect((await shadowOf("132", "A")).reserved).toBe(0);
  });
});

describe("rtp-notify(10): identical core requirement to credit-notify (pure notification)", () => {
  it("stores the request-to-pay for the payer bank to pull, no core interaction", async () => {
    const r = await adapter.rtpNotify({
      bank_id: "133",
      rtp_id: "RTP-1",
      amount: 3_000,
      request_id: "rn1",
    });
    expect(r).toEqual({ result: "OK" });
    const items = await adapter.pullNotifications("133");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ txid: "RTP-1", account_id: null, amount: 3_000 });
  });

  it("is idempotent under redelivery", async () => {
    await adapter.rtpNotify({ bank_id: "134", rtp_id: "RTP-2", amount: 1, request_id: "rn2" });
    await adapter.rtpNotify({ bank_id: "134", rtp_id: "RTP-2", amount: 1, request_id: "rn2" });
    expect(await adapter.pullNotifications("134")).toHaveLength(1);
  });
});
