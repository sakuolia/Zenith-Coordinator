/**
 * @file Unit tests for src/zc/fx/rates.ts — integer fixed-point FX arithmetic.
 *
 * Pins the rounding contract (forward=floor, backward=ceil, both FXP-favourable
 * so the scheme never creates money), bridge-rate composition (the Icebreaker
 * SEK→ILS-via-NOK worked example), and BigInt overflow safety.
 */
import { describe, it, expect } from "vitest";
import {
  RATE_SCALE,
  convertForward,
  convertBackward,
  composeRates,
  formatRate,
} from "../../src/zc/fx/rates";

describe("fx/rates: RATE_SCALE", () => {
  it("is 1e8", () => {
    expect(RATE_SCALE).toBe(100_000_000);
  });
});

describe("fx/rates: convertForward (payer-denominated, floor)", () => {
  it("identity rate returns the same amount", () => {
    expect(convertForward(1_000_000, RATE_SCALE)).toBe(1_000_000);
  });

  it("JPY→USD at 0.0067 (rate=670_000) floors", () => {
    // 1,000,000 JPY × 0.0067 = 6,700 USD exactly
    expect(convertForward(1_000_000, 670_000)).toBe(6_700);
  });

  it("rounds the sub-unit remainder DOWN (FXP keeps it)", () => {
    // 3 × 1.5 = 4.5 → floor 4
    expect(convertForward(3, 150_000_000)).toBe(4);
  });

  it("zero amount converts to zero", () => {
    expect(convertForward(0, 670_000)).toBe(0);
  });

  it("handles large amounts without precision loss (BigInt path)", () => {
    // 1e12 × 1.23456789 → 1,234,567,890,000 exactly (product 1e20 > 2^53)
    expect(convertForward(1_000_000_000_000, 123_456_789)).toBe(1_234_567_890_000);
  });

  it("rejects negative or non-integer inputs", () => {
    expect(() => convertForward(-1, RATE_SCALE)).toThrow(RangeError);
    expect(() => convertForward(1.5, RATE_SCALE)).toThrow(RangeError);
  });
});

describe("fx/rates: convertBackward (payee-denominated, ceil)", () => {
  it("identity rate returns the same amount", () => {
    expect(convertBackward(6_700, RATE_SCALE)).toBe(6_700);
  });

  it("computes the minimum source that yields the target, rounding UP", () => {
    // want 6_700 USD at rate 670_000 → exactly 1,000,000 JPY
    expect(convertBackward(6_700, 670_000)).toBe(1_000_000);
  });

  it("rounds UP so the FXP is never short", () => {
    // want 4 at rate 1.5 → 4/1.5 = 2.66… → ceil 3 (3×1.5=4.5 ≥ 4)
    const src = convertBackward(4, 150_000_000);
    expect(src).toBe(3);
    expect(convertForward(src, 150_000_000)).toBeGreaterThanOrEqual(4);
  });

  it("rejects rate of zero", () => {
    expect(() => convertBackward(100, 0)).toThrow(RangeError);
  });
});

describe("fx/rates: composeRates (bridge route)", () => {
  it("composes SEK→NOK (0.909…) and NOK→ILS (0.44) ≈ SEK→ILS 0.40 (Icebreaker)", () => {
    // rate(SEK→NOK) = 1/1.10 = 0.90909090… → 90_909_090
    // rate(NOK→ILS) = 0.44 → 44_000_000
    const composed = composeRates(90_909_090, 44_000_000);
    // 0.90909090 × 0.44 = 0.39999999… → ~0.40
    expect(composed).toBe(39_999_999); // floor of 0.3999999...
    expect(formatRate(composed).startsWith("0.39")).toBe(true);
  });

  it("composing with identity is a no-op", () => {
    expect(composeRates(670_000, RATE_SCALE)).toBe(670_000);
  });
});

describe("fx/rates: formatRate", () => {
  it("renders fixed-point as decimal", () => {
    expect(formatRate(RATE_SCALE)).toBe("1.0");
    expect(formatRate(670_000)).toBe("0.0067");
    expect(formatRate(150_000_000)).toBe("1.5");
  });
});
