/**
 * @file chaos_gtid.test.ts — Adversarial probe #9: GTID finalization must not
 *       permanently suspend a coordinated transfer on a *transient* leg state.
 *
 * GTID (取引連携型決済モデル) completion is recognised by checkAndFinalizeGtid:
 * all legs SETTLED → GT_SETTLED; any failed leg → GT_SUSPENDED. The bug: it
 * treated a SUSPENDED leg as "failed" and moved the GTID to the terminal
 * GT_SUSPENDED. But SUSPENDED is a *transient* state — a leg awaiting payee
 * approval (AWAITING_PAYEE_APPROVAL) is SUSPENDED and resumes to SETTLED once
 * approved. If finalization ran during that window, the GTID was pinned at
 * GT_SUSPENDED forever; even after the leg approved and settled, the GTID could
 * never reach GT_SETTLED (checkAndFinalizeGtid only acts on GT_DECIDED_TO_SETTLE).
 *
 * Only a *terminal* leg failure (FAILED_EXECUTION — what the timeout sweep
 * eventually assigns to a permanently stuck SUSPENDED leg) should suspend the
 * GTID. A SUSPENDED leg means "still in flight, keep waiting".
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { registerGtid, advanceGtid } from "../../src/zc/lanes/gtid";
import { checkAndFinalizeGtid, processQueueMessage } from "../../src/zc/orchestrator";

const BANK_A = "001";
const BANK_B = "002";
const ACC_A = "0010000001";
const ACC_A2 = "0010000002";
const ACC_B = "0020000001";
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
      send: async (m) => {
        sink.push(m);
      },
    },
    ZC_HMAC_SECRET: "test-secret",
  };
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

async function drain(env: TestEnv, max = 80): Promise<void> {
  let n = 0;
  while (env.QUEUE._sink.length > 0 && n < max) {
    await processQueueMessage(env.QUEUE._sink.shift()!, env as any);
    n++;
  }
  if (n >= max) throw new Error("drain: did not converge");
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

/** Per-currency account balance — a multi-currency GTID must move each currency on its own rail. */
async function balanceOfCcy(
  db: MockD1Database,
  accountId: string,
  currency: string
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ? AND amount_currency = ?`
    )
    .bind(accountId, currency)
    .first<{ b: number }>();
  return row?.b ?? 0;
}

/** Per-(bank, currency) zero-sum — every currency must independently net to 0. */
async function perCurrencyZeroSum(db: MockD1Database, bankId: string): Promise<boolean> {
  const rows = await db
    .prepare(
      `SELECT amount_currency, COALESCE(SUM(amount), 0) AS total FROM BankJournals WHERE bank_id = ? GROUP BY amount_currency`
    )
    .bind(bankId)
    .all<{ amount_currency: string; total: number }>();
  return (rows.results ?? []).every((r) => r.total === 0);
}

/** Prefund an account in a currency (account(+)/ZCS(-), per-currency zero-sum). */
function seedCcyBalance(
  db: MockD1Database,
  bankId: string,
  accountId: string,
  amount: number,
  currency: string
) {
  for (const [acct, amt] of [
    [accountId, amount],
    [`${bankId}-ZCS`, -amount],
  ] as const) {
    db.prepare(
      `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, amount_currency, tx_type, tx_group_id, value_date, created_at)
       VALUES (?, ?, ?, ?, ?, 'CASH', ?, '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(
        `JNL-PF-${accountId}-${currency}-${amt}`,
        bankId,
        acct,
        amt,
        currency,
        `PF-${accountId}-${currency}`
      )
      ._runSync();
  }
}

let d1: MockD1Database;
beforeEach(() => {
  ({ d1 } = createTestDb());
  seedParticipant(d1, BANK_A);
  seedParticipant(d1, BANK_B);
});

describe("chaos #9: GTID leg transiently SUSPENDED (awaiting approval) then resolved", () => {
  it("still reaches GT_SETTLED after the leg approves and settles", async () => {
    const env = makeEnv(d1);
    const amount = 50_000;

    await registerGtid(
      {
        gtid: "GT-SUSP-001",
        idempotency_key: "IK-GT-SUSP-001",
        expires_at: "2099-12-31T00:00:00Z",
        legs: [
          {
            leg_id: "GT-SUSP-001-A",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A,
            amount: { value: amount, currency: "JPY" },
          },
          {
            leg_id: "GT-SUSP-001-B",
            role: "PAYEE",
            bank_id: BANK_B,
            account_hash: ACC_B,
            amount: { value: amount, currency: "JPY" },
          },
        ],
      } as any,
      env as any
    );
    await advanceGtid("GT-SUSP-001", env as any);

    const gtState = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-SUSP-001'`)
      .first<{ state: string }>();
    expect(gtState?.state).toBe("GT_DECIDED_TO_SETTLE");

    // The settlement-bearing leg (PAYER leg → TX-GT-*) is transiently SUSPENDED
    // awaiting the payee's approval — a state that resumes to SETTLED once
    // approved. (PAYEE legs carry no txid; the PAYER leg's tx is the transfer.)
    const payerLeg = (await d1
      .prepare(`SELECT txid FROM GtidLegs WHERE gtid='GT-SUSP-001' AND role='PAYER'`)
      .first<{ txid: string }>())!.txid;
    d1.prepare(
      `UPDATE Transactions SET state='SUSPENDED', reason_code='AWAITING_PAYEE_APPROVAL' WHERE txid=?`
    )
      .bind(payerLeg)
      ._runSync();

    // Finalization runs during the approval window. It must NOT terminally
    // suspend the GTID on a transient leg state.
    await checkAndFinalizeGtid("GT-SUSP-001", d1 as any);
    const afterFirst = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-SUSP-001'`)
      .first<{ state: string }>();
    expect(afterFirst?.state).not.toBe("GT_SUSPENDED");

    // The payee approves and the leg settles.
    d1.prepare(`UPDATE Transactions SET state='SETTLED' WHERE txid=?`).bind(payerLeg)._runSync();

    // Now finalization completes the GTID.
    await checkAndFinalizeGtid("GT-SUSP-001", d1 as any);
    const finalGt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-SUSP-001'`)
      .first<{ state: string }>();
    expect(finalGt?.state).toBe("GT_SETTLED");
  });

  it("still suspends the GTID on a TERMINAL leg failure (FAILED_EXECUTION)", async () => {
    const env = makeEnv(d1);
    const amount = 50_000;

    await registerGtid(
      {
        gtid: "GT-FAIL-001",
        idempotency_key: "IK-GT-FAIL-001",
        expires_at: "2099-12-31T00:00:00Z",
        legs: [
          {
            leg_id: "GT-FAIL-001-A",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A,
            amount: { value: amount, currency: "JPY" },
          },
          {
            leg_id: "GT-FAIL-001-B",
            role: "PAYEE",
            bank_id: BANK_B,
            account_hash: ACC_B,
            amount: { value: amount, currency: "JPY" },
          },
        ],
      } as any,
      env as any
    );
    await advanceGtid("GT-FAIL-001", env as any);

    // A terminal failure on the settlement-bearing PAYER leg.
    const payerLeg = (await d1
      .prepare(`SELECT txid FROM GtidLegs WHERE gtid='GT-FAIL-001' AND role='PAYER'`)
      .first<{ txid: string }>())!.txid;
    d1.prepare(`UPDATE Transactions SET state='FAILED_EXECUTION' WHERE txid=?`)
      .bind(payerLeg)
      ._runSync();

    await checkAndFinalizeGtid("GT-FAIL-001", d1 as any);
    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-FAIL-001'`)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SUSPENDED");
  });
});

/**
 * Probe #14 — GTID fan-out (1×N) settles each payee its own amount.
 *
 * GTID execution is payer-driven: advanceGtid creates one Transaction per PAYER
 * leg, crediting a rank-paired PAYEE its PAYER's amount; PAYEE legs carry no
 * txid and checkAndFinalizeGtid counts a null-txid leg as "complete". A raw
 * fan-out (one PAYER, several PAYEEs) therefore created a single transfer — the
 * whole PAYER amount landed on the first PAYEE while the surplus PAYEEs' legs
 * were still counted complete, so the GTID reported GT_SETTLED with money
 * dropped (a per-account misallocation that a global zero-sum check misses).
 *
 * registerGtid now normalizes a balanced single-payer fan-out into an aligned
 * M×M square (one PAYER sub-leg per PAYEE), so the existing rank-paired path
 * credits each PAYEE exactly its amount from the shared payer — with no change
 * to the ready-check / execution / finalization wiring. Invariant: every PAYEE
 * is credited its own (distinct) amount, the payer is debited the total, and the
 * GTID reaches GT_SETTLED.
 */
describe("chaos #14: GTID fan-out (1×2) settles each payee its own amount", () => {
  it("splits the single payer across payees and credits each exactly its amount", async () => {
    const env = makeEnv(d1);

    // Distinct payee amounts (70 + 130 = 200) so a mis-split or mis-pairing
    // would land the wrong amount on the wrong account.
    await registerGtid(
      {
        gtid: "GT-FANOUT-001",
        idempotency_key: "IK-GT-FANOUT-001",
        expires_at: "2099-12-31T00:00:00Z",
        legs: [
          {
            leg_id: "GT-FO-1-PAYER",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A,
            amount: { value: 200, currency: "JPY" },
          },
          {
            leg_id: "GT-FO-2-PAYEE-A",
            role: "PAYEE",
            bank_id: BANK_B,
            account_hash: ACC_B,
            amount: { value: 70, currency: "JPY" },
          },
          {
            leg_id: "GT-FO-3-PAYEE-B",
            role: "PAYEE",
            bank_id: BANK_B,
            account_hash: ACC_B2,
            amount: { value: 130, currency: "JPY" },
          },
        ],
      } as any,
      env as any
    );
    await advanceGtid("GT-FANOUT-001", env as any);
    await drain(env);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-FANOUT-001'`)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SETTLED");

    // Each payee credited its own amount; the single payer debited the total.
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - 200);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + 70);
    expect(await balanceOf(d1, ACC_B2)).toBe(SEED_BAL + 130);
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);

    // The normalization is audited (1 registered payer → 2 PAYER sub-legs).
    const fl = await d1
      .prepare(
        `SELECT payload_json FROM FinalityLog WHERE gtid='GT-FANOUT-001' AND event_type='GtidRegistered'`
      )
      .first<{ payload_json: string }>();
    expect(fl?.payload_json).toContain('"fanout_normalized":true');
  });
});

/**
 * Probe #18 — general N×M (both sides > 1, rank-misaligned) settles each account
 * its own amount via debit/credit decoupling.
 *
 * GTID execution is payer-driven and rank-paired: one Transaction per PAYER leg
 * crediting a rank-paired PAYEE its PAYER's amount. That faithfully settles only
 * fan-in, single-payer fan-out (#14), and rank-aligned squares — so a *general*
 * N×M (counts/amounts that don't line up rank-for-rank) used to be cancelled
 * (GTID_SHAPE_UNSUPPORTED) because settling it would misallocate per-account
 * funds even when the global total balanced. That is a liveness gap: a perfectly
 * balanced many-to-many instruction could never settle.
 *
 * The fix decouples debits from credits at registration: registerGtid runs a
 * greedy bipartite *waterfall match* (decomposeGeneralNM) that rewrites the N×M
 * into K ≤ N+M−1 rank-aligned 1:1 sub-transfers preserving every payer's and
 * payee's total, which the unchanged aligned-square path then settles. Invariant:
 * every payer account is debited exactly its registered total and every payee
 * account credited exactly its registered total, the GTID reaches GT_SETTLED,
 * and each bank stays zero-sum.
 *
 * This 2×3 (A:100 + A2:200 → B:100 + B2:100 + B:100, where B appears twice) is
 * the exact shape that was previously cancelled as GTID_SHAPE_UNSUPPORTED.
 */
describe("chaos #18: general N×M GTID settles each account its own amount", () => {
  const NM_LEGS = [
    {
      leg_id: "GT-NM-1-PAYER-A",
      role: "PAYER",
      bank_id: BANK_A,
      account_hash: ACC_A,
      amount: { value: 100, currency: "JPY" },
    },
    {
      leg_id: "GT-NM-2-PAYER-B",
      role: "PAYER",
      bank_id: BANK_A,
      account_hash: ACC_A2,
      amount: { value: 200, currency: "JPY" },
    },
    {
      leg_id: "GT-NM-3-PAYEE-A",
      role: "PAYEE",
      bank_id: BANK_B,
      account_hash: ACC_B,
      amount: { value: 100, currency: "JPY" },
    },
    {
      leg_id: "GT-NM-4-PAYEE-B",
      role: "PAYEE",
      bank_id: BANK_B,
      account_hash: ACC_B2,
      amount: { value: 100, currency: "JPY" },
    },
    {
      leg_id: "GT-NM-5-PAYEE-C",
      role: "PAYEE",
      bank_id: BANK_B,
      account_hash: ACC_B,
      amount: { value: 100, currency: "JPY" },
    },
  ];

  it("waterfall-decomposes into 1:1 sub-transfers and credits each payee its own amount", async () => {
    const env = makeEnv(d1);

    await registerGtid(
      {
        gtid: "GT-NM-001",
        idempotency_key: "IK-GT-NM-001",
        expires_at: "2099-12-31T00:00:00Z",
        legs: NM_LEGS,
      } as any,
      env as any
    );
    await advanceGtid("GT-NM-001", env as any);
    await drain(env);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-NM-001'`)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SETTLED");

    // Per-account conservation: payers debited their totals, payees credited theirs
    // (ACC_B received two legs of 100 → +200).
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - 100);
    expect(await balanceOf(d1, ACC_A2)).toBe(SEED_BAL - 200);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + 200);
    expect(await balanceOf(d1, ACC_B2)).toBe(SEED_BAL + 100);
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);

    // The decomposition is audited (general N×M, both sides rewritten).
    const fl = await d1
      .prepare(
        `SELECT payload_json FROM FinalityLog WHERE gtid='GT-NM-001' AND event_type='GtidRegistered'`
      )
      .first<{ payload_json: string }>();
    expect(fl?.payload_json).toContain('"nm_decomposed":true');
  });

  it("settles exactly once under at-least-once (duplicated) delivery", async () => {
    const env = makeEnv(d1);

    await registerGtid(
      {
        gtid: "GT-NM-DUP",
        idempotency_key: "IK-GT-NM-DUP",
        expires_at: "2099-12-31T00:00:00Z",
        legs: NM_LEGS.map((l) => ({ ...l, leg_id: l.leg_id.replace("GT-NM", "GT-NMD") })),
      } as any,
      env as any
    );
    await advanceGtid("GT-NM-DUP", env as any);

    // Hostile DeliveryPolicy: every queue message is delivered twice (dup). The
    // per-leg CAS / bank-debit idempotency must absorb it — no double settle.
    let n = 0;
    while (env.QUEUE._sink.length > 0 && n < 200) {
      const msg = env.QUEUE._sink.shift()!;
      await processQueueMessage(msg, env as any);
      await processQueueMessage(msg, env as any); // duplicate
      n++;
    }

    expect(
      (
        await d1
          .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-NM-DUP'`)
          .first<{ state: string }>()
      )?.state
    ).toBe("GT_SETTLED");

    // Balances are identical to the single-delivery run — the dup moved no extra money.
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - 100);
    expect(await balanceOf(d1, ACC_A2)).toBe(SEED_BAL - 200);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + 200);
    expect(await balanceOf(d1, ACC_B2)).toBe(SEED_BAL + 100);
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);
  });
});

/**
 * Probe #19 — multi-currency balanced general N×M settles per currency group.
 *
 * A GTID whose legs span several currencies, where *each currency balances on
 * its own* (Σpayer == Σpayee within that currency), is NOT true FX: it is several
 * independent single-currency transfers bundled into one atomic GTID.
 * decomposeGeneralNM now waterfall-matches each currency group separately — never
 * across currencies — so the rank-aligned 1:1 sub-transfers settle through the
 * existing payer-driven path, each moving its own currency. This closes the
 * "複数通貨にまたがる一般 N×M" gap for the balanced case (30_internal_design.md § 7),
 * while true cross-currency FX stays out of scope (probe #18b below).
 */
function seedCurrencyLimit(db: MockD1Database, bankId: string, currency: string) {
  db.prepare(
    `INSERT OR REPLACE INTO ParticipantCurrencyLimits (bank_id, currency, h_limit, h_used)
     VALUES (?, ?, 100000000, 0)`
  )
    .bind(bankId, currency)
    ._runSync();
}

describe("chaos #19: multi-currency balanced general N×M settles per currency", () => {
  it("decomposes per currency group and moves each currency independently", async () => {
    const env = makeEnv(d1);
    // Per-currency H dimension (Theme D): the USD payer leg reserves against the
    // bank's USD limit, not the JPY one.
    seedCurrencyLimit(d1, BANK_A, "USD");
    seedCurrencyLimit(d1, BANK_B, "USD");
    // BANK_A's USD payer leg (ACC_A2) pays USD, so it must hold USD prefunding —
    // the leg-ready funds check is now scoped to the leg's currency.
    seedCcyBalance(d1, BANK_A, ACC_A2, 1_000, "USD");

    await registerGtid(
      {
        gtid: "GT-NM-CCY",
        idempotency_key: "IK-GT-NM-CCY",
        expires_at: "2099-12-31T00:00:00Z",
        legs: [
          {
            leg_id: "GT-CCY-1-PAYER",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A,
            amount: { value: 100, currency: "JPY" },
          },
          {
            leg_id: "GT-CCY-2-PAYER",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A2,
            amount: { value: 100, currency: "USD" },
          },
          {
            leg_id: "GT-CCY-3-PAYEE",
            role: "PAYEE",
            bank_id: BANK_B,
            account_hash: ACC_B,
            amount: { value: 100, currency: "USD" },
          },
          {
            leg_id: "GT-CCY-4-PAYEE",
            role: "PAYEE",
            bank_id: BANK_B,
            account_hash: ACC_B2,
            amount: { value: 100, currency: "JPY" },
          },
        ],
      } as any,
      env as any
    );
    await advanceGtid("GT-NM-CCY", env as any);
    await drain(env);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-NM-CCY'`)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SETTLED");

    // JPY leg: ACC_A → ACC_B2 (100). USD leg: ACC_A2 → ACC_B (100). Each transfer
    // must move ONLY its own currency — asserted per currency so a USD movement
    // mislabelled as JPY (or vice-versa) is caught (a currency-blind sum would
    // mask exactly that).
    expect(await balanceOfCcy(d1, ACC_A, "JPY")).toBe(SEED_BAL - 100); // JPY payer
    expect(await balanceOfCcy(d1, ACC_A, "USD")).toBe(0);
    expect(await balanceOfCcy(d1, ACC_A2, "USD")).toBe(1_000 - 100); // USD payer (prefund − 100)
    expect(await balanceOfCcy(d1, ACC_A2, "JPY")).toBe(SEED_BAL); // its JPY untouched
    expect(await balanceOfCcy(d1, ACC_B, "USD")).toBe(100); // USD payee (no USD seed)
    expect(await balanceOfCcy(d1, ACC_B, "JPY")).toBe(SEED_BAL);
    expect(await balanceOfCcy(d1, ACC_B2, "JPY")).toBe(SEED_BAL + 100); // JPY payee
    expect(await balanceOfCcy(d1, ACC_B2, "USD")).toBe(0);
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);
    expect(await perCurrencyZeroSum(d1, BANK_A)).toBe(true);
    expect(await perCurrencyZeroSum(d1, BANK_B)).toBe(true);

    // The decomposition is audited (general N×M, both sides rewritten).
    const fl = await d1
      .prepare(
        `SELECT payload_json FROM FinalityLog WHERE gtid='GT-NM-CCY' AND event_type='GtidRegistered'`
      )
      .first<{ payload_json: string }>();
    expect(fl?.payload_json).toContain('"nm_decomposed":true');
  });
});

/**
 * Probe #18b — guard precision: *true cross-currency FX* is still safely
 * cancelled, not misallocated.
 *
 * When a currency does NOT balance on its own (here JPY only on the payer side,
 * USD only on the payee side — pay JPY to receive USD), settling it would require
 * an FX rate and netting non-fungible units at par. decomposeGeneralNM leaves
 * such legs untouched and advanceGtid's per-currency balance check cancels it
 * (AMOUNT_BALANCE_MISMATCH), moving no money. This is the genuinely out-of-scope
 * case the multi-currency decomposition (probe #19) deliberately does not touch.
 */
describe("chaos #18b: true cross-currency FX is still safely cancelled", () => {
  it("cancels when a currency does not balance on its own and moves no money", async () => {
    const env = makeEnv(d1);

    await registerGtid(
      {
        gtid: "GT-FX",
        idempotency_key: "IK-GT-FX",
        expires_at: "2099-12-31T00:00:00Z",
        legs: [
          {
            leg_id: "GT-FX-1-PAYER",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A,
            amount: { value: 100, currency: "JPY" },
          },
          {
            leg_id: "GT-FX-2-PAYER",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A2,
            amount: { value: 200, currency: "JPY" },
          },
          {
            leg_id: "GT-FX-3-PAYEE",
            role: "PAYEE",
            bank_id: BANK_B,
            account_hash: ACC_B,
            amount: { value: 2, currency: "USD" },
          },
          {
            leg_id: "GT-FX-4-PAYEE",
            role: "PAYEE",
            bank_id: BANK_B,
            account_hash: ACC_B2,
            amount: { value: 1, currency: "USD" },
          },
        ],
      } as any,
      env as any
    );
    await advanceGtid("GT-FX", env as any);
    await drain(env);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-FX'`)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_CANCELLED");

    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL);
    expect(await balanceOf(d1, ACC_A2)).toBe(SEED_BAL);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL);
    expect(await balanceOf(d1, ACC_B2)).toBe(SEED_BAL);

    const fl = await d1
      .prepare(
        `SELECT payload_json FROM FinalityLog WHERE gtid='GT-FX' AND event_type='GtidDecidedCancel'`
      )
      .first<{ payload_json: string }>();
    expect(fl?.payload_json).toContain("AMOUNT_BALANCE_MISMATCH");
  });
});

/**
 * Probe #14b — fan-in (N×1) still settles correctly (guard precision).
 *
 * The shape guard must not over-reject: a fan-in (several PAYERs funding one
 * PAYEE) is faithfully settled by the payer-driven model — each PAYER's
 * transfer credits the single PAYEE, summing to its registered amount. This is
 * the resilience guard that the cancel path in probe #14 is precise.
 */
describe("chaos #14b: GTID fan-in (2×1) still settles and conserves money", () => {
  it("credits the single payee the sum of both payers", async () => {
    const env = makeEnv(d1);

    await registerGtid(
      {
        gtid: "GT-FANIN-001",
        idempotency_key: "IK-GT-FANIN-001",
        expires_at: "2099-12-31T00:00:00Z",
        legs: [
          {
            leg_id: "GT-FI-1-PAYER-A",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A,
            amount: { value: 100, currency: "JPY" },
          },
          {
            leg_id: "GT-FI-2-PAYER-B",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A2,
            amount: { value: 100, currency: "JPY" },
          },
          {
            leg_id: "GT-FI-3-PAYEE",
            role: "PAYEE",
            bank_id: BANK_B,
            account_hash: ACC_B,
            amount: { value: 200, currency: "JPY" },
          },
        ],
      } as any,
      env as any
    );
    await advanceGtid("GT-FANIN-001", env as any);
    await drain(env);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-FANIN-001'`)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SETTLED");

    // Both payers debited 100; the single payee credited 200.
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - 100);
    expect(await balanceOf(d1, ACC_A2)).toBe(SEED_BAL - 100);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + 200);
    expect(await bankSum(d1, BANK_A)).toBe(0);
    expect(await bankSum(d1, BANK_B)).toBe(0);
  });
});
