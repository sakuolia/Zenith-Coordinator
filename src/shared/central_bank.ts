/**
 * @file Central-bank settlement registry and tokenized central-bank-deposit
 * (CBT) account model.
 *
 * Finality for a currency is established at *that currency's* central bank, not
 * at the Bank of Japan. ZC is a Japanese coordinator and cannot connect to a
 * foreign central bank's RTGS (ECB / FedNY / …) directly. The portable rail it
 * *can* observe is a **tokenized central-bank deposit (CBT)**: each central bank
 * issues its reserve as a token on one or more chains (Ethereum, Polygon, …),
 * and ZC accepts finality by verifying the issuer's signed settlement
 * observation (`venue='CB_TOKEN'`, trust-anchored in `KeyRegistry`, exactly like
 * the onchain/attestation rails — see `src/shared/watcher.ts`).
 *
 * Consequences encoded here:
 *  - JPY keeps its classic BOJ-Net current account (`{bank}-BOJ`). The tokenized
 *    JPY deposit is an *additional* rail (`{bank}-CBT-JPY-{chain}`), never a
 *    replacement.
 *  - Every non-JPY currency settles on a CBT account at its own central bank;
 *    `{bank}-BOJ-{CCY}` (the old "BOJ holds euros" fiction) is gone.
 *  - The CBT account carries a **chain** dimension: the same currency can be
 *    settled on different chains, so the chain is part of the account identity
 *    and of the `CB_TOKEN` proof `source`.
 *
 * @module shared/central_bank
 */
import { bojAccountId } from "../types/primitives";

/** Currency → issuing central bank code. Extend as currencies are onboarded. */
export const CENTRAL_BANK_BY_CURRENCY: Record<string, string> = {
  JPY: "BOJ", // Bank of Japan
  USD: "FED", // Federal Reserve (FedNY)
  EUR: "ECB", // European Central Bank
  GBP: "BOE", // Bank of England
  CHF: "SNB", // Swiss National Bank
};

/**
 * Chains on which a tokenized central-bank deposit can settle. The list is the
 * extension point for new rails — adding one here (and registering its issuer
 * key) is all that a new chain requires.
 */
export const SUPPORTED_SETTLEMENT_CHAINS = ["ETH", "POLYGON"] as const;
export type SettlementChain = (typeof SUPPORTED_SETTLEMENT_CHAINS)[number];

/** Chain used when a settlement does not pin one explicitly. */
export const DEFAULT_SETTLEMENT_CHAIN: SettlementChain = "ETH";

/** Whether a currency settles on the JPY-classic BOJ-Net rail. */
export function isJpyClassicCurrency(currency: string): boolean {
  return currency === "JPY";
}

/** Whether `chain` is a recognized settlement chain. */
export function isSupportedSettlementChain(chain: string): chain is SettlementChain {
  return (SUPPORTED_SETTLEMENT_CHAINS as readonly string[]).includes(chain);
}

/**
 * Resolve the central bank that issues finality for `currency`. Returns the
 * issuer code (e.g. `'ECB'`), or `null` for a currency with no registered
 * central bank (caller decides whether that is an error).
 */
export function centralBankFor(currency: string): string | null {
  return CENTRAL_BANK_BY_CURRENCY[currency] ?? null;
}

/**
 * Tokenized central-bank-deposit account for a bank, currency and chain:
 * `{bank}-CBT-{CCY}-{CHAIN}` (e.g. `001-CBT-USD-ETH`). Chain-dimensioned so the
 * same currency on two chains never commingles in one balance.
 */
export function cbTokenAccountId(
  bankCode: string,
  currency: string,
  chain: string = DEFAULT_SETTLEMENT_CHAIN
): string {
  return `${bankCode}-CBT-${currency}-${chain}`;
}

/**
 * The central-bank settlement account for a (bank, currency) leg.
 *
 *  - JPY with no chain pinned → the classic BOJ-Net current account
 *    (`{bank}-BOJ`), unchanged.
 *  - Otherwise (any non-JPY currency, or JPY when a chain is pinned = the
 *    tokenized JPY rail) → the tokenized CBT account on the given/default chain.
 *
 * `chain` is the cycle's `settlement_chain` (NULL for JPY-classic).
 */
export function settlementAccountId(
  bankCode: string,
  currency: string,
  chain?: string | null
): string {
  if (isJpyClassicCurrency(currency) && !chain) {
    return bojAccountId(bankCode);
  }
  return cbTokenAccountId(bankCode, currency, chain ?? DEFAULT_SETTLEMENT_CHAIN);
}

/**
 * Canonical `source` for a `CB_TOKEN` settlement observation:
 * `CB_TOKEN:{centralBank}:{chain}` (e.g. `CB_TOKEN:ECB:ETH`). Mirrors the
 * `ONCHAIN:{chain}` convention so a Watcher/issuer key can be scoped per rail.
 */
export function cbTokenObservationSource(currency: string, chain: string): string {
  return `CB_TOKEN:${centralBankFor(currency) ?? "UNKNOWN"}:${chain}`;
}
