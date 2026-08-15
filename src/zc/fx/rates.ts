/**
 * @file FX rate arithmetic (integer fixed-point) for true cross-currency FX.
 *
 * Rates are **directional**: `rate(X→Y)` is how many units of Y one unit of X
 * converts to, scaled by {@link RATE_SCALE} (1e8) so the whole system stays in
 * integers (the codebase has no floating-point money). A currency pair's
 * bid/ask is simply the two directional rates `X→Y` and `Y→X`; an FXP spread
 * means `rate(X→Y)·rate(Y→X) < RATE_SCALE²`.
 *
 * ## Rounding (system-safe / FXP-favourable)
 * Conversions round so the scheme **never creates money**:
 *  - forward (payer-denominated): `floor` — payee receives no more than the rate
 *    yields; the sub-unit remainder accrues to the FXP.
 *  - backward (payee-denominated): `ceil` — payer pays at least enough to cover
 *    the target; the FXP is never short.
 * Both directions therefore round in the FXP's favour, which is the invariant
 * the per-currency zero-sum balance checks rely on (see docs/specs/20_method_design.md §3.1, §5).
 *
 * ## Precision
 * `amount × rate` can exceed `Number.MAX_SAFE_INTEGER` (e.g. 1e12 × 1e8 = 1e20),
 * so the multiply/divide is done in `BigInt` and only the final, in-range result
 * is narrowed back to `number` (asserted safe).
 *
 * @module zc/fx/rates
 */

/** Fixed-point scale for all FX rates: a stored `rate` of 1e8 means 1.0. */
export const RATE_SCALE = 100_000_000;

/** `RATE_SCALE` as BigInt, for the internal big-integer arithmetic. */
const RATE_SCALE_BIG = BigInt(RATE_SCALE);

/**
 * Narrow a BigInt result to a safe `number`, or throw — guards against silently
 * returning a lossy float for an out-of-range amount.
 */
function toSafeNumber(v: bigint, context: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`FX ${context} overflows safe integer range: ${v.toString()}`);
  }
  return Number(v);
}

/** Validate that a value is a non-negative safe integer (amount or rate). */
function assertNonNegInt(v: number, label: string): void {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new RangeError(`FX ${label} must be a non-negative safe integer, got ${v}`);
  }
}

/**
 * Forward conversion (payer-denominated): given `amountFrom` units of the source
 * currency and a directional `rate` (from→to, ×RATE_SCALE), return how many
 * units of the target currency the payee receives. Rounds **down** (FXP keeps
 * the sub-unit remainder).
 */
export function convertForward(amountFrom: number, rate: number): number {
  assertNonNegInt(amountFrom, "amountFrom");
  assertNonNegInt(rate, "rate");
  const product = BigInt(amountFrom) * BigInt(rate);
  return toSafeNumber(product / RATE_SCALE_BIG, "forward conversion"); // floor (both operands ≥ 0)
}

/**
 * Backward conversion (payee-denominated): given a desired `amountTo` in the
 * target currency and a directional `rate` (from→to, ×RATE_SCALE), return the
 * minimum units of the source currency the payer must pay. Rounds **up** so the
 * FXP is never short.
 */
export function convertBackward(amountTo: number, rate: number): number {
  assertNonNegInt(amountTo, "amountTo");
  assertNonNegInt(rate, "rate");
  if (rate === 0) throw new RangeError("FX backward conversion requires rate > 0");
  const numerator = BigInt(amountTo) * RATE_SCALE_BIG;
  const r = BigInt(rate);
  // ceil(numerator / r)
  const ceil = (numerator + r - 1n) / r;
  return toSafeNumber(ceil, "backward conversion");
}

/**
 * Compose two directional rates into one for a bridge route:
 * `rate(A→B) = rate(A→C) · rate(C→B) / RATE_SCALE` (e.g. SEK→ILS via NOK,
 * docs/specs/20_method_design.md §3.3 / §11.2). Rounds **down** so the composed rate never
 * over-states the payee's receipt.
 */
export function composeRates(rateFirst: number, rateSecond: number): number {
  assertNonNegInt(rateFirst, "rateFirst");
  assertNonNegInt(rateSecond, "rateSecond");
  const product = BigInt(rateFirst) * BigInt(rateSecond);
  return toSafeNumber(product / RATE_SCALE_BIG, "rate composition");
}

/** Human-readable decimal string for a fixed-point rate (diagnostics only). */
export function formatRate(rate: number): string {
  const whole = Math.floor(rate / RATE_SCALE);
  const frac = rate % RATE_SCALE;
  return `${whole}.${frac.toString().padStart(8, "0").replace(/0+$/, "") || "0"}`;
}
