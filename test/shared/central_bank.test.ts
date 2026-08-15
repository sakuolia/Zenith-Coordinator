/**
 * @file Unit tests for src/shared/central_bank.ts — the currency→central-bank
 * registry and the tokenized central-bank-deposit (CBT) account/chain model.
 */
import { describe, it, expect } from "vitest";
import {
  centralBankFor,
  cbTokenAccountId,
  settlementAccountId,
  cbTokenObservationSource,
  isJpyClassicCurrency,
  isSupportedSettlementChain,
  DEFAULT_SETTLEMENT_CHAIN,
  SUPPORTED_SETTLEMENT_CHAINS,
} from "../../src/shared/central_bank";

describe("centralBankFor", () => {
  it("maps each currency to its issuing central bank", () => {
    expect(centralBankFor("JPY")).toBe("BOJ");
    expect(centralBankFor("USD")).toBe("FED");
    expect(centralBankFor("EUR")).toBe("ECB");
    expect(centralBankFor("GBP")).toBe("BOE");
  });

  it("returns null for an unregistered currency", () => {
    expect(centralBankFor("XYZ")).toBeNull();
  });
});

describe("cbTokenAccountId", () => {
  it("is chain-dimensioned so one currency on two chains never commingles", () => {
    expect(cbTokenAccountId("001", "USD", "ETH")).toBe("001-CBT-USD-ETH");
    expect(cbTokenAccountId("001", "USD", "POLYGON")).toBe("001-CBT-USD-POLYGON");
    expect(cbTokenAccountId("001", "USD", "ETH")).not.toBe(
      cbTokenAccountId("001", "USD", "POLYGON")
    );
  });

  it("defaults to the default settlement chain", () => {
    expect(cbTokenAccountId("002", "EUR")).toBe(`002-CBT-EUR-${DEFAULT_SETTLEMENT_CHAIN}`);
  });
});

describe("settlementAccountId", () => {
  it("routes JPY with no chain to the classic BOJ-Net current account", () => {
    expect(settlementAccountId("001", "JPY")).toBe("001-BOJ");
    expect(settlementAccountId("001", "JPY", null)).toBe("001-BOJ");
  });

  it("routes non-JPY to the tokenized CB deposit at its own central bank", () => {
    expect(settlementAccountId("001", "USD", "ETH")).toBe("001-CBT-USD-ETH");
    expect(settlementAccountId("002", "EUR", "POLYGON")).toBe("002-CBT-EUR-POLYGON");
  });

  it("treats JPY WITH a pinned chain as the additional tokenized-JPY rail", () => {
    // The BOJ classic account stays {bank}-BOJ; the tokenized JPY rail is separate.
    expect(settlementAccountId("001", "JPY", "ETH")).toBe("001-CBT-JPY-ETH");
    expect(settlementAccountId("001", "JPY", "ETH")).not.toBe(settlementAccountId("001", "JPY"));
  });

  it("falls back to the default chain when a non-JPY currency pins none", () => {
    expect(settlementAccountId("001", "USD")).toBe(`001-CBT-USD-${DEFAULT_SETTLEMENT_CHAIN}`);
  });
});

describe("cbTokenObservationSource", () => {
  it("encodes both the central bank and the chain (mirrors ONCHAIN:{chain})", () => {
    expect(cbTokenObservationSource("EUR", "ETH")).toBe("CB_TOKEN:ECB:ETH");
    expect(cbTokenObservationSource("USD", "POLYGON")).toBe("CB_TOKEN:FED:POLYGON");
    expect(cbTokenObservationSource("JPY", "ETH")).toBe("CB_TOKEN:BOJ:ETH");
  });
});

describe("chain helpers", () => {
  it("recognizes only supported chains", () => {
    for (const chain of SUPPORTED_SETTLEMENT_CHAINS) {
      expect(isSupportedSettlementChain(chain)).toBe(true);
    }
    expect(isSupportedSettlementChain("SOLANA")).toBe(false);
  });

  it("isJpyClassicCurrency is JPY-only", () => {
    expect(isJpyClassicCurrency("JPY")).toBe(true);
    expect(isJpyClassicCurrency("USD")).toBe(false);
  });
});
