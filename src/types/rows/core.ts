/**
 * @file rows/core.ts — core ZC ledger/liquidity row types (participants,
 *       transactions, H reservations, idempotency, system mode).
 * @module types/rows/core
 */
import type { TxState, TxLane, PurposeType, SystemModeValue } from "../states";

/** Participants table: Banks registered with the Zenith Coordinator. */
export interface ParticipantRow {
  bank_id: string;
  bank_name: string;
  ingress_base_url: string;
  h_limit: number;
  /**
   * Materialized counter — NOT careless denormalization. The atomic
   * `UPDATE ... SET h_used = h_used + ? WHERE (h_used + ?) <= h_limit` form
   * is how the H-limit is enforced race-free; deriving via SUM(HReservations
   * WHERE is_released=0) would reopen a TOCTOU window between the SUM and the
   * insert. Reconcilable with that SUM at rest. See src/zc/liquidity/h_model.ts#reserveH.
   */
  h_used: number;
  /** 1 = active participant, 0 = suspended. */
  is_active: number;
  registered_at: string;
  /** Per-bank HIGH_VALUE auto-routing threshold (JPY). NULL = use system default. */
  hv_threshold: number | null;
  /**
   * Theme F (給付行政 / benefits administration): 'BANK' (default) | 'GOVERNMENT'.
   * A 'GOVERNMENT' participant is a benefit-issuing administrative agency
   * acting as an originating participant (給付発起参加者). Purely a
   * classification label — no behavioral branching in the lane state
   * machines depends on it.
   */
  participant_type: string;
}

/**
 * ParticipantCurrencyLimits table (Theme D, multi-currency support):
 * per-(bank_id, currency) H-limit/usage for non-JPY currencies. JPY continues
 * to use `ParticipantRow.h_limit`/`h_used`.
 */
export interface ParticipantCurrencyLimitRow {
  bank_id: string;
  currency: string;
  h_limit: number;
  h_used: number;
}

/** Transactions table: Core transaction record managed by the ZC orchestrator. */
export interface TransactionRow {
  txid: string;
  /** Column domain is wider than the API-facing LaneType — GTID legs land here. */
  lane: TxLane;
  state: TxState;
  amount_value: number;
  amount_currency: string;
  payer_bank_id: string;
  payer_account_hash: string;
  payee_bank_id: string;
  payee_account_hash: string | null;
  pspr_ref: string | null;
  purpose: PurposeType | null;
  idempotency_key: string;
  schema_version: string;
  h_reservation_id: string | null;
  decision_proof_ref: string | null;
  finality_log_ref: string | null;
  payer_bank_proof_ref: string | null;
  payee_bank_proof_ref: string | null;
  reason_code: string | null;
  case_id: string | null;
  dns_cycle_id: string | null;
  expires_at: string | null;
  /**
   * IGS/BOJ external settlement status for HIGH_VALUE lane.
   * NONE = not an HV tx; REQUESTED = IGS sent; SETTLED = BOJ confirmed;
   * FAILED = IGS failed (recoverable); HOLD = BOJ hold (awaiting retry).
   */
  external_settlement_status: string;
  /**
   * 単一所有者則 (single-owner rule, docs/specs/30_internal_design.md §5 単一所有者則): the one
   * party currently allowed to move this row.
   * 'ZC' | 'CYCLE:<cycle_id>' | 'VENUE:<venue_id>' | 'CHAIN:<watcher_set>'.
   * Handoffs are first-class FinalityLog events (OwnershipTransferred /
   * OwnershipReclaimed) and only change via src/zc/lanes/_helpers.ts.
   */
  owner: string;
  /** Optimistic lock counter — incremented on every state transition. */
  version: number;
  created_at: string;
  updated_at: string;
  /** Optional Mandate reference (Theme B, Agentic Commerce delegation chains), or null. */
  mandate_id: string | null;
}

/**
 * HReservations table: H-model liquidity reservations.
 * Each reservation locks a portion of a bank's h_limit.
 */
export interface HReservationRow {
  reservation_id: string;
  txid: string;
  bank_id: string;
  amount: number;
  /** RESERVED = standard hold, LOCKED = HTLC-reinforced hold. */
  mode: "RESERVED" | "LOCKED";
  /** 1 = reservation released (funds settled or cancelled). */
  is_released: number;
  created_at: string;
  released_at: string | null;
  /**
   * ISO 4217 currency code of the H capacity consumed (Theme D, multi-currency
   * support). 'JPY' reservations consume `Participants.h_limit`/`h_used`;
   * other currencies consume `ParticipantCurrencyLimits`.
   */
  currency: string;
}

export interface IdempotencyKeyRow {
  key: string;
  status: "PROCESSING" | "DONE";
  response_body: string | null;
  created_at: string;
  updated_at: string | null;
}

/**
 * SystemMode table: single-row (id=1) ZC-wide operational mode (テーマ H,
 * 可搬性と縮退 — portability and graceful degradation).
 */
export interface SystemModeRow {
  mode: SystemModeValue;
  reason: string | null;
  activated_at: string | null;
  updated_at: string;
}
