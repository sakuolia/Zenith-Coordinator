/**
 * @file Tests for src/zc/fx/transfer.ts — FXP-conduit leg construction and FX
 * transfer initiation.
 *
 * Covers:
 * - buildFxGtidLegs emits balanced per-currency PAYER/PAYEE pairs for a direct
 *   route (payer→FXP→payee) and a bridge route (payer→FXP→FXP→payee).
 * - initiateFxTransfer records FxTransfers, registers the conduit GTID, and the
 *   GTID lane DECIDES TO SETTLE with per-currency H reservations and the USD
 *   amount derived from the quoted rate.
 * - a lapsed quote is rejected with FX_QUOTE_EXPIRED.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { advanceGtid } from "../../src/zc/lanes/gtid";
import { getHStatus } from "../../src/zc/liquidity/h_model";
import { upsertQuote } from "../../src/zc/fx/quotes";
import { findBestRoute, type FxRoute } from "../../src/zc/fx/routing";
import { buildFxGtidLegs, initiateFxTransfer, getFxTransfer } from "../../src/zc/fx/transfer";
import { convertForward } from "../../src/zc/fx/rates";
import { isDomainError } from "../../src/shared/errors";

const PAYER_BANK = "001";
const FXP_BANK = "002";
const PAYER_ACC = "0010000001"; // payer's JPY account
const PAYEE_ACC = "0010000002"; // payee's USD account (also at bank 001)
const FXP_JPY_ACC = "0020000001"; // FXP receives JPY here
const FXP_USD_ACC = "0020000002"; // FXP pays USD from here
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

let d1: MockD1Database;

function makeEnv(db: MockD1Database): any {
  return { DB: db, QUEUE: { send: async () => {} }, ZC_HMAC_SECRET: "test-secret" };
}

function seedParticipant(db: MockD1Database, bankId: string, hLimit = 100_000_000) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, is_fx_provider, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', ?, 0, 1, ?, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId, hLimit, bankId === FXP_BANK ? 1 : 0)
    ._runSync();
}

function seedCurrencyLimit(db: MockD1Database, bankId: string, currency: string, hLimit: number) {
  db.prepare(
    `INSERT OR REPLACE INTO ParticipantCurrencyLimits (bank_id, currency, h_limit, h_used)
     VALUES (?, ?, ?, 0)`
  )
    .bind(bankId, currency, hLimit)
    ._runSync();
}

/**
 * Prefund an account in a specific currency (account(+amount)/ZCS(-amount) so the
 * bank stays per-currency zero-sum). An FXP can only pay a currency it actually
 * holds, so its target-currency leg requires real prefunding on that rail.
 */
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

const resolveFxpAccount = (bankId: string, currency: string): string => {
  if (bankId === FXP_BANK && currency === "JPY") return FXP_JPY_ACC;
  if (bankId === FXP_BANK && currency === "USD") return FXP_USD_ACC;
  return `${bankId}-${currency}-NOSTRO`;
};

beforeEach(() => {
  ({ d1 } = createTestDb());
  seedParticipant(d1, PAYER_BANK);
  seedParticipant(d1, FXP_BANK);
  seedCurrencyLimit(d1, FXP_BANK, "USD", 10_000_000);
  // FXP holds USD prefunding to pay its USD leg (an FXP cannot pay a currency
  // it does not hold — the leg-ready funds check is now currency-scoped).
  seedCcyBalance(d1, FXP_BANK, FXP_USD_ACC, 10_000_000, "USD");
});

// ---------------------------------------------------------------------------
// buildFxGtidLegs — pure leg construction
// ---------------------------------------------------------------------------

describe("buildFxGtidLegs — direct route", () => {
  it("emits two balanced per-currency leg pairs (payer→FXP→payee)", () => {
    const route: FxRoute = {
      from_currency: "JPY",
      to_currency: "USD",
      amount_from: 1_000_000,
      amount_to: 6_700,
      effective_rate: 670_000,
      hops: [
        {
          fxp_bank_id: FXP_BANK,
          from_currency: "JPY",
          to_currency: "USD",
          amount_in: 1_000_000,
          amount_out: 6_700,
          quote_id: "FXQ-1",
          rate: 670_000,
        },
      ],
      expires_at: FAR_FUTURE,
    };
    const legs = buildFxGtidLegs(route, {
      gtid: "GT-FX-1",
      payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACC },
      payee: { bank_id: PAYER_BANK, account_hash: PAYEE_ACC },
      resolveFxpAccount,
    });
    expect(legs).toHaveLength(4);

    const jpy = legs.filter((l) => l.amount.currency === "JPY");
    const usd = legs.filter((l) => l.amount.currency === "USD");
    // JPY: payer (PAYER) → FXP (PAYEE), 1,000,000
    expect(jpy.find((l) => l.role === "PAYER")).toMatchObject({
      bank_id: PAYER_BANK,
      account_hash: PAYER_ACC,
    });
    expect(jpy.find((l) => l.role === "PAYEE")).toMatchObject({
      bank_id: FXP_BANK,
      account_hash: FXP_JPY_ACC,
    });
    expect(jpy.every((l) => l.amount.value === 1_000_000)).toBe(true);
    // USD: FXP (PAYER) → payee (PAYEE), 6,700
    expect(usd.find((l) => l.role === "PAYER")).toMatchObject({
      bank_id: FXP_BANK,
      account_hash: FXP_USD_ACC,
    });
    expect(usd.find((l) => l.role === "PAYEE")).toMatchObject({
      bank_id: PAYER_BANK,
      account_hash: PAYEE_ACC,
    });
    expect(usd.every((l) => l.amount.value === 6_700)).toBe(true);
  });
});

describe("buildFxGtidLegs — bridge route", () => {
  it("emits three balanced per-currency leg pairs (payer→FXP→FXP→payee)", () => {
    const route: FxRoute = {
      from_currency: "JPY",
      to_currency: "USD",
      amount_from: 1_000_000,
      amount_to: 16_500,
      effective_rate: 1_650_000,
      hops: [
        {
          fxp_bank_id: "002",
          from_currency: "JPY",
          to_currency: "EUR",
          amount_in: 1_000_000,
          amount_out: 15_000,
          quote_id: "FXQ-A",
          rate: 1_500_000,
        },
        {
          fxp_bank_id: "003",
          from_currency: "EUR",
          to_currency: "USD",
          amount_in: 15_000,
          amount_out: 16_500,
          quote_id: "FXQ-B",
          rate: 110_000_000,
        },
      ],
      expires_at: FAR_FUTURE,
    };
    const legs = buildFxGtidLegs(route, {
      gtid: "GT-FX-BR",
      payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACC },
      payee: { bank_id: PAYER_BANK, account_hash: PAYEE_ACC },
      resolveFxpAccount,
    });
    expect(legs).toHaveLength(6);
    // Each currency appears exactly once on each side, and the conduit chains:
    // JPY: payer→002 ; EUR: 002→003 ; USD: 003→payee.
    const byCcyRole = (ccy: string, role: string) =>
      legs.find((l) => l.amount.currency === ccy && l.role === role)!;
    expect(byCcyRole("JPY", "PAYER").bank_id).toBe(PAYER_BANK);
    expect(byCcyRole("JPY", "PAYEE").bank_id).toBe("002");
    expect(byCcyRole("EUR", "PAYER").bank_id).toBe("002");
    expect(byCcyRole("EUR", "PAYEE").bank_id).toBe("003");
    expect(byCcyRole("USD", "PAYER").bank_id).toBe("003");
    expect(byCcyRole("USD", "PAYEE").bank_id).toBe(PAYER_BANK);
    expect(byCcyRole("EUR", "PAYER").amount.value).toBe(15_000);
  });
});

// ---------------------------------------------------------------------------
// initiateFxTransfer — end-to-end through GT_DECIDED_TO_SETTLE
// ---------------------------------------------------------------------------

describe("initiateFxTransfer — direct JPY→USD", () => {
  async function setupRoute(): Promise<FxRoute> {
    await upsertQuote(d1, {
      fxp_bank_id: FXP_BANK,
      from_currency: "JPY",
      to_currency: "USD",
      rate: 670_000,
      valid_to: FAR_FUTURE,
    });
    const r = await findBestRoute(d1, {
      from_currency: "JPY",
      to_currency: "USD",
      amount: 1_000_000,
      denomination: "PAYER",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("no route");
    return r.route;
  }

  it("records FxTransfers, registers the conduit GTID, and decides to settle", async () => {
    const env = makeEnv(d1);
    const route = await setupRoute();

    const res = await initiateFxTransfer(env, {
      gtid: "GT-FXT-001",
      route,
      payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACC },
      payee: { bank_id: PAYER_BANK, account_hash: PAYEE_ACC },
      resolveFxpAccount,
      idempotency_key: "IK-FXT-001",
      expires_at: "2099-12-31T00:00:00Z",
    });

    expect(res.hashlock).toMatch(/^[0-9a-f]{64}$/);
    expect(res.amount_from).toBe(1_000_000);
    expect(res.amount_to).toBe(convertForward(1_000_000, 670_000)); // 6,700

    const rec = await getFxTransfer(env, "GT-FXT-001");
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe("INITIATED");
    expect(rec!.from_currency).toBe("JPY");
    expect(rec!.to_currency).toBe("USD");
    expect(rec!.amount_to).toBe(6_700);

    await advanceGtid("GT-FXT-001", env);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-FXT-001")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_DECIDED_TO_SETTLE");

    // Per-currency H: payer bank reserved JPY, FXP reserved USD.
    expect((await getHStatus(PAYER_BANK, d1))?.h_used).toBe(1_000_000);
    expect((await getHStatus(FXP_BANK, d1, "USD"))?.h_used).toBe(6_700);

    // The USD leg's settlement Transaction carries the rate-derived amount.
    const usdLeg = await d1
      .prepare(
        `SELECT amount_value, amount_currency FROM Transactions
         WHERE txid IN (SELECT txid FROM GtidLegs WHERE gtid=? AND leg_currency='USD' AND role='PAYER')`
      )
      .bind("GT-FXT-001")
      .first<{ amount_value: number; amount_currency: string }>();
    expect(usdLeg?.amount_currency).toBe("USD");
    expect(usdLeg?.amount_value).toBe(6_700);
  });

  it("rejects a route whose quote has lapsed (FX_QUOTE_EXPIRED)", async () => {
    const env = makeEnv(d1);
    const route = await setupRoute();
    // Expire the quote after routing but before initiation.
    await d1
      .prepare(`UPDATE FxQuotes SET valid_to = '2020-01-01T00:00:00.000Z' WHERE quote_id = ?`)
      .bind(route.hops[0]!.quote_id)
      ._runSync();

    await expect(
      initiateFxTransfer(env, {
        gtid: "GT-FXT-002",
        route,
        payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACC },
        payee: { bank_id: PAYER_BANK, account_hash: PAYEE_ACC },
        resolveFxpAccount,
        idempotency_key: "IK-FXT-002",
      })
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.reason_code === "FX_QUOTE_EXPIRED");

    // Nothing registered.
    expect(await getFxTransfer(env, "GT-FXT-002")).toBeNull();
  });
});
