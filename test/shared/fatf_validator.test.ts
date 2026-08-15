/**
 * @file Unit tests for src/shared/fatf_validator.ts
 *
 * Regression coverage for:
 *   B3 — extra closing-quote in intermediary.country error message was
 *        producing malformed strings. Fixed by removing the stray "')".
 */
import { describe, it, expect } from "vitest";
import {
  validateFatfR16,
  isFatfApplicable,
  toJpyEquivalent,
} from "../../src/shared/fatf_validator";
import type { FatfR16Data } from "../../src/types";

function baseData(): FatfR16Data {
  return {
    originator: {
      name: "山田太郎",
      account_id: "0010000001",
      address: "東京都千代田区1-1",
    },
    beneficiary: {
      name: "John Doe",
      account_id: "0020000099",
    },
    ordering_institution: {
      bank_id: "001",
      bank_name: "Bank A",
      country: "JP",
    },
    beneficiary_institution: {
      bank_id: "002",
      bank_name: "Bank B",
      country: "US",
    },
    is_cross_border: true,
    fatf16_applicable: true,
  };
}

describe("validateFatfR16 — well-formed data", () => {
  it("passes a complete valid payload", () => {
    const result = validateFatfR16(baseData());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe("validateFatfR16 — error messages are well-formed (B3)", () => {
  it("error for invalid intermediary country code does not contain stray quote characters", () => {
    const data: FatfR16Data = {
      ...baseData(),
      intermediary: {
        name: "Intermediary Bank",
        country: "XYZ", // invalid: 3 chars, fails /^[A-Z]{2}$/ — triggers B3 code path
      },
    };
    const result = validateFatfR16(data);
    expect(result.valid).toBe(false);

    const countryError = result.errors.find((e) => e.includes("intermediary.country"));
    expect(countryError).toBeDefined();

    // B3 regression: the original message ended with "が必要)')" — two extra chars.
    // After the fix it ends with "が必要)" — exactly one closing paren, no stray quote.
    expect(countryError).not.toMatch(/が必要'\)/); // old broken pattern
    expect(countryError).toMatch(/が必要\)$/); // correct: ends with single ")"
  });

  it("error for missing intermediary country is a separate message", () => {
    const data: FatfR16Data = {
      ...baseData(),
      intermediary: {
        name: "Intermediary Bank",
        country: "",
      },
    };
    const result = validateFatfR16(data);
    expect(result.valid).toBe(false);
    const countryError = result.errors.find((e) => e.includes("intermediary.country"));
    expect(countryError).toBeDefined();
    expect(countryError).toContain("必須");
  });
});

describe("validateFatfR16 — originator identity", () => {
  it("rejects when no additional identity info is provided", () => {
    const data: FatfR16Data = {
      ...baseData(),
      originator: { name: "山田太郎", account_id: "0010000001" },
    };
    const result = validateFatfR16(data);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("originator"))).toBe(true);
  });

  it("passes when originator has date_of_birth + place_of_birth instead of address", () => {
    const data: FatfR16Data = {
      ...baseData(),
      originator: {
        name: "山田太郎",
        account_id: "0010000001",
        date_of_birth: "1990-01-01",
        place_of_birth: "Tokyo",
      },
    };
    const result = validateFatfR16(data);
    expect(result.valid).toBe(true);
  });

  it("rejects when only date_of_birth is given (without place_of_birth)", () => {
    const data: FatfR16Data = {
      ...baseData(),
      originator: {
        name: "山田太郎",
        account_id: "0010000001",
        date_of_birth: "1990-01-01",
      },
    };
    const result = validateFatfR16(data);
    expect(result.valid).toBe(false);
  });
});

describe("validateFatfR16 — flag consistency", () => {
  it("rejects fatf16_applicable=true when is_cross_border=false", () => {
    const data: FatfR16Data = {
      ...baseData(),
      is_cross_border: false,
      fatf16_applicable: true,
    };
    const result = validateFatfR16(data);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("is_cross_border"))).toBe(true);
  });
});

// `amount` for both functions below is an integer count of `currency`'s
// minor unit (e.g. USD 100.50 is `10050`), matching the convention enforced
// at the cross-border ingress boundary (src/zc/richdata/cross_border.ts).
describe("toJpyEquivalent — minor-unit conversion", () => {
  it("converts USD minor units (cents) to JPY using the major-unit rate", () => {
    // USD rate is 150 JPY/major-unit; 100.50 USD * 150 = 15,075 JPY.
    expect(toJpyEquivalent(10_050, "USD")).toBe(15_075);
  });

  it("treats JPY as a 0-decimal pass-through", () => {
    expect(toJpyEquivalent(150_000, "JPY")).toBe(150_000);
  });

  it("converts EUR minor units (cents) to JPY using the major-unit rate", () => {
    // EUR rate is 163 JPY/major-unit; 200.00 EUR * 163 = 32,600 JPY.
    expect(toJpyEquivalent(20_000, "EUR")).toBe(32_600);
  });

  it("is case-insensitive for the currency code", () => {
    expect(toJpyEquivalent(10_050, "usd")).toBe(15_075);
  });
});

describe("isFatfApplicable — minor-unit threshold check", () => {
  it("is not applicable below the JPY 150,000 / USD 1,000 threshold even for a large minor-unit amount", () => {
    // USD 999.99 (99999 cents) -> 149,998.50 JPY, just under the threshold.
    expect(isFatfApplicable(99_999, "USD", true)).toBe(false);
  });

  it("is applicable at or above the threshold", () => {
    // USD 1,000.00 (100000 cents) -> 150,000 JPY, exactly at the threshold.
    expect(isFatfApplicable(100_000, "USD", true)).toBe(true);
  });

  it("is never applicable for a domestic (non-cross-border) transfer regardless of amount", () => {
    expect(isFatfApplicable(10_000_000, "USD", false)).toBe(false);
  });
});
