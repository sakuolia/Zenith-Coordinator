/**
 * @file api/transfers.ts — ZC Core transfer/GTID/RTP/query request & response types.
 * @module types/api/transfers
 */
import type { Amount, BankProofRef, FatfR16Data } from "../primitives";
import type { CaseState, IgsStatus, LaneType, ProxyType, PurposeType, TxState } from "../states";

/** POST /api/transfers — Payment initiation request (all lanes). */
export interface PaymentInitiatedRequest {
  schema_version: string;
  message_type: "EVENT";
  name: "PaymentInitiated";
  message_id: string;
  idempotency_key: string;
  occurred_at: string;
  txid: string;
  lane: LaneType;
  amount: Amount;
  payer: { bank_id: string; account_hash: string; vault_ref?: string };
  payee: { bank_id: string; account_hash?: string; vault_ref?: string };
  purpose: PurposeType;
  pspr_ref?: string;
  expires_at?: string;
  proxy_type?: ProxyType;
  proxy_value?: string;
  is_cross_border?: number | boolean;
  fatf_data?: FatfR16Data;
  qr_ref?: string;
  /**
   * Optional Mandate reference (delegation chain, Theme B / Agentic Commerce).
   * When present, EXPRESS/STANDARD precheck resolves it via `assertMandateValid`
   * and routes amount/purpose/lane/expiry/revocation breaches to
   * PRECHECKED_SUSPENDED + a Case instead of hard-rejecting.
   */
  mandate_id?: string;
}

// POST /api/gtid/register
export interface GtidRegisterRequest {
  gtid: string;
  legs: GtidLegInput[];
  expires_at?: string;
  idempotency_key: string;
  /**
   * Theme B (Agentic Commerce): optional delegated-authority mandate for the
   * coordinated transfer as a whole. advanceGtid verifies the GT's total PAYER
   * amount and lane='GTID' fall within scope at GT_PRECHECKED; a breach cancels
   * the GTID before any leg settles.
   */
  mandate_id?: string;
}

export interface GtidLegInput {
  leg_id: string;
  role: "PAYER" | "PAYEE";
  bank_id: string;
  account_hash: string;
  amount: Amount;
  /**
   * Set by registration-time normalization when it rewrote this leg's id
   * (`20_method_design.md` §2.2.5.1): the leg_id the participant actually
   * registered. Absent on legs that were left as registered. Callers do not
   * send this — it is produced by `normalizeGtidLegs`.
   */
  origin_leg_id?: string;
}

// POST /api/rtp/request
export interface RtpRequestInput {
  rtp_id: string;
  payee_bank_id: string;
  payer_bank_id: string;
  amount: Amount;
  expires_at: string;
  idempotency_key: string;
  payee_name?: string;
  description?: string;
  payee_account?: string;
}

// POST /api/transfers/:txid/authorize
export interface TransferAuthorizeRequest {
  txid: string;
  authorized: boolean;
  idempotency_key: string;
}

// POST /api/transfers/:txid/cancel
export interface TransferCancelRequest {
  txid: string;
  reason_code: string;
  idempotency_key: string;
}

// GET /api/transactions/:txid
export interface QueryResponse {
  txid: string;
  state: TxState;
  reason_code?: string;
  decision: {
    status: "NONE" | "DECIDED_TO_SETTLE" | "DECIDED_CANCEL";
    decision_proof_ref?: string;
  };
  execution: {
    a: "NONE" | "OK" | "NG";
    b: "NONE" | "OK" | "NG";
    payer_bank_proof_ref?: BankProofRef;
    payee_bank_proof_ref?: BankProofRef;
  };
  case?: { case_id?: string; status?: CaseState };
  as_of: string;
  watermark: number;
  /**
   * Per-chain breakdown of `watermark` (docs/specs/30_internal_design.md §13.6):
   * `{ shards: { "TX:<txid>": 42, "GT:<gtid>": 77 } }`. `watermark` alone cannot
   * make an aggregate reproducible — a GTID leg's decision lives on the GT chain,
   * not the leg's — so audit reads the breakdown and the counter reads the
   * number. Built by `src/zc/finality/watermark.ts`.
   */
  watermark_detail: { shards: Record<string, number> };
  freshness_level: "GREEN" | "YELLOW" | "RED";
  next_action_hint: "WAIT" | "RETRY_LATER" | "CONTACT_PAYER_BANK" | "OPEN_CASE";
  next_retry_at: string | null;
  /**
   * Pre-approved disclosure template id, present only while a settlement cycle
   * touching this transaction is held. The participant keys its customer wording
   * to this id; ZC never renders customer text itself
   * (docs/specs/20_method_design.md §9.4.4.1, docs/specs/10_requirements.md §3.3.1-4).
   */
  public_message_id?: string;
  /**
   * Informational only, and only for ordinary lanes: the interbank net cycle is
   * held while this transaction is already complete. It must never be rendered
   * as "the transaction is incomplete" (docs/specs/20_method_design.md §9.4.4.1 (B)).
   */
  dns_settlement_status?: "HOLD_ACTIVE";
  /**
   * The central-bank settlement leg's own outcome, for HIGH_VALUE transactions
   * that reached it.
   *
   * The transaction's state `reason_code` is `IGS_FAILED` whether the central
   * bank returned HOLD (a temporary liquidity shortfall, resolvable by retry) or
   * FAILED (it will not complete) — one label for two situations that demand
   * *opposite* explanations at the counter. Until this field existed the only
   * way to tell them apart was the presence of `public_message_id`, an
   * inference from an unrelated fact (docs/specs/20_method_design.md §9.4.4.1).
   *
   * `retriable` is derived here rather than left to each participant: the
   * mapping from settlement status to "does waiting help" is a scheme rule, and
   * eight participants deriving it independently is eight chances to get the
   * crisis-time answer wrong.
   *
   * The central bank's raw failure text is deliberately **not** carried. It can
   * name a counterparty's shortfall, which §9.4.4 keeps to the closed domain.
   */
  external_settlement?: {
    status: IgsStatus;
    retriable: boolean;
  };
}

// POST /api/participants/register
export interface ParticipantRegisterRequest {
  bank_id: string;
  bank_name: string;
  ingress_base_url: string;
  h_limit: number;
}

// POST /api/pspr/register
export interface PsprRegisterRequest {
  pspr_ref: string;
  payee_bank_id: string;
  account_hash: string;
  expires_at: string;
}
