/**
 * @file Schema validation for ZC Ingress API payloads (Appendix E compliance).
 *
 * Each validator enforces the mandatory fields, format constraints, and
 * business rules defined in the spec. On failure it returns a structured
 * `reason_code` that is forwarded to the caller as-is.
 *
 * All validators are pure functions with no side effects.
 *
 * @module shared/validator
 */
import type {
  PaymentInitiatedRequest,
  HtlcCreateRequest,
  HtlcClaimRequest,
  HtlcAttestClaimRequest,
  HtlcCrossChainLockRequest,
  HtlcOnchainFulfillmentRequest,
  GtidRegisterRequest,
  RtpRequestInput,
  LaneType,
  PurposeType,
} from "../types";
import { MAX_AMOUNT_VALUE } from "./constants";

/** Result of a schema validation check. */
export interface ValidationResult {
  /** `true` if validation passed */
  ok: boolean;
  /** Machine-readable error code (e.g. `INVALID_AMOUNT`) */
  reason_code?: string;
  /** Human-readable explanation */
  message?: string;
}

const VALID_LANES: LaneType[] = [
  "EXPRESS",
  "STANDARD",
  "BULK",
  "DEFERRED",
  "RTP",
  "HTLC",
  "HIGH_VALUE",
];
const VALID_PURPOSES: PurposeType[] = ["MERCHANT", "P2P", "BILL", "SALARY", "REFUND"];

/**
 * Currencies accepted for GTID leg amounts (Theme D). A PvP GTID has legs
 * spanning more than one of these currencies.
 * Domestic single-currency lanes (validatePaymentInitiated) remain JPY-only
 * and are unaffected by this allowlist.
 */
const VALID_CURRENCIES = ["JPY", "USD", "EUR", "GBP", "CHF"];

function fail(reason_code: string, message: string): ValidationResult {
  return { ok: false, reason_code, message };
}

// ---------------------------------------------------------------------------
// PaymentInitiated (POST /api/transfers)
// ---------------------------------------------------------------------------

/**
 * Validate a payment initiation request (POST /api/transfers).
 *
 * Checks schema_version, txid format, lane, amount, payer/payee, and purpose.
 *
 * @param req - Partial request body to validate
 * @returns Validation result with reason_code on failure
 */
export function validatePaymentInitiated(req: Partial<PaymentInitiatedRequest>): ValidationResult {
  if (!req.schema_version || req.schema_version !== "1.0")
    return fail("INVALID_SCHEMA_VERSION", 'schema_version must be "1.0"');
  if (!req.txid || !/^TX-/.test(req.txid)) return fail("INVALID_TXID", "txid must start with TX-");
  if (!req.idempotency_key) return fail("MISSING_IDEMPOTENCY_KEY", "idempotency_key required");
  if (!req.lane || !VALID_LANES.includes(req.lane))
    return fail("INVALID_LANE", `lane must be one of ${VALID_LANES.join("|")}`);
  if (
    !req.amount ||
    typeof req.amount.value !== "number" ||
    req.amount.value <= 0 ||
    !Number.isInteger(req.amount.value) ||
    req.amount.value > MAX_AMOUNT_VALUE
  )
    return fail("INVALID_AMOUNT", `amount.value must be a positive integer <= ${MAX_AMOUNT_VALUE}`);
  if (!req.amount.currency || req.amount.currency !== "JPY")
    return fail("INVALID_CURRENCY", "amount.currency must be JPY");
  if (!req.payer?.bank_id || !req.payer?.account_hash)
    return fail("MISSING_PAYER", "payer.bank_id and payer.account_hash required");
  if (!req.payee?.bank_id) return fail("MISSING_PAYEE", "payee.bank_id required");
  if (!req.purpose || !VALID_PURPOSES.includes(req.purpose))
    return fail("INVALID_PURPOSE", `purpose must be one of ${VALID_PURPOSES.join("|")}`);
  if (req.mandate_id !== undefined && !/^MANDATE-/.test(req.mandate_id))
    return fail("INVALID_MANDATE_ID", "mandate_id must start with MANDATE-");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HtlcCreate (POST /api/htlc/create)
// ---------------------------------------------------------------------------

/**
 * Validate an HTLC creation request.
 *
 * Checks htlc_id format, optional hashlock hex, timelock date, amounts,
 * payer/payee accounts, and bank IDs.
 *
 * @param req - Partial request body to validate
 * @returns Validation result with reason_code on failure
 */
export function validateHtlcCreate(req: Partial<HtlcCreateRequest>): ValidationResult {
  if (!req.htlc_id || !/^HTLC-/.test(req.htlc_id))
    return fail("INVALID_HTLC_ID", "htlc_id must start with HTLC-");
  // hashlock allows an empty string (auto-generated on the server side)
  if (req.hashlock && !/^[0-9a-f]{64}$/.test(req.hashlock))
    return fail(
      "INVALID_HASHLOCK",
      "hashlock must be 64-char hex SHA256 or empty for auto-generation"
    );
  if (!req.timelock || Number.isNaN(Date.parse(req.timelock)))
    return fail("INVALID_TIMELOCK", "timelock must be RFC3339");
  if (!req.amount || req.amount.value <= 0 || req.amount.value > MAX_AMOUNT_VALUE)
    return fail("INVALID_AMOUNT", `amount.value must be positive and <= ${MAX_AMOUNT_VALUE}`);
  if (!req.payer_account_hash || req.payer_account_hash.length !== 10)
    return fail("INVALID_PAYER_ACCOUNT", "payer_account_hash must be 10-digit account number");
  if (!req.payee_account_hash || req.payee_account_hash.length !== 10)
    return fail("INVALID_PAYEE_ACCOUNT", "payee_account_hash must be 10-digit account number");
  if (!req.payer_bank_id || !req.payee_bank_id)
    return fail("MISSING_BANK_IDS", "payer_bank_id and payee_bank_id required");
  if (!req.idempotency_key) return fail("MISSING_IDEMPOTENCY_KEY", "idempotency_key required");
  if (req.cross_chain) {
    if (!req.cross_chain.source)
      return fail("INVALID_CROSS_CHAIN_SOURCE", "cross_chain.source required");
    if (
      !req.cross_chain.onchain_timelock ||
      Number.isNaN(Date.parse(req.cross_chain.onchain_timelock))
    )
      return fail("INVALID_TIMELOCK", "cross_chain.onchain_timelock must be RFC3339");
  }
  if (req.condition_template_id !== undefined && !/^TPL-/.test(req.condition_template_id))
    return fail("INVALID_TEMPLATE_ID", "condition_template_id must start with TPL-");
  // mandate_id format is enforced uniformly across every ingress that accepts it
  // (docs/specs/32_api_contracts.md states the MANDATE- prefix rule without restricting
  // it to a single lane). Mirrors the check in validatePaymentInitiated so
  // /api/htlc/create no longer silently accepts a malformed mandate_id.
  if (req.mandate_id !== undefined && !/^MANDATE-/.test(req.mandate_id))
    return fail("INVALID_MANDATE_ID", "mandate_id must start with MANDATE-");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HtlcClaim (POST /api/htlc/:htlc_id/claim)
// ---------------------------------------------------------------------------

/**
 * Validate an HTLC claim (preimage reveal) request.
 *
 * @param req - Partial request body to validate
 * @returns Validation result with reason_code on failure
 */
export function validateHtlcClaim(req: Partial<HtlcClaimRequest>): ValidationResult {
  if (!req.htlc_id) return fail("MISSING_HTLC_ID", "htlc_id required");
  if (!req.preimage || !/^[0-9a-f]+$/.test(req.preimage))
    return fail("INVALID_PREIMAGE", "preimage must be hex string");
  if (!req.idempotency_key) return fail("MISSING_IDEMPOTENCY_KEY", "idempotency_key required");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HtlcAttestClaim (POST /api/htlc/:htlc_id/claim-by-attestation, テーマC)
// ---------------------------------------------------------------------------

/**
 * Validate an HTLC fulfillment-by-attestation request (テーマC).
 *
 * @param req - Partial request body to validate
 * @returns Validation result with reason_code on failure
 */
export function validateHtlcAttestClaim(req: Partial<HtlcAttestClaimRequest>): ValidationResult {
  if (!req.htlc_id) return fail("MISSING_HTLC_ID", "htlc_id required");
  if (!req.template_id || !/^TPL-/.test(req.template_id))
    return fail("INVALID_TEMPLATE_ID", "template_id must start with TPL-");
  if (!req.statement_hash || !/^[0-9a-f]{64}$/.test(req.statement_hash))
    return fail("ATTESTATION_INVALID", "statement_hash must be a sha256 hex digest");
  if (req.verified_result !== "PASS" && req.verified_result !== "FAIL")
    return fail("ATTESTATION_INVALID", "verified_result must be PASS or FAIL");
  if (!req.attester_key_id) return fail("MISSING_FIELD", "attester_key_id required");
  if (!req.nonce) return fail("MISSING_FIELD", "nonce required");
  if (!req.occurred_at || Number.isNaN(Date.parse(req.occurred_at)))
    return fail("INVALID_TIMESTAMP", "occurred_at must be RFC3339");
  if (!req.signature) return fail("MISSING_FIELD", "signature required");
  if (!req.idempotency_key) return fail("MISSING_IDEMPOTENCY_KEY", "idempotency_key required");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HtlcCrossChainLock (POST /api/htlc/:htlc_id/cross-chain-lock, テーマA)
// ---------------------------------------------------------------------------

/**
 * Validate a Watcher-signed cross-chain HTLC lock observation.
 *
 * @param req - Partial request body to validate
 * @returns Validation result with reason_code on failure
 */
export function validateHtlcCrossChainLock(
  req: Partial<HtlcCrossChainLockRequest>
): ValidationResult {
  if (!req.htlc_id) return fail("MISSING_HTLC_ID", "htlc_id required");
  if (!req.external_ref) return fail("MISSING_FIELD", "external_ref required");
  if (!req.watcher_key_id) return fail("MISSING_FIELD", "watcher_key_id required");
  if (!req.nonce) return fail("MISSING_FIELD", "nonce required");
  if (!req.occurred_at || Number.isNaN(Date.parse(req.occurred_at)))
    return fail("INVALID_TIMESTAMP", "occurred_at must be RFC3339");
  if (!req.signature) return fail("MISSING_FIELD", "signature required");
  if (!req.idempotency_key) return fail("MISSING_IDEMPOTENCY_KEY", "idempotency_key required");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HtlcOnchainFulfillment (POST /api/htlc/:htlc_id/onchain-fulfillment, テーマA)
// ---------------------------------------------------------------------------

/**
 * Validate a Watcher-signed cross-chain HTLC release (preimage) observation.
 *
 * @param req - Partial request body to validate
 * @returns Validation result with reason_code on failure
 */
export function validateHtlcOnchainFulfillment(
  req: Partial<HtlcOnchainFulfillmentRequest>
): ValidationResult {
  if (!req.htlc_id) return fail("MISSING_HTLC_ID", "htlc_id required");
  if (!req.external_ref) return fail("MISSING_FIELD", "external_ref required");
  if (!req.preimage || !/^[0-9a-f]+$/.test(req.preimage))
    return fail("INVALID_PREIMAGE", "preimage must be hex string");
  if (!req.watcher_key_id) return fail("MISSING_FIELD", "watcher_key_id required");
  if (!req.nonce) return fail("MISSING_FIELD", "nonce required");
  if (!req.occurred_at || Number.isNaN(Date.parse(req.occurred_at)))
    return fail("INVALID_TIMESTAMP", "occurred_at must be RFC3339");
  if (!req.signature) return fail("MISSING_FIELD", "signature required");
  if (!req.idempotency_key) return fail("MISSING_IDEMPOTENCY_KEY", "idempotency_key required");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// GtidRegister (POST /api/gtid/register)
// ---------------------------------------------------------------------------

/**
 * Validate a GTID (coordinated multi-leg transaction) registration request.
 *
 * Ensures at least 2 legs are present and each leg has the required fields.
 *
 * @param req - Partial request body to validate
 * @returns Validation result with reason_code on failure
 */
export function validateGtidRegister(req: Partial<GtidRegisterRequest>): ValidationResult {
  if (!req.gtid || !/^GT-/.test(req.gtid)) return fail("INVALID_GTID", "gtid must start with GT-");
  if (!Array.isArray(req.legs) || req.legs.length < 2)
    return fail("INVALID_LEGS", "legs must have at least 2 entries");
  for (const leg of req.legs) {
    if (!leg.leg_id || !leg.role || !leg.bank_id || !leg.account_hash)
      return fail("INVALID_LEG", "each leg requires leg_id, role, bank_id, account_hash");
    if (!leg.amount || leg.amount.value <= 0 || leg.amount.value > MAX_AMOUNT_VALUE)
      return fail(
        "INVALID_LEG_AMOUNT",
        `each leg amount.value must be positive and <= ${MAX_AMOUNT_VALUE}`
      );
    if (leg.amount.currency && !VALID_CURRENCIES.includes(leg.amount.currency))
      return fail(
        "INVALID_CURRENCY",
        `leg.amount.currency must be one of ${VALID_CURRENCIES.join("|")}`
      );
  }
  if (!req.idempotency_key) return fail("MISSING_IDEMPOTENCY_KEY", "idempotency_key required");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// RtpRequest (POST /api/rtp/request)
// ---------------------------------------------------------------------------

/**
 * Validate a Request-to-Pay initiation request.
 *
 * @param req - Partial request body to validate
 * @returns Validation result with reason_code on failure
 */
export function validateRtpRequest(req: Partial<RtpRequestInput>): ValidationResult {
  if (!req.rtp_id || !/^RTP-/.test(req.rtp_id))
    return fail("INVALID_RTP_ID", "rtp_id must start with RTP-");
  if (!req.payee_bank_id || !req.payer_bank_id)
    return fail("MISSING_BANK_IDS", "payee_bank_id and payer_bank_id required");
  if (!req.amount || req.amount.value <= 0 || req.amount.value > MAX_AMOUNT_VALUE)
    return fail("INVALID_AMOUNT", `amount.value must be positive and <= ${MAX_AMOUNT_VALUE}`);
  if (!req.expires_at || Number.isNaN(Date.parse(req.expires_at)))
    return fail("INVALID_EXPIRES_AT", "expires_at must be RFC3339");
  if (!req.idempotency_key) return fail("MISSING_IDEMPOTENCY_KEY", "idempotency_key required");
  return { ok: true };
}

/**
 * Safely parse a JSON request body.
 *
 * @typeParam T - Expected shape of the parsed body
 * @param req - Incoming Request object
 * @returns Parsed body as `T`, or `null` if parsing fails
 */
export async function parseBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
