/**
 * @file End-to-end balance test for true cross-currency FX.
 *
 * Proves a JPY→USD transfer settles real customer balances across two currency
 * rails: the FXP-conduit GTID (payer→FXP in JPY, FXP→payee in USD) is driven to
 * GT_SETTLED through the ordinary GTID/DNS machinery, the payer loses JPY, the
 * payee gains the rate-derived USD, the FXP's two currency legs net out, and the
 * per-bank double-entry zero-sum holds even though the banks span currencies
 * (each customer movement's contra is within the same bank — see chaos_gtid #19).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { advanceGtid } from "../../src/zc/lanes/gtid";
import { processQueueMessage } from "../../src/zc/orchestrator";
import { upsertQuote } from "../../src/zc/fx/quotes";
import { findBestRoute } from "../../src/zc/fx/routing";
import { initiateFxTransfer } from "../../src/zc/fx/transfer";
import { convertForward } from "../../src/zc/fx/rates";

const PAYER_BANK = "001";
const FXP_BANK = "002";
const PAYER_ACC = "0010000001"; // payer pays JPY
const PAYEE_ACC = "0010000002"; // payee (also bank 001) receives USD
const FXP_JPY_ACC = "0020000001"; // FXP receives JPY
const FXP_USD_ACC = "0020000002"; // FXP pays USD
const SEED_BAL = 1_000_000;
const PREFUND_USD = 1_000_000; // FXP's USD prefunding (it can only pay USD it holds)
const RATE = 670_000; // 0.0067 JPY→USD
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

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

function seedCurrencyLimit(db: MockD1Database, bankId: string, currency: string) {
  db.prepare(
    `INSERT OR REPLACE INTO ParticipantCurrencyLimits (bank_id, currency, h_limit, h_used)
     VALUES (?, ?, 100000000, 0)`
  )
    .bind(bankId, currency)
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

/** Per-currency account balance — the FX legs must move each currency on its own rail. */
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
  seedParticipant(d1, PAYER_BANK);
  seedParticipant(d1, FXP_BANK);
  seedCurrencyLimit(d1, FXP_BANK, "USD"); // FXP reserves USD H for its USD payer leg
  // FXP holds real USD prefunding for its USD payer leg — an FXP cannot pay a
  // currency it does not hold (the leg-ready funds check is currency-scoped).
  seedCcyBalance(d1, FXP_BANK, FXP_USD_ACC, PREFUND_USD, "USD");
});

const resolveFxpAccount = (_bankId: string, currency: string): string =>
  currency === "JPY" ? FXP_JPY_ACC : FXP_USD_ACC;

describe("FX settlement — direct JPY→USD moves customer balances", () => {
  it("payer loses JPY, payee gains rate-derived USD, FXP nets out, banks zero-sum", async () => {
    const env = makeEnv(d1);
    const jpyAmount = 500_000;
    const usdAmount = convertForward(jpyAmount, RATE); // 3,350

    await upsertQuote(d1, {
      fxp_bank_id: FXP_BANK,
      from_currency: "JPY",
      to_currency: "USD",
      rate: RATE,
      valid_to: FAR_FUTURE,
    });
    const routed = await findBestRoute(d1, {
      from_currency: "JPY",
      to_currency: "USD",
      amount: jpyAmount,
      denomination: "PAYER",
    });
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;

    await initiateFxTransfer(env, {
      gtid: "GT-FXSET-1",
      route: routed.route,
      payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACC },
      payee: { bank_id: PAYER_BANK, account_hash: PAYEE_ACC },
      resolveFxpAccount,
      idempotency_key: "IK-FXSET-1",
      expires_at: "2099-12-31T00:00:00Z",
    });

    await advanceGtid("GT-FXSET-1", env as any);
    await drain(env);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-FXSET-1'`)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SETTLED");

    // Customer balances move on the correct rail (per currency), not conflated:
    //  - payer pays JPY only (no phantom USD movement),
    //  - payee receives USD only (its JPY untouched),
    //  - FXP receives JPY on the JPY rail and pays USD on the USD rail.
    // Asserting per currency is what catches a USD outflow mislabelled as JPY:
    // a currency-blind sum would pass even when the FXP's USD payment is booked
    // against the wrong rail.
    expect(await balanceOfCcy(d1, PAYER_ACC, "JPY")).toBe(SEED_BAL - jpyAmount);
    expect(await balanceOfCcy(d1, PAYER_ACC, "USD")).toBe(0);
    expect(await balanceOfCcy(d1, PAYEE_ACC, "USD")).toBe(usdAmount);
    expect(await balanceOfCcy(d1, PAYEE_ACC, "JPY")).toBe(SEED_BAL);
    expect(await balanceOfCcy(d1, FXP_JPY_ACC, "JPY")).toBe(SEED_BAL + jpyAmount);
    expect(await balanceOfCcy(d1, FXP_USD_ACC, "USD")).toBe(PREFUND_USD - usdAmount);

    // Per-bank double-entry zero-sum holds across currencies AND within each.
    expect(await bankSum(d1, PAYER_BANK)).toBe(0);
    expect(await bankSum(d1, FXP_BANK)).toBe(0);
    expect(await perCurrencyZeroSum(d1, PAYER_BANK)).toBe(true);
    expect(await perCurrencyZeroSum(d1, FXP_BANK)).toBe(true);

    // FX record tracks the GTID settlement: checkAndFinalizeGtid (fired during
    // drain) flips FxTransfers.status to SETTLED (Phase 3 linkage).
    const fx = await d1
      .prepare(
        `SELECT amount_from, amount_to, effective_rate, status FROM FxTransfers WHERE gtid='GT-FXSET-1'`
      )
      .first<{ amount_from: number; amount_to: number; effective_rate: number; status: string }>();
    expect(fx?.amount_from).toBe(jpyAmount);
    expect(fx?.amount_to).toBe(usdAmount);
    expect(fx?.effective_rate).toBe(RATE);
    expect(fx?.status).toBe("SETTLED");
  });
});
