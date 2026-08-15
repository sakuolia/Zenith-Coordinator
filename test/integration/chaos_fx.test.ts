/**
 * @file Chaos / adversarial tests for true cross-currency FX (docs/specs/20_method_design.md).
 *
 * These probes attack the FX feature where it is most likely to leak value or
 * strand a transfer: an FXP without liquidity, a quote that moves or lapses
 * between price discovery and execution, a leg that fails mid-settlement, and
 * races between claim, refund, and the sweep cron. The invariant under test is
 * always the same — **no partial settlement and no double settlement**: an FX
 * transfer either settles every leg or none, exactly once.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { advanceGtid } from "../../src/zc/lanes/gtid";
import { processQueueMessage, checkAndFinalizeGtid } from "../../src/zc/orchestrator";
import { sha256hex } from "../../src/shared/hmac";
import { upsertQuote, withdrawQuote } from "../../src/zc/fx/quotes";
import { findBestRoute } from "../../src/zc/fx/routing";
import { initiateFxTransfer, getFxTransfer } from "../../src/zc/fx/transfer";
import {
  lockFxTransfer,
  claimFxTransfer,
  sweepExpiredFxLocks,
  getFxLegLocks,
  FX_HTLC_BASE_TIMEOUT_MS,
  FX_HTLC_HOP_MARGIN_MS,
} from "../../src/zc/fx/htlc";
import { isDomainError } from "../../src/shared/errors";

const PAYER_BANK = "001";
const FXP_BANK = "002";
const FXP2_BANK = "003";
const PAYER_ACC = "0010000001";
const PAYEE_ACC = "0010000002";
const FXP_JPY_ACC = "0020000001";
const FXP_USD_ACC = "0020000002";
const SEED_BAL = 1_000_000;
const RATE = 670_000;
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

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

async function drain(env: TestEnv, max = 80): Promise<void> {
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

function seedCurrencyLimit(db: MockD1Database, bankId: string, currency: string) {
  db.prepare(
    `INSERT OR REPLACE INTO ParticipantCurrencyLimits (bank_id, currency, h_limit, h_used)
     VALUES (?, ?, 100000000, 0)`
  )
    .bind(bankId, currency)
    ._runSync();
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

async function balanceOf(db: MockD1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ?`)
    .bind(accountId)
    .first<{ b: number }>();
  return row?.b ?? 0;
}

const resolveFxpAccount = (_bankId: string, currency: string): string =>
  currency === "JPY" ? FXP_JPY_ACC : FXP_USD_ACC;

let d1: MockD1Database;
let env: TestEnv;

beforeEach(() => {
  ({ d1 } = createTestDb());
  env = makeEnv(d1);
  seedParticipant(d1, PAYER_BANK);
  seedParticipant(d1, FXP_BANK);
  // FXP prefunds USD so its USD leg can pay (currency-scoped funds check). Tests
  // that assert a cancel do so via the H gate or a missing route, not lack of
  // this deposit, so prefunding here is safe for them.
  seedCcyBalance(d1, FXP_BANK, FXP_USD_ACC, 10_000_000, "USD");
});

async function routeJpyUsd(amount = 500_000) {
  await upsertQuote(d1, {
    fxp_bank_id: FXP_BANK,
    from_currency: "JPY",
    to_currency: "USD",
    rate: RATE,
    valid_to: FAR_FUTURE,
  });
  const r = await findBestRoute(d1, {
    from_currency: "JPY",
    to_currency: "USD",
    amount,
    denomination: "PAYER",
  });
  if (!r.ok) throw new Error("no route");
  return r.route;
}

const parties = {
  payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACC },
  payee: { bank_id: PAYER_BANK, account_hash: PAYEE_ACC },
  resolveFxpAccount,
};

// ---------------------------------------------------------------------------
// #1 — FXP without target-currency liquidity: cancel, no partial settlement
// ---------------------------------------------------------------------------
describe("chaos fx #1: FXP lacks USD liquidity (H)", () => {
  it("cancels the whole transfer; no leg settles and no money moves", async () => {
    // No USD ParticipantCurrencyLimits row for the FXP → its USD payer leg can't
    // reserve H → advanceGtid cancels the GTID before any debit.
    const route = await routeJpyUsd();
    await initiateFxTransfer(env as any, {
      gtid: "GT-CFX-1",
      route,
      ...parties,
      idempotency_key: "IK-CFX-1",
    });
    await advanceGtid("GT-CFX-1", env as any);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-CFX-1'`)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_CANCELLED");
    // No customer money moved, and the FX record never reaches SETTLED.
    expect(await balanceOf(d1, PAYER_ACC)).toBe(SEED_BAL);
    expect(await balanceOf(d1, PAYEE_ACC)).toBe(SEED_BAL);
    expect((await getFxTransfer(env as any, "GT-CFX-1"))!.status).not.toBe("SETTLED");
  });
});

// ---------------------------------------------------------------------------
// #2 — quote withdrawn between price discovery and execution
// ---------------------------------------------------------------------------
describe("chaos fx #2: quote withdrawn before initiate", () => {
  it("rejects with FX_QUOTE_EXPIRED and registers nothing", async () => {
    const route = await routeJpyUsd();
    await withdrawQuote(d1, route.hops[0]!.quote_id); // FXP pulls the quote

    await expect(
      initiateFxTransfer(env as any, {
        gtid: "GT-CFX-2",
        route,
        ...parties,
        idempotency_key: "IK-CFX-2",
      })
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.reason_code === "FX_QUOTE_EXPIRED");
    expect(await getFxTransfer(env as any, "GT-CFX-2")).toBeNull();
    const gt = await d1.prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-CFX-2'`).first();
    expect(gt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #3 — locked rate is honoured even if the quote lapses after the lock
// ---------------------------------------------------------------------------
describe("chaos fx #3: quote expires after HTLC lock", () => {
  it("claim still settles at the locked rate (lock fixes the price)", async () => {
    seedCurrencyLimit(d1, FXP_BANK, "USD");
    const route = await routeJpyUsd();
    const { secret } = await lockFxTransfer(env as any, { gtid: "GT-CFX-3", route, ...parties });

    // The market moves out from under the locked transfer.
    await d1
      .prepare(`UPDATE FxQuotes SET valid_to=? WHERE quote_id=?`)
      .bind(PAST, route.hops[0]!.quote_id)
      ._runSync();

    const res = await claimFxTransfer(env as any, "GT-CFX-3", secret!);
    await drain(env);
    expect(res.status).toBe("SETTLED");
    // Settled at the rate captured at lock time (3,350 USD), not re-priced.
    expect(await balanceOf(d1, PAYEE_ACC)).toBe(SEED_BAL + 3_350);
  });
});

// ---------------------------------------------------------------------------
// #4 — claim wins a race against the refund sweep (and vice versa)
// ---------------------------------------------------------------------------
describe("chaos fx #4: claim vs refund-sweep race", () => {
  beforeEach(() => seedCurrencyLimit(d1, FXP_BANK, "USD"));
  const afterExpiry = () =>
    new Date(Date.now() + FX_HTLC_BASE_TIMEOUT_MS + 3 * FX_HTLC_HOP_MARGIN_MS).toISOString();

  it("claim before the sweep settles; the sweep then refunds nothing", async () => {
    const route = await routeJpyUsd();
    const { secret } = await lockFxTransfer(env as any, { gtid: "GT-CFX-4A", route, ...parties });
    await claimFxTransfer(env as any, "GT-CFX-4A", secret!); // claim lands first
    await drain(env);
    expect(await sweepExpiredFxLocks(env as any, afterExpiry())).toBe(0); // nothing to refund
    expect((await getFxLegLocks(env as any, "GT-CFX-4A")).every((l) => l.state === "CLAIMED")).toBe(
      true
    );
    expect(await balanceOf(d1, PAYEE_ACC)).toBe(SEED_BAL + 3_350);
  });

  it("sweep before the claim refunds; the late claim is rejected and no money moves", async () => {
    const route = await routeJpyUsd();
    const { secret } = await lockFxTransfer(env as any, { gtid: "GT-CFX-4B", route, ...parties });
    expect(await sweepExpiredFxLocks(env as any, afterExpiry())).toBe(1); // refund lands first
    await expect(claimFxTransfer(env as any, "GT-CFX-4B", secret!)).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.reason_code === "FX_ALREADY_REFUNDED"
    );
    expect(
      (await getFxLegLocks(env as any, "GT-CFX-4B")).every((l) => l.state === "REFUNDED")
    ).toBe(true);
    expect(await balanceOf(d1, PAYER_ACC)).toBe(SEED_BAL); // never debited
  });
});

// ---------------------------------------------------------------------------
// #5 — a leg fails mid-settlement: GTID suspends, FX not SETTLED, no partial pay
// ---------------------------------------------------------------------------
describe("chaos fx #5: one leg fails during settlement", () => {
  it("suspends the GTID and never marks the transfer SETTLED (atomicity)", async () => {
    seedCurrencyLimit(d1, FXP_BANK, "USD");
    const route = await routeJpyUsd();
    await initiateFxTransfer(env as any, {
      gtid: "GT-CFX-5",
      route,
      ...parties,
      idempotency_key: "IK-CFX-5",
    });
    await advanceGtid("GT-CFX-5", env as any); // both legs → DECIDED_TO_SETTLE

    // Terminal failure on one currency leg before any debit drains.
    const leg = (await d1
      .prepare(
        `SELECT txid FROM GtidLegs WHERE gtid='GT-CFX-5' AND role='PAYER' AND leg_currency='USD'`
      )
      .first<{ txid: string }>())!.txid;
    d1.prepare(`UPDATE Transactions SET state='FAILED_EXECUTION' WHERE txid=?`)
      .bind(leg)
      ._runSync();

    await checkAndFinalizeGtid("GT-CFX-5", d1 as any);
    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-CFX-5'`)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SUSPENDED");
    // The FX record must not advertise a settlement that did not fully happen,
    // and the payee must not have been credited.
    expect((await getFxTransfer(env as any, "GT-CFX-5"))!.status).not.toBe("SETTLED");
    expect(await balanceOf(d1, PAYEE_ACC)).toBe(SEED_BAL);
  });
});

// ---------------------------------------------------------------------------
// #6 — duplicate claim is settled exactly once (no double debit)
// ---------------------------------------------------------------------------
describe("chaos fx #6: redelivered claim", () => {
  it("settles once even when the claim is replayed several times", async () => {
    seedCurrencyLimit(d1, FXP_BANK, "USD");
    const route = await routeJpyUsd();
    const { secret } = await lockFxTransfer(env as any, { gtid: "GT-CFX-6", route, ...parties });
    await claimFxTransfer(env as any, "GT-CFX-6", secret!);
    await claimFxTransfer(env as any, "GT-CFX-6", secret!);
    await claimFxTransfer(env as any, "GT-CFX-6", secret!);
    await drain(env);
    expect(await balanceOf(d1, PAYER_ACC)).toBe(SEED_BAL - 500_000); // not 3×
    expect(await balanceOf(d1, PAYEE_ACC)).toBe(SEED_BAL + 3_350);
  });
});

// ---------------------------------------------------------------------------
// #7 — bridge route where the second-hop FXP lacks liquidity
// ---------------------------------------------------------------------------
describe("chaos fx #7: bridge with an under-funded middle FXP", () => {
  it("cancels the bridged transfer with no partial settlement", async () => {
    seedParticipant(d1, FXP2_BANK);
    // JPY→EUR via FXP_BANK, EUR→USD via FXP2_BANK. FXP_BANK gets EUR H but
    // FXP2_BANK is NOT given USD H → its USD payer leg can't reserve → cancel.
    seedCurrencyLimit(d1, FXP_BANK, "EUR");
    await upsertQuote(d1, {
      fxp_bank_id: FXP_BANK,
      from_currency: "JPY",
      to_currency: "EUR",
      rate: 1_500_000,
      valid_to: FAR_FUTURE,
    });
    await upsertQuote(d1, {
      fxp_bank_id: FXP2_BANK,
      from_currency: "EUR",
      to_currency: "USD",
      rate: 110_000_000,
      valid_to: FAR_FUTURE,
    });

    const r = await findBestRoute(d1, {
      from_currency: "JPY",
      to_currency: "USD",
      amount: 1_000_000,
      denomination: "PAYER",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.hops).toHaveLength(2); // bridged

    await initiateFxTransfer(env as any, {
      gtid: "GT-CFX-7",
      route: r.route,
      payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACC },
      payee: { bank_id: PAYER_BANK, account_hash: PAYEE_ACC },
      resolveFxpAccount: (bankId, ccy) => `${bankId}-${ccy}-ACC`,
      idempotency_key: "IK-CFX-7",
    });
    await advanceGtid("GT-CFX-7", env as any);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-CFX-7'`)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_CANCELLED");
    expect(await balanceOf(d1, PAYER_ACC)).toBe(SEED_BAL);
  });
});

// ---------------------------------------------------------------------------
// #8 — wrong secret repeatedly does not lock out the correct claim
// ---------------------------------------------------------------------------
describe("chaos fx #8: repeated wrong secret then correct", () => {
  it("keeps the legs LOCKED through bad attempts, then settles on the real secret", async () => {
    seedCurrencyLimit(d1, FXP_BANK, "USD");
    const route = await routeJpyUsd();
    const { secret } = await lockFxTransfer(env as any, { gtid: "GT-CFX-8", route, ...parties });

    for (const bad of ["aa", "bb", "cc"]) {
      const h = await sha256hex(bad);
      await expect(claimFxTransfer(env as any, "GT-CFX-8", h)).rejects.toSatisfy(
        (e: unknown) => isDomainError(e) && e.reason_code === "PREIMAGE_MISMATCH"
      );
    }
    expect((await getFxLegLocks(env as any, "GT-CFX-8")).every((l) => l.state === "LOCKED")).toBe(
      true
    );

    const res = await claimFxTransfer(env as any, "GT-CFX-8", secret!);
    await drain(env);
    expect(res.status).toBe("SETTLED");
    expect(await balanceOf(d1, PAYEE_ACC)).toBe(SEED_BAL + 3_350);
  });
});
