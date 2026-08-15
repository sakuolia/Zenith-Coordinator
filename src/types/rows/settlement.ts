/**
 * @file rows/settlement.ts — DNS netting, IGS defer/throttle, LSM run, and IGS
 *       request row types.
 * @module types/rows/settlement
 */
import type { DnsState, IgsMode, IgsStatus } from "../states";

export interface DnsCycleRow {
  cycle_id: string;
  business_date: string;
  state: DnsState;
  igs_mode: IgsMode;
  kicked_at: string | null;
  settled_at: string | null;
  hold_reason: string | null;
  net_positions: string | null;
  /**
   * JSON array of bank_ids whose BOJ shortfall caused a DNS_HOLD (the ring-fence
   * cause set, docs/specs/20_method_design.md §2.4 類型B). NULL = none / not a shortfall hold. Set by
   * settleDns on escalation to RINGFENCED; cleared when the cycle settles.
   */
  hold_causing_participants: string | null;
  /** ISO 4217 currency code; canonical identity component of a DNS cycle. Defaults to 'JPY'. */
  currency: string;
  /** Intraday sequence number (1-based); canonical identity component (docs/specs/20_method_design.md §9.4.2). Defaults to 1. */
  intraday_seq: number;
  /**
   * Settlement rail/chain for this cycle. NULL = JPY-classic BOJ-Net
   * current account ({bank}-BOJ). Non-JPY cycles pin a chain ('ETH'|'POLYGON'|…)
   * and settle on the tokenized central-bank deposit {bank}-CBT-{CCY}-{CHAIN}.
   */
  settlement_chain: string | null;
  /**
   * RINGFENCED_PLUS promotion evidence (docs/specs/20_method_design.md §2.4 類型B). The recovery reserve
   * ZC computed in real time for this hold, the digest of its inputs/formula/
   * output, and the confidence score that gated the RINGFENCED → RINGFENCED_PLUS
   * promotion. NULL until the cycle is promoted.
   */
  dns_recovery_reserve: number | null;
  reserve_explain_hash: string | null;
  reserve_confidence: number | null;
  /**
   * Official-disclosure template id while the cycle is held
   * (`DNS_HOLD_{business_date}`; NULL unless `state='HOLD_ACTIVE'`). This is the
   * join key between ZC's official status and the wording a participant is
   * permitted to show customers — without it, "customer messaging must match the
   * official disclosure" is unverifiable after the fact
   * (docs/specs/10_requirements.md §3.3.1-3/-4, docs/specs/20_method_design.md §9.4.4.2).
   */
  public_message_id: string | null;
  created_at: string;
}

/**
 * IgsDeferQueue row — a HIGH_VALUE (IGS) transfer blocked during a DNS hold and
 * re-injected with a priority + scheduled execution window rather than left to
 * the plain suspend→sweep path (docs/specs/20_method_design.md §2.4 類型B). One live row per txid.
 */
export interface IgsDeferRow {
  defer_id: string;
  txid: string;
  cycle_id: string;
  payer_bank_id: string;
  payee_bank_id: string;
  amount_value: number;
  reason_code: string;
  /** Lower = higher priority (re-injected first). */
  priority: number;
  /** ISO ts; eligible for re-injection at or after this time. */
  scheduled_execution_window: string;
  status: "DEFERRED" | "RESUMED" | "CANCELLED";
  enqueued_at: string;
  resumed_at: string | null;
}

/**
 * IgsThrottleState row — per (held cycle, participant) IGS admission budget
 * consumed during a hold (igs_throttle_budget fairness control, docs/specs/20_method_design.md §2.4 類型B).
 */
export interface IgsThrottleRow {
  cycle_id: string;
  bank_id: string;
  admitted_amount: number;
  admitted_count: number;
  updated_at: string;
}

/**
 * LsmRuns row — audit trail of one Bulk LSM optimiser run / fallback
 * (docs/specs/30_internal_design.md §14.2 / §14.3). Captures the input snapshot, constraint
 * digest, execution-set hash, trace digest, and objective metrics so the
 * adoption of an execution set is explainable and reproducible after the fact.
 */
export interface LsmRunRow {
  run_id: string;
  business_date: string;
  window_id: string;
  mode: "OPTIMIZED" | "FIFO" | "PRIORITY" | "THROTTLE";
  is_fallback: number;
  input_snapshot_id: string;
  constraints_digest: string;
  execution_set_hash: string;
  trace_digest: string;
  candidate_count: number;
  selected_count: number;
  deferred_count: number;
  objective_metrics: string;
  created_at: string;
}

export interface IgsRequestRow {
  ext_instruction_id: string;
  txid: string;
  payer_bank_id: string;
  payee_bank_id: string;
  amount_value: number;
  amount_currency: string;
  status: IgsStatus;
  boj_settle_ref: string | null;
  requested_at: string;
  settled_at: string | null;
  failed_reason: string | null;
  retry_count: number;
}
