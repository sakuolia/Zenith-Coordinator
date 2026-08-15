/**
 * @file _authority_check.ts — shared AML/sanctions (Authority Check) step and
 *       the start of the T_auth clock.
 *
 * Three outcomes, not two. The check answers OK or NG, but it can also fail to
 * answer at all: the payer bank's circuit is OPEN, or its ingress returned
 * something that is neither verdict. Every lane used to test `result === "NG"`
 * and fall through on anything else, so a payer bank that could not be reached
 * had the same effect on the transaction as a clean sanctions pass — the one
 * failure mode a screening step must not have. AML screening is fail-closed by
 * definition: no answer means the transaction does not advance.
 *
 * "Does not advance" is not "is cancelled", though. A circuit trips on transient
 * downstream trouble, and cancelling a legitimate transfer because the screening
 * host was briefly unreachable is its own customer-facing defect. So a
 * non-verdict parks the transaction where it already is — PRECHECKED — and
 * starts a clock:
 *
 *   **T_auth** (`20_method_design.md` §3.3.1): PRECHECKED → PRECHECKED_SUSPENDED
 *   with `reason_code='SUSPEND_AUTHORITY_PENDING'` once the wait exceeds the
 *   deadline. The sweep step lives in `src/cron/timeout_sweep.ts`.
 *
 * **Where the request time lives.** In `pending_since`, a column that exists for
 * exactly this. Marking the row writes `reason_code='SUSPEND_AUTHORITY_PENDING'`
 * and `pending_since=now` while leaving `state='PRECHECKED'`: the reason_code
 * selects the rows the sweep considers, `pending_since` is the clock it reads.
 *
 * This used to measure from `updated_at`, on the reasoning that a dedicated
 * column "buys nothing" since every other timer measured from `updated_at` too.
 * That reasoning was wrong, and wrong for all four timers rather than just this
 * one. `updated_at` moves on ANY write to the row, including writes that say
 * nothing about progress: `case_id` when a CASE is opened against the
 * transaction (src/zc/cases/case.ts), `edi_ref` when remittance data is linked
 * (src/zc/richdata/edi.ts). Neither carries a state guard, so opening a CASE on
 * a parked transaction — precisely what an operator does about a parked
 * transaction — pushed T_auth's deadline back, and repeated touches pushed it
 * back without bound. The row most in need of the timer is the one most likely
 * to be touched for another reason while it waits.
 *
 * That is the failure 有界時間内の検出 rules out
 * (docs/disclosure/CORE_DISCLOSURE.md【0013】(a)、【0124】4 and 請求項36, which
 * require the elapsed time to be computed from a column separate from the
 * general update-time column). `pending_since` is written only by the lane
 * helpers and by this file, so no incidental write can reach it.
 *
 * The marker is not a state change, so it does not (and must not) go through
 * `transitionWithLog`: PRECHECKED → PRECHECKED is not a transition, and inventing
 * one to carry a column write would put a phantom edge in ALLOWED_TRANSITIONS.
 * The audited event is the suspension the sweep writes when the clock runs out.
 *
 * @module zc/lanes/_authority_check
 */
import { makeRequestId, REQUEST_PREFIX } from "../../shared/request-id";
import type { Env } from "../../types";
import { nowISO } from "../../types";
import { callBankAuthorityCheck } from "../orchestrator";

/** `reason_code` marking a transaction as waiting for an Authority Check verdict. */
export const AUTHORITY_PENDING_REASON = "SUSPEND_AUTHORITY_PENDING";

export type AuthorityCheckOutcome =
  /** Screening passed — the caller advances the transaction. */
  | { outcome: "OK" }
  /** Screening rejected — the caller cancels, using `reason_code`. */
  | { outcome: "NG"; reason_code: string }
  /**
   * No verdict. The row has been marked as waiting and is left in PRECHECKED;
   * the caller stops advancing it and the T_auth sweep resolves the wait.
   */
  | { outcome: "PENDING"; reason_code: string };

export interface AuthorityCheckParams {
  txid: string;
  /** The payer bank runs the screening. */
  payerBankId: string;
  /** Optional Vault reference carrying the payer identity material. */
  vaultRef?: string;
}

/**
 * Run the INITIAL Authority Check for a transaction sitting in PRECHECKED.
 *
 * On a non-verdict the transaction is marked as awaiting the response (see the
 * file header) and `PENDING` is returned; the marking is CAS-guarded on
 * `state='PRECHECKED'`, so a row that moved on in the meantime is left alone.
 */
export async function authorityCheckOrMarkPending(
  env: Env,
  params: AuthorityCheckParams
): Promise<AuthorityCheckOutcome> {
  const result = await callBankAuthorityCheck(
    params.payerBankId,
    {
      request_id: makeRequestId(REQUEST_PREFIX.AUTHORITY_CHECK, params.txid),
      txid: params.txid,
      check_type: "INITIAL",
      ...(params.vaultRef ? { vault_ref: params.vaultRef } : {}),
    },
    env
  );

  if (result.result === "OK") return { outcome: "OK" };
  if (result.result === "NG") {
    return { outcome: "NG", reason_code: result.reason_code ?? "AUTHORITY_CHECK_NG" };
  }

  // Anything else is "the bank did not answer" — including the circuit breaker's
  // synthetic {result:'ERROR', reason_code:'CIRCUIT_OPEN'} (bank_hub.ts).
  const detail = (result as { reason_code?: string }).reason_code ?? "NO_VERDICT";
  console.warn(
    `[authority_check] no verdict for txid=${params.txid} bank=${params.payerBankId} ` +
      `(${detail}) — parking in PRECHECKED, T_auth is running`
  );
  await markAuthorityPending(env.DB, params.txid);
  return { outcome: "PENDING", reason_code: AUTHORITY_PENDING_REASON };
}

/**
 * Stamp the awaiting-verdict marker on a PRECHECKED row and (re)start T_auth.
 *
 * `pending_since` is the clock the sweep reads; `updated_at` is bumped too
 * because this is a write to the row like any other, but nothing measures from
 * it (see the file header). `version` is bumped so an optimistic-lock holder
 * sees the change; the state column is deliberately untouched.
 */
async function markAuthorityPending(db: D1Database, txid: string): Promise<void> {
  const now = nowISO();
  await db
    .prepare(
      `UPDATE Transactions
          SET reason_code = ?, updated_at = ?, pending_since = ?, version = version + 1
        WHERE txid = ? AND state = 'PRECHECKED'`
    )
    .bind(AUTHORITY_PENDING_REASON, now, now, txid)
    .run();
}
