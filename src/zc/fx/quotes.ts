/**
 * @file FX quote storage — reads/writes for the FxQuotes marketplace table
 * (migrations/0004). An FXP (a participant bank with `is_fx_provider=1`) posts
 * directional conversion quotes; the routing engine (src/zc/fx/routing.ts)
 * reads the ACTIVE, in-window quotes to pick the best effective rate.
 *
 * Pure DB access — no rate arithmetic (that lives in ./rates.ts) and no
 * settlement side effects.
 *
 * @module zc/fx/quotes
 */
import { nowISO } from "../../types";
import { newUUID } from "../../shared/idempotency";

/** A row of the FxQuotes table. */
export interface FxQuote {
  quote_id: string;
  fxp_bank_id: string;
  from_currency: string;
  to_currency: string;
  /** units of to_currency per 1 from_currency, × RATE_SCALE (1e8). */
  rate: number;
  min_amount: number;
  max_amount: number | null;
  valid_from: string;
  valid_to: string;
  status: "ACTIVE" | "WITHDRAWN";
  created_at: string;
  updated_at: string;
  version: number;
}

/** Fields an FXP supplies when posting/updating a quote. */
export interface FxQuoteInput {
  fxp_bank_id: string;
  from_currency: string;
  to_currency: string;
  rate: number;
  min_amount?: number;
  max_amount?: number | null;
  valid_from?: string;
  valid_to: string;
}

/**
 * Upsert a directional quote. A given FXP holds at most one ACTIVE quote per
 * ordered pair `(from_currency → to_currency)`: re-posting the same pair
 * supersedes the previous quote's rate/window in place (WITHDRAWN rows are left
 * as history). Returns the stored quote.
 */
export async function upsertQuote(db: D1Database, input: FxQuoteInput): Promise<FxQuote> {
  const now = nowISO();
  const existing = await db
    .prepare(
      `SELECT quote_id FROM FxQuotes
       WHERE fxp_bank_id = ? AND from_currency = ? AND to_currency = ? AND status = 'ACTIVE'`
    )
    .bind(input.fxp_bank_id, input.from_currency, input.to_currency)
    .first<{ quote_id: string }>();

  const minAmount = input.min_amount ?? 0;
  const maxAmount = input.max_amount ?? null;
  const validFrom = input.valid_from ?? now;

  if (existing) {
    await db
      .prepare(
        `UPDATE FxQuotes
         SET rate = ?, min_amount = ?, max_amount = ?, valid_from = ?, valid_to = ?,
             updated_at = ?, version = version + 1
         WHERE quote_id = ?`
      )
      .bind(input.rate, minAmount, maxAmount, validFrom, input.valid_to, now, existing.quote_id)
      .run();
    return (await getQuote(db, existing.quote_id))!;
  }

  const quoteId = `FXQ-${newUUID()}`;
  await db
    .prepare(
      `INSERT INTO FxQuotes
         (quote_id, fxp_bank_id, from_currency, to_currency, rate, min_amount, max_amount,
          valid_from, valid_to, status, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, 0)`
    )
    .bind(
      quoteId,
      input.fxp_bank_id,
      input.from_currency,
      input.to_currency,
      input.rate,
      minAmount,
      maxAmount,
      validFrom,
      input.valid_to,
      now,
      now
    )
    .run();
  return (await getQuote(db, quoteId))!;
}

/** Fetch a single quote by id, or null. */
export async function getQuote(db: D1Database, quoteId: string): Promise<FxQuote | null> {
  return await db
    .prepare(`SELECT * FROM FxQuotes WHERE quote_id = ?`)
    .bind(quoteId)
    .first<FxQuote>();
}

/**
 * List ACTIVE quotes for an ordered pair that are valid at `at` (now). Ordered
 * best-first (highest `rate` = most to_currency per from_currency).
 */
export async function listActiveQuotes(
  db: D1Database,
  fromCurrency: string,
  toCurrency: string,
  at: string = nowISO()
): Promise<FxQuote[]> {
  const res = await db
    .prepare(
      `SELECT * FROM FxQuotes
       WHERE from_currency = ? AND to_currency = ? AND status = 'ACTIVE'
         AND valid_from <= ? AND valid_to >= ?
       ORDER BY rate DESC`
    )
    .bind(fromCurrency, toCurrency, at, at)
    .all<FxQuote>();
  return res.results ?? [];
}

/**
 * All ACTIVE, in-window quotes whose `from_currency` is `fromCurrency` — used by
 * the routing engine to discover bridge first-legs without enumerating pairs.
 */
export async function listActiveQuotesFrom(
  db: D1Database,
  fromCurrency: string,
  at: string = nowISO()
): Promise<FxQuote[]> {
  const res = await db
    .prepare(
      `SELECT * FROM FxQuotes
       WHERE from_currency = ? AND status = 'ACTIVE'
         AND valid_from <= ? AND valid_to >= ?
       ORDER BY rate DESC`
    )
    .bind(fromCurrency, at, at)
    .all<FxQuote>();
  return res.results ?? [];
}

/** Withdraw (deactivate) a single quote. Returns true if a row changed. */
export async function withdrawQuote(db: D1Database, quoteId: string): Promise<boolean> {
  const upd = await db
    .prepare(
      `UPDATE FxQuotes SET status = 'WITHDRAWN', updated_at = ?, version = version + 1
       WHERE quote_id = ? AND status = 'ACTIVE'`
    )
    .bind(nowISO(), quoteId)
    .run();
  return (upd.meta.changes ?? 0) > 0;
}
