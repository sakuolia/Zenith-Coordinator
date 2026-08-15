/**
 * @file operating_window.ts - Participant operating-window primitive
 * (Theme E: 24/365 稼働).
 *
 * Each participant bank may declare a daily operating window in JST (the system
 * timezone) via `Participants.operating_window_start` / `operating_window_end`
 * ('HH:MM').
 * NULL/NULL — the default for all existing participants — means "always
 * open", so banks that do not configure a window see no behavior change.
 *
 * This is the H-limit-style "managed state" referenced by the design: a
 * gate checked before synchronous bank calls, with an explainable wait
 * state (PRECHECKED_SUSPENDED + reason_code='COUNTERPARTY_WINDOW_CLOSED' in
 * src/zc/lanes/express.ts) rather than a hard failure.
 */

import { systemMinutesOfDay } from "../../types";

export interface OperatingWindow {
  operating_window_start: string | null;
  operating_window_end: string | null;
}

/** Parse 'HH:MM' into minutes-since-midnight, or null if absent/invalid. */
function toMinutes(hhmm: string | null): number | null {
  if (!hhmm) return null;
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Returns true if `now` falls within [start, end), where start/end are JST
 * wall-clock times (the system timezone).
 *
 * - NULL start or end (or both) → always open (default for existing rows).
 * - start === end → treated as a 24h window (always open).
 * - start < end → same-day window, e.g. 09:00-17:00 JST.
 * - start > end → wraps past midnight, e.g. 22:00-06:00 JST.
 */
export function isWithinOperatingWindow(window: OperatingWindow, now: Date): boolean {
  const start = toMinutes(window.operating_window_start);
  const end = toMinutes(window.operating_window_end);
  if (start === null || end === null) return true;
  if (start === end) return true;

  const nowMinutes = systemMinutesOfDay(now);
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  return nowMinutes >= start || nowMinutes < end;
}

/**
 * Look up `bankId`'s operating window and evaluate it against `now`.
 * Returns true (open) if the bank has no row or no window configured —
 * callers needing BANK_NOT_FOUND semantics must check that separately.
 */
export async function isBankOpenNow(
  bankId: string,
  db: D1Database,
  now: Date = new Date()
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT operating_window_start, operating_window_end FROM Participants WHERE bank_id = ?`
    )
    .bind(bankId)
    .first<OperatingWindow>();
  if (!row) return true;
  return isWithinOperatingWindow(row, now);
}
