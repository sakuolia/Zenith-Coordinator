/**
 * @file Zero-sum double-entry ledger (BankJournals). Every journal group must
 * satisfy SUM(amount)==0. Supports daily balance snapshots, interest accrual
 * (30/360), and zero-sum verification.
 * @module bank/ledger
 */
import { nowISO, retainedEarningsAccountId } from "../types";
import { newUUID } from "../shared/idempotency";

/** ISO 4217 code used when an entry/group does not specify a currency. */
export const DEFAULT_JOURNAL_CURRENCY = "JPY";

export interface JournalEntry {
  accountId: string;
  amount: number; // Signed (positive = increase, negative = decrease)
  txType: string; // TRANSFER|RESERVE|EXECUTE|CREDIT|INTEREST|CASH|CORRECTION
  txid?: string;
  description?: string;
  /**
   * ISO 4217 currency code of this entry's amount. Falls back to the group's
   * `currency`, then to {@link DEFAULT_JOURNAL_CURRENCY}. Zero-sum is validated
   * independently per currency, so a single group may mix currencies as long as
   * each one balances on its own (e.g. a PvP leg pair).
   */
  currency?: string;
}

export interface JournalGroupInput {
  bankId: string;
  txGroupId: string;
  entries: JournalEntry[];
  valueDate: string; // YYYY-MM-DD
  /** Default currency for entries that do not set their own. */
  currency?: string;
}

/**
 * Batch INSERT a journal entry group.
 * Zero-sum validation: throws if SUM(amount) != 0
 */
export async function insertJournalGroup(db: D1Database, input: JournalGroupInput): Promise<void> {
  const currencyOf = (e: JournalEntry) => e.currency ?? input.currency ?? DEFAULT_JOURNAL_CURRENCY;

  // Zero-sum is enforced per currency: a group may carry more than one currency
  // (e.g. a PvP leg pair), but each must balance on its own. A cross-currency
  // group that nets to 0 only when units are mixed is exactly the bug this
  // dimensioning prevents.
  const sums = new Map<string, number>();
  for (const e of input.entries) {
    const ccy = currencyOf(e);
    sums.set(ccy, (sums.get(ccy) ?? 0) + e.amount);
  }
  for (const [ccy, sum] of sums) {
    if (sum !== 0) {
      // A zero-sum violation is a system bug, so throw an exception
      throw new Error(
        `Zero-sum violation: SUM(amount)=${sum} for currency=${ccy} group=${input.txGroupId}`
      );
    }
  }

  const now = nowISO();
  const stmts = input.entries.map((e) =>
    db
      .prepare(
        `INSERT INTO BankJournals
       (journal_id, bank_id, account_id, amount, amount_currency, tx_type, txid, tx_group_id, description, value_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        `JNL-${newUUID()}`,
        input.bankId,
        e.accountId,
        e.amount,
        currencyOf(e),
        e.txType,
        e.txid ?? null,
        input.txGroupId,
        e.description ?? null,
        input.valueDate,
        now
      )
  );
  await db.batch(stmts);
}

/**
 * Compute the account balance (sum of journal entries).
 *
 * When `currency` is given, only that currency's entries are summed — required
 * for shared accounts (suspense / ZCS / RE) that are not currency-segregated by
 * account id. When omitted, sums across all currencies (legacy behaviour; safe
 * for single-currency accounts).
 */
export async function calcBalance(
  accountId: string,
  db: D1Database,
  currency?: string
): Promise<number> {
  const row = currency
    ? await db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS balance FROM BankJournals WHERE account_id = ? AND amount_currency = ?`
        )
        .bind(accountId, currency)
        .first<{ balance: number }>()
    : await db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS balance FROM BankJournals WHERE account_id = ?`
        )
        .bind(accountId)
        .first<{ balance: number }>();
  return row?.balance ?? 0;
}

/**
 * Save the daily balance snapshot
 */
export async function snapshotDailyBalance(
  accountId: string,
  snapshotDate: string,
  db: D1Database
): Promise<void> {
  const balance = await calcBalance(accountId, db);
  await db
    .prepare(
      `INSERT OR REPLACE INTO DailyBalances (account_id, snapshot_date, end_of_day_balance)
     VALUES (?, ?, ?)`
    )
    .bind(accountId, snapshotDate, balance)
    .run();
}

/**
 * Interest calculation and journal entry (30/360)
 * annual_rate: 0.001 = 0.1%
 */
export async function applyDailyInterest(
  bankId: string,
  snapshotDate: string,
  db: D1Database
): Promise<void> {
  const accounts = await db
    .prepare(
      `SELECT account_id FROM BankAccounts WHERE bank_id=? AND status='NORMAL' AND account_type='SAVINGS'`
    )
    .bind(bankId)
    .all<{ account_id: string }>();

  const rate = await db
    .prepare(
      `SELECT annual_rate FROM InterestRates WHERE bank_id=? AND account_type='SAVINGS' AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1`
    )
    .bind(bankId, snapshotDate)
    .first<{ annual_rate: number }>();

  if (!rate || accounts.results.length === 0) return;

  const dailyRate = rate.annual_rate / 360; // 30/360 rule
  const reAcctId = retainedEarningsAccountId(bankId); // Retained earnings account (does not pollute the segregated deposit (suspense))

  for (const acc of accounts.results) {
    const balance = await calcBalance(acc.account_id, db);
    if (balance <= 0) continue;
    const interest = Math.floor(balance * dailyRate);
    if (interest === 0) continue;

    // Idempotency guard (EOD re-run safety): runEod is not transactional, so a
    // crash-retry or a second cron fire in the same business day re-invokes this
    // step. The tx_group_id is deterministic (`INT-{date}-{account}`), but
    // insertJournalGroup mints a fresh journal_id per call and does not enforce
    // tx_group_id uniqueness — re-posting would credit interest twice (and the
    // re-run compounds on the already-inflated balance). Skip if already posted.
    // Mirrors the DNS Phase-2 BOJ group guard in settleDns.
    const intGroupId = `INT-${snapshotDate}-${acc.account_id}`;
    const alreadyPosted = await db
      .prepare(`SELECT 1 FROM BankJournals WHERE tx_group_id = ? LIMIT 1`)
      .bind(intGroupId)
      .first();
    if (alreadyPosted) continue;

    // Zero-sum: retained earnings (negative = expense) and ordinary deposit (positive = liability)
    await insertJournalGroup(db, {
      bankId,
      txGroupId: intGroupId,
      entries: [
        {
          accountId: acc.account_id,
          amount: interest,
          txType: "INTEREST",
          description: `利息入金 ${snapshotDate}`,
        },
        {
          accountId: reAcctId,
          amount: -interest,
          txType: "INTEREST",
          description: `利息 費用計上 ${snapshotDate}`,
        },
      ],
      valueDate: snapshotDate,
    });
  }
}

/**
 * Zero-sum validation: every currency must independently sum to 0 across the
 * bank's ledger. Summing across all currencies at once could mask a per-currency
 * imbalance (a positive JPY drift cancelled by a negative USD drift), so the
 * check is grouped by `amount_currency`.
 */
export async function verifyZeroSum(bankId: string, db: D1Database): Promise<boolean> {
  const rows = await db
    .prepare(
      `SELECT amount_currency, COALESCE(SUM(amount), 0) AS total
         FROM BankJournals WHERE bank_id = ?
        GROUP BY amount_currency`
    )
    .bind(bankId)
    .all<{ amount_currency: string; total: number }>();
  return rows.results.every((r) => r.total === 0);
}
