/**
 * @file Tests for cross-border transfer initiation (src/zc/richdata/cross_border.ts),
 * specifically the minor-unit currency conversion fix: `foreign_amount` is an
 * integer count of `foreign_currency`'s minor unit (e.g. USD 100.50 is
 * `10050`), not a major-unit float, and the JPY conversion must scale by the
 * currency's decimal places before applying the mock exchange rate.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  initiateCrossBorderTransfer,
  getCrossBorderTransaction,
} from "../../src/zc/richdata/cross_border";
import type { CrossBorderSendRequest, FatfR16Data } from "../../src/types";

let d1: MockD1Database;
const env = {};

function fatfData(): FatfR16Data {
  return {
    originator: {
      name: "Taro Yamada",
      account_id: "0010000001",
      address: "1-1 Marunouchi, Chiyoda-ku, Tokyo",
    },
    beneficiary: {
      name: "John Smith",
      account_id: "US123456789",
    },
    ordering_institution: {
      bank_id: "001",
      bank_name: "Test Bank",
      country: "JP",
    },
    beneficiary_institution: {
      bank_id: "CHASUS33",
      bank_name: "Chase",
      country: "US",
      bic: "CHASUS33",
    },
    is_cross_border: true,
    fatf16_applicable: true,
  };
}

function sendRequest(overrides: Partial<CrossBorderSendRequest> = {}): CrossBorderSendRequest {
  return {
    cb_txid: `CB-${crypto.randomUUID()}`,
    payer_bank_id: "001",
    payer_account_id: "0010000001",
    foreign_fps_id: "CHASUS33",
    foreign_bank_bic: "CHASUS33",
    foreign_account_id: "US123456789",
    foreign_currency: "USD",
    foreign_amount: 10050,
    fatf_data: fatfData(),
    idempotency_key: crypto.randomUUID(),
    ...overrides,
  };
}

beforeEach(() => {
  ({ d1 } = createTestDb());
});

describe("initiateCrossBorderTransfer: minor-unit conversion", () => {
  it("converts USD 100.50 (foreign_amount 10050) to its correct JPY equivalent, not a 100x-inflated amount", async () => {
    const { cbTxid } = await initiateCrossBorderTransfer(
      d1,
      sendRequest({ foreign_amount: 10050 }),
      env
    );

    const row = await getCrossBorderTransaction(d1, cbTxid);
    expect(row).not.toBeNull();
    // USD rate is 150 JPY/major-unit; 100.50 USD * 150 = 15,075 JPY.
    // The pre-fix bug treated 10050 as 10050 *major* units, giving 1,507,500.
    expect(row!.domestic_amount).toBe(15_075);
    expect(row!.foreign_amount).toBe(10050);
  });

  it("handles JPY (0 decimal places) as a pass-through with rate 1", async () => {
    const { cbTxid } = await initiateCrossBorderTransfer(
      d1,
      sendRequest({ foreign_currency: "JPY", foreign_amount: 50_000 }),
      env
    );

    const row = await getCrossBorderTransaction(d1, cbTxid);
    expect(row!.domestic_amount).toBe(50_000);
  });

  it("converts EUR minor units using the EUR rate and 2 decimal places", async () => {
    const { cbTxid } = await initiateCrossBorderTransfer(
      d1,
      sendRequest({ foreign_currency: "EUR", foreign_amount: 20_000 }), // EUR 200.00
      env
    );

    const row = await getCrossBorderTransaction(d1, cbTxid);
    // EUR rate is 163 JPY/major-unit; 200.00 EUR * 163 = 32,600 JPY.
    expect(row!.domestic_amount).toBe(32_600);
  });

  it("is case-insensitive for foreign_currency", async () => {
    const { cbTxid } = await initiateCrossBorderTransfer(
      d1,
      sendRequest({ foreign_currency: "usd", foreign_amount: 10050 }),
      env
    );
    const row = await getCrossBorderTransaction(d1, cbTxid);
    expect(row!.domestic_amount).toBe(15_075);
  });
});

describe("initiateCrossBorderTransfer: input validation", () => {
  it("rejects an unsupported foreign_currency instead of silently defaulting to JPY parity", async () => {
    await expect(
      initiateCrossBorderTransfer(d1, sendRequest({ foreign_currency: "XYZ" }), env)
    ).rejects.toThrow(/Unsupported foreign_currency: XYZ/);
  });

  it("rejects a non-integer foreign_amount", async () => {
    await expect(
      initiateCrossBorderTransfer(d1, sendRequest({ foreign_amount: 100.5 }), env)
    ).rejects.toThrow(/foreign_amount must be a positive integer/);
  });

  it("rejects a zero foreign_amount", async () => {
    await expect(
      initiateCrossBorderTransfer(d1, sendRequest({ foreign_amount: 0 }), env)
    ).rejects.toThrow(/foreign_amount must be a positive integer/);
  });

  it("rejects a negative foreign_amount", async () => {
    await expect(
      initiateCrossBorderTransfer(d1, sendRequest({ foreign_amount: -10050 }), env)
    ).rejects.toThrow(/foreign_amount must be a positive integer/);
  });

  it("still rejects FATF-invalid data after the new currency/amount checks pass", async () => {
    const bad = sendRequest();
    bad.fatf_data.originator.name = "";
    await expect(initiateCrossBorderTransfer(d1, bad, env)).rejects.toThrow(
      /FATF R16 validation failed/
    );
  });
});
