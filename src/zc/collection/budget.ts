/**
 * @file budget.ts — cumulative-budget reservation for continuous collection.
 *
 * The naive shape of this check is a race:
 *
 *     SELECT SUM(amount) ... → decide → INSERT
 *
 * Two collections interleaving between the SELECT and the INSERT both pass, and
 * the contract's ceiling is breached. This repository already treats that class
 * of bug as real (`test/integration/concurrent_races.test.ts` drives the
 * interleaving deliberately), and design principle 8 already answers it for H:
 * a limit is held as *state*, not recomputed from history.
 *
 * So every counter for one contract lives in a single `MandateBudget` row, and
 * one conditional UPDATE checks and consumes all of them at once. `meta.changes`
 * is the sole arbiter — the same CAS idiom as `transitionWithLog`, H
 * reservations and `FxTransfers.status`. Putting each window in its own row
 * would have forced an atomic multi-row acquire, and with it a lock-ordering
 * discipline; one row makes the serialisation point structural instead.
 *
 * Two consequences worth stating, because they are easy to undo by accident:
 *
 *  - **Caps are read back from `DebitMandate` inside the statement**, not copied
 *    onto the counter row. Caps change mid-contract (lowering is free, raising
 *    needs a customer signature), and a copy would drift into "the declared cap
 *    and the enforced cap disagree". A correlated subquery is evaluated within
 *    the same statement, so it cannot race the change either.
 *  - **Window rollover happens inside the same UPDATE**, via CASE expressions.
 *    A separate monthly reset job would race the reservation it is resetting.
 *
 * docs/specs/20_method_design.md §2.2.7.7, docs/specs/10_requirements.md §3.2.8.4.
 *
 * @module zc/collection/budget
 */
import type { DebitMandateRow, MandateBudgetRow } from "../../types";
import { nowISO } from "../../types";

/** Reset-type breach: the window will reopen. Distinct from exhaustion. */
export const BUDGET_RATE_EXCEEDED = "BUDGET_RATE_EXCEEDED";
/** Consuming-type breach: the contract's total is spent, which ends it. */
export const BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED";

export interface BudgetRequest {
  ddMandateId: string;
  /** Principal only. */
  amount: number;
  /** Late-payment interest, budgeted separately so it cannot hide in principal. */
  latefee?: number;
  mode: string;
  /** RFC3339; defaults to now. Drives which window the consumption lands in. */
  at?: string;
}

export interface BudgetOutcome {
  ok: boolean;
  reason_code?: string;
  /** Which cap was hit, for the operator-facing message. */
  breached?: string;
}

/** 'YYYY-MM' / 'YYYY-MM-DD' keys in JST, matching the business-date convention. */
function windowKeys(at: string): { monthKey: string; dayKey: string } {
  const jst = new Date(Date.parse(at) + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return { monthKey: `${y}-${m}`, dayKey: `${y}-${m}-${d}` };
}

/** Is `prev` the calendar month immediately before `cur`? */
function isPrecedingMonth(prev: string | null, cur: string): boolean {
  if (!prev) return false;
  const [py, pm] = prev.split("-").map(Number);
  const [cy, cm] = cur.split("-").map(Number);
  if (py === undefined || pm === undefined || cy === undefined || cm === undefined) return false;
  return py * 12 + pm + 1 === cy * 12 + cm;
}

/** Create the counter row for a new contract. Idempotent. */
export async function initBudget(
  db: D1Database,
  ddMandateId: string,
  at: string = nowISO()
): Promise<void> {
  const { monthKey, dayKey } = windowKeys(at);
  await db
    .prepare(
      `INSERT OR IGNORE INTO MandateBudget
         (dd_mandate_id, month_key, month_amount, month_count, prev_month_key,
          prev_month_amount, day_key, day_count, latefee_month_amount,
          realtime_month_count, lifetime_amount, lifetime_count,
          pending_amount, pending_count, last_amount, updated_at, version)
       VALUES (?, ?, 0, 0, NULL, 0, ?, 0, 0, 0, 0, 0, 0, 0, NULL, ?, 0)`
    )
    .bind(ddMandateId, monthKey, dayKey, at)
    .run();
}

/**
 * Reserve every applicable budget for one collection, atomically.
 *
 * The single UPDATE does three things at once: roll windows over if the key
 * changed, check all caps against the *post-rollover* counters, and consume.
 * `cap IS NULL` disables a budget rather than acting as zero.
 *
 * On `changes = 0` we do a second, read-only pass to say *which* cap was hit.
 * That extra query only runs on the rejection path, so it costs nothing in the
 * normal case, and reporting `BUDGET_RATE_EXCEEDED` where the truth is
 * `BUDGET_EXHAUSTED` would tell the customer to wait for a window that is never
 * going to reopen.
 */
export async function reserveBudget(db: D1Database, req: BudgetRequest): Promise<BudgetOutcome> {
  const at = req.at ?? nowISO();
  const { monthKey, dayKey } = windowKeys(at);
  const prevKey = precedingMonthKey(monthKey);
  const amt = req.amount;
  const fee = req.latefee ?? 0;
  const isRealtime = req.mode === "REALTIME" ? 1 : 0;

  // Binds are appended by `p()` at the exact point the placeholder is emitted,
  // so SQL and parameters cannot drift apart as clauses are edited. Numbered
  // (`?N`) placeholders are deliberately avoided: better-sqlite3 treats them as
  // *named* parameters, so they do not bind positionally the way D1 does.
  const binds: Array<string | number | null> = [];
  const p = (v: string | number | null): string => {
    binds.push(v);
    return "?";
  };

  // Rolled-over counter expressions. Each is emitted fresh (not shared as a
  // string) because every emission also appends its bind.
  const mAmt = () => `(CASE WHEN month_key = ${p(monthKey)} THEN month_amount ELSE 0 END)`;
  const mCnt = () => `(CASE WHEN month_key = ${p(monthKey)} THEN month_count ELSE 0 END)`;
  const mFee = () => `(CASE WHEN month_key = ${p(monthKey)} THEN latefee_month_amount ELSE 0 END)`;
  const mRt = () => `(CASE WHEN month_key = ${p(monthKey)} THEN realtime_month_count ELSE 0 END)`;
  const dCnt = () => `(CASE WHEN day_key = ${p(dayKey)} THEN day_count ELSE 0 END)`;
  // Two-month total: the current window plus the immediately preceding one.
  // Without it, a 10,000/month contract yields 20,000 across 30 April and
  // 1 May. `prev_month_amount` only counts when it belongs to the month
  // directly before this one; if the window has moved on twice, the older
  // figure is no longer part of any two-month total.
  const prevAmt = () =>
    `(CASE WHEN month_key = ${p(monthKey)} THEN COALESCE(prev_month_amount, 0)
           WHEN month_key = ${p(prevKey)} THEN month_amount
           ELSE 0 END)`;
  const cap = (col: string) =>
    `(SELECT ${col} FROM DebitMandate WHERE dd_mandate_id = ${p(req.ddMandateId)})`;

  const sql = `
    UPDATE MandateBudget SET
      month_amount         = ${mAmt()} + ${p(amt)},
      month_count          = ${mCnt()} + 1,
      latefee_month_amount = ${mFee()} + ${p(fee)},
      realtime_month_count = ${mRt()} + ${p(isRealtime)},
      prev_month_amount    = ${prevAmt()},
      prev_month_key       = CASE WHEN month_key = ${p(monthKey)}
                                  THEN prev_month_key ELSE month_key END,
      month_key            = ${p(monthKey)},
      day_count            = ${dCnt()} + 1,
      day_key              = ${p(dayKey)},
      lifetime_amount      = lifetime_amount + ${p(amt)},
      lifetime_count       = lifetime_count + 1,
      pending_amount       = pending_amount + ${p(amt + fee)},
      pending_count        = pending_count + 1,
      updated_at           = ${p(at)},
      version              = version + 1
    WHERE dd_mandate_id = ${p(req.ddMandateId)}
      AND (${cap("per_collection_cap")} IS NULL
           OR ${p(amt + fee)} <= ${cap("per_collection_cap")})
      AND (${cap("month_amount_cap")} IS NULL
           OR ${mAmt()} + ${p(amt)} <= ${cap("month_amount_cap")})
      AND (${cap("month_count_cap")} IS NULL
           OR ${mCnt()} + 1 <= ${cap("month_count_cap")})
      AND (${cap("two_month_amount_cap")} IS NULL
           OR ${mAmt()} + ${prevAmt()} + ${p(amt)} <= ${cap("two_month_amount_cap")})
      AND (${cap("day_count_cap")} IS NULL
           OR ${dCnt()} + 1 <= ${cap("day_count_cap")})
      AND (${cap("latefee_month_cap")} IS NULL
           OR ${mFee()} + ${p(fee)} <= ${cap("latefee_month_cap")})
      AND (${cap("realtime_month_count_cap")} IS NULL
           OR ${mRt()} + ${p(isRealtime)} <= ${cap("realtime_month_count_cap")})
      AND (${cap("lifetime_amount_cap")} IS NULL
           OR lifetime_amount + ${p(amt)} <= ${cap("lifetime_amount_cap")})
      AND (${cap("lifetime_count_cap")} IS NULL
           OR lifetime_count + 1 <= ${cap("lifetime_count_cap")})
      AND (${cap("pending_amount_cap")} IS NULL
           OR pending_amount + ${p(amt + fee)} <= ${cap("pending_amount_cap")})
      AND (${cap("pending_count_cap")} IS NULL
           OR pending_count + 1 <= ${cap("pending_count_cap")})`;

  const res = await db
    .prepare(sql)
    .bind(...binds)
    .run();

  if ((res.meta.changes ?? 0) > 0) return { ok: true };
  return diagnoseRejection(db, req, at, monthKey, dayKey);
}

/** 'YYYY-MM' of the month directly before `monthKey`. */
function precedingMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  if (y === undefined || m === undefined) return monthKey;
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  return `${prevY}-${String(prevM).padStart(2, "0")}`;
}

/**
 * Read-only second pass: name the cap that rejected the reservation.
 *
 * Consuming budgets are reported first. A contract that has spent its lifetime
 * total is finished, not throttled, and telling the customer to wait would be
 * telling them to wait forever.
 */
async function diagnoseRejection(
  db: D1Database,
  req: BudgetRequest,
  at: string,
  monthKey: string,
  dayKey: string
): Promise<BudgetOutcome> {
  const m = await db
    .prepare(`SELECT * FROM DebitMandate WHERE dd_mandate_id = ?`)
    .bind(req.ddMandateId)
    .first<DebitMandateRow>();
  const b = await db
    .prepare(`SELECT * FROM MandateBudget WHERE dd_mandate_id = ?`)
    .bind(req.ddMandateId)
    .first<MandateBudgetRow>();
  if (!m || !b) return { ok: false, reason_code: "DD_MANDATE_NOT_FOUND" };

  const amt = req.amount;
  const fee = req.latefee ?? 0;
  const sameMonth = b.month_key === monthKey;
  const sameDay = b.day_key === dayKey;
  const mAmt = sameMonth ? b.month_amount : 0;
  const mCnt = sameMonth ? b.month_count : 0;
  const mFee = sameMonth ? b.latefee_month_amount : 0;
  const mRt = sameMonth ? b.realtime_month_count : 0;
  const dCnt = sameDay ? b.day_count : 0;
  const prevAmt = sameMonth
    ? (b.prev_month_amount ?? 0)
    : isPrecedingMonth(b.month_key, monthKey)
      ? b.month_amount
      : 0;

  const exhausted: Array<[string, boolean]> = [
    ["lifetime_amount_cap", over(m.lifetime_amount_cap, b.lifetime_amount + amt)],
    ["lifetime_count_cap", over(m.lifetime_count_cap, b.lifetime_count + 1)],
  ];
  for (const [name, breached] of exhausted) {
    if (breached) return { ok: false, reason_code: BUDGET_EXHAUSTED, breached: name };
  }

  const rate: Array<[string, boolean]> = [
    ["per_collection_cap", over(m.per_collection_cap, amt + fee)],
    ["month_amount_cap", over(m.month_amount_cap, mAmt + amt)],
    ["month_count_cap", over(m.month_count_cap, mCnt + 1)],
    ["two_month_amount_cap", over(m.two_month_amount_cap, mAmt + prevAmt + amt)],
    ["day_count_cap", over(m.day_count_cap, dCnt + 1)],
    ["latefee_month_cap", over(m.latefee_month_cap, mFee + fee)],
    [
      "realtime_month_count_cap",
      over(m.realtime_month_count_cap, mRt + (req.mode === "REALTIME" ? 1 : 0)),
    ],
    ["pending_amount_cap", over(m.pending_amount_cap, b.pending_amount + amt + fee)],
    ["pending_count_cap", over(m.pending_count_cap, b.pending_count + 1)],
  ];
  for (const [name, breached] of rate) {
    if (breached) return { ok: false, reason_code: BUDGET_RATE_EXCEEDED, breached: name };
  }

  // Every cap holds on re-read: the row was changed by a concurrent writer
  // between the CAS and this diagnosis. Report it as a rate breach rather than
  // claiming success — the reservation genuinely did not happen.
  void at;
  return { ok: false, reason_code: BUDGET_RATE_EXCEEDED, breached: "CONCURRENT" };
}

function over(cap: number | null, projected: number): boolean {
  return cap !== null && projected > cap;
}

/**
 * Release a reservation.
 *
 * `outcome` decides how much comes back:
 *  - `FAILED`  — the collection did not happen, so reset-type budgets and the
 *    pending hold are all restored. Nothing was collected.
 *  - `SETTLED` — only the pending hold clears. The consumption is real and the
 *    consuming budgets keep it; that is what makes "12 instalments" expressible.
 *
 * Consuming budgets are never restored in either case beyond the FAILED path,
 * because a failed collection was never a consumption in the first place.
 */
export async function releaseBudget(
  db: D1Database,
  ddMandateId: string,
  amount: number,
  latefee: number,
  outcome: "SETTLED" | "FAILED",
  at: string = nowISO()
): Promise<void> {
  if (outcome === "SETTLED") {
    await db
      .prepare(
        `UPDATE MandateBudget
            SET pending_amount = MAX(0, pending_amount - ?),
                pending_count  = MAX(0, pending_count - 1),
                last_amount    = ?,
                updated_at     = ?,
                version        = version + 1
          WHERE dd_mandate_id = ?`
      )
      .bind(amount + latefee, amount, at, ddMandateId)
      .run();
    return;
  }

  await db
    .prepare(
      `UPDATE MandateBudget
          SET month_amount         = MAX(0, month_amount - ?),
              month_count          = MAX(0, month_count - 1),
              latefee_month_amount = MAX(0, latefee_month_amount - ?),
              lifetime_amount      = MAX(0, lifetime_amount - ?),
              lifetime_count       = MAX(0, lifetime_count - 1),
              day_count            = MAX(0, day_count - 1),
              pending_amount       = MAX(0, pending_amount - ?),
              pending_count        = MAX(0, pending_count - 1),
              updated_at           = ?,
              version              = version + 1
        WHERE dd_mandate_id = ?`
    )
    .bind(amount, latefee, amount, amount + latefee, at, ddMandateId)
    .run();
}

/**
 * Has the contract spent a consuming budget outright?
 *
 * Distinct from a rate breach: exhaustion is the contract reaching its declared
 * total, which is a completion condition rather than a throttle.
 */
export async function isExhausted(db: D1Database, ddMandateId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT b.lifetime_amount, b.lifetime_count,
              m.lifetime_amount_cap, m.lifetime_count_cap
         FROM MandateBudget b JOIN DebitMandate m USING (dd_mandate_id)
        WHERE b.dd_mandate_id = ?`
    )
    .bind(ddMandateId)
    .first<{
      lifetime_amount: number;
      lifetime_count: number;
      lifetime_amount_cap: number | null;
      lifetime_count_cap: number | null;
    }>();
  if (!row) return false;
  return (
    (row.lifetime_amount_cap !== null && row.lifetime_amount >= row.lifetime_amount_cap) ||
    (row.lifetime_count_cap !== null && row.lifetime_count >= row.lifetime_count_cap)
  );
}
