/**
 * @file Regression tests for the bank-ledger currency dimension on the
 * cross-currency (FX) paths.
 *
 * The FXP-conduit FX feature lets a single account carry entries in more than
 * one currency (a payee SAVINGS account credited in USD by the FXP leg; an FXP
 * paying USD it prefunded). Several bank-ledger primitives previously assumed a
 * single JPY pool and so leaked the currency dimension:
 *
 *   1. releaseRecoveredCustody booked the auto-release in the DEFAULT 'JPY',
 *      crediting a USD custody back to the customer as JPY and stranding the
 *      real USD in the suspense account forever.
 *   2. getAvailableBalance summed across ALL currencies, so a balance held in
 *      currency X could silently fund a debit in currency Y.
 *
 * These probes pin both to the correct per-currency behaviour so a regression
 * is caught even though a currency-blind sum (or per-bank zero-sum) would not
 * notice the mislabel.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  landSuspense,
  releaseRecoveredCustody,
  getAvailableBalance,
} from "../../src/bank/suspense";
import { insertJournalGroup } from "../../src/bank/ledger";

const BANK = "001";
const CUSTOMER_ACC = "0010000001"; // seeded NORMAL/SAVINGS with 1,000,000 JPY
const SUSPENSE_ACC = "0010000000"; // seeded SUSPENSE system account
const SEED_JPY = 1_000_000;
const USD_AMOUNT = 6_700;

let d1: MockD1Database;

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

function setAccountStatus(db: MockD1Database, accountId: string, status: string) {
  db.prepare(`UPDATE BankAccounts SET status=? WHERE account_id=? AND bank_id=?`)
    .bind(status, accountId, BANK)
    ._runSync();
}

beforeEach(() => {
  ({ d1 } = createTestDb());
});

// ---------------------------------------------------------------------------
// 1. CUSTODY auto-release must reverse in the LANDED currency, not DEFAULT JPY.
// ---------------------------------------------------------------------------
describe("releaseRecoveredCustody — non-JPY custody (FX payee leg)", () => {
  it("credits the customer in the landed currency and drains the foreign suspense balance", async () => {
    // A USD FX credit lands on a frozen payee account → CUSTODY in USD.
    setAccountStatus(d1, CUSTOMER_ACC, "FROZEN");
    const suspId = await landSuspense(d1, {
      bankId: BANK,
      accountId: CUSTOMER_ACC,
      direction: "RECEIVE",
      amount: USD_AMOUNT,
      txid: "TX-FXCUST-1",
      isCustody: true,
      custodyReason: "ACCOUNT_FROZEN",
      currency: "USD",
    });

    // While frozen, the USD sits in suspense; the customer is untouched.
    expect(await balanceOfCcy(d1, SUSPENSE_ACC, "USD")).toBe(USD_AMOUNT);
    expect(await balanceOfCcy(d1, CUSTOMER_ACC, "USD")).toBe(0);

    // Account recovers → auto-release.
    setAccountStatus(d1, CUSTOMER_ACC, "NORMAL");
    expect(await releaseRecoveredCustody(d1)).toBe(1);

    const status = await d1
      .prepare(`SELECT status FROM SuspenseDetails WHERE suspense_id=?`)
      .bind(suspId)
      .first<{ status: string }>();
    expect(status?.status).toBe("SETTLED");

    // The customer is credited in USD (NOT JPY), and the foreign suspense
    // balance is fully drained — the core of the bug fix.
    expect(await balanceOfCcy(d1, CUSTOMER_ACC, "USD")).toBe(USD_AMOUNT);
    expect(await balanceOfCcy(d1, CUSTOMER_ACC, "JPY")).toBe(SEED_JPY); // JPY untouched
    expect(await balanceOfCcy(d1, SUSPENSE_ACC, "USD")).toBe(0);
    // No phantom JPY was minted into the customer's account by the release.
    const releaseJpy = await d1
      .prepare(
        `SELECT COALESCE(SUM(amount),0) AS b FROM BankJournals
         WHERE tx_group_id=? AND amount_currency='JPY'`
      )
      .bind(`SUSP-AUTORESOLVE-${suspId}`)
      .first<{ b: number }>();
    expect(releaseJpy?.b).toBe(0);

    // Every currency still balances independently.
    expect(await perCurrencyZeroSum(d1, BANK)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Available-balance funds check must be scoped to the debit currency.
// ---------------------------------------------------------------------------
describe("getAvailableBalance — currency scoping", () => {
  it("does not let a balance in one currency fund a debit in another", async () => {
    // The customer holds 1,000,000 JPY (seed) and is credited 6,700 USD.
    await insertJournalGroup(d1, {
      bankId: BANK,
      txGroupId: "USD-CREDIT-1",
      currency: "USD",
      valueDate: "2025-01-01",
      entries: [
        { accountId: CUSTOMER_ACC, amount: USD_AMOUNT, txType: "CREDIT" },
        { accountId: `${BANK}-ZCS`, amount: -USD_AMOUNT, txType: "CREDIT" },
      ],
    });

    // Scoped balances are per currency.
    expect(await getAvailableBalance(CUSTOMER_ACC, d1, "JPY")).toBe(SEED_JPY);
    expect(await getAvailableBalance(CUSTOMER_ACC, d1, "USD")).toBe(USD_AMOUNT);

    // A USD debit larger than the USD balance fails even though the JPY balance
    // (a different currency) could "cover" it under a currency-blind sum.
    const usdAvail = await getAvailableBalance(CUSTOMER_ACC, d1, "USD");
    expect(usdAvail < USD_AMOUNT + 1).toBe(true); // 6,700 USD cannot fund 6,701 USD

    // The legacy currency-blind form still sums everything (back-compat).
    expect(await getAvailableBalance(CUSTOMER_ACC, d1)).toBe(SEED_JPY + USD_AMOUNT);
  });

  it("a JPY-only account reports zero available in a foreign currency", async () => {
    expect(await getAvailableBalance(CUSTOMER_ACC, d1, "JPY")).toBe(SEED_JPY);
    expect(await getAvailableBalance(CUSTOMER_ACC, d1, "USD")).toBe(0);
  });
});
