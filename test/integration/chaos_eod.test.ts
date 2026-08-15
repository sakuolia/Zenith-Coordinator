/**
 * @file chaos_eod.test.ts — Adversarial harness for the EOD cron re-run seam.
 *
 * Ladder target: EOD cron partial failure / re-run (src/cron/eod.ts, runEod).
 * EOD is a multi-step batch (BULK advance → DNS kick → DNS settle → interest
 * accrual → snapshots → zero-sum → limit reset → retries → finality audit). It
 * is NOT transactional: a crash between steps, or the cron firing twice in one
 * business day, re-runs steps that already committed. The DNS money path was
 * hardened to be re-run safe (probes #6/#7 — Phase-1 is_settled + Phase-2
 * tx_group_id guards). But interest accrual moves money too:
 *
 *   applyDailyInterest posts INTEREST journals under a *deterministic*
 *   tx_group_id (`INT-{date}-{account}`) but never checks whether that group is
 *   already posted, and insertJournalGroup mints a fresh journal_id per call
 *   (no tx_group_id uniqueness). So a second EOD run for the same day posts
 *   interest a SECOND time — and because the first run already credited the
 *   account, the re-run compounds interest on the inflated balance. Each group
 *   is internally zero-sum, so verifyZeroSum cannot catch it: the customer is
 *   silently over-credited.
 *
 * Invariant: a same-day EOD re-run is idempotent on interest — exactly one
 * INTEREST group per account, identical balances after the second run.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { runEod } from "../../src/cron/eod";
import { kickDns } from "../../src/zc/settlement/dns";
import { applyDailyInterest, calcBalance, verifyZeroSum } from "../../src/bank/ledger";
import { todayJST } from "../../src/types";

let d1: MockD1Database;

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

/** Count distinct INTEREST tx_group_ids that touch a given account. */
async function interestGroupCount(accountId: string): Promise<number> {
  const row = await d1
    .prepare(
      `SELECT COUNT(DISTINCT tx_group_id) AS c FROM BankJournals
       WHERE account_id = ? AND tx_type = 'INTEREST'`
    )
    .bind(accountId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

beforeEach(() => {
  ({ d1 } = createTestDb());
});

/**
 * Probe #11 — two EOD runs in one business day (the headline re-run seam).
 *
 * Seed account 0010000001 carries a positive savings balance (seed data), so
 * interest is non-zero. Running runEod twice must credit it exactly once.
 */
describe("chaos: EOD cron runs twice in one business day", () => {
  it("applies daily interest exactly once across a same-day re-run", async () => {
    const env = makeEnv(d1);
    const ACC = "0010000001";

    const r1 = await runEod(env as any);
    expect(r1.ok, r1.log.join("\n")).toBe(true);
    const balAfter1 = await calcBalance(ACC, d1 as any);

    // The day's interest must have been credited (seed balance is positive).
    const balSeed = 1_000_000;
    expect(balAfter1).toBeGreaterThan(balSeed);

    // Cron fires a second time for the same business day (or a crash-retry of a
    // run that already passed the interest step).
    const r2 = await runEod(env as any);
    expect(r2.ok, r2.log.join("\n")).toBe(true);
    const balAfter2 = await calcBalance(ACC, d1 as any);

    // The re-run must not credit interest a second time.
    expect(balAfter2).toBe(balAfter1);
    expect(await interestGroupCount(ACC)).toBe(1);

    // Per-bank double-entry zero-sum survives the re-run.
    expect(await verifyZeroSum("001", d1 as any)).toBe(true);
    expect(await verifyZeroSum("002", d1 as any)).toBe(true);
  });
});

/**
 * Probe #11b — applyDailyInterest re-invoked directly (the non-idempotent unit
 * under the cron). Pins the fix at its source independent of the rest of EOD.
 */
describe("chaos: applyDailyInterest re-invoked for the same date", () => {
  it("is idempotent — second call credits nothing", async () => {
    const ACC = "0010000001";
    const date = "2026-06-13";

    const before = await calcBalance(ACC, d1 as any);
    await applyDailyInterest("001", date, d1 as any);
    const afterOnce = await calcBalance(ACC, d1 as any);
    expect(afterOnce).toBeGreaterThan(before);

    await applyDailyInterest("001", date, d1 as any);
    const afterTwice = await calcBalance(ACC, d1 as any);
    expect(afterTwice).toBe(afterOnce);
    expect(await interestGroupCount(ACC)).toBe(1);
  });
});

/**
 * Probe #13 — non-JPY DNS cycle EOD settlement (multi-currency close).
 *
 * DNS netting is multiplexed per currency (Theme D), but EOD historically kicked
 * and settled ONLY the JPY cycle, so a non-JPY cycle stayed OPEN forever — its
 * tx and H-reservations stranded, never reaching a settled position. runEod now
 * iterates every currency with an OPEN cycle for the day and settles each into
 * its own currency's tokenized central-bank deposit (CBT) account at that
 * currency's central bank (`{bank}-CBT-{CCY}-{CHAIN}`) — the BOJ does not hold
 * non-JPY, so a USD cycle settles on the ECB/FedNY-style CBT rail, not BOJ.
 *
 * The conservation invariant the ledger CAN express: a non-JPY close lands in
 * its own per-currency CBT account and leaves the JPY central-bank
 * (`{bank}-BOJ`) prefund/position untouched — no commingling of non-fungible
 * units — while both cycles reach SETTLED and every bank stays zero-sum.
 */
describe("chaos: EOD settles a non-JPY DNS cycle into its own currency's nostro", () => {
  function insertDecidedTx(
    db: MockD1Database,
    txid: string,
    amount: number,
    currency: string,
    dnsCycleId: string | null
  ) {
    db.prepare(
      `INSERT INTO Transactions
       (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash,
        payee_bank_id, payee_account_hash, dns_cycle_id, idempotency_key, schema_version,
        version, created_at, updated_at)
       VALUES (?, 'BULK', 'DECIDED_TO_SETTLE', ?, ?, '001', '0010000001', '002', '0020000001',
               ?, ?, '1.0', 0, '2025-06-01T12:00:00Z', '2025-06-01T12:00:00Z')`
    )
      .bind(txid, amount, currency, dnsCycleId, `IK-${txid}`)
      ._runSync();
  }

  it("closes the USD cycle in {bank}-CBT-USD-ETH and leaves the JPY BOJ position intact", async () => {
    const env = makeEnv(d1);
    const today = todayJST();
    const usdCycle = `DNS-USD-${today.replace(/-/g, "")}-01`;
    const jpyAmount = 30_000;
    const usdAmount = 5_000;

    // An OPEN USD cycle for today (minted by getOrCreateDnsCycle in production),
    // pinned to the ETH CBT rail.
    d1.prepare(
      `INSERT INTO DnsCycles (cycle_id, business_date, state, igs_mode, currency, intraday_seq, settlement_chain, created_at)
       VALUES (?, ?, 'OPEN', 'NORMAL', 'USD', 1, 'ETH', '2025-06-01T00:00:00Z')`
    )
      .bind(usdCycle, today)
      ._runSync();

    // A JPY tx (swept into the auto-created JPY cycle) and a USD tx (swept into
    // the USD cycle) — both unassigned so kickDns does the currency-scoped sweep.
    insertDecidedTx(d1, "TX-EOD-JPY-001", jpyAmount, "JPY", null);
    insertDecidedTx(d1, "TX-EOD-USD-001", usdAmount, "USD", null);

    // 001 is the USD net debtor; seed its USD tokenized-CB-deposit prefund
    // (zero-sum pair, the same shape as the JPY BOJ prefund) so settlement clears.
    d1.prepare(
      `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, amount_currency, tx_type, tx_group_id, value_date, created_at)
       VALUES ('JNL-USD-PREFUND-ZCS', '001', '001-ZCS', 1000000, 'USD', 'CASH', 'USD-PREFUND-001', '2025-01-01', '2025-01-01T00:00:00Z'),
              ('JNL-USD-PREFUND-CBT', '001', '001-CBT-USD-ETH', -1000000, 'USD', 'CASH', 'USD-PREFUND-001', '2025-01-01', '2025-01-01T00:00:00Z')`
    )._runSync();

    const jpyBojBefore = await calcBalance("001-BOJ", d1 as any);

    const r = await runEod(env as any);
    expect(r.ok, r.log.join("\n")).toBe(true);

    // Both cycles reach SETTLED.
    const usd = await d1
      .prepare(`SELECT state FROM DnsCycles WHERE cycle_id=?`)
      .bind(usdCycle)
      .first<{ state: string }>();
    expect(usd?.state).toBe("SETTLED");
    const jpy = await d1
      .prepare(`SELECT state FROM DnsCycles WHERE cycle_id=? AND currency='JPY'`)
      .bind(`DNS-${today}`)
      .first<{ state: string }>();
    expect(jpy?.state).toBe("SETTLED");

    // The USD settlement landed in the per-currency CBT account: 001 paid 5,000
    // USD (prefund -1,000,000 + 5,000 = -995,000), 002 received it.
    expect(await calcBalance("001-CBT-USD-ETH", d1 as any)).toBe(-995_000);
    expect(await calcBalance("002-CBT-USD-ETH", d1 as any)).toBe(-usdAmount);

    // Isolation: the JPY central-bank position moved ONLY by the JPY cycle
    // (+30,000 net send), never by the USD 5,000.
    expect(await calcBalance("001-BOJ", d1 as any)).toBe(jpyBojBefore + jpyAmount);
    // The USD tx was not netted into the JPY cycle.
    const usdTx = await d1
      .prepare(`SELECT dns_cycle_id FROM Transactions WHERE txid='TX-EOD-USD-001'`)
      .first<{ dns_cycle_id: string | null }>();
    expect(usdTx?.dns_cycle_id).toBe(usdCycle);

    // Every bank stays zero-sum across both currency closes.
    expect(await verifyZeroSum("001", d1 as any)).toBe(true);
    expect(await verifyZeroSum("002", d1 as any)).toBe(true);
  });
});

/**
 * Probe #19 — EOD mid-step crash: a non-JPY cycle stranded in KICKED.
 *
 * EOD is a multi-step batch and is NOT transactional. Probe #11 covers a clean
 * re-run (EOD fired twice) and probes #6/#7 cover the DNS money path's own retry
 * safety, but the *cross-stage* crash — EOD dies BETWEEN a currency's kick and
 * its settle — was uncharacterized. settleDns is re-run safe, so the danger is
 * not double-settlement but a stranded cycle: EOD discovered the currencies to
 * settle from cycles in state 'OPEN' only, and force-added JPY. So a non-JPY
 * cycle left in KICKED by a crash (BOJ half-posted, BULK never executed,
 * H-reservations never released) was invisible to the re-run — it never reached
 * SETTLED. JPY survived solely because it is hardcoded into the iteration set.
 *
 * The fix discovers currencies from cycles in state IN ('OPEN','KICKED'), so a
 * stranded KICKED cycle is re-driven: kickDns returns 'KICKED' for an already-
 * kicked cycle and settleDns completes the unfinished settle exactly once.
 *
 * Invariant: an EOD re-run after a crash between a non-JPY currency's kick and
 * settle drives that cycle to SETTLED, landing in its own per-currency nostro,
 * conserving money, with exactly one BOJ settlement group (idempotent).
 */
describe("chaos #19: EOD re-run settles a non-JPY cycle stranded in KICKED by a mid-step crash", () => {
  function insertDecidedUsdTx(db: MockD1Database, txid: string, amount: number) {
    db.prepare(
      `INSERT INTO Transactions
       (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash,
        payee_bank_id, payee_account_hash, dns_cycle_id, idempotency_key, schema_version,
        version, created_at, updated_at)
       VALUES (?, 'BULK', 'DECIDED_TO_SETTLE', ?, 'USD', '001', '0010000001', '002', '0020000001',
               NULL, ?, '1.0', 0, '2025-06-01T12:00:00Z', '2025-06-01T12:00:00Z')`
    )
      .bind(txid, amount, `IK-${txid}`)
      ._runSync();
  }

  it("re-drives the KICKED USD cycle to SETTLED, idempotently and conserving money", async () => {
    const env = makeEnv(d1);
    const today = todayJST();
    const usdCycle = `DNS-USD-${today.replace(/-/g, "")}-01`;
    const usdAmount = 5_000;

    // An OPEN USD cycle for today (ETH CBT rail) and a pending USD BULK tx (001 is net debtor).
    d1.prepare(
      `INSERT INTO DnsCycles (cycle_id, business_date, state, igs_mode, currency, intraday_seq, settlement_chain, created_at)
       VALUES (?, ?, 'OPEN', 'NORMAL', 'USD', 1, 'ETH', '2025-06-01T00:00:00Z')`
    )
      .bind(usdCycle, today)
      ._runSync();
    insertDecidedUsdTx(d1, "TX-EOD19-USD-001", usdAmount);

    // 001's USD tokenized-CB-deposit prefund (zero-sum pair) so settlement clears.
    d1.prepare(
      `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, amount_currency, tx_type, tx_group_id, value_date, created_at)
       VALUES ('JNL19-USD-PREFUND-ZCS', '001', '001-ZCS', 1000000, 'USD', 'CASH', 'USD-PREFUND-001', '2025-01-01', '2025-01-01T00:00:00Z'),
              ('JNL19-USD-PREFUND-CBT', '001', '001-CBT-USD-ETH', -1000000, 'USD', 'CASH', 'USD-PREFUND-001', '2025-01-01', '2025-01-01T00:00:00Z')`
    )._runSync();

    // EOD reached the USD kick (tx assigned, net positions snapshotted) and then
    // crashed BEFORE settleDns — the cycle is stranded in KICKED.
    const kick = await kickDns(today, env as any, "USD");
    expect(kick.state).toBe("KICKED");
    const stranded = await d1
      .prepare(`SELECT state FROM DnsCycles WHERE cycle_id=?`)
      .bind(usdCycle)
      .first<{ state: string }>();
    expect(stranded?.state).toBe("KICKED");
    const assigned = await d1
      .prepare(`SELECT dns_cycle_id FROM Transactions WHERE txid='TX-EOD19-USD-001'`)
      .first<{ dns_cycle_id: string | null }>();
    expect(assigned?.dns_cycle_id).toBe(usdCycle);

    // EOD re-runs from the top. It must recover the stranded KICKED USD cycle.
    const r = await runEod(env as any);
    expect(r.ok, r.log.join("\n")).toBe(true);

    const settled = await d1
      .prepare(`SELECT state FROM DnsCycles WHERE cycle_id=?`)
      .bind(usdCycle)
      .first<{ state: string }>();
    expect(settled?.state).toBe("SETTLED");

    // Settlement landed in the per-currency CBT account: 001 paid 5,000 USD
    // (prefund -1,000,000 + 5,000), 002 received it. JPY BOJ untouched.
    expect(await calcBalance("001-CBT-USD-ETH", d1 as any)).toBe(-995_000);
    expect(await calcBalance("002-CBT-USD-ETH", d1 as any)).toBe(-usdAmount);

    // Exactly one BOJ settlement group for the net debtor (no double-post).
    const bojGroupCount = await d1
      .prepare(`SELECT COUNT(*) AS c FROM BankJournals WHERE tx_group_id = ?`)
      .bind(`DNS-BOJ-${usdCycle}-001`)
      .first<{ c: number }>();
    expect(bojGroupCount?.c).toBe(2);

    expect(await verifyZeroSum("001", d1 as any)).toBe(true);
    expect(await verifyZeroSum("002", d1 as any)).toBe(true);
  });
});
