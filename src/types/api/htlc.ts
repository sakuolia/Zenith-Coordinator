/**
 * @file api/htlc.ts — HTLC and HTLC-Auth request types (create/claim/cross-chain,
 *       payer-side authorization, capture/void, whitelist).
 * @module types/api/htlc
 */
import type { Amount } from "../primitives";
import type { PurposeType } from "../states";

// POST /api/htlc/create
export interface HtlcCreateRequest {
  htlc_id: string;
  hashlock: string;
  timelock: string;
  amount: Amount;
  payer_bank_id: string;
  payer_account_hash: string;
  payee_bank_id: string;
  payee_account_hash: string;
  idempotency_key: string;
  /**
   * Cross-chain HTLC (テーマA): when present, the same `hashlock` also locks
   * an onchain escrow observed via `source` (Watcher: docs/specs/20_method_design.md §7.7). ZC holds no
   * onchain funds or secrets — it only records Watcher-signed observations.
   */
  cross_chain?: {
    /** Watcher `source` identifier for the onchain rail, e.g. `'ONCHAIN:ETH'`. */
    source: string;
    /**
     * RFC3339 inner timelock of the onchain escrow. Must be strictly before
     * `timelock` so the ZC-side outer timelock always expires last.
     */
    onchain_timelock: string;
    /**
     * Theme A confirmation depth: required confirmations
     * before a release observed at/after the inner timelock may settle
     * (reorg safety). Omitted or 0 = no gate.
     */
    min_confirmations?: number;
    /**
     * Watcher quorum (trust minimization): the number of *distinct Watcher
     * operators* that must independently attest the onchain release before it
     * settles. Defaults to 1 (a single Watcher — the legacy behaviour). Set to
     * N≥2 so no single Watcher key can settle a cross-chain leg on its own;
     * settlement is held in HTLC_ONCHAIN_PENDING until N distinct operators
     * have signed the same release.
     */
    min_watchers?: number;
  };
  /**
   * Theme C (programmability generalization): optional
   * `ConditionTemplate.template_id`. When present, this HTLC may
   * additionally be fulfilled via `POST /api/htlc/:htlc_id/claim-by-attestation`
   * with a signed Attestation against this template (verified_result='PASS'),
   * instead of (or in addition to) presenting the preimage.
   */
  condition_template_id?: string;
  /**
   * Programmability generalization (30_internal_design.md § 7): an AND/OR expression
   * tree over several whitelisted ConditionTemplates. When present, the HTLC is
   * fulfilled via `POST /api/htlc/:htlc_id/claim-by-conditions` once the
   * expression evaluates true against the set of PASS-attested templates. Shape:
   * `{template_id} | {op:'AND'|'OR', operands:[...]}` (see zc/condition_expr.ts).
   */
  condition_expr_json?: unknown;
  /**
   * Cross-chain finality classification (30_internal_design.md § 7): how the onchain
   * leg's confirmations are treated. PUBLIC ⇒ probabilistic finality (depth
   * matters); PRIVATE/PERMISSIONED ⇒ deterministic. Optional quantum-risk
   * metadata records the onchain proof's signature suite for auditability.
   */
  onchain_chain_class?: "PUBLIC" | "PRIVATE" | "PERMISSIONED";
  onchain_crypto_suite?: string;
  onchain_quantum_risk?: "VULNERABLE" | "RESISTANT" | "UNKNOWN";
  /**
   * Theme B (Agentic Commerce): optional delegated-authority mandate. When
   * present, ZC verifies at lock time that the HTLC's amount/lane fall within
   * the mandate's scope (and it is live); a breach cancels the contract before
   * any funds are reserved.
   */
  mandate_id?: string;
}

/** One signed attestation in a multi-condition HTLC claim. */
export interface HtlcConditionAttestationInput {
  template_id: string;
  statement_hash: string;
  verified_result: "PASS" | "FAIL";
  attester_key_id: string;
  nonce: string;
  occurred_at: string;
  signature: string;
}

// POST /api/htlc/:htlc_id/claim-by-conditions (AND/OR programmability)
export interface HtlcConditionsClaimRequest {
  htlc_id: string;
  /** One signed Attestation per template the claimant is presenting. */
  attestations: HtlcConditionAttestationInput[];
  idempotency_key: string;
}

// POST /api/htlc/:htlc_id/claim
export interface HtlcClaimRequest {
  htlc_id: string;
  preimage: string;
  idempotency_key: string;
}

// POST /api/htlc/:htlc_id/claim-by-attestation (テーマC)
export interface HtlcAttestClaimRequest {
  htlc_id: string;
  /** Must equal HtlcContracts.condition_template_id (CONDITION_TEMPLATE_NOT_SET / TEMPLATE_MISMATCH otherwise). */
  template_id: string;
  /** sha256 hex digest of the (off-ZC-held) statement payload. */
  statement_hash: string;
  verified_result: "PASS" | "FAIL";
  /** `KeyRegistry.key_id` of the claimed attester. */
  attester_key_id: string;
  nonce: string;
  /** RFC3339 timestamp claimed by the attester. */
  occurred_at: string;
  /** Base64 signature over `buildAttestationMessage(...)`. */
  signature: string;
  idempotency_key: string;
}

// POST /api/htlc/:htlc_id/cross-chain-lock (テーマA, Watcher-only)
export interface HtlcCrossChainLockRequest {
  htlc_id: string;
  /** Onchain escrow lock reference (e.g. tx hash) observed by the Watcher. */
  external_ref: string;
  /** `KeyRegistry.key_id` of the observing Watcher (owner_type EXTERNAL_RAIL|ATTESTER). */
  watcher_key_id: string;
  nonce: string;
  occurred_at: string;
  /** Base64 signature over `buildWatcherObservationPayload()`. */
  signature: string;
  idempotency_key: string;
}

// POST /api/htlc/:htlc_id/onchain-fulfillment (テーマA, Watcher-only)
export interface HtlcOnchainFulfillmentRequest {
  htlc_id: string;
  /** Onchain escrow release reference (e.g. tx hash) observed by the Watcher. */
  external_ref: string;
  /** Preimage revealed on the onchain escrow; must hash to `hashlock`. */
  preimage: string;
  /** `KeyRegistry.key_id` of the observing Watcher (owner_type EXTERNAL_RAIL|ATTESTER). */
  watcher_key_id: string;
  nonce: string;
  occurred_at: string;
  /** Base64 signature over `buildWatcherObservationPayload()`. */
  signature: string;
  /**
   * Theme A confirmation depth: how many confirmations the
   * Watcher attests for this onchain release. Required to be
   * `>= HtlcContracts.onchain_min_confirmations` when the release is observed
   * at/after the inner timelock. Omitted = 0 (legacy/unknown).
   */
  confirmations?: number;
  idempotency_key: string;
}

// ---------------------------------------------------------------------------
// HTLC Auth API
// ---------------------------------------------------------------------------

export interface HtlcAuthRequestInput {
  auth_id: string;
  payee_bank_id: string;
  payee_account_hash: string;
  payer_bank_id: string;
  payer_account_hash: string;
  amount: Amount;
  purpose?: PurposeType;
  description?: string;
  auth_expires_at: string;
  capture_expires_at: string;
  idempotency_key: string;
  /**
   * Theme F (給付行政 / benefits administration): required when the
   * matched `HtlcAuthWhitelist.eligibility_template_id` is set. A signed
   * Attestation proving the payer's eligibility for this benefit
   * (verified_result must be 'PASS'; ELIGIBILITY_NOT_ATTESTED otherwise).
   */
  eligibility_attestation?: {
    /** sha256 hex digest of the (off-ZC-held) eligibility statement payload. */
    statement_hash: string;
    verified_result: "PASS" | "FAIL";
    /** `KeyRegistry.key_id` of the claimed attester (e.g. a government registry). */
    attester_key_id: string;
    nonce: string;
    /** RFC3339 timestamp claimed by the attester. */
    occurred_at: string;
    /** Base64 signature over `buildAttestationMessage(...)`. */
    signature: string;
  };
}

export interface HtlcAuthApproveInput {
  idempotency_key: string;
}

export interface HtlcAuthDeclineInput {
  reason?: string;
  idempotency_key: string;
}

export interface HtlcCaptureRequest {
  idempotency_key: string;
}

export interface HtlcVoidRequest {
  reason?: string;
  idempotency_key: string;
}

export interface HtlcAuthWhitelistRegisterRequest {
  payee_bank_id: string;
  payee_account_hash: string;
  allowed_payer_bank_id?: string;
  max_amount?: number;
  allowed_purposes?: PurposeType[];
  description?: string;
  expires_at?: string;
  /**
   * Theme F (給付行政 / benefits administration): optional
   * `ConditionTemplate.template_id` (must start with `TPL-`) proving
   * payer eligibility. When set, `createAuthRequest()` requires a signed
   * PASS Attestation against this template (ELIGIBILITY_NOT_ATTESTED
   * otherwise).
   */
  eligibility_template_id?: string;
}
