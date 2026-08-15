/**
 * @file rows/lanes.ts — lane-specific row types (HTLC contracts, HTLC-Auth,
 *       GTID transactions/legs, RTP requests).
 * @module types/rows/lanes
 */
import type { HtlcState, GtidState, LegState, RtpState, HtlcAuthStatus } from "../states";

export interface HtlcContractRow {
  htlc_id: string;
  txid: string;
  state: HtlcState;
  hashlock: string;
  timelock: string;
  amount_value: number;
  payer_bank_id: string;
  payee_bank_id: string;
  secret_verified: number;
  authority_recheck_required: number;
  version: number;
  created_at: string;
  updated_at: string;
  /** Watcher `source` for the onchain escrow leg (テーマA), or null if not cross-chain. */
  cross_chain_source: string | null;
  /** RFC3339 inner timelock of the onchain escrow; must be before `timelock`. */
  onchain_timelock: string | null;
  /** External ref (e.g. tx hash) of the observed onchain escrow lock (CrossChainLocked). */
  onchain_lock_ref: string | null;
  /** SettlementProofRef JSON for the onchain escrow lock observation. */
  onchain_lock_proof_json: string | null;
  /** SettlementProofRef JSON for the onchain escrow release observation. */
  onchain_release_proof_json: string | null;
  /**
   * Optional `ConditionTemplate.template_id` (Theme C, programmability
   * generalization). When set, `claimHtlcByAttestation` may fulfill this HTLC
   * with a signed Attestation against this template instead of the preimage.
   */
  condition_template_id: string | null;
  /**
   * Theme A confirmation depth: required confirmations before
   * a release observed at/after `onchain_timelock` may settle. 0 = no gate.
   */
  onchain_min_confirmations: number;
  /**
   * Watcher quorum: number of distinct Watcher operators that must
   * independently attest the onchain release before it settles. 1 = legacy
   * single-Watcher behaviour; N≥2 means no single Watcher key can settle the
   * cross-chain leg alone.
   */
  onchain_min_watchers: number;
  /**
   * AND/OR expression tree (JSON) over whitelisted ConditionTemplates
   * (programmability generalization). NULL = preimage / single
   * template. Fulfilled via claimHtlcByConditions.
   */
  condition_expr_json: string | null;
  /**
   * Cross-chain finality classification + quantum-risk metadata.
   * chain_class: PUBLIC | PRIVATE | PERMISSIONED; finality_class:
   * PROBABILISTIC | DETERMINISTIC (derived); quantum_risk:
   * VULNERABLE | RESISTANT | UNKNOWN.
   */
  onchain_chain_class: string | null;
  onchain_crypto_suite: string | null;
  onchain_quantum_risk: string | null;
  onchain_finality_class: string | null;
}

export interface GtidTransactionRow {
  gtid: string;
  state: GtidState;
  initiator_bank_id: string;
  total_amount: number;
  leg_count: number;
  /**
   * Display-only denormalization of GtidLegs.state counts. The settle decision
   * (`checkAndFinalizeGtid`) derives "all settled" from real leg/tx states, not
   * these columns — they exist for dashboard rendering. Snapshot-written at
   * GT_DECIDED_TO_SETTLE / GT_SETTLED, so stored values are accurate at
   * terminal transitions but may lag mid-flight. The single-GTID API
   * (`handleGetGtid`) overrides them with values derived from the loaded legs
   * to avoid any drift in the detail view.
   */
  legs_ready_count: number;
  legs_settled_count: number;
  expires_at: string | null;
  /** Theme B: delegated-authority mandate scoping the whole GT (NULL = none). */
  mandate_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface GtidLegRow {
  leg_id: string;
  gtid: string;
  txid: string | null;
  role: "PAYER" | "PAYEE";
  bank_id: string;
  account_hash: string;
  amount_value: number;
  /**
   * ISO 4217 currency code of this leg (Theme D, multi-currency support).
   * Defaults to 'JPY'. A PvP GTID has legs spanning more than one
   * currency, with per-currency balance checked independently.
   */
  leg_currency: string;
  state: LegState;
  /**
   * The leg_id the participant registered, when registration-time normalization
   * rewrote this leg (`20_method_design.md` §2.2.5.1). NULL when the leg is as
   * registered.
   */
  origin_leg_id: string | null;
  bank_proof_ref: string | null;
  expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RtpRequestRow {
  rtp_id: string;
  payee_bank_id: string;
  payer_bank_id: string;
  amount_value: number;
  state: RtpState;
  attempt_count: number;
  max_attempts: number;
  linked_txid: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface HtlcAuthWhitelistRow {
  whitelist_id: string;
  payee_bank_id: string;
  payee_account_hash: string;
  allowed_payer_bank_id: string | null;
  max_amount: number | null;
  allowed_purposes: string | null;
  description: string | null;
  is_active: number;
  registered_at: string;
  expires_at: string | null;
  /**
   * Theme F (給付行政 / benefits administration): optional `ConditionTemplate.template_id`
   * proving payer eligibility for this benefit. When set, `createAuthRequest()`
   * requires a signed PASS Attestation against this template
   * (ELIGIBILITY_NOT_ATTESTED otherwise).
   */
  eligibility_template_id: string | null;
}

export interface HtlcAuthRequestRow {
  auth_id: string;
  htlc_id: string | null;
  txid: string | null;
  status: HtlcAuthStatus;
  payee_bank_id: string;
  payee_account_hash: string;
  payer_bank_id: string;
  payer_account_hash: string;
  amount_value: number;
  purpose: string | null;
  description: string | null;
  auth_expires_at: string;
  capture_expires_at: string;
  vault_ref: string | null;
  hashlock: string | null;
  whitelist_id: string;
  approved_at: string | null;
  captured_at: string | null;
  voided_at: string | null;
  decline_reason: string | null;
  idempotency_key: string;
  version: number;
  created_at: string;
  updated_at: string;
  /**
   * Theme F (給付行政 / benefits administration): `Attestation.attestation_id`
   * that satisfied `HtlcAuthWhitelist.eligibility_template_id` for this
   * request, or NULL when the whitelist has no eligibility requirement.
   */
  eligibility_attestation_id: string | null;
}
