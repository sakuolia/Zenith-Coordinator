/**
 * @file igs_hold.ts — IGS (HIGH_VALUE) admission support during a DNS hold:
 *       the priority Defer queue and the per-participant throttle budget.
 *
 * These close the "Defer キュー" and "igs_throttle_budget による公平性制御"
 * gaps tracked in docs/specs/30_internal_design.md 第7章 (normative:
 * docs/specs/20_method_design.md §2.4 類型B). They are intentionally self-contained — they take a D1Database and
 * touch only IgsDeferQueue / IgsThrottleState (+ FinalityLog) — so neither dns.ts
 * nor highvalue.ts forms an import cycle through this module. The orchestration
 * (re-injecting due deferrals) lives in the timeout sweep, which already owns the
 * resume path.
 * @module zc/igs_hold
 */
import { nowISO } from "../../types";
import type { IgsDeferRow } from "../../types";
import { newUUID } from "../../shared/idempotency";
import { writeFinalityLog } from "../orchestrator";
import { IGS_THROTTLE_BUDGET_JPY, IGS_DEFER_WINDOW_SEC } from "../../shared/constants";

// ---------------------------------------------------------------------------
// Throttle budget (igs_throttle_budget): per (held cycle, participant) gross IGS
// admitted during a hold. Over-budget IGS is Deferred, not rejected.
// ---------------------------------------------------------------------------

/**
 * Read how much gross IGS `bankId` has already had admitted during the held
 * `cycleId`. 0 when no IGS has settled yet under this hold.
 */
export async function getThrottleConsumed(
  db: D1Database,
  cycleId: string,
  bankId: string
): Promise<number> {
  const row = await db
    .prepare(`SELECT admitted_amount FROM IgsThrottleState WHERE cycle_id = ? AND bank_id = ?`)
    .bind(cycleId, bankId)
    .first<{ admitted_amount: number }>();
  return row?.admitted_amount ?? 0;
}

/**
 * Would admitting `amount` for `bankId` exceed its IGS throttle budget for this
 * held cycle? A participant that has already pushed its budget worth of IGS has
 * further IGS deferred so scarce recovery-phase liquidity is shared fairly.
 */
export async function wouldExceedThrottle(
  db: D1Database,
  cycleId: string,
  bankId: string,
  amount: number
): Promise<boolean> {
  const consumed = await getThrottleConsumed(db, cycleId, bankId);
  return consumed + amount > IGS_THROTTLE_BUDGET_JPY;
}

/**
 * Record that `amount` of IGS was admitted for `bankId` under the held
 * `cycleId`. Called only when a RINGFENCED_PLUS admission actually settles, so
 * the budget tracks real consumption. Upsert-accumulate.
 */
export async function consumeThrottleBudget(
  db: D1Database,
  cycleId: string,
  bankId: string,
  amount: number
): Promise<void> {
  const now = nowISO();
  await db
    .prepare(
      `INSERT INTO IgsThrottleState (cycle_id, bank_id, admitted_amount, admitted_count, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(cycle_id, bank_id) DO UPDATE SET
         admitted_amount = admitted_amount + excluded.admitted_amount,
         admitted_count  = admitted_count + 1,
         updated_at      = excluded.updated_at`
    )
    .bind(cycleId, bankId, amount, now)
    .run();
}

// ---------------------------------------------------------------------------
// Defer queue: a blocked IGS re-injected with a priority + scheduled window,
// rather than left to the plain suspend→sweep path. "拒否ではなく Defer を原則
// とし、scheduled_execution_window を付与する" (docs/specs/20_method_design.md §2.4 類型B / §10.9.3.1).
//
// Ring-fenced (Mode 1 isolation) and throttled (Mode 2 fairness) IGS both sit on
// THIS ONE queue, which is what makes their relative order definable at all.
// Ordering (lower = sooner):
//
//   THROTTLED  (200) — a fully admissible transfer held back only because its
//                      payer spent its fairness budget for this hold.
//   RINGFENCED (300) — a transfer touching a hold-causing participant. Last:
//                      admitting it would move the defaulter's central-bank
//                      position while the cycle is held, which is the one thing
//                      the ring-fence exists to prevent.
//
// The earlier code had these reversed in intent (default 100 for ring-fenced,
// 200 for throttled) while never enqueueing ring-fenced rows at all, so the
// ordering was both unreachable and backwards: it put the transfer that cannot
// be admitted ahead of the one that can.
// ---------------------------------------------------------------------------

/** Defer priority for a Mode-2 fairness-throttled IGS. Lower = sooner. */
export const IGS_DEFER_PRIORITY_THROTTLED = 200;
/** Defer priority for a ring-fenced IGS (isolation). Last in the queue. */
export const IGS_DEFER_PRIORITY_RINGFENCED = 300;

/**
 * Enqueue a Deferred IGS. Idempotent per txid (idx_igs_defer_txid UNIQUE +
 * INSERT OR IGNORE): a tx already deferred is not double-queued, so an at-least-
 * once admission path cannot inflate the queue. Writes an `IgsDeferred` event so
 * the deferral is on the audit chain.
 *
 * `priority` is lower = sooner; see the ordering note above. Callers pass one of
 * `IGS_DEFER_PRIORITY_THROTTLED` / `IGS_DEFER_PRIORITY_RINGFENCED`; the default
 * is the ring-fenced (last) position, so an unlabelled deferral cannot jump the
 * queue ahead of a transfer that is actually admissible.
 */
export async function deferIgs(
  db: D1Database,
  args: {
    txid: string;
    cycle_id: string;
    payer_bank_id: string;
    payee_bank_id: string;
    amount_value: number;
    reason_code: string;
    priority?: number;
  }
): Promise<void> {
  const now = nowISO();
  const scheduled = new Date(Date.now() + IGS_DEFER_WINDOW_SEC * 1000).toISOString();
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO IgsDeferQueue
         (defer_id, txid, cycle_id, payer_bank_id, payee_bank_id, amount_value,
          reason_code, priority, scheduled_execution_window, status, enqueued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DEFERRED', ?)`
    )
    .bind(
      `IGSDEFER-${newUUID()}`,
      args.txid,
      args.cycle_id,
      args.payer_bank_id,
      args.payee_bank_id,
      args.amount_value,
      args.reason_code,
      args.priority ?? IGS_DEFER_PRIORITY_RINGFENCED,
      scheduled,
      now
    )
    .run();

  if ((res.meta.changes ?? 0) > 0) {
    await writeFinalityLog(db, {
      txid: args.txid,
      event_type: "IgsDeferred",
      state_from: "PRECHECKED",
      state_to: "PRECHECKED_SUSPENDED",
      payload_json: JSON.stringify({
        cycle_id: args.cycle_id,
        reason: args.reason_code,
        priority: args.priority ?? IGS_DEFER_PRIORITY_RINGFENCED,
        scheduled_execution_window: scheduled,
      }),
      txid_or_gtid: args.txid,
    });
  }
}

/**
 * Return DEFERRED IGS whose scheduled execution window has arrived, in priority
 * order (lower priority value first, then earliest enqueued). The timeout sweep
 * drives each through resumeRingfencedIgs and marks it RESUMED on success.
 */
export async function getDueDeferredIgs(
  db: D1Database,
  now: string = nowISO()
): Promise<IgsDeferRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM IgsDeferQueue
       WHERE status = 'DEFERRED' AND scheduled_execution_window <= ?
       ORDER BY priority ASC, enqueued_at ASC`
    )
    .bind(now)
    .all<IgsDeferRow>();
  return rows.results ?? [];
}

/** Mark a Deferred IGS as RESUMED (its tx has been re-injected into settlement). */
export async function markDeferResumed(db: D1Database, txid: string): Promise<void> {
  const now = nowISO();
  const res = await db
    .prepare(
      `UPDATE IgsDeferQueue SET status='RESUMED', resumed_at=?
       WHERE txid=? AND status='DEFERRED'`
    )
    .bind(now, txid)
    .run();
  if ((res.meta.changes ?? 0) > 0) {
    await writeFinalityLog(db, {
      txid,
      event_type: "IgsDeferResumed",
      state_from: "PRECHECKED_SUSPENDED",
      state_to: "PRECHECKED",
      payload_json: JSON.stringify({ txid }),
      txid_or_gtid: txid,
    });
  }
}
