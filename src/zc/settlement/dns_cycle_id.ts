/**
 * @file dns_cycle_id.ts — Canonical DNS cycle identifier format.
 *
 * Defines the target identifier format `DNS-{CCY}-YYYYMMDD-NN` (`CCY` = ISO
 * 4217 currency code, `NN` = 1-based intraday sequence number, zero-padded to
 * 2 digits) that themes D/E build their per-currency, multiple-per-day DNS
 * cycle logic on top of.
 *
 * This module is a pure, additive primitive: `src/zc/dns.ts`'s existing
 * `cycle_id` strings (`DNS-${business_date}` and late-cycle
 * `DNS-${business_date}-${HHMMSS}` variants) and its `business_date`-keyed
 * lookups are unchanged. `DnsCycles.currency` / `DnsCycles.intraday_seq`
 * (defaulted to
 * `'JPY'` / `1`) record each cycle's canonical identity per
 * `legacyDnsCycleIdentity()` below, without altering the existing `cycle_id`
 * column.
 */

/** Default currency for cycles created before per-currency DNS existed. */
export const DEFAULT_DNS_CURRENCY = "JPY";

export interface DnsCycleIdParts {
  /** ISO 4217 currency code, e.g. 'JPY', 'USD'. */
  currency: string;
  /** Business date in 'YYYY-MM-DD' format. */
  businessDate: string;
  /** 1-based intraday sequence number. */
  intradaySeq: number;
}

/**
 * Format the canonical `DNS-{CCY}-YYYYMMDD-NN` cycle identifier.
 */
export function formatDnsCycleId(parts: DnsCycleIdParts): string {
  const ymd = parts.businessDate.replace(/-/g, "");
  const nn = String(parts.intradaySeq).padStart(2, "0");
  return `DNS-${parts.currency}-${ymd}-${nn}`;
}

/**
 * Parse a canonical `DNS-{CCY}-YYYYMMDD-NN` cycle identifier.
 *
 * Returns `null` if `cycleId` does not match the canonical format (e.g. the
 * pre-existing `DNS-${business_date}` / `DNS-${business_date}-${HHMMSS}`
 * identifiers produced by `src/zc/dns.ts`).
 */
export function parseDnsCycleId(cycleId: string): DnsCycleIdParts | null {
  const m = cycleId.match(/^DNS-([A-Z]{3})-(\d{4})(\d{2})(\d{2})-(\d{2})$/);
  if (!m) {
    return null;
  }
  const [, currency, year, month, day, nn] = m as RegExpMatchArray &
    [string, string, string, string, string, string];
  return {
    currency,
    businessDate: `${year}-${month}-${day}`,
    intradaySeq: Number(nn),
  };
}

/**
 * The canonical identity for the pre-existing single-daily JPY DNS cycle, per
 * docs/specs/20_method_design.md §9.4.2 backward-compat rule: `business_date` maps to
 * `DNS-JPY-YYYYMMDD-01` (currency='JPY', intraday_seq=1). This is the value
 * recorded in `DnsCycles.currency` / `DnsCycles.intraday_seq` for cycles
 * created by the existing `src/zc/dns.ts` logic; it does not replace the
 * existing `cycle_id` string.
 */
export function legacyDnsCycleIdentity(businessDate: string): DnsCycleIdParts {
  return { currency: DEFAULT_DNS_CURRENCY, businessDate, intradaySeq: 1 };
}
