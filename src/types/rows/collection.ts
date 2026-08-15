/**
 * @file rows/collection.ts — continuous collection (direct debit) row types.
 *
 * Three layers whose jobs do not overlap (docs/specs/10_requirements.md §3.2.8.1):
 *   DebitMandate + MandateBudget — who may collect from whom, for what, up to
 *                                  what limits
 *   ScheduledCollection + CollectionAttempt — when and how much, disclosed in
 *                                  advance, and what each attempt observed
 *   Transactions (lane='DIRECT_DEBIT') — the money movement itself
 *
 * @module types/rows/collection
 */

/** How a contract's charge items are identified and validated. */
export type ChargeMode = "PERIODIC" | "ITEMIZED";

/** Recurrence declared by a PERIODIC contract; NULL for ITEMIZED. */
export type PeriodCycle = "MONTHLY" | "YEARLY";

/**
 * Collection mode. Fixes when the result becomes final:
 *  - REALTIME  — the EXPRESS lane's contract. Synchronous through Decision
 *    (`DECISION_ACCEPTED`), a/b asynchronous. One attempt, so failure is final
 *    at Decision.
 *  - SCHEDULED / SCHEDULED_LONG — the core may retry through the debit date, so
 *    failure is not final until 24:00 of that date. They share one finality
 *    contract; SCHEDULED_LONG differs only in notice length (risk position).
 */
export type CollectionMode = "REALTIME" | "SCHEDULED" | "SCHEDULED_LONG";

/** What to do when a due date lands on a non-business day. */
export type NonBusinessDayRule = "FORWARD" | "BACKWARD" | "NEXT_BUSINESS";

export type DebitMandateState = "ACTIVE" | "EXHAUSTED" | "REVOKED";

/**
 * DebitMandate: the standing collection contract.
 *
 * Caps live here and nowhere else. They can change mid-contract (lowering needs
 * no customer signature, raising does), so a denormalised copy on the counter
 * row would drift into "the declared cap and the enforced cap disagree". The
 * budget CAS reads them back with a correlated subquery instead.
 */
export interface DebitMandateRow {
  dd_mandate_id: string;
  /** The customer-signed Mandate this contract rests on. */
  mandate_id: string;
  payer_bank_id: string;
  /** ALS/Proxy alias, never a raw account number — survives account changes. */
  payer_account_alias: string;
  payee_bank_id: string;
  payee_account_hash: string;
  /** Opaque scope key meaningful to customer and payee; ZC never interprets it. */
  product_ref: string;
  charge_mode: ChargeMode;
  period_cycle: PeriodCycle | null;
  collection_mode: CollectionMode;
  notice_days_min: number;
  /** Hours before the due date at which unfavourable amendments stop. */
  amend_freeze_hours: number;
  ladder_max: number;
  nonbusiness_day_rule: NonBusinessDayRule;
  // Caps. NULL = this budget does not constrain.
  per_collection_cap: number | null;
  month_amount_cap: number | null;
  month_count_cap: number | null;
  two_month_amount_cap: number | null;
  day_count_cap: number | null;
  lifetime_amount_cap: number | null;
  lifetime_count_cap: number | null;
  pending_amount_cap: number | null;
  pending_count_cap: number | null;
  latefee_month_cap: number | null;
  latefee_rate_max: number | null;
  realtime_month_count_cap: number | null;
  variance_ratio_max: number | null;
  eligibility_attestation_id: string | null;
  state: DebitMandateState;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

/**
 * MandateBudget: one row per contract holding every counter.
 *
 * Not keyed by (contract, window): a single collection consumes the monthly,
 * lifetime and pending budgets *at once*, so per-window rows would need an
 * atomic multi-row acquire and therefore a lock-ordering discipline. One row
 * makes the single-row CAS the serialisation point, the same idiom as
 * `transitionWithLog` and H reservations.
 *
 * Window rollover happens inside that same UPDATE via CASE expressions — a
 * separate reset job would race the reservation it is resetting.
 */
export interface MandateBudgetRow {
  dd_mandate_id: string;
  month_key: string;
  month_amount: number;
  month_count: number;
  prev_month_key: string | null;
  prev_month_amount: number;
  day_key: string;
  day_count: number;
  latefee_month_amount: number;
  realtime_month_count: number;
  /** Consuming budgets: never restored. Exhaustion ends the contract. */
  lifetime_amount: number;
  lifetime_count: number;
  /** Reserved-but-unconfirmed. Released when the collection confirms either way. */
  pending_amount: number;
  pending_count: number;
  last_amount: number | null;
  updated_at: string;
  version: number;
}

export type CollectionState =
  | "SCHEDULED"
  | "AWAITING_ADDITIONAL_AUTH"
  | "FROZEN"
  | "FIRED"
  | "DECLINED_BY_PAYER"
  | "LAPSED"
  | "WITHDRAWN"
  | "SUPERSEDED";

/** NULL while the outcome is still open. */
export type CollectionResult = "CONFIRMED_OK" | "CONFIRMED_NG";

/**
 * ScheduledCollection: the advance notice. Not a Transaction — only a rung that
 * fires on its due date materialises one.
 *
 * Ladder rungs are rows of this table sharing a `charge_ref`. At most one may
 * reach CONFIRMED_OK, enforced by the partial unique index
 * `uq_collection_charge_ok`; that single constraint is both the double-charge
 * guard and the ladder's mutual exclusion, because they are the same invariant.
 */
export interface ScheduledCollectionRow {
  collection_id: string;
  dd_mandate_id: string;
  /** Charge item, normalised. Shown to the customer verbatim. */
  charge_ref: string;
  ladder_seq: number;
  amount_value: number;
  /** Late-payment interest, kept separate from principal — never folded in. */
  latefee_value: number;
  amount_currency: string;
  due_date: string;
  /**
   * When failure becomes final. SCHEDULED* = 24:00 of the due date, REALTIME =
   * the Decision. The distinction is "can another attempt still happen", not
   * sync vs async — b is asynchronous in every mode.
   */
  confirm_deadline_at: string;
  /** REALTIME sets this to the creation instant: a zero-width window, not NULL. */
  amend_freeze_at: string;
  mode: CollectionMode;
  /** What the payee bank asked for, so a demotion can be explained. */
  requested_mode: CollectionMode;
  state: CollectionState;
  result: CollectionResult | null;
  reason_code: string | null;
  retriable_today: number;
  vault_ref: string | null;
  hashlock: string | null;
  /** One-shot additional authorisation granted by the customer. */
  extra_mandate_id: string | null;
  edi_ref: string | null;
  priority_hint: number | null;
  budget_reserved: number;
  txid: string | null;
  notified_at: string | null;
  frozen_at: string | null;
  fired_at: string | null;
  confirmed_at: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  version: number;
}

/**
 * CollectionAttempt: append-only observation series.
 *
 * The collection's current state is derived from this series plus whether the
 * deadline has passed. Intermediate results are not final, but they are what
 * lets a payee act while there is still time to act.
 */
export interface CollectionAttemptRow {
  attempt_id: string;
  collection_id: string;
  attempt_no: number;
  observed_at: string;
  result: "OK" | "NG";
  reason_code: string | null;
  retriable_today: number;
  bank_proof_ref: string | null;
  created_at: string;
}
