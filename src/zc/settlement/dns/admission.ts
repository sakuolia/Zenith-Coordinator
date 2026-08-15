/**
 * @file DNS/IGS admission — checkIgsAdmission gate (HIGH_VALUE admission during
 *       a DNS hold) and its IgsAdmissionDecision result type.
 * @module zc/settlement/dns/admission
 */
import type { IgsMode } from "../../../types";
import { nowISO, businessDateJST } from "../../../types";
import {
  wouldExceedThrottle,
  IGS_DEFER_PRIORITY_THROTTLED,
  IGS_DEFER_PRIORITY_RINGFENCED,
} from "../igs_hold";

// ---------------------------------------------------------------------------
// IGS (HIGH_VALUE) admission control during a DNS_HOLD (igs_mode ring-fence).
// ---------------------------------------------------------------------------
/** Admission decision for a HIGH_VALUE (IGS) transfer during a DNS hold. */
export interface IgsAdmissionDecision {
  admit: boolean;
  igs_mode: IgsMode;
  reason_code?: string;
  /** When true the tx should be parked *and* enqueued on the priority Defer
   *  queue (fairness throttling), not just suspended. */
  defer?: boolean;
  /** The held JPY cycle gating this decision (for throttle accounting / Defer). */
  cycle_id?: string;
  /** Defer priority (lower = sooner); ring-fenced IGS sits behind throttled. */
  priority?: number;
}

/**
 * Decide whether a HIGH_VALUE (IGS) transfer may settle right now, given the
 * day's JPY DNS cycle state (docs/specs/20_method_design.md §2.4 類型B). IGS settles through the BOJ
 * rail, so it is gated by the JPY cycle's `igs_mode` while that cycle is held:
 *
 *   - no HOLD_ACTIVE cycle → admit (igs_mode NORMAL).
 *   - STOP (e.g. a manual holdDns, cause not identified) → halt ALL IGS.
 *   - RINGFENCED (Mode 1, cause identified) → admit only when neither leg is a
 *     hold-causing participant, so the defaulter's central-bank position cannot
 *     move while the cycle is held; a touched leg is **Deferred** to the last
 *     position of the priority queue (isolation is a deferral, not a rejection).
 *   - RINGFENCED_PLUS (Mode 2, recovery reserve computed) → as Mode 1, plus a
 *     per-participant `igs_throttle_budget` fairness gate: a non-causing payer
 *     that has already pushed its budget worth of IGS this hold has further IGS
 *     **Deferred** (priority queue + scheduled window), not rejected.
 *
 * `amount` is required for the Mode 2 throttle gate; when omitted, throttling is
 * skipped (a touched-leg block still applies). Returns the blocking `reason_code`
 * when `admit` is false, and `defer:true` when the block is a fairness deferral.
 */
export async function checkIgsAdmission(
  db: D1Database,
  payerBankId: string,
  payeeBankId: string,
  amount?: number,
  now: string = nowISO()
): Promise<IgsAdmissionDecision> {
  const today = businessDateJST(now);
  const hold = await db
    .prepare(
      `SELECT cycle_id, igs_mode, hold_causing_participants FROM DnsCycles
       WHERE business_date = ? AND currency = 'JPY' AND state = 'HOLD_ACTIVE'
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(today)
    .first<{ cycle_id: string; igs_mode: IgsMode; hold_causing_participants: string | null }>();
  if (!hold) return { admit: true, igs_mode: "NORMAL" };

  if (hold.igs_mode === "STOP") {
    return {
      admit: false,
      igs_mode: "STOP",
      reason_code: "DNS_HOLD_IGS_STOPPED",
      cycle_id: hold.cycle_id,
    };
  }

  if (hold.igs_mode === "RINGFENCED" || hold.igs_mode === "RINGFENCED_PLUS") {
    const cause: string[] = hold.hold_causing_participants
      ? (JSON.parse(hold.hold_causing_participants) as string[])
      : [];
    if (cause.includes(payerBankId) || cause.includes(payeeBankId)) {
      // Isolation is a *deferral*, on the same priority queue as the Mode-2
      // fairness throttle and last within it. Putting both on one queue is what
      // makes their relative order defined at all; leaving isolation off the
      // queue (park + per-minute rescan) left the two incomparable, and in
      // practice retried the transfer that cannot be admitted more eagerly than
      // the one that can.
      return {
        admit: false,
        igs_mode: hold.igs_mode,
        reason_code: "DNS_RINGFENCED",
        defer: true,
        cycle_id: hold.cycle_id,
        priority: IGS_DEFER_PRIORITY_RINGFENCED,
      };
    }

    // Mode 2 only: fairness throttle. A non-causing payer over its budget for
    // this hold is Deferred (queued + scheduled), not rejected — "公平性のため
    // igs_throttle_budget 超過分は Defer".
    if (
      hold.igs_mode === "RINGFENCED_PLUS" &&
      typeof amount === "number" &&
      (await wouldExceedThrottle(db, hold.cycle_id, payerBankId, amount))
    ) {
      return {
        admit: false,
        igs_mode: "RINGFENCED_PLUS",
        reason_code: "DNS_IGS_THROTTLED",
        defer: true,
        cycle_id: hold.cycle_id,
        priority: IGS_DEFER_PRIORITY_THROTTLED,
      };
    }

    return { admit: true, igs_mode: hold.igs_mode, cycle_id: hold.cycle_id };
  }

  return { admit: true, igs_mode: hold.igs_mode, cycle_id: hold.cycle_id };
}
