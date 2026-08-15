// =============================================================================
// src/shared/constants.ts  system constants and configuration values
// =============================================================================
// Centrally managed to eliminate magic numbers and improve maintainability.
// Each module imports from here instead of hardcoding numeric values.
// =============================================================================

// ---------------------------------------------------------------------------
// FATF R.16 constants
// ---------------------------------------------------------------------------

/** FATF R.16 application threshold (JPY): equivalent to 1,000 USD */
export const FATF_THRESHOLD_JPY = 150_000;

/** Exchange rates: each currency → JPY conversion (JPY per one *major* unit) */
export const EXCHANGE_RATE_TO_JPY: Record<string, number> = {
  JPY: 1,
  USD: 150,
  EUR: 163,
  GBP: 190,
  CNY: 21,
  HKD: 19,
  SGD: 112,
  AUD: 98,
  CAD: 110,
  CHF: 170,
} as const;

/**
 * ISO 4217 minor-unit exponent for each currency in {@link EXCHANGE_RATE_TO_JPY}:
 * how many digits past the decimal point its smallest unit (e.g. cents)
 * represents. The codebase has no floating-point money (see zc/fx/rates.ts),
 * so a foreign-currency amount is always an integer count of its *minor* unit
 * — e.g. USD 100.50 is carried end-to-end as the integer `10050`, not the
 * float `100.5`. JPY's minor unit is the yen itself (0 decimal places).
 */
export const CURRENCY_DECIMAL_PLACES: Record<string, number> = {
  JPY: 0,
  USD: 2,
  EUR: 2,
  GBP: 2,
  CNY: 2,
  HKD: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
  CHF: 2,
} as const;

// ---------------------------------------------------------------------------
// Amount and count limits
// ---------------------------------------------------------------------------

/**
 * Upper bound for any single `amount.value` (minor units, any currency)
 * accepted at an ingress boundary. Chosen far above any plausible real
 * transaction (10x `BOJ_INITIAL_PREFUND`) but far below
 * `Number.MAX_SAFE_INTEGER`, so downstream aggregation (FX rate
 * multiplication, per-currency leg summation) never approaches float
 * precision loss. Not a business limit — `tx_amount_limit` /
 * `daily_amount_limit` / `hv_threshold` already govern real per-bank caps;
 * this is a sanity backstop against malformed/adversarial input.
 */
export const MAX_AMOUNT_VALUE = 1_000_000_000_000;

// ---------------------------------------------------------------------------
// HIGH_VALUE auto-escalation threshold (docs/specs/10_requirements.md §3.2.7)
// ---------------------------------------------------------------------------

/**
 * System-wide fallback for the HIGH_VALUE auto-escalation threshold (JPY): the
 * amount at or above which ZC rewrites an `EXPRESS`/`STANDARD` request's `lane`
 * to `HIGH_VALUE` at ingress (`zc/ingress/transfers.ts`). This is the last of
 * three levels ZC resolves in order — `Participants.hv_threshold` (per-bank)
 * → `env.ZC_HV_THRESHOLD` (system-wide override) → this constant.
 *
 * The institutional parameter is `PR-HV-THRESHOLD` (docs/specs/30_internal_design.md
 * §12.9); this is the technical default used when neither override is set.
 * Changing the effective threshold is a governed institutional act (four-eyes
 * approval, no self-service by a participant — §3.2.7), not a code change: the
 * per-bank and system-wide overrides above are how that governance takes
 * effect without redeploying this constant.
 */
export const DEFAULT_HV_THRESHOLD = 100_000_000;

// ---------------------------------------------------------------------------
// Rich data constants
// ---------------------------------------------------------------------------

/** Default retention period for rich data (days) */
export const RICHDATA_DEFAULT_RETENTION_DAYS = 365;

// ---------------------------------------------------------------------------
// Query freshness (docs/specs/30_internal_design.md §13.6)
// ---------------------------------------------------------------------------

/**
 * `freshness_level` thresholds, in milliseconds of **read-model lag**.
 *
 * The quantity measured is how far the derived view (`Transactions`) trails the
 * source of truth (`FinalityLog`) — *not* how long ago the transaction last
 * moved. Measuring the latter makes every normally completed transaction report
 * RED once it is a minute old, which is both meaningless as an indicator and
 * actively wrong at the counter (the RED template says "queries are congested").
 */
export const FRESHNESS_GREEN_MAX_MS = 10_000;
export const FRESHNESS_YELLOW_MAX_MS = 60_000;

// ---------------------------------------------------------------------------
// Record correction constants
// ---------------------------------------------------------------------------

/**
 * Time window for a MisrecordCorrected record correction (§13.4): a correction is
 * only permitted close to the erroneously recorded `a`, so a long-settled history
 * cannot be reopened under the guise of a "correction". 24 hours.
 */
export const MISRECORD_CORRECTION_WINDOW_SEC = 24 * 3600;

// ---------------------------------------------------------------------------
// DNS_HOLD igs_mode hierarchy (docs/specs/20_method_design.md docs/specs/20_method_design.md §2.4 類型B)
// ---------------------------------------------------------------------------

/**
 * Buffer rate applied on top of the outstanding BOJ shortfall when ZC computes
 * `dns_recovery_reserve`. The reserve is the liquidity the system should keep
 * available to complete the held cycle, with headroom for measurement error.
 * The institutional debate over the exact figure is out of scope; the *method*
 * (a deterministic, reproducible formula) is what the spec normatively fixes.
 */
export const DNS_RECOVERY_RESERVE_BUFFER_RATE = 0.1;

/**
 * Actions offered to a defaulting participant in the closed-domain hold detail
 * (docs/specs/20_method_design.md §9.4.4 (B)). They mirror the first two rungs of the
 * default waterfall — the defaulter's own collateral and self-help — because
 * those are the only rungs the defaulter itself can act on
 * (docs/specs/10_requirements.md §3.2.5.2).
 */
export const DNS_HOLD_RECOMMENDED_ACTIONS = [
  "MARKET_FUNDING",
  "LENDING_REQUEST",
  "COLLATERAL_PLEDGE",
] as const;

/**
 * Emergency contact route published with the hold detail. A constant rather
 * than free text so the crisis desk cannot be reached through a channel nobody
 * agreed on in advance (docs/specs/10_requirements.md §3.3.1-1).
 */
export const DNS_HOLD_CONTACT_CHANNEL = "ZC-OPS-CRISIS-DESK";

/**
 * Minimum `reserve_confidence` required to promote RINGFENCED → RINGFENCED_PLUS.
 * Below this, the reserve estimate is too uncertain to justify the stricter
 * (but more permissive for non-causing banks) Mode 2 admission, so the cycle
 * stays in RINGFENCED.
 */
export const RESERVE_CONFIDENCE_THRESHOLD = 0.8;

/**
 * Per-participant IGS admission budget (gross JPY) consumed while a cycle is held
 * in RINGFENCED_PLUS. A participant that has already pushed this much IGS during
 * the hold has its further IGS Deferred (not rejected) for fairness, so scarce
 * recovery-phase liquidity is not monopolised by one bank.
 */
export const IGS_THROTTLE_BUDGET_JPY = 5_000_000_000;

/** Re-injection delay applied to a Deferred IGS (seconds). */
export const IGS_DEFER_WINDOW_SEC = 60;

// ---------------------------------------------------------------------------
// CASE SLA (docs/specs/20_method_design.md §10.7.4 / §10.10.2)
// ---------------------------------------------------------------------------

/**
 * Default time a CASE may sit in OPEN / IN_PROGRESS before the sweep escalates
 * it to ESCALATED — the "Auto-Progress → Manual-Only" promotion of §10.7.4.
 *
 * The norm has always required this ("`next_action_hint=WAIT` のみで一定期間推移
 * しない場合、Auto-Progress→Manual-Only へ昇格する"), but `Cases` had no deadline
 * column, so nothing could evaluate it: every CASE waited forever and the
 * promotion existed only on paper. The institutional value is `PR-CASE-SLA`
 * (docs/specs/30_internal_design.md §12.9); this is the technical default used when a
 * caller does not supply one.
 */
export const CASE_SLA_SEC = 24 * 3600;

/**
 * Distinct transactions bound to one aggregated CASE past which a CASE already
 * in ESCALATED gets a *second* notification (docs/specs/20_method_design.md §10.7.2.2).
 *
 * §10.7.2.1's de-duplication treats ESCALATED as unresolved, so while a person
 * holds a CASE every further occurrence of the same cause is folded into it and
 * §10.7.4's auto-close leaves it alone. Both are right, and together they have
 * a blind spot: once a person is queued, the cause growing from ten
 * transactions to ten thousand changes neither the CASE count nor any state, so
 * nothing tells anyone the blast radius grew. This threshold is what breaks the
 * silence. It is a guide to how many transactions one handler can hold in view
 * at once, not a capacity limit — tune it against operational experience.
 */
export const CASE_SECONDARY_ESCALATION_COUNT = 100;

// ---------------------------------------------------------------------------
// Bulk LSM optimiser (docs/specs/30_internal_design.md 第14章)
// ---------------------------------------------------------------------------

/**
 * Fairness weight for the lexicographic LSM objective: a candidate's effective
 * priority is improved by `floor(waited_seconds / IGS...)`. Wait time is scored
 * in buckets of this many seconds so a long-waiting tx is preferred over a fresh
 * one of equal due-time (§14.1 #2 飢餓防止).
 */
export const LSM_FAIRNESS_BUCKET_SEC = 60;

// ---------------------------------------------------------------------------
// BOJ prefunding constants
// ---------------------------------------------------------------------------

/** Initial prefunding amount (JPY): 100 billion yen */
export const BOJ_INITIAL_PREFUND = 100_000_000_000;
