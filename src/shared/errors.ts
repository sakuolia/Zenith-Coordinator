/**
 * @file errors.ts — Structured error system for the Zenith Coordinator.
 *
 * Single source of truth for error categories, HTTP status mapping, and
 * retry semantics. Design rationale (the anti-patterns it replaces) lives in
 * docs/specs/30_internal_design.md § 2.
 *
 * # Usage
 *
 * ```ts
 * // Raise a typed domain error
 * throw new DomainError('H_LIMIT_EXCEEDED', 'H reservation exceeds participant limit', {
 *   bank_id, txid, requested: amount, available: remaining,
 * })
 *
 * // Inside an HTTP handler, convert to a Response
 * try {
 *   await processExpress(req, env)
 * } catch (e) {
 *   return errorResponse(e)
 * }
 * ```
 *
 * Every reason_code is documented in `docs/specs/32_api_contracts.md` (Error Catalog).
 */

// ---------------------------------------------------------------------------
// Error category & retry semantics
// ---------------------------------------------------------------------------

/**
 * Error category. Drives HTTP status mapping and queue retry decisions.
 *
 * - VALIDATION: bad input (400). Never retry.
 * - AUTH:       missing/invalid credential (401/403). Never retry.
 * - NOT_FOUND:  target resource absent (404). Never retry.
 * - CONFLICT:   state guard / optimistic-lock conflict (409). Caller should re-read state.
 * - INVARIANT:  internal consistency violation (500). Bug; do not retry blindly.
 * - DOWNSTREAM: bank / IGS / external call failed transiently (502/503). Retry safe.
 * - TIMEOUT:    downstream did not respond in time (504). Retry safe.
 * - RATE_LIMIT: too many requests (429). Retry with backoff.
 * - INTERNAL:   uncategorized (500). Default for unknown throws.
 */
export type ErrorCategory =
  | "VALIDATION"
  | "AUTH"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVARIANT"
  | "DOWNSTREAM"
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "INTERNAL";

/** Whether the queue consumer should retry on this category. */
export function isRetryable(category: ErrorCategory): boolean {
  return category === "DOWNSTREAM" || category === "TIMEOUT" || category === "RATE_LIMIT";
}

/** HTTP status mapping. */
export function httpStatusOf(category: ErrorCategory): number {
  switch (category) {
    case "VALIDATION":
      return 400;
    case "AUTH":
      return 401;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "RATE_LIMIT":
      return 429;
    case "TIMEOUT":
      return 504;
    case "DOWNSTREAM":
      return 502;
    case "INVARIANT":
      return 500;
    case "INTERNAL":
      return 500;
  }
}

// ---------------------------------------------------------------------------
// Reason code catalog
// ---------------------------------------------------------------------------

/**
 * Canonical reason_code → category mapping.
 *
 * Mirrors the Error Catalog in `docs/specs/32_api_contracts.md`. Any new code added
 * to a lane / handler MUST be registered here so HTTP status, retry policy,
 * and the public spec stay in sync.
 */
export const REASON_CODE_CATEGORY: Record<string, ErrorCategory> = {
  // ----- Validation
  INVALID_REQUEST: "VALIDATION",
  MISSING_FIELD: "VALIDATION",
  INVALID_AMOUNT: "VALIDATION",
  INVALID_CURRENCY: "VALIDATION",
  INVALID_LANE: "VALIDATION",
  INVALID_STATE: "VALIDATION",
  INVALID_PROXY_TYPE: "VALIDATION",
  FATF_R16_VIOLATION: "VALIDATION",
  PREIMAGE_MISMATCH: "VALIDATION",
  EXPIRED: "VALIDATION",

  // ----- Authentication / authorization
  UNAUTHORIZED: "AUTH",
  INVALID_HMAC: "AUTH",
  WHITELIST_REJECTED: "AUTH",
  ACCOUNT_FROZEN: "AUTH",

  // ----- Continuous collection (direct debit)
  //
  // BUDGET_RATE_EXCEEDED and BUDGET_EXHAUSTED are deliberately distinct: the
  // first is a throttle that reopens when the window rolls, the second is the
  // contract reaching its declared total, which ends it. Collapsing them would
  // tell a finished customer to wait for a window that never reopens.
  CHARGE_REF_INVALID: "VALIDATION",
  CAP_EXCEEDS_POLICY: "VALIDATION",
  NOTICE_PERIOD_TOO_SHORT: "VALIDATION",
  LADDER_MAX_EXCEEDED: "VALIDATION",
  LADDER_RUNG_CANNOT_BE_REALTIME: "VALIDATION",
  LATEFEE_EXCEEDS_POLICY: "VALIDATION",
  SIGNATURE_REQUIRED_FOR_RAISE: "AUTH",
  REALTIME_NOT_PERMITTED: "AUTH",
  DD_MANDATE_NOT_FOUND: "NOT_FOUND",
  COLLECTION_NOT_FOUND: "NOT_FOUND",
  CHARGE_REF_ALREADY_COLLECTED: "CONFLICT",
  BUDGET_RATE_EXCEEDED: "CONFLICT",
  BUDGET_EXHAUSTED: "CONFLICT",
  FROZEN_UNFAVOURABLE_CHANGE: "CONFLICT",
  MODE_UNSUPPORTED_BY_PAYER_BANK: "CONFLICT",

  // ----- Not found
  TX_NOT_FOUND: "NOT_FOUND",
  HTLC_NOT_FOUND: "NOT_FOUND",
  GTID_NOT_FOUND: "NOT_FOUND",
  RTP_NOT_FOUND: "NOT_FOUND",
  ACCOUNT_NOT_FOUND: "NOT_FOUND",
  PROXY_NOT_FOUND: "NOT_FOUND",
  PARTICIPANT_NOT_FOUND: "NOT_FOUND",

  // ----- Conflict (state machine / optimistic lock)
  CONCURRENCY_CONFLICT: "CONFLICT",
  STATE_GUARD: "CONFLICT",
  IDEMPOTENCY_REPLAY: "CONFLICT",
  ALREADY_PROCESSED: "CONFLICT",
  IDEMPOTENCY_KEY_CONFLICT: "CONFLICT",

  // ----- Settlement / domain
  H_LIMIT_EXCEEDED: "CONFLICT",
  RESERVE_FAILED: "CONFLICT",
  AUTHORITY_CHECK_NG: "CONFLICT",
  NAME_MISMATCH: "CONFLICT",
  CIRCUIT_OPEN: "CONFLICT",

  // ----- Downstream / infrastructure
  BANK_ERROR: "DOWNSTREAM",
  BANK_TIMEOUT: "TIMEOUT",
  IGS_ERROR: "DOWNSTREAM",
  ALS_LOOKUP_FAILED: "DOWNSTREAM",
  RATE_LIMITED: "RATE_LIMIT",
  // A concurrent duplicate of the same idempotency key is still being
  // processed by another in-flight call (src/bank/legacy/adapter.ts). Self-
  // resolving once that call completes, so DOWNSTREAM (retryable) rather than
  // CONFLICT — the caller should not have to re-read state, just retry.
  LEGACY_ADAPTER_REQUEST_IN_FLIGHT: "DOWNSTREAM",

  // ----- Invariant violations (these indicate bugs)
  CHAIN_TAMPERED: "INVARIANT",
  LEDGER_IMBALANCE: "INVARIANT",
  IMPOSSIBLE_TRANSITION: "INVARIANT",
  INVARIANT_VIOLATION: "INVARIANT",
  // 単一所有者則 (single-owner rule, docs/specs/30_internal_design.md §5 単一所有者則): a state
  // transition was issued by a party that does not own the row. Same severity
  // and HTTP mapping as INVARIANT_VIOLATION — thrown unconditionally, never
  // downgraded by `strict:false`.
  OWNERSHIP_VIOLATION: "INVARIANT",

  // ----- External signature verification (KeyRegistry)
  KEY_NOT_FOUND: "NOT_FOUND",
  KEY_REVOKED: "AUTH",
  KEY_EXPIRED: "AUTH",
  EXTERNAL_SIGNATURE_INVALID: "AUTH",
  SIGNATURE_REPLAYED: "CONFLICT",
  TIMESTAMP_SKEW: "VALIDATION",

  // ----- Attestation (ConditionTemplate)
  TEMPLATE_NOT_WHITELISTED: "AUTH",
  ATTESTER_UNAUTHORIZED: "AUTH",
  ATTESTATION_INVALID: "VALIDATION",
  ATTESTATION_EXPIRED: "VALIDATION",

  // ----- Mandate
  MANDATE_NOT_FOUND: "NOT_FOUND",
  MANDATE_BREACH: "AUTH",
  MANDATE_EXPIRED: "AUTH",
  MANDATE_REVOKED: "AUTH",

  // ----- ZC egress asymmetric signing
  ZC_SIGNING_NOT_CONFIGURED: "INTERNAL", // misconfiguration: no signing key present
  ZC_SIGNATURE_WRONG_OWNER: "AUTH", // signature verified but key is not owner_type='ZC'

  // ----- Watcher
  WATCHER_UNAUTHORIZED: "AUTH",
  // Two distinct Watchers contradict each other about the same external event
  // (different proof_type/venue). Not a bug in ZC — Byzantine behaviour on the
  // rail — so it converges into a CASE rather than retrying.
  WATCHER_EQUIVOCATION: "CONFLICT",

  // ----- Cross-chain HTLC
  ONCHAIN_TIMELOCK_INVALID: "VALIDATION",
  ONCHAIN_CHAIN_CLASS_REQUIRED: "VALIDATION",
  NOT_CROSS_CHAIN: "VALIDATION",
  ONCHAIN_PROOF_MISMATCH: "VALIDATION",
  ONCHAIN_TIMEOUT: "VALIDATION",
  ONCHAIN_INSUFFICIENT_CONFIRMATIONS: "VALIDATION",

  // ----- Transparency anchoring / co-signing
  ANCHOR_NOT_FOUND: "NOT_FOUND",
  CHAIN_NOT_ANCHORED: "NOT_FOUND",
  COSIGN_ENTRY_NOT_FOUND: "NOT_FOUND",
  COSIGN_BASIS_NOT_FOUND: "NOT_FOUND",
  COSIGN_PARTICIPANT_MISMATCH: "AUTH",
  COSIGN_NOT_APPLICABLE: "VALIDATION",

  // ----- System mode / degradation (read-only). DOWNSTREAM = transient +
  // retryable: the queue holds in-flight work and replays it once the system
  // returns to NORMAL, rather than acking (dropping) money movement.
  SYSTEM_BCP_READ_ONLY: "DOWNSTREAM",
  SYSTEM_QUORUM_LOSS_READ_ONLY: "DOWNSTREAM",

  // ----- HTLC condition-template fulfillment
  CONDITION_TEMPLATE_NOT_SET: "VALIDATION",
  TEMPLATE_MISMATCH: "VALIDATION",
  ATTESTATION_NOT_PASS: "VALIDATION",
  // Thrown as a DomainError by lanes/htlc/create.ts when condition_expr_json is
  // malformed. Without an entry here categoryOf() falls back to INTERNAL, so a
  // client's malformed expression surfaced as 500 (and the queue treated it as a
  // non-retryable bug) instead of the documented 400 VALIDATION.
  CONDITION_EXPR_INVALID: "VALIDATION",
  CONDITION_EXPR_NOT_SET: "VALIDATION",
  // "Not yet satisfied" gates, mirroring ONCHAIN_INSUFFICIENT_CONFIRMATIONS:
  // the request is well-formed, the condition simply is not met yet.
  CONDITIONS_NOT_MET: "VALIDATION",
  ONCHAIN_QUORUM_PENDING: "VALIDATION",
  // Contradictory statements about the same subject. CONFLICT, symmetric with
  // WATCHER_EQUIVOCATION — both are fail-closed and converge to a CASE.
  ATTESTATION_EQUIVOCATION: "CONFLICT",

  // ----- Operating window
  COUNTERPARTY_WINDOW_CLOSED: "CONFLICT",

  // ----- Benefit administration
  ELIGIBILITY_NOT_ATTESTED: "AUTH",
  PURPOSE_VIOLATION: "AUTH",

  // ----- Money-not-held / settlement proof trust
  PROOF_SOURCE_UNTRUSTED: "AUTH",

  // ----- Cross-currency FX (docs/specs/30_internal_design.md)
  FX_NO_ROUTE: "CONFLICT", // no FXP quote prices this pair/amount in band
  FX_QUOTE_EXPIRED: "CONFLICT", // accepted quote lapsed before execution
  FX_ALREADY_REFUNDED: "CONFLICT", // the FX transfer was already refunded; claim is closed
  FX_CLAIM_WINDOW_EXPIRED: "CONFLICT", // too little time left to the upstream timelock to settle
  FX_RATE_MISMATCH: "VALIDATION", // leg amounts inconsistent with the quoted rate
  FX_ROUTE_INCONSISTENT: "VALIDATION", // legs do not form a connected from→to chain
  FX_LIQUIDITY_INSUFFICIENT: "CONFLICT", // an FXP lacks per-currency liquidity to lock a leg
  INVALID_FX_RATE: "VALIDATION", // malformed/non-positive rate on a quote
  FX_FXP_ACCOUNT_MISSING: "VALIDATION", // no settlement account supplied for an FXP currency leg
};

/** Resolve the category of a reason_code; defaults to INTERNAL when unknown. */
export function categoryOf(reasonCode: string): ErrorCategory {
  return REASON_CODE_CATEGORY[reasonCode] ?? "INTERNAL";
}

// ---------------------------------------------------------------------------
// DomainError class
// ---------------------------------------------------------------------------

/**
 * Typed domain error. Carries:
 *  - reason_code: machine-readable code (see REASON_CODE_CATEGORY).
 *  - category:    derived from the code; controls HTTP status + retry policy.
 *  - details:     structured context (txid, bank_id, amounts, etc.) — never PII.
 *
 * Throwing `DomainError` is preferred over `throw new Error(...)` because the
 * top-level handlers can render a consistent JSON response and the queue
 * consumer can decide retry vs ack.
 */
export class DomainError extends Error {
  readonly reason_code: string;
  readonly category: ErrorCategory;
  readonly details: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(
    reason_code: string,
    message: string,
    details: Record<string, unknown> = {},
    options: { cause?: unknown; category?: ErrorCategory } = {}
  ) {
    super(message);
    this.name = "DomainError";
    this.reason_code = reason_code;
    this.category = options.category ?? categoryOf(reason_code);
    this.details = details;
    this.cause = options.cause;
  }

  toJSON(): {
    error: string;
    reason_code: string;
    category: ErrorCategory;
    details: Record<string, unknown>;
  } {
    return {
      error: this.message,
      reason_code: this.reason_code,
      category: this.category,
      details: this.details,
    };
  }
}

/** Type guard — narrows an unknown thrown value to DomainError. */
export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}

// ---------------------------------------------------------------------------
// HTTP rendering
// ---------------------------------------------------------------------------

/**
 * Render any thrown value into a JSON error Response.
 *
 * - DomainError → typed JSON with reason_code + category.
 * - other Error → 500 INTERNAL_ERROR with the error message.
 * - non-Error   → 500 INTERNAL_ERROR with String(e).
 *
 * Always includes a `request_id` field if provided (taken from the request
 * tracing context; see logger.ts).
 */
export function errorResponse(e: unknown, request_id?: string): Response {
  if (isDomainError(e)) {
    const status = httpStatusOf(e.category);
    const body = { ...e.toJSON(), request_id };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const msg = e instanceof Error ? e.message : String(e);
  const body = {
    error: msg,
    reason_code: "INTERNAL_ERROR",
    category: "INTERNAL" as ErrorCategory,
    details: {},
    request_id,
  };
  return new Response(JSON.stringify(body), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}
