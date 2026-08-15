/**
 * @file h_model.ts - H-Limit Reservation Management (Liquidity Control)
 *
 * Implements the H-limit (bilateral net sending cap) reservation system for ZC.
 * Each participant bank has a configurable h_limit; outbound transfers consume
 * h_used via atomic SQL UPDATE with overflow guard (h_used + amount <= h_limit).
 *
 * Reservation lifecycle:
 *   RESERVED  - capacity claimed at ingress/pre-check time
 *   LOCKED    - promoted when DECIDED_TO_SETTLE (held until DNS settlement)
 *   RELEASED  - returned to pool on cancel, timeout, or DNS cycle completion
 *
 * All mutations use D1 batch or single-statement atomicity; no SELECT FOR UPDATE.
 */
import type { HReservationRow } from "../../types";
import { nowISO } from "../../types";
import { newUUID } from "../../shared/idempotency";

// ---------------------------------------------------------------------------
// Acquire H-reserve (optimistic lock)
// ---------------------------------------------------------------------------

/**
 * Discriminated result returned by reserveH. Every variant carries enough
 * context to explain WHY the call returned that way without a second query:
 *
 *   - ok=true: reservation_id, bank_id, amount taken, h_used_after, h_limit.
 *   - BANK_NOT_FOUND: bank_id of the missed lookup.
 *   - BANK_INACTIVE: bank_id of the suspended participant.
 *   - H_LIMIT_EXCEEDED: bank_id, requested, h_used (current), h_limit, and
 *     available (= h_limit - h_used) so callers can render a precise error.
 */
export type ReserveHResult =
  | {
      ok: true;
      reservation_id: string;
      bank_id: string;
      amount: number;
      h_used_after: number;
      h_limit: number;
    }
  | { ok: false; reason: "BANK_NOT_FOUND"; bank_id: string }
  | { ok: false; reason: "BANK_INACTIVE"; bank_id: string }
  | {
      ok: false;
      reason: "H_LIMIT_EXCEEDED";
      bank_id: string;
      requested: number;
      h_used: number;
      h_limit: number;
      available: number;
    };

/**
 * Acquire an H-limit reservation for an outbound transfer.
 * Atomically increments h_used if the amount fits within h_limit.
 *
 * @param bankId   - Payer bank ID (Participants.bank_id)
 * @param txid     - Transaction ID to associate with the reservation
 * @param amount   - Reservation amount in minor units
 * @param db       - D1 database handle
 * @param currency - ISO 4217 currency code of the H capacity to consume
 *                    (Theme D: per-currency H limits). 'JPY'
 *                    (default) consumes `Participants.h_limit`/`h_used` as
 *                    before; other currencies consume the per-(bank,currency)
 *                    row in `ParticipantCurrencyLimits`.
 * @returns ReserveHResult — see type definition for the full diagnostic set.
 */
export async function reserveH(
  bankId: string,
  txid: string,
  amount: number,
  db: D1Database,
  currency: string = "JPY"
): Promise<ReserveHResult> {
  const reservationId = `H-${newUUID()}`;
  const now = nowISO();

  if (currency === "JPY") {
    // Atomic limit gate: the single UPDATE both reserves capacity and rejects
    // overflow in one statement. h_used is intentionally kept as a materialized
    // counter (rather than derived from SUM(HReservations)) because this guard
    // form is race-free under concurrent reservations — a SUM-then-check would
    // reopen a TOCTOU window where two callers each pass the check and over-
    // reserve. Reconcilable with SUM(HReservations WHERE is_released=0) at rest.
    // Crash-safety: the h_used increment and the HReservations INSERT must
    // commit-or-roll-back as a unit. Run as two statements (increment, then a
    // `changes() > 0`-gated INSERT) so a process death between them cannot leave
    // h_used incremented with no reservation row — capacity that could never be
    // released (releaseH needs the row). Symmetric to releaseH, which was already
    // batched. The conditional INSERT fires iff the limit-gated UPDATE hit a row.
    const upd = (
      await db.batch([
        db
          .prepare(
            `UPDATE Participants
             SET h_used = h_used + ?
             WHERE bank_id = ? AND is_active = 1 AND (h_used + ?) <= h_limit`
          )
          .bind(amount, bankId, amount),
        db
          .prepare(
            `INSERT INTO HReservations
               (reservation_id, txid, bank_id, amount, mode, is_released, created_at, currency)
             SELECT ?, ?, ?, ?, 'RESERVED', 0, ?, ?
             WHERE changes() > 0`
          )
          .bind(reservationId, txid, bankId, amount, now, currency),
      ])
    )[0]!;

    if ((upd.meta.changes ?? 0) === 0) {
      // changes=0 means one of (a) no participant bank, (b) inactive, (c) h_limit exceeded.
      // Fetch is_active and h_limit/h_used in a single query to return the specific reason.
      const bankRow = await db
        .prepare(`SELECT is_active, h_limit, h_used FROM Participants WHERE bank_id = ?`)
        .bind(bankId)
        .first<{ is_active: number; h_limit: number; h_used: number }>();
      if (!bankRow) return { ok: false, reason: "BANK_NOT_FOUND", bank_id: bankId };
      if (bankRow.is_active === 0) return { ok: false, reason: "BANK_INACTIVE", bank_id: bankId };
      return {
        ok: false,
        reason: "H_LIMIT_EXCEEDED",
        bank_id: bankId,
        requested: amount,
        h_used: bankRow.h_used,
        h_limit: bankRow.h_limit,
        available: bankRow.h_limit - bankRow.h_used,
      };
    }

    // The HReservations row was inserted atomically with the increment above.
    // Fetch the success snapshot (h_used_after, h_limit) in a single query
    const after = await db
      .prepare(`SELECT h_used, h_limit FROM Participants WHERE bank_id = ?`)
      .bind(bankId)
      .first<{ h_used: number; h_limit: number }>();

    return {
      ok: true,
      reservation_id: reservationId,
      bank_id: bankId,
      amount,
      h_used_after: after?.h_used ?? 0,
      h_limit: after?.h_limit ?? 0,
    };
  }

  // Non-JPY: first confirm the bank exists/is active via Participants (the
  // currency-agnostic source of truth), then gate capacity against the
  // per-(bank, currency) row in ParticipantCurrencyLimits.
  const bank = await db
    .prepare(`SELECT is_active FROM Participants WHERE bank_id = ?`)
    .bind(bankId)
    .first<{ is_active: number }>();
  if (!bank) return { ok: false, reason: "BANK_NOT_FOUND", bank_id: bankId };
  if (bank.is_active === 0) return { ok: false, reason: "BANK_INACTIVE", bank_id: bankId };

  // Crash-safety (per-currency path): atomically increment and insert the
  // reservation, mirroring the JPY path above.
  const updCcy = (
    await db.batch([
      db
        .prepare(
          `UPDATE ParticipantCurrencyLimits
           SET h_used = h_used + ?
           WHERE bank_id = ? AND currency = ? AND (h_used + ?) <= h_limit`
        )
        .bind(amount, bankId, currency, amount),
      db
        .prepare(
          `INSERT INTO HReservations
             (reservation_id, txid, bank_id, amount, mode, is_released, created_at, currency)
           SELECT ?, ?, ?, ?, 'RESERVED', 0, ?, ?
           WHERE changes() > 0`
        )
        .bind(reservationId, txid, bankId, amount, now, currency),
    ])
  )[0]!;

  if ((updCcy.meta.changes ?? 0) === 0) {
    // changes=0 means either no limit row exists for this (bank, currency)
    // (treated as a zero-capacity limit) or the limit was exceeded.
    const limitRow = await db
      .prepare(
        `SELECT h_limit, h_used FROM ParticipantCurrencyLimits WHERE bank_id = ? AND currency = ?`
      )
      .bind(bankId, currency)
      .first<{ h_limit: number; h_used: number }>();
    const h_limit = limitRow?.h_limit ?? 0;
    const h_used = limitRow?.h_used ?? 0;
    return {
      ok: false,
      reason: "H_LIMIT_EXCEEDED",
      bank_id: bankId,
      requested: amount,
      h_used,
      h_limit,
      available: h_limit - h_used,
    };
  }

  // The HReservations row was inserted atomically with the increment above.
  const afterCcy = await db
    .prepare(
      `SELECT h_used, h_limit FROM ParticipantCurrencyLimits WHERE bank_id = ? AND currency = ?`
    )
    .bind(bankId, currency)
    .first<{ h_used: number; h_limit: number }>();

  return {
    ok: true,
    reservation_id: reservationId,
    bank_id: bankId,
    amount,
    h_used_after: afterCcy?.h_used ?? 0,
    h_limit: afterCcy?.h_limit ?? 0,
  };
}

/**
 * Promote an H-reservation from RESERVED to LOCKED.
 * Called at DECIDED_TO_SETTLE to hold capacity until DNS cycle completion.
 *
 * @param reservationId - H-reservation ID to lock
 * @param db            - D1 database handle
 * @returns true if the lock succeeded, false if already released or not found
 */
export async function lockH(reservationId: string, db: D1Database): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE HReservations SET mode = 'LOCKED'
       WHERE reservation_id = ? AND mode = 'RESERVED' AND is_released = 0`
    )
    .bind(reservationId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Release an H-reservation and return capacity to the bank's h_used pool.
 * Uses D1 batch to atomically mark the reservation released and decrement h_used.
 *
 * @param reservationId - H-reservation ID to release
 * @param db            - D1 database handle
 * @returns true if released, false if already released or not found
 */
export async function releaseH(reservationId: string, db: D1Database): Promise<boolean> {
  // TOCTOU prevention: execute in a single batch with a CAS guard
  // The is_released=0 guard on HReservations prevents double release,
  // and the h_used decrement on Participants depends on that guard succeeding
  const row = await db
    .prepare(
      `SELECT bank_id, amount, is_released, currency FROM HReservations WHERE reservation_id = ?`
    )
    .bind(reservationId)
    .first<{ bank_id: string; amount: number; is_released: number; currency: string }>();

  if (!row || row.is_released === 1) return false;

  const now = nowISO();
  const isJpy = row.currency === "JPY";
  // Within the batch, perform the HReservations CAS update and the
  // Participants/ParticipantCurrencyLimits h_used decrement in the same transaction
  // If the HReservations UPDATE yields changes=0 (already is_released=1),
  // the second UPDATE also runs within the same transaction, but
  // detect changes=0 in the return value and return false to the caller
  const stmts = [
    db
      .prepare(
        `UPDATE HReservations SET is_released = 1, released_at = ?
         WHERE reservation_id = ? AND is_released = 0`
      )
      .bind(now, reservationId),
    // The h_used decrement is only meaningful if the HReservations CAS succeeds
    // Since a D1 batch executes within a transaction, on CAS failure the subsequent stmts included
    // are not rolled back, but the caller decides based on changes=0
    // Note: if h_used < amount, emit a warning log because of an accounting inconsistency.
    // Keep MAX(0, ...) as floor protection, but prevent it from hiding the inconsistency.
    isJpy
      ? db
          .prepare(
            `UPDATE Participants SET h_used = CASE
               WHEN h_used < ? THEN 0
               ELSE h_used - ?
             END
             WHERE bank_id = ? AND EXISTS (
               SELECT 1 FROM HReservations
               WHERE reservation_id = ? AND is_released = 1 AND released_at = ?
             )`
          )
          .bind(row.amount, row.amount, row.bank_id, reservationId, now)
      : db
          .prepare(
            `UPDATE ParticipantCurrencyLimits SET h_used = CASE
               WHEN h_used < ? THEN 0
               ELSE h_used - ?
             END
             WHERE bank_id = ? AND currency = ? AND EXISTS (
               SELECT 1 FROM HReservations
               WHERE reservation_id = ? AND is_released = 1 AND released_at = ?
             )`
          )
          .bind(row.amount, row.amount, row.bank_id, row.currency, reservationId, now),
  ];

  const results = await db.batch(stmts);
  const released = (results[0]?.meta.changes ?? 0) > 0;
  if (released && isJpy) {
    // If h_used < amount, this is an accounting inconsistency (h_used is clamped to 0)
    const p = await db
      .prepare(`SELECT h_used FROM Participants WHERE bank_id = ?`)
      .bind(row.bank_id)
      .first<{ h_used: number }>();
    if (p && p.h_used === 0) {
      // Warning for cases where h_used=0 after release may not be as expected
      // (if it became 0 while other reservations exist, that is a sign the floor protection kicked in)
      const otherActive = await db
        .prepare(`SELECT COUNT(*) as cnt FROM HReservations WHERE bank_id = ? AND is_released = 0`)
        .bind(row.bank_id)
        .first<{ cnt: number }>();
      if (otherActive && otherActive.cnt > 0) {
        console.warn(
          `[h_model] WARNING: h_used floored to 0 for bank_id=${row.bank_id} but ${otherActive.cnt} active reservations remain. Possible accounting inconsistency.`
        );
      }
    }
  }
  return released;
}

/**
 * Retrieve an H-reservation record by ID.
 *
 * @param reservationId - H-reservation ID
 * @param db            - D1 database handle
 * @returns HReservationRow or null if not found
 */
export async function getHReservation(
  reservationId: string,
  db: D1Database
): Promise<HReservationRow | null> {
  return db
    .prepare(`SELECT * FROM HReservations WHERE reservation_id = ?`)
    .bind(reservationId)
    .first<HReservationRow>();
}

/**
 * Get the current H-limit usage status for a participant bank.
 *
 * @param bankId   - Participant bank ID
 * @param db       - D1 database handle
 * @param currency - ISO 4217 currency code (Theme D: per-currency H limits).
 *                    'JPY' (default) reads `Participants`; other
 *                    currencies read `ParticipantCurrencyLimits` (returns
 *                    null if no limit row exists for that bank/currency).
 * @returns Object with h_limit and h_used, or null if bank not found/inactive
 *          (JPY) or no limit configured (non-JPY)
 */
export async function getHStatus(
  bankId: string,
  db: D1Database,
  currency: string = "JPY"
): Promise<{ h_limit: number; h_used: number } | null> {
  if (currency === "JPY") {
    return db
      .prepare(`SELECT h_limit, h_used FROM Participants WHERE bank_id = ? AND is_active = 1`)
      .bind(bankId)
      .first<{ h_limit: number; h_used: number }>();
  }
  return db
    .prepare(
      `SELECT h_limit, h_used FROM ParticipantCurrencyLimits WHERE bank_id = ? AND currency = ?`
    )
    .bind(bankId, currency)
    .first<{ h_limit: number; h_used: number }>();
}
