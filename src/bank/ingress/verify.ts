/**
 * @module bank/ingress/verify
 * @description Verification ingress commands: authority-check (6),
 * name-check (7), account-verify (8). Read-only checks (no idempotency/audit
 * bookkeeping) used during pre-decision screening.
 */
import type {
  Env,
  AuthorityCheckRequest,
  AuthorityCheckResponse,
  BankAccountVerifyIngressRequest,
  BankAccountVerifyIngressResponse,
  NameCheckRequest,
  NameCheckResponse,
} from "../../types";
import { getAccountByHash } from "../suspense";

/**
 * **Command 6: authority-check** — AML/sanctions screening (mock: always OK).
 *
 * In production, this would integrate with the bank's compliance engine
 * to perform anti-money laundering and sanctions list screening. The mock
 * implementation always returns OK.
 *
 * @param bankId - Bank identifier
 * @param req    - Contains txid, check_type
 * @param env    - Worker environment bindings
 * @returns AuthorityCheckResponse with result OK
 */
export async function bankAuthorityCheck(
  bankId: string,
  req: AuthorityCheckRequest,
  _env: Env
): Promise<AuthorityCheckResponse> {
  console.log(`[bank/${bankId}] authority-check txid=${req.txid} type=${req.check_type}`);
  return { result: "OK" };
}

/**
 * **Command 7: name-check** — Payee name verification.
 *
 * Verifies that the payee account exists and is transferable (SAVINGS or
 * CURRENT type only; system accounts like SUSPENSE/ZCS/CASH/BOJ are
 * rejected). Supports two resolution modes:
 *   - By PSPR reference (proxy payment service provider registry)
 *   - By account_hash (direct account lookup)
 *
 * Returns the customer_name on MATCH for UI display.
 *
 * @param bankId - Payee bank identifier
 * @param req    - Contains account_hash or pspr_ref
 * @param env    - Worker environment bindings
 * @returns NameCheckResponse with result MATCH or MISMATCH, plus customer_name
 */
export async function bankNameCheck(
  bankId: string,
  req: NameCheckRequest,
  env: Env
): Promise<NameCheckResponse & { customer_name?: string }> {
  const db = env.DB;
  if (req.pspr_ref) {
    const pspr = await db
      .prepare(`SELECT pspr_ref FROM PsprRegistry WHERE pspr_ref=? AND capability_state='ACTIVE'`)
      .bind(req.pspr_ref)
      .first();
    if (!pspr) return { result: "MISMATCH", reason_code: "PSPR_NOT_FOUND" };
    return { result: "MATCH" };
  }
  if (req.account_hash) {
    const account = await getAccountByHash(bankId, req.account_hash, db);
    if (!account) return { result: "MISMATCH", reason_code: "NAME_MISMATCH" };
    // System accounts (segregated deposit, settlement account, cash, BOJ) cannot be used for transfers
    // SAVINGS (individual ordinary account) and CURRENT (corporate current account) can receive credits
    if (account.account_type !== "SAVINGS" && account.account_type !== "CURRENT") {
      return { result: "MISMATCH", reason_code: "ACCOUNT_NOT_TRANSFERABLE" };
    }
    return { result: "MATCH", customer_name: account.customer_name };
  }
  // If neither pspr_ref nor account_hash is specified, account holder name matching is impossible
  // Fail safe and return MISMATCH (per spec, account holder name verification is a required step)
  return { result: "MISMATCH", reason_code: "NO_IDENTIFIER_PROVIDED" };
}

/**
 * **Command 8: account-verify** — Account existence and name matching.
 *
 * Looks up the target account by hash and compares the provided name against
 * the stored customer_name using Levenshtein distance:
 *   - Exact match: score 1.0, result MATCHED
 *   - Edit distance <= 1: score 0.8, result MATCHED (typo tolerance)
 *   - Otherwise: score 0.0, result MISMATCHED
 *
 * Only SAVINGS accounts are considered valid targets. If no name is provided,
 * returns MATCHED (account-existence-only check).
 *
 * @param bankId - Bank identifier to search
 * @param req    - Contains target_account_hash, optional target_account_name
 * @param env    - Worker environment bindings
 * @returns Object with result, match_score, name_provided, fraud_warning
 */
export async function bankAccountVerify(
  bankId: string,
  req: BankAccountVerifyIngressRequest,
  env: Env
): Promise<BankAccountVerifyIngressResponse> {
  const db = env.DB;

  // Account lookup
  const account = await getAccountByHash(bankId, req.target_account_hash, db);
  if (!account || account.account_type !== "SAVINGS") {
    return {
      result: "NOT_FOUND",
      match_score: 0.0,
      name_provided: req.target_account_name ?? null,
      fraud_warning: false,
    };
  }

  // If the account holder name is not specified, return MATCHED rather than NOT_FOUND (account existence check only)
  if (!req.target_account_name) {
    return { result: "MATCHED", match_score: 1.0, name_provided: null, fraud_warning: false };
  }

  const provided = req.target_account_name;
  const stored = account.customer_name;

  // Exact match
  if (provided === stored) {
    return { result: "MATCHED", match_score: 1.0, name_provided: provided, fraud_warning: false };
  }

  // Partial match within one character (edit distance <= 1)
  if (isEditDistanceAtMostOne(provided, stored)) {
    return { result: "MATCHED", match_score: 0.8, name_provided: provided, fraud_warning: false };
  }

  return { result: "MISMATCHED", match_score: 0.0, name_provided: provided, fraud_warning: false };
}

/**
 * Determine whether the edit distance (Levenshtein) is 1 or less in O(n) time and O(1) extra memory.
 *
 * Since account-verify only uses "exact match or one-character difference" in its decision,
 * there is no need to build the full DP table. If the length difference is 2 or more it is immediately false,
 * and only when the length difference is 0 or 1 is it determined in a single scan.
 *
 * Complexity:
 *   - Original DP implementation: O(m*n) time, O((m+1)(n+1)) heap allocation
 *   - This implementation       : O(min(m,n)) time, zero allocation
 *
 * @returns true if the edit distance is 1 or less
 */
function isEditDistanceAtMostOne(a: string, b: string): boolean {
  const m = a.length;
  const n = b.length;
  const diff = m - n;
  if (diff > 1 || diff < -1) return false;

  if (m === n) {
    // Same length: allow at most one differing character
    let mismatches = 0;
    for (let i = 0; i < m; i++) {
      if (a.charCodeAt(i) !== b.charCodeAt(i)) {
        if (++mismatches > 1) return false;
      }
    }
    return true;
  }

  // Length difference 1: determine whether the shorter side is a one-character-deletion subsequence of the longer side
  const longer = m > n ? a : b;
  const shorter = m > n ? b : a;
  const longLen = longer.length;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < longLen && j < shorter.length) {
    if (longer.charCodeAt(i) === shorter.charCodeAt(j)) {
      i++;
      j++;
    } else {
      if (skipped) return false;
      skipped = true;
      i++;
    }
  }
  return true;
}
