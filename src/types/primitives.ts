/**
 * @file primitives.ts — Leaf-level types with no intra-package dependencies.
 *
 * Contains Env, monetary primitives, proof references, FATF data structures,
 * account-number utilities, and timestamp helpers. These are imported by
 * every other type sub-module, so they must remain dependency-free.
 */

// ---------------------------------------------------------------------------
// Cloudflare Worker Environment Bindings
// ---------------------------------------------------------------------------

/** Cloudflare Worker environment bindings shared by ZC and Bank workers. */
export interface Env {
  DB: D1Database;
  QUEUE: Queue;
  R2: R2Bucket;
  ZC_HMAC_SECRET: string;
  /**
   * Rotation overlap for the shared HMAC secret (`src/shared/secret_rotation.ts`).
   * `ZC_HMAC_SECRET_PREVIOUS` is accepted for VERIFICATION only — signing always
   * uses `ZC_HMAC_SECRET` — and only until `ZC_HMAC_SECRET_PREVIOUS_UNTIL`
   * (RFC3339). A previous secret without a deadline is ignored: an unbounded
   * second valid secret is not an overlap window.
   */
  ZC_HMAC_SECRET_PREVIOUS?: string;
  ZC_HMAC_SECRET_PREVIOUS_UNTIL?: string;
  /**
   * ZC egress asymmetric signing key (replaces the single shared HMAC over time).
   * When all three are set, ZC signs outbound requests with this private key and
   * participants verify against the matching `KeyRegistry` public key
   * (`owner_type='ZC'`, `key_id = ZC_SIGNING_KEY_ID`). When unset, ZC falls back
   * to the legacy `ZC_HMAC_SECRET`. Verifiers dual-accept during migration.
   *   - ZC_SIGNING_KEY_ID:    KeyRegistry key_id of the active ZC signing key.
   *   - ZC_SIGNING_KEY_PKCS8: base64-encoded PKCS#8 private key (kept in a secret
   *                           store / HSM-backed binding in production).
   *   - ZC_SIGNING_ALGO:      "ECDSA_P256" (default) | "ED25519".
   */
  ZC_SIGNING_KEY_ID?: string;
  ZC_SIGNING_KEY_PKCS8?: string;
  ZC_SIGNING_ALGO?: string;
  BANK_BASE_URL: string;
  CRON_SECRET: string;
  QR_SECRET: string;
  /**
   * Separate admin key for privileged operations (whitelist registration, etc.).
   * If unset, falls back to ZC_HMAC_SECRET for backward compatibility.
   */
  ZC_ADMIN_KEY?: string;
  /**
   * Opt-in: serve `/api/*` to unauthenticated same-origin callers so the bundled
   * demo dashboards work without a key. **Off unless set to the string "true".**
   * It is not a security control — request headers are attacker-controlled, so a
   * deployment that enables this has made its API public (`src/index.ts`).
   */
  ZC_ALLOW_UNAUTHENTICATED_UI?: string;
  /**
   * System-wide HIGH_VALUE auto-routing threshold in JPY (integer string).
   * Payments at or above this amount are automatically escalated to HIGH_VALUE lane.
   * Default: 100000000 (¥100,000,000 = 100 million yen). Per-bank override via Participants.hv_threshold.
   */
  ZC_HV_THRESHOLD?: string;
  /**
   * Consensus-log replica membership for design-principle-10 quorum health
   * (comma-separated replica ids, e.g. "tokyo,osaka,sapporo"). A deployment's
   * health monitor reports observed reachability against this set via
   * /internal/system-mode/quorum-report. Defaults to a three-replica set when
   * unset (see src/zc/platform/quorum.ts).
   */
  ZC_QUORUM_REPLICAS?: string;
  R2_BUCKET?: R2Bucket;
  FOREIGN_FPS_ENDPOINT?: string;
  STREAM_DO?: DurableObjectNamespace;
  ALS_KV?: KVNamespace;
}

// ---------------------------------------------------------------------------
// Monetary Primitives & Proof References
// ---------------------------------------------------------------------------

/** Monetary amount with currency code (typically "JPY"). */
export interface Amount {
  value: number;
  currency: string;
}

/**
 * Bank-issued proof reference attached to a transaction after execution.
 * Each proof certifies that a debit or credit was (or was not) applied.
 *
 * Generalized into a
 * `SettlementProofRef`: the four `venue`/`external_ref`/`signer_key_id`/
 * `verified_at` fields are additive and optional so that non-bank-ledger
 * proof sources (IGS/onchain/attestation) can be represented in the same
 * shape without breaking existing `BANK_LEDGER` proofs (which omit them).
 */
export interface BankProofRef {
  issuer_bank_id: string;
  proof_type: ProofType;
  proof_id: string;
  recorded_at: string;
  custody_detail?: CustodyDetail | null;
  /** Where the proof originates. Omitted/absent is equivalent to "BANK_LEDGER". */
  venue?: ProofVenue;
  /** Reference within `venue` (chain tx hash / IGS-ID / attestation ID). */
  external_ref?: string | null;
  /** `KeyRegistry.key_id` of the external signer that attested this proof. */
  signer_key_id?: string | null;
  /** When ZC verified the external signature (RFC3339). */
  verified_at?: string | null;
}

/**
 * `SettlementProofRef` is the P1-generalized name for `BankProofRef`; both
 * names refer to the same shape. New code that may carry non-bank-ledger
 * proofs should prefer this name.
 */
export type SettlementProofRef = BankProofRef;

export type ProofType =
  | "PAYER_EXEC_PROOF"
  | "PAYER_HV_ISOLATION_PROOF"
  | "PAYEE_EXEC_PROOF"
  | "NO_DEBIT_RECORDED_PROOF"
  /** Onchain escrow locked under the same `hashlock` (テーマA cross-chain HTLC). */
  | "ONCHAIN_ESCROW_LOCK_PROOF"
  /** Onchain escrow released with a preimage matching `hashlock` (テーマA). */
  | "ONCHAIN_RELEASE_PROOF"
  /**
   * Payer-bank proof that funds isolated for a high-value leg were restored
   * internally after the central-bank settlement did not complete
   * (FAILED / HOLD). docs/specs/10_requirements.md §1.2.3 requires the restoration to
   * be evidenced *and* keeps it out of inter-bank Reversal: the money never left
   * the payer bank, so there is nothing between banks to unwind.
   */
  | "EXT_REFUND_PROOF"
  /**
   * Payee-bank proof that moving the funds onward is *physically* impossible.
   *
   * This is the sole cause-of-action that opens the Reversal gate
   * (docs/specs/10_requirements.md §4.3.0 第1層). Account-side conditions — frozen,
   * closed, unknown account — are explicitly NOT causes: those are absorbed as
   * Custody, and a Reversal raised on them would unwind a settlement that in
   * fact completed.
   */
  | "CREDIT_FAILED_PROOF";

/**
 * Origin of a SettlementProofRef.
 *
 * - `BANK_LEDGER`: ZC's own bank-ledger hub (the default `BankProofRef`).
 * - `IGS_BOJ`: BOJ-Net immediate gross settlement (JPY central-bank rail).
 * - `ONCHAIN`: a public-chain HTLC/escrow event.
 * - `ATTESTATION`: a third-party attester.
 * - `CB_TOKEN`: a tokenized central-bank deposit settled on a chain. The
 *   finality rail for non-JPY currencies (each at its own central bank — ECB,
 *   FedNY, …) and the optional tokenized-JPY rail. ZC cannot reach a foreign
 *   central bank directly, so it accepts only the issuer's signed observation
 *   (verified against `KeyRegistry`, like `ONCHAIN`/`ATTESTATION`). The chain is
 *   carried in the observation `source` (`CB_TOKEN:{centralBank}:{chain}`).
 */
export type ProofVenue = "BANK_LEDGER" | "IGS_BOJ" | "ONCHAIN" | "ATTESTATION" | "CB_TOKEN";

/** Details when credit lands in a custody (suspense) account instead of the payee. */
export interface CustodyDetail {
  is_custody: true;
  reason_code: string;
  custody_account_ref: string;
}

// ---------------------------------------------------------------------------
// FATF Recommendation 16 — Cross-border Transfer Data
// ---------------------------------------------------------------------------

export interface FatfParty {
  name: string;
  account_id: string;
  address?: string;
  national_id?: string;
  date_of_birth?: string;
  place_of_birth?: string;
}

export interface FatfInstitution {
  bank_id: string;
  bank_name: string;
  bic?: string;
  country: string;
}

export interface FatfR16Data {
  originator: FatfParty;
  beneficiary: FatfParty;
  ordering_institution: FatfInstitution;
  beneficiary_institution: FatfInstitution;
  intermediary?: {
    name: string;
    license_number?: string;
    country: string;
  };
  is_cross_border: boolean;
  fatf16_applicable: boolean;
}

// ---------------------------------------------------------------------------
// Account Number Utilities
// ---------------------------------------------------------------------------

/** Get the bank code (3 digits) from an account number */
export function bankCodeFromAccount(accountId: string): string {
  return accountId.slice(0, 3);
}

/** Generate a segregated deposit (suspense) account number from a bank code */
export function suspenseAccountId(bankCode: string): string {
  return `${bankCode}0000000`;
}

/** Generate the ZC settlement account number from a bank code */
export function nostroAccountId(bankCode: string): string {
  return `${bankCode}-ZCS`;
}

/** Generate the Retained Earnings account number from a bank code */
export function retainedEarningsAccountId(bankCode: string): string {
  return `${bankCode}-RE`;
}

/**
 * The JPY classic central-bank current account at the Bank of Japan
 * (`{bank}-BOJ`), used for the BOJ-Net RTGS / DNS rail.
 *
 * This is JPY-only by construction: the BOJ does not hold euros or dollars.
 * Non-JPY finality settles on a tokenized central-bank deposit at the relevant
 * central bank — see `settlementAccountId` / `cbTokenAccountId` in
 * `src/shared/central_bank.ts`. Use `settlementAccountId(bank, currency, chain)`
 * for currency-aware routing.
 */
export function bojAccountId(bankCode: string): string {
  return `${bankCode}-BOJ`;
}

/** Generate the Cash account number from a bank code */
export function cashAccountId(bankCode: string): string {
  return `${bankCode}-CASH`;
}

/** Generate the next account number */
export function generateAccountId(bankCode: string, seq: number): string {
  return `${bankCode}${String(seq).padStart(7, "0")}`;
}

// ---------------------------------------------------------------------------
// Timestamp Utilities
// ---------------------------------------------------------------------------

/**
 * The system's canonical business/display timezone is **JST (Asia/Tokyo,
 * UTC+09:00)**. Instants are *stored* in UTC (`nowISO`, RFC3339 `Z`) so that
 * lexicographic order equals chronological order and the FinalityLog hash chain
 * stays unambiguous; business dates (`businessDateJST`) and offset-less input
 * timestamps (`parseSystemTime`) are *interpreted* in JST.
 */
export const SYSTEM_TZ = "Asia/Tokyo";
export const SYSTEM_UTC_OFFSET = "+09:00";
export const SYSTEM_UTC_OFFSET_MINUTES = 9 * 60;
const JST_OFFSET_MS = SYSTEM_UTC_OFFSET_MINUTES * 60 * 1000;

/** Minutes-since-midnight of `d` in the system timezone (JST). Ignores the date. */
export function systemMinutesOfDay(d: Date): number {
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + SYSTEM_UTC_OFFSET_MINUTES) % (24 * 60);
}

/** Current instant, stored in UTC (RFC3339 `Z`). Ordering-safe canonical form. */
export function nowISO(): string {
  return new Date().toISOString();
}

/** 'YYYY-MM-DD' business date in JST for `iso` (default: now). */
export function businessDateJST(iso?: string): string {
  const ms = iso ? Date.parse(iso) : Date.now();
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** JST business date for now. */
export function todayJST(): string {
  return businessDateJST();
}

/**
 * Parse an RFC3339 timestamp to epoch ms, interpreting an **offset-less** string
 * as JST (the system timezone) rather than UTC. Returns `NaN` if unparseable.
 * Timestamps that carry an explicit offset (`Z` or `±HH:MM`) are respected as-is
 * (the instant is unambiguous).
 */
export function parseSystemTime(s: string): number {
  const t = s.trim();
  const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(t);
  return Date.parse(hasOffset ? t : `${t}${SYSTEM_UTC_OFFSET}`);
}
