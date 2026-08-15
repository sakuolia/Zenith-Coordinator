/**
 * @file Unit tests for src/zc/settlement/dns_cycle_id.ts (canonical DNS cycle identifier, docs/specs/20_method_design.md §9.4.2).
 */
import { describe, it, expect } from "vitest";
import {
  formatDnsCycleId,
  parseDnsCycleId,
  legacyDnsCycleIdentity,
  DEFAULT_DNS_CURRENCY,
} from "../../src/zc/settlement/dns_cycle_id";

describe("formatDnsCycleId", () => {
  it("formats DNS-{CCY}-YYYYMMDD-NN", () => {
    expect(formatDnsCycleId({ currency: "JPY", businessDate: "2025-06-01", intradaySeq: 1 })).toBe(
      "DNS-JPY-20250601-01"
    );
  });

  it("zero-pads the intraday sequence number to 2 digits", () => {
    expect(formatDnsCycleId({ currency: "USD", businessDate: "2025-06-01", intradaySeq: 9 })).toBe(
      "DNS-USD-20250601-09"
    );
    expect(formatDnsCycleId({ currency: "USD", businessDate: "2025-06-01", intradaySeq: 12 })).toBe(
      "DNS-USD-20250601-12"
    );
  });
});

describe("parseDnsCycleId", () => {
  it("round-trips a value produced by formatDnsCycleId", () => {
    const parts = { currency: "EUR", businessDate: "2025-12-31", intradaySeq: 3 };
    expect(parseDnsCycleId(formatDnsCycleId(parts))).toEqual(parts);
  });

  it("returns null for the pre-existing DNS-<business_date> format", () => {
    expect(parseDnsCycleId("DNS-2025-06-01")).toBeNull();
  });

  it("returns null for the pre-existing late-cycle DNS-<business_date>-<HHMMSS> format", () => {
    expect(parseDnsCycleId("DNS-2025-06-01-153045")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseDnsCycleId("DNS-jpy-20250601-01")).toBeNull();
    expect(parseDnsCycleId("DNS-JPY-2025-06-01")).toBeNull();
    expect(parseDnsCycleId("not-a-cycle-id")).toBeNull();
  });
});

describe("legacyDnsCycleIdentity", () => {
  it("maps a business_date to currency=JPY, intraday_seq=1", () => {
    expect(legacyDnsCycleIdentity("2025-06-01")).toEqual({
      currency: DEFAULT_DNS_CURRENCY,
      businessDate: "2025-06-01",
      intradaySeq: 1,
    });
  });

  it("produces the canonical DNS-JPY-YYYYMMDD-01 identifier via formatDnsCycleId", () => {
    expect(formatDnsCycleId(legacyDnsCycleIdentity("2025-06-01"))).toBe("DNS-JPY-20250601-01");
  });
});
