/**
 * @file chaos_dns.test.ts — Adversarial probe #6: DNS settlement is the most
 *       systemic operation in the system (it moves every participant's central-
 *       bank position at once), so a non-idempotent re-run is the highest-
 *       severity failure mode.
 *
 * `settleDns` is not atomic: it settles suspense, posts ZCS journals (Phase 1,
 * guarded by `is_settled`), posts BOJ settlement journals (Phase 2), then
 * commits `state='SETTLED'` as a final separate write. If the process crashes
 * (or the SETTLED write is lost to a partition) AFTER Phase 2 but BEFORE the
 * commit, the cycle is still `KICKED` and the queue/cron will retry settleDns.
 *
 * This probe reproduces that retry faithfully: run a full settleDns, then reset
 * the cycle to KICKED (the exact state a lost SETTLED-commit leaves behind —
 * is_settled=1, BOJ journals posted, state still KICKED) and settle again. The
 * invariant: a DNS retry must not move any participant's BOJ position twice.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { todayJST } from "../../src/types";
import { advanceBulk } from "../../src/zc/lanes/bulk";
import { advanceHighValue } from "../../src/zc/lanes/highvalue";
import {
  kickDns,
  settleDns,
  resumeDns,
  holdDns,
  getOrCreateDnsCycle,
} from "../../src/zc/settlement/dns";
import { processQueueMessage } from "../../src/zc/orchestrator";
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

async function drain(env: TestEnv, max = 50): Promise<void> {
  let n = 0;
  while (env.QUEUE._sink.length > 0 && n < max) {
    await processQueueMessage(env.QUEUE._sink.shift()!, env as any);
    n++;
  }
  if (n >= max) throw new Error("drain: did not converge");
}

function seedParticipant(db: MockD1Database, bankId: string) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 100000000, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId)
    ._runSync();
}

function insertBulkTx(db: MockD1Database, txid: string, amount: number) {
  db.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash,
      payee_bank_id, payee_account_hash, pspr_ref, idempotency_key, schema_version,
      version, created_at, updated_at)
     VALUES (?, 'BULK', 'RECEIVED', ?, 'JPY', ?, ?, ?, ?, NULL, ?, '1.0', 0,
             '2025-06-01T12:00:00Z', '2025-06-01T12:00:00Z')`
  )
    .bind(txid, amount, BANK_A, ACC_A, BANK_B, ACC_B, `IK-${txid}`)
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

let d1: MockD1Database;
beforeEach(() => {
  ({ d1 } = createTestDb());
  seedParticipant(d1, BANK_A);
  seedParticipant(d1, BANK_B);
});

describe("chaos #6: DNS settlement retried after a lost SETTLED-commit", () => {
  it("does not move any participant's BOJ position twice on a settleDns retry", async () => {
    const env = makeEnv(d1);
    const amount = 30_000;
    insertBulkTx(d1, "TX-BULK-CHAOS-001", amount);

    await advanceBulk("TX-BULK-CHAOS-001", env as any);
    const today = todayJST();
    const kick = await kickDns(today, env as any);
    expect(kick.state).toBe("KICKED");

    await settleDns(kick.cycle_id, env as any);
    await drain(env);

    // Snapshot the correct post-settlement positions.
    const bojA1 = await balanceOf(d1, `${BANK_A}-BOJ`);
    const bojB1 = await balanceOf(d1, `${BANK_B}-BOJ`);
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);

    // Simulate the crash window: Phase 2 (BOJ journals) already posted, but the
    // final state='SETTLED' write was lost — the cycle is still KICKED, so the
    // retry path re-enters settleDns.
    d1.prepare(`UPDATE DnsCycles SET state='KICKED' WHERE cycle_id=?`)
      .bind(kick.cycle_id)
      ._runSync();

    await settleDns(kick.cycle_id, env as any);
    await drain(env);

    // The retry must be a no-op for money: every BOJ position is unchanged, and
    // exactly one DNS-BOJ journal group exists per bank (2 entries, not 4).
    expect(await balanceOf(d1, `${BANK_A}-BOJ`)).toBe(bojA1);
    expect(await balanceOf(d1, `${BANK_B}-BOJ`)).toBe(bojB1);
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);

    const bojGroupCount = await d1
      .prepare(`SELECT COUNT(*) AS c FROM BankJournals WHERE tx_group_id = ?`)
      .bind(`DNS-BOJ-${kick.cycle_id}-${BANK_A}`)
      .first<{ c: number }>();
    expect(bojGroupCount?.c).toBe(2);
  });

  it("does not double-post the Phase-1 suspense/ZCS journal when is_settled was not yet flipped", async () => {
    // settleDns Phase 1 posts the `DNS-SETTLE-{cycle}-{bank}` group and then, in
    // a SEPARATE statement, flips DnsNetPositions.is_settled=1. A crash between
    // those two re-enters settleDns with is_settled still 0, so the netPositions
    // (WHERE is_settled=0) query re-selects the bank and would re-post the group
    // — double-moving suspense → ZCS. This pins the alreadyPosted guard that
    // makes the re-post a no-op (mirrors the Phase-2 BOJ guard in chaos #6).
    const env = makeEnv(d1);
    const amount = 30_000;
    insertBulkTx(d1, "TX-BULK-P1-001", amount);
    await advanceBulk("TX-BULK-P1-001", env as any);

    const today = todayJST();
    const kick = await kickDns(today, env as any);
    expect(kick.state).toBe("KICKED");

    await settleDns(kick.cycle_id, env as any);
    await drain(env);

    const sendGroupId = `DNS-SETTLE-${kick.cycle_id}-${BANK_A}`;
    const zcsBefore = await balanceOf(d1, `${BANK_A}-ZCS`);
    const groupBefore = await d1
      .prepare(`SELECT COUNT(*) AS c FROM BankJournals WHERE tx_group_id = ?`)
      .bind(sendGroupId)
      .first<{ c: number }>();
    expect(groupBefore?.c).toBe(2); // one balanced suspense/ZCS pair

    // Simulate the precise crash window: Phase-1 journal already posted, but the
    // is_settled flip AND the final state='SETTLED' write were both lost.
    d1.prepare(`UPDATE DnsCycles SET state='KICKED' WHERE cycle_id=?`)
      .bind(kick.cycle_id)
      ._runSync();
    d1.prepare(`UPDATE DnsNetPositions SET is_settled=0 WHERE cycle_id=?`)
      .bind(kick.cycle_id)
      ._runSync();

    await settleDns(kick.cycle_id, env as any);
    await drain(env);

    // The retry must NOT re-post the Phase-1 group: still exactly 2 entries, and
    // the bank's ZCS position is unchanged. Ledger zero-sum still holds.
    const groupAfter = await d1
      .prepare(`SELECT COUNT(*) AS c FROM BankJournals WHERE tx_group_id = ?`)
      .bind(sendGroupId)
      .first<{ c: number }>();
    expect(groupAfter?.c).toBe(2);
    expect(await balanceOf(d1, `${BANK_A}-ZCS`)).toBe(zcsBefore);
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);
  });
});

/**
 * Probe #7 — the kick/sweep commitment boundary.
 *
 * kickDns is the commitment point: it assigns pending tx to the cycle and
 * SNAPSHOTS each participant's net position into DnsNetPositions. settleDns
 * then settles that snapshot, not the live tx states. So once a tx is in the
 * snapshot, it must not be able to leave the settle-able set behind the
 * cycle's back — otherwise settleDns moves money for a tx that was meanwhile
 * abandoned (the net debtor's snapshot no longer matches reality).
 *
 * But the timeout sweep selects PAYER_EXEC_CONFIRMED / DECIDED_TO_SETTLE tx
 * with no regard for dns_cycle_id, so it can SUSPEND a tx that kickDns already
 * baked into the net position. This probe pins the invariant: a tx committed
 * to a DNS cycle is governed by that cycle, not by the payee-proof timeout.
 */
describe("chaos #7: timeout sweep must not abandon a tx already committed to a DNS cycle", () => {
  it("does not suspend a PAYER_EXEC_CONFIRMED tx after kickDns snapshotted it into the net position", async () => {
    const env = makeEnv(d1);
    const amount = 40_000;

    // A STANDARD tx stuck in PAYER_EXEC_CONFIRMED (payer debited, payee credit
    // pending), with an old updated_at so the payee-proof timeout would fire.
    d1.prepare(
      `INSERT INTO Transactions
       (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash,
        payee_bank_id, payee_account_hash, idempotency_key, schema_version, version,
        created_at, updated_at)
       VALUES ('TX-DNS-COMMIT-001', 'STANDARD', 'PAYER_EXEC_CONFIRMED', ?, 'JPY', ?, ?, ?, ?,
               'IK-DNS-COMMIT-001', '1.0', 0, '2025-06-01T11:00:00Z', '2025-06-01T11:00:00Z')`
    )
      .bind(amount, BANK_A, ACC_A, BANK_B, ACC_B)
      ._runSync();

    // kickDns commits the tx to the cycle and snapshots the net position.
    const today = todayJST();
    const kick = await kickDns(today, env as any);
    expect(kick.state).toBe("KICKED");

    const assigned = await d1
      .prepare(`SELECT dns_cycle_id FROM Transactions WHERE txid='TX-DNS-COMMIT-001'`)
      .first<{ dns_cycle_id: string | null }>();
    expect(assigned?.dns_cycle_id).toBe(kick.cycle_id); // committed
    const netPos = await d1
      .prepare(`SELECT net_position FROM DnsNetPositions WHERE cycle_id=? AND bank_id=?`)
      .bind(kick.cycle_id, BANK_A)
      .first<{ net_position: number }>();
    expect(netPos?.net_position).toBe(-amount); // snapshot includes the tx

    // The payee-proof timeout fires. It must NOT abandon a tx the cycle already
    // owns — otherwise settleDns would settle a net position for an abandoned tx.
    await runTimeoutSweep(env as any);

    const after = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid='TX-DNS-COMMIT-001'`)
      .first<{ state: string }>();
    expect(after?.state).not.toBe("SUSPENDED");
    expect(after?.state).toBe("PAYER_EXEC_CONFIRMED");
  });
});

/**
 * Probe #8 — DNS_HOLD recovery (net-debtor shortfall liveness).
 *
 * When a net debtor cannot cover its position, settleDns aborts the cycle to
 * HOLD_ACTIVE. Recovery follows the DNS_HOLD protocol (10_requirements.md §2.5.2):
 * self-help / LPB / mutual contribution / central-bank supply deliver bridge
 * liquidity, after which the clearing completes (the "不足解消? → はい →
 * SETTLED" edge). resumeDns re-checks the shortfall and, once cleared, takes the
 * cycle HOLD_ACTIVE → KICKED → SETTLED.
 *
 * Without recovery a single shortfall would strand the cycle forever — and
 * (per probe #7) the committed tx is also excluded from the timeout sweep, so
 * there is no other escape. This probe pins that recovery now works.
 */
describe("chaos #8: DNS_HOLD on a net-debtor shortfall recovers once liquidity is restored", () => {
  it("holds on shortfall, stays held while still short, then resumeDns settles after bridge liquidity", async () => {
    const env = makeEnv(d1);

    // Fund ACC_A enough to send 11,000,000 (> the 10,000,000 BOJ pre-fund),
    // forcing a net-debtor BOJ shortfall at settlement time.
    d1.prepare(
      `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES ('JNL-FUND-A', ?, ?, 10000000, 'CASH', 'FUND', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(BANK_A, ACC_A)
      ._runSync();

    const amount = 11_000_000;
    insertBulkTx(d1, "TX-BULK-HOLD-001", amount);
    await advanceBulk("TX-BULK-HOLD-001", env as any);

    const today = todayJST();
    const kick = await kickDns(today, env as any);
    expect(kick.state).toBe("KICKED");

    // settleDns detects BANK_A's BOJ shortfall (11M required vs 10M pre-fund).
    await settleDns(kick.cycle_id, env as any);
    const held = await d1
      .prepare(`SELECT state FROM DnsCycles WHERE cycle_id=?`)
      .bind(kick.cycle_id)
      .first<{ state: string }>();
    expect(held?.state).toBe("HOLD_ACTIVE");

    // The settlement-time hold must be recorded under the canonical event name
    // 'DnsHoldActivated' (FinalityEventType / explain EVENT_REASONS), not the
    // off-union 'DnsHeld' — otherwise explain/story cannot map it to a reason.
    const holdEvents = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE gtid=? AND state_to='HOLD_ACTIVE'`)
      .bind(kick.cycle_id)
      .all<{ event_type: string }>();
    expect(holdEvents.results.map((r) => r.event_type)).toContain("DnsHoldActivated");
    expect(holdEvents.results.map((r) => r.event_type)).not.toContain("DnsHeld");

    // resumeDns before liquidity arrives: still short, stays held.
    const early = await resumeDns(kick.cycle_id, env as any);
    expect(early.resumed).toBe(false);
    expect(early.shortfalls?.length).toBeGreaterThan(0);

    // Bridge liquidity arrives (LPB / mutual contribution / central-bank supply
    // into the pool): top up BANK_A's BOJ so the shortfall clears.
    d1.prepare(
      `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES ('JNL-BRIDGE-A', ?, ?, -2000000, 'CASH', 'BRIDGE', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(BANK_A, `${BANK_A}-BOJ`)
      ._runSync();

    // resumeDns now completes the clearing: HOLD_ACTIVE → KICKED → SETTLED.
    const recovered = await resumeDns(kick.cycle_id, env as any);
    expect(recovered.resumed).toBe(true);
    await drain(env);

    const settled = await d1
      .prepare(`SELECT state FROM DnsCycles WHERE cycle_id=?`)
      .bind(kick.cycle_id)
      .first<{ state: string }>();
    expect(settled?.state).toBe("SETTLED");

    // The previously-stranded tx settles, money is conserved, and there is
    // exactly one DNS-BOJ journal group per debtor (idempotent settle).
    const finalTx = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid='TX-BULK-HOLD-001'`)
      .first<{ state: string }>();
    expect(finalTx?.state).toBe("SETTLED");
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);
    // BANK_B has no injected one-sided journals, so its double-entry zero-sum
    // must still hold. (BANK_A's is intentionally broken by the simulated
    // external cash-in + bridge-liquidity journals this fixture injects.)
    expect(await bankSum(d1, BANK_B)).toBe(0);

    const bojGroupCount = await d1
      .prepare(`SELECT COUNT(*) AS c FROM BankJournals WHERE tx_group_id = ?`)
      .bind(`DNS-BOJ-${kick.cycle_id}-${BANK_A}`)
      .first<{ c: number }>();
    expect(bojGroupCount?.c).toBe(2);

    // A redundant resume on an already-SETTLED cycle is a no-op.
    const again = await resumeDns(kick.cycle_id, env as any);
    expect(again.resumed).toBe(false);
  });
});

/**
 * Probe #12 — multi-currency cross-cycle leakage at DNS kick.
 *
 * DNS netting is multiplexed along the currency axis (Theme D): each currency
 * has its own cycle (`DNS-{CCY}-…`), and only the JPY cycle is settled by EOD
 * today. But kickDns was currency-blind on BOTH sides of the commit:
 *   - it picked the day's oldest OPEN cycle with no currency filter, and
 *   - its NULL-dns_cycle_id sweep assigned EVERY pending non-HIGH_VALUE tx to
 *     that cycle regardless of amount_currency, then netted amount_value at par.
 *
 * So a pending USD transaction was swept into the JPY settlement cycle and its
 * 700 "USD" was netted as 700 JPY — a foreign obligation settled through the
 * JPY BOJ rail at 1:1. That is a money-conservation break: the netting mixes
 * units that are not fungible. The invariant: a DNS cycle nets only the
 * transactions of its own currency; a tx of a different currency is left for
 * its own currency's cycle (dns_cycle_id stays unassigned here).
 */
describe("chaos #12: DNS kick must not net foreign-currency tx into the JPY cycle", () => {
  function insertDecidedTx(db: MockD1Database, txid: string, amount: number, currency: string) {
    db.prepare(
      `INSERT INTO Transactions
       (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash,
        payee_bank_id, payee_account_hash, idempotency_key, schema_version, version,
        created_at, updated_at)
       VALUES (?, 'BULK', 'DECIDED_TO_SETTLE', ?, ?, ?, ?, ?, ?, ?, '1.0', 0,
               '2025-06-01T12:00:00Z', '2025-06-01T12:00:00Z')`
    )
      .bind(txid, amount, currency, BANK_A, ACC_A, BANK_B, ACC_B, `IK-${txid}`)
      ._runSync();
  }

  it("nets only JPY tx and leaves the USD tx for its own currency's cycle", async () => {
    const env = makeEnv(d1);
    const jpyAmount = 100_000;
    const usdAmount = 700;

    insertDecidedTx(d1, "TX-DNS-JPY-001", jpyAmount, "JPY");
    insertDecidedTx(d1, "TX-DNS-USD-001", usdAmount, "USD");

    const today = todayJST();
    const kick = await kickDns(today, env as any);
    expect(kick.state).toBe("KICKED");

    // The kicked cycle is the JPY cycle.
    const cycle = await d1
      .prepare(`SELECT currency FROM DnsCycles WHERE cycle_id=?`)
      .bind(kick.cycle_id)
      .first<{ currency: string }>();
    expect(cycle?.currency).toBe("JPY");

    // The USD tx must NOT have been swept into the JPY cycle.
    const usd = await d1
      .prepare(`SELECT dns_cycle_id FROM Transactions WHERE txid='TX-DNS-USD-001'`)
      .first<{ dns_cycle_id: string | null }>();
    expect(usd?.dns_cycle_id).toBeNull();

    // The JPY tx is committed to the cycle.
    const jpy = await d1
      .prepare(`SELECT dns_cycle_id FROM Transactions WHERE txid='TX-DNS-JPY-001'`)
      .first<{ dns_cycle_id: string | null }>();
    expect(jpy?.dns_cycle_id).toBe(kick.cycle_id);

    // Net positions reflect ONLY the JPY amount — no 700 of foreign value mixed in.
    expect(kick.net_positions[BANK_A]).toBe(-jpyAmount);
    expect(kick.net_positions[BANK_B]).toBe(jpyAmount);
    const netA = await d1
      .prepare(`SELECT net_position FROM DnsNetPositions WHERE cycle_id=? AND bank_id=?`)
      .bind(kick.cycle_id, BANK_A)
      .first<{ net_position: number }>();
    expect(netA?.net_position).toBe(-jpyAmount);
  });
});

/**
 * Probe #16 — DNS_HOLD igs_mode ring-fence escalation (docs/specs/20_method_design.md §2.4 類型B).
 *
 * When a DNS cycle is held on a BOJ shortfall, HIGH_VALUE (IGS) settlement used
 * to continue unaffected — including transfers moving the *defaulting* bank's
 * central-bank position, the exact thing a hold is meant to contain. settleDns
 * now escalates the held cycle to igs_mode=RINGFENCED and records the
 * hold-causing participants; checkIgsAdmission (called from advanceHighValue)
 * then isolates the defaulter: IGS is admitted only when neither leg is a
 * hold-causing bank. The invariant: a partial ring-fence conserves money — the
 * held bank's position is frozen while non-held banks keep settling.
 */
const BANK_C = "003";
const ACC_C = "0030000001";

function seedBankCAccount(db: MockD1Database) {
  db.prepare(
    `INSERT OR IGNORE INTO BankAccounts
     (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
     VALUES (?, ?, 'C003', 'Bank C User', 'SAVINGS', 'NORMAL', '2025-01-01T00:00:00Z')`
  )
    .bind(ACC_C, BANK_C)
    ._runSync();
}

function insertHvTx(
  db: MockD1Database,
  txid: string,
  amount: number,
  payerBank: string,
  payerAcc: string,
  payeeBank: string,
  payeeAcc: string
) {
  db.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash,
      payee_bank_id, payee_account_hash, idempotency_key, schema_version, version,
      created_at, updated_at)
     VALUES (?, 'HIGH_VALUE', 'RECEIVED', ?, 'JPY', ?, ?, ?, ?, ?, '1.0', 0,
             '2025-06-01T12:00:00Z', '2025-06-01T12:00:00Z')`
  )
    .bind(txid, amount, payerBank, payerAcc, payeeBank, payeeAcc, `IK-${txid}`)
    ._runSync();
}

async function hvState(db: MockD1Database, txid: string) {
  return db
    .prepare(`SELECT state, reason_code FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: string; reason_code: string | null }>();
}

describe("chaos #16: DNS_HOLD ring-fence isolates the defaulter's IGS, not everyone's", () => {
  it("blocks IGS that touches a hold-causing bank, admits IGS among non-held banks, lifts on recovery", async () => {
    const env = makeEnv(d1);
    seedParticipant(d1, BANK_C);
    seedBankCAccount(d1);

    // BANK_A becomes a net debtor it cannot cover: fund it to send 11M (> its 10M
    // BOJ pre-fund), forcing a shortfall and a DNS_HOLD caused by BANK_A.
    d1.prepare(
      `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES ('JNL-RF-FUND-A', ?, ?, 10000000, 'CASH', 'FUND', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(BANK_A, ACC_A)
      ._runSync();

    insertBulkTx(d1, "TX-RF-BULK", 11_000_000);
    await advanceBulk("TX-RF-BULK", env as any);
    const today = todayJST();
    const kick = await kickDns(today, env as any);
    await settleDns(kick.cycle_id, env as any);

    // The cycle is held and ring-fenced, with BANK_A recorded as the cause.
    const held = await d1
      .prepare(`SELECT state, igs_mode, hold_causing_participants FROM DnsCycles WHERE cycle_id=?`)
      .bind(kick.cycle_id)
      .first<{ state: string; igs_mode: string; hold_causing_participants: string | null }>();
    expect(held?.state).toBe("HOLD_ACTIVE");
    expect(held?.igs_mode).toBe("RINGFENCED");
    expect(JSON.parse(held?.hold_causing_participants ?? "[]")).toContain(BANK_A);

    const bojABefore = await balanceOf(d1, `${BANK_A}-BOJ`);

    // IGS touching the held bank (A→C) is blocked — A's position must not move.
    insertHvTx(d1, "TX-RF-HELD", 500_000, BANK_A, ACC_A, BANK_C, ACC_C);
    await advanceHighValue("TX-RF-HELD", env as any);
    const blocked = await hvState(d1, "TX-RF-HELD");
    expect(blocked?.state).toBe("PRECHECKED_SUSPENDED");
    expect(blocked?.reason_code).toBe("DNS_RINGFENCED");
    expect(await balanceOf(d1, `${BANK_A}-BOJ`)).toBe(bojABefore); // frozen

    // IGS among non-held banks (B→C) keeps settling.
    insertHvTx(d1, "TX-RF-FREE", 500_000, BANK_B, ACC_B, BANK_C, ACC_C);
    await advanceHighValue("TX-RF-FREE", env as any);
    expect((await hvState(d1, "TX-RF-FREE"))?.state).toBe("DECIDED_TO_SETTLE");

    // Bridge liquidity covers BANK_A's shortfall; resumeDns settles the cycle and
    // lifts the ring-fence (igs_mode → NORMAL, cause cleared).
    d1.prepare(
      `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES ('JNL-RF-BRIDGE-A', ?, ?, -2000000, 'CASH', 'BRIDGE', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(BANK_A, `${BANK_A}-BOJ`)
      ._runSync();
    const recovered = await resumeDns(kick.cycle_id, env as any);
    expect(recovered.resumed).toBe(true);

    const settled = await d1
      .prepare(`SELECT state, igs_mode, hold_causing_participants FROM DnsCycles WHERE cycle_id=?`)
      .bind(kick.cycle_id)
      .first<{ state: string; igs_mode: string; hold_causing_participants: string | null }>();
    expect(settled?.state).toBe("SETTLED");
    expect(settled?.igs_mode).toBe("NORMAL");
    expect(settled?.hold_causing_participants).toBeNull();

    // With the hold lifted, BANK_A's IGS is admitted again.
    insertHvTx(d1, "TX-RF-AFTER", 300_000, BANK_A, ACC_A, BANK_C, ACC_C);
    await advanceHighValue("TX-RF-AFTER", env as any);
    expect((await hvState(d1, "TX-RF-AFTER"))?.state).toBe("DECIDED_TO_SETTLE");
  });

  it("STOP halts all IGS (manual holdDns, no cause identified)", async () => {
    const env = makeEnv(d1);
    seedParticipant(d1, BANK_C);
    seedBankCAccount(d1);

    const today = todayJST();
    await getOrCreateDnsCycle(d1 as any, `${today}T12:00:00Z`); // OPEN JPY cycle
    await holdDns(today, "EMERGENCY", env as any); // OPEN → HOLD_ACTIVE, igs_mode=STOP

    // Even non-held banks are halted under STOP (cause not yet identified).
    insertHvTx(d1, "TX-STOP-1", 500_000, BANK_B, ACC_B, BANK_C, ACC_C);
    await advanceHighValue("TX-STOP-1", env as any);
    const tx = await hvState(d1, "TX-STOP-1");
    expect(tx?.state).toBe("PRECHECKED_SUSPENDED");
    expect(tx?.reason_code).toBe("DNS_HOLD_IGS_STOPPED");
  });
});

/**
 * Probe #17 — ring-fenced IGS auto-resume once the hold lifts (docs/specs/20_method_design.md §2.4 類型B, liveness).
 *
 * Probe #16 pinned *containment*: while a DNS cycle is held and ring-fenced, an
 * IGS that touches the defaulting bank is parked in PRECHECKED_SUSPENDED so the
 * held bank's central-bank position cannot move. But containment without a
 * release edge is a different bug: when the cycle recovers (resumeDns settles it
 * and lifts igs_mode → NORMAL), the parked IGS used to stay PRECHECKED_SUSPENDED
 * *forever*. Nothing re-drove it — the payer is never debited and the payee
 * never credited, even though the instruction was always valid and is now fully
 * admissible. A transfer blocked purely for containment had no path back to
 * settlement: stranded funds-in-flight.
 *
 * The fix wires resumeRingfencedIgs into the per-minute timeout sweep (the same
 * liveness backstop that resumes window-closed EXPRESS, probe — Theme E). It
 * re-checks live IGS admission, so it is a no-op while the cycle is still held,
 * and revives the tx exactly once after recovery.
 *
 * Invariant: a ring-fenced IGS resumes once and only once after the hold lifts —
 * it stays parked while still held, settles to SETTLED after recovery moving the
 * payer/payee exactly +/- amount, and a redelivered (at-least-once) sweep does
 * not double-settle.
 */
describe("chaos #17: a ring-fenced IGS resumes exactly once after the DNS hold lifts", () => {
  it("stays parked while held, settles after recovery, and a duplicate sweep is a no-op", async () => {
    const env = makeEnv(d1);

    // BANK_A becomes an uncoverable net debtor (send 11M > its 10M BOJ pre-fund),
    // forcing a DNS_HOLD ring-fence caused by BANK_A. Fund ACC_A for the 11M BULK
    // *plus* the 500k HIGH_VALUE that follows.
    const HV = 500_000;
    d1.prepare(
      `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES ('JNL-17-FUND-A', ?, ?, 10500000, 'CASH', 'FUND', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(BANK_A, ACC_A)
      ._runSync();

    insertBulkTx(d1, "TX-17-BULK", 11_000_000);
    await advanceBulk("TX-17-BULK", env as any);
    const today = todayJST();
    const kick = await kickDns(today, env as any);
    await settleDns(kick.cycle_id, env as any);

    // Cycle is held and ring-fenced with BANK_A as the cause.
    const held = await d1
      .prepare(`SELECT state, igs_mode FROM DnsCycles WHERE cycle_id=?`)
      .bind(kick.cycle_id)
      .first<{ state: string; igs_mode: string }>();
    expect(held?.state).toBe("HOLD_ACTIVE");
    expect(held?.igs_mode).toBe("RINGFENCED");

    // An IGS touching the held bank (A→B) is ring-fenced into PRECHECKED_SUSPENDED.
    insertHvTx(d1, "TX-17-IGS", HV, BANK_A, ACC_A, BANK_B, ACC_B);
    await advanceHighValue("TX-17-IGS", env as any);
    const parked = await hvState(d1, "TX-17-IGS");
    expect(parked?.state).toBe("PRECHECKED_SUSPENDED");
    expect(parked?.reason_code).toBe("DNS_RINGFENCED");

    // Sweep while the cycle is STILL held: the IGS must stay parked (admission
    // re-check fails), and the payer must not be debited.
    const accABeforeRecovery = await balanceOf(d1, ACC_A);
    await runTimeoutSweep(env as any);
    await drain(env);
    expect((await hvState(d1, "TX-17-IGS"))?.state).toBe("PRECHECKED_SUSPENDED");
    expect(await balanceOf(d1, ACC_A)).toBe(accABeforeRecovery);

    // Bridge liquidity covers BANK_A's shortfall; resumeDns settles the cycle and
    // lifts the ring-fence (igs_mode → NORMAL). Drain to complete the BULK money path.
    d1.prepare(
      `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES ('JNL-17-BRIDGE-A', ?, ?, -2000000, 'CASH', 'BRIDGE', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(BANK_A, `${BANK_A}-BOJ`)
      ._runSync();
    const recovered = await resumeDns(kick.cycle_id, env as any);
    expect(recovered.resumed).toBe(true);
    await drain(env);

    const settledCycle = await d1
      .prepare(`SELECT state, igs_mode FROM DnsCycles WHERE cycle_id=?`)
      .bind(kick.cycle_id)
      .first<{ state: string; igs_mode: string }>();
    expect(settledCycle?.state).toBe("SETTLED");
    expect(settledCycle?.igs_mode).toBe("NORMAL");

    // The IGS is still parked — recovery alone does not resume it; the sweep does.
    expect((await hvState(d1, "TX-17-IGS"))?.state).toBe("PRECHECKED_SUSPENDED");

    // Snapshot the clean post-BULK positions, then run the sweep that revives the IGS.
    const accABefore = await balanceOf(d1, ACC_A);
    const accBBefore = await balanceOf(d1, ACC_B);

    await runTimeoutSweep(env as any);
    await drain(env); // ZC_BANK_DEBIT → ZC_IGS_CALLBACK → ZC_BANK_CREDIT

    // The IGS settled end-to-end: payer −HV, payee +HV, exactly once.
    expect((await hvState(d1, "TX-17-IGS"))?.state).toBe("SETTLED");
    expect(await balanceOf(d1, ACC_A)).toBe(accABefore - HV);
    expect(await balanceOf(d1, ACC_B)).toBe(accBBefore + HV);

    // At-least-once: a redelivered sweep must not double-settle. The tx is past
    // PRECHECKED_SUSPENDED, so resumeRingfencedIgs is a no-op.
    await runTimeoutSweep(env as any);
    await drain(env);
    expect((await hvState(d1, "TX-17-IGS"))?.state).toBe("SETTLED");
    expect(await balanceOf(d1, ACC_A)).toBe(accABefore - HV);
    expect(await balanceOf(d1, ACC_B)).toBe(accBBefore + HV);

    // Exactly one resume was recorded in the audit trail.
    const resumeEvents = await d1
      .prepare(
        `SELECT COUNT(*) AS c FROM FinalityLog WHERE txid='TX-17-IGS' AND event_type='IgsRingfenceResumed'`
      )
      .first<{ c: number }>();
    expect(resumeEvents?.c).toBe(1);

    // BANK_B keeps its double-entry zero-sum (BANK_A's is intentionally broken by
    // the injected one-sided FUND/BRIDGE journals this fixture uses).
    expect(await bankSum(d1, BANK_B)).toBe(0);
  });
});
