/**
 * @file api/bank-ingress.ts — ZC→Bank ingress command request/response types
 *       (reserve/debit/credit/release/leg-ready/authority/name-check),
 *       plus bank-side account-verify, credit-notify, rtp-notify, and IGS.
 * @module types/api/bank-ingress
 */
import type { Amount, BankProofRef } from "../primitives";
import type { LaneType } from "../states";

// reserve-funds
export interface ReserveFundsRequest {
  request_id: string;
  txid: string;
  amount: Amount;
  account_hash: string;
}

export type ReserveFundsResponse =
  | { result: "RESERVED"; reservation_ref: string }
  | { result: "ERROR"; reason_code: string };

// execute-debit
export interface ExecuteDebitRequest {
  request_id: string;
  txid: string;
  amount: Amount;
  decision_proof_ref: string;
  h_reservation?: { reservation_id: string; mode: "RESERVED" | "LOCKED" };
  execution_deadline?: string;
  lane?: LaneType;
  payer_account_hash?: string;
}

export interface ExecuteDebitResponse {
  result: "OK";
  bank_proof_ref: BankProofRef;
}

// execute-credit
export interface ExecuteCreditRequest {
  request_id: string;
  txid: string;
  amount: Amount;
  decision_proof_ref: string;
  payee_account_hash?: string;
}

export interface ExecuteCreditResponse {
  result: "OK";
  bank_proof_ref: BankProofRef;
}

// release-reserve
export interface ReleaseReserveRequest {
  request_id: string;
  txid: string;
  reservation_ref: string;
}

export interface ReleaseReserveResponse {
  result: "RELEASED";
  reservation_ref: string;
}

// leg-ready-check
export interface LegReadyCheckRequest {
  request_id: string;
  gtid: string;
  leg_id: string;
  role: "PAYER" | "PAYEE";
  amount: Amount;
  account_hash: string;
}

export type LegReadyCheckResponse =
  | { result: "OK"; reservation_ref?: string }
  | { result: "NG"; reason_code: string };

// authority-check
export interface AuthorityCheckRequest {
  request_id: string;
  txid: string;
  check_type: "INITIAL" | "RECHECK";
  vault_ref?: string;
}

export type AuthorityCheckResponse = { result: "OK" } | { result: "NG"; reason_code: string };

// name-check
export interface NameCheckRequest {
  request_id: string;
  txid: string;
  pspr_ref?: string;
  account_hash: string;
}

export type NameCheckResponse = { result: "MATCH" } | { result: "MISMATCH"; reason_code: string };

// ---------------------------------------------------------------------------
// Bank Ingress: account-verify / credit-notify / rtp-notify
//
// These three commands cross the same ZC→Bank seam as the ones above, but their
// types used to be declared twice — once here (consumed by the ZC caller) and
// once inside `src/bank/ingress/*.ts` (consumed by the handler) — with
// *different field names*. Nothing made the two halves meet, so the compiler
// could not see the drift: `account-verify` shipped with the caller sending
// `{account_id, name_to_verify}` while the handler read
// `{target_account_hash, target_account_name}`, i.e. the command could never
// resolve an account. The declarations below are now the single source for
// both ends — the handlers import them, so any future drift is a type error.
// ---------------------------------------------------------------------------

// account-verify
export interface BankAccountVerifyIngressRequest {
  request_id: string;
  verification_id: string;
  target_account_hash: string;
  /** Name to match against the account holder. Omit for existence-only check. */
  target_account_name?: string;
}

/**
 * The bank echoes back the *provided* name, never the name it holds on file —
 * returning the stored name would turn this command into a name-harvesting
 * oracle over account numbers (`32_api_contracts.md § account-verify`).
 */
export type BankAccountVerifyIngressResponse = {
  result: "MATCHED" | "MISMATCHED" | "NOT_FOUND";
  match_score: number;
  name_provided: string | null;
  fraud_warning: boolean;
};

// credit-notify
export interface BankCreditNotifyIngressRequest {
  request_id: string;
  notification_id: string;
  txid: string;
  payee_account_hash: string;
  amount: Amount;
  payer_bank_id: string;
  payer_name_masked?: string;
  purpose?: string | null;
  edi_summary?: string;
}

// rtp-notify
export interface BankRtpNotifyIngressRequest {
  request_id: string;
  rtp_id: string;
  payee_bank_id: string;
  payer_bank_id: string;
  amount: Amount;
  expires_at: string;
  payee_name?: string;
  description?: string;
}

// debit-settled
/**
 * Settlement acknowledgement sent back to the payer bank once the payee credit
 * has landed. Declared here rather than beside its handler for the reason given
 * above: the ZC caller (`zc/orchestrator.ts`) built this body as a bare object
 * literal passed into `handleBankIngress(payload: unknown)`, so nothing tied the
 * two ends together — the same shape of hole that made `account-verify` dead.
 */
export interface BankDebitSettledRequest {
  request_id: string;
  txid: string;
  amount: Amount;
  payee_bank_id: string;
  settled_at: string;
}

// initialize-bank
export interface BankInitializeRequest {
  request_id?: string;
  /** BOJ prefunding booked at initialization. Defaults to 100 billion yen. */
  boj_prefund?: number;
}

// cleanup-bank
/** `cleanup-bank` is addressed by `bankId` alone and carries no body. */
export type BankCleanupRequest = Record<string, never>;

// ---------------------------------------------------------------------------
// The command registry
//
// `10_requirements.md` §7.2.1 fixes the thirteen commands ZC requires of a core
// banking system. The dispatcher (`bank/ingress.ts`) takes `command: string` and
// `payload: unknown` because the HTTP entry point receives both off the wire, so
// the compiler cannot police that boundary by itself. What it *can* police is
// that both ends name the same type — provided there is one name to share. That
// is what this map is: the single place a command's body shape is declared, and
// the list the seam tests are driven from (`test/integration/ingress_commands.test.ts`
// fails if a command is added without one).
// ---------------------------------------------------------------------------

/** The thirteen ZC→Bank ingress commands, in the order of `10_requirements.md` §7.2.1. */
export const BANK_INGRESS_COMMANDS = [
  "reserve-funds",
  "execute-debit",
  "execute-credit",
  "release-reserve",
  "leg-ready-check",
  "authority-check",
  "name-check",
  "account-verify",
  "credit-notify",
  "rtp-notify",
  "debit-settled",
  "initialize-bank",
  "cleanup-bank",
] as const;

export type BankIngressCommand = (typeof BANK_INGRESS_COMMANDS)[number];

/** Command name → the request body both the ZC caller and the bank handler use. */
export interface BankIngressRequestMap {
  "reserve-funds": ReserveFundsRequest;
  "execute-debit": ExecuteDebitRequest;
  "execute-credit": ExecuteCreditRequest;
  "release-reserve": ReleaseReserveRequest;
  "leg-ready-check": LegReadyCheckRequest;
  "authority-check": AuthorityCheckRequest;
  "name-check": NameCheckRequest;
  "account-verify": BankAccountVerifyIngressRequest;
  "credit-notify": BankCreditNotifyIngressRequest;
  "rtp-notify": BankRtpNotifyIngressRequest;
  "debit-settled": BankDebitSettledRequest;
  "initialize-bank": BankInitializeRequest;
  "cleanup-bank": BankCleanupRequest;
}

// ---------------------------------------------------------------------------
// IGS API
// ---------------------------------------------------------------------------

export interface IgsRequestInput {
  ext_instruction_id: string;
  txid: string;
  payer_bank_id: string;
  payee_bank_id: string;
  amount: Amount;
  decision_proof_ref: string;
  a_proof_ref: string;
}

export interface IgsCallbackInput {
  ext_instruction_id: string;
  result: "SETTLED" | "FAILED" | "HOLD";
  boj_settle_ref?: string;
  reason?: string;
}
