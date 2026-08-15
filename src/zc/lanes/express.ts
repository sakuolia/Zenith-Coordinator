/**
 * @file EXPRESS lane processing. Synchronous end-to-end settlement within a
 *       single request: PreCheck -> H-Reserve -> Decision -> Debit -> Credit -> Settle.
 *
 * Migrated to use `transitionWithLog` / `cancelInFlightTx` so every state
 * advance is validated against `ALLOWED_TRANSITIONS` and batched atomically
 * with its FinalityLog entry.
 *
 * @module zc/lanes/express
 */
import type { Env, PaymentInitiatedRequest } from "../../types";
import { nowISO } from "../../types";
import { callBankNameCheck } from "../orchestrator";
import { authorityCheckOrMarkPending } from "./_authority_check";
import { transitionWithLog, cancelInFlightTx } from "./_helpers";
import { mandatePrecheckOrSuspend } from "./_mandate_precheck";
import { reserveFundsForDebit } from "./_reserve_funds";
import { decideToSettleAndEnqueueDebit } from "./_decide_and_enqueue";
import { isBankOpenNow } from "../platform/operating_window";
import { makeRequestId, REQUEST_PREFIX } from "../../shared/request-id";

export interface ExpressResult {
  result: "DECISION_ACCEPTED" | "DECISION_REJECTED";
  txid: string;
  state: string;
  decision_proof_ref?: string;
  reason_code?: string;
}

/**
 * Express lane: completes synchronously through Decision
 * RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE
 */
export async function processExpress(
  req: PaymentInitiatedRequest,
  env: Env
): Promise<ExpressResult> {
  const db = env.DB;
  const txid = req.txid;
  const now = nowISO();

  // 1. PRECHECKED — validated via transitionWithLog (ALLOWED_TRANSITIONS check + atomic log).
  const prechecked = await transitionWithLog(db, {
    txid,
    fromState: "RECEIVED",
    toState: "PRECHECKED",
    eventType: "PreCheckPassed",
    payload: { txid },
  });
  if (!prechecked.applied) {
    return {
      result: "DECISION_REJECTED",
      txid,
      state: prechecked.previousState ?? "NOT_FOUND",
      reason_code: "INVALID_STATE",
    };
  }

  // 1b. Mandate check (Theme B: delegated-mandate scoping) — when the
  // request carries a mandate_id, verify amount/purpose/lane are within the
  // delegated scope and the mandate is neither expired nor revoked. Breaches
  // do not hard-reject: they suspend the transaction for human/ops review.
  // Shared with every async lane via `mandatePrecheckOrSuspend`.
  const mandate = await mandatePrecheckOrSuspend(db, {
    txid,
    mandate_id: req.mandate_id ?? null,
    amount_value: req.amount.value,
    purpose: req.purpose ?? null,
    lane: req.lane,
  });
  if (mandate.suspended) {
    return {
      result: "DECISION_REJECTED",
      txid,
      state: "PRECHECKED_SUSPENDED",
      reason_code: mandate.reason_code,
    };
  }

  // 1c. Operating-window check (Theme E: 24/365 operating windows) — if
  // the payee bank has declared a daily operating window and it's currently
  // closed, suspend with an explainable independent wait state
  // (PRECHECKED_SUSPENDED + reason_code='COUNTERPARTY_WINDOW_CLOSED') rather
  // than hard-failing. The original request is snapshotted so the timeout
  // sweep can resume it once the window reopens.
  const payeeOpen = await isBankOpenNow(req.payee.bank_id, db, new Date(now));
  if (!payeeOpen) {
    await transitionWithLog(db, {
      txid,
      fromState: "PRECHECKED",
      toState: "PRECHECKED_SUSPENDED",
      eventType: "CounterpartyWindowClosed",
      payload: { reason_code: "COUNTERPARTY_WINDOW_CLOSED", payee_bank_id: req.payee.bank_id },
      setColumns: {
        reason_code: "COUNTERPARTY_WINDOW_CLOSED",
        pending_request_json: JSON.stringify(req),
      },
    });
    return {
      result: "DECISION_REJECTED",
      txid,
      state: "PRECHECKED_SUSPENDED",
      reason_code: "COUNTERPARTY_WINDOW_CLOSED",
    };
  }

  return continueExpressFromPrecheck(req, env, now);
}

/**
 * Continues the EXPRESS flow from PRECHECKED through settlement decision:
 * AML/Authority check -> Name check -> H-Reserve -> Decision -> Enqueue execution.
 * Shared by `processExpress` and `resumeSuspendedExpress`.
 */
async function continueExpressFromPrecheck(
  req: PaymentInitiatedRequest,
  env: Env,
  now: string
): Promise<ExpressResult> {
  const db = env.DB;
  const txid = req.txid;

  // 2. AML/Authority Check (payerBank). A non-verdict parks the tx in
  // PRECHECKED under T_auth rather than letting it through
  // (src/zc/lanes/_authority_check.ts). EXPRESS answers its caller
  // synchronously, so the wait is reported as a rejected decision with the
  // pending reason — the transfer has not been decided, and the T_auth sweep
  // is what moves it to PRECHECKED_SUSPENDED if no verdict arrives.
  const auth = await authorityCheckOrMarkPending(env, {
    txid,
    payerBankId: req.payer.bank_id,
    vaultRef: req.payer.vault_ref,
  });
  if (auth.outcome === "PENDING") {
    return {
      result: "DECISION_REJECTED",
      txid,
      state: "PRECHECKED",
      reason_code: auth.reason_code,
    };
  }
  if (auth.outcome === "NG") {
    await cancelInFlightTx(db, {
      txid,
      reasonCode: auth.reason_code,
    });
    return {
      result: "DECISION_REJECTED",
      txid,
      state: "DECIDED_CANCEL",
      reason_code: auth.reason_code,
    };
  }

  // 3. Name Check (via PSPR reference or payeeAccount)
  const nameResult = await callBankNameCheck(
    req.payee.bank_id,
    {
      request_id: makeRequestId(REQUEST_PREFIX.NAME_CHECK, txid),
      txid,
      pspr_ref: req.pspr_ref,
      account_hash: req.payee.account_hash ?? "",
    },
    env
  );
  if (nameResult.result === "MISMATCH") {
    await cancelInFlightTx(db, { txid, reasonCode: "NAME_MISMATCH" });
    return {
      result: "DECISION_REJECTED",
      txid,
      state: "DECIDED_CANCEL",
      reason_code: "NAME_MISMATCH",
    };
  }

  // 4-5. H reservation → H_RESERVED → Bank reserve-funds (shared via helper).
  // EXPRESS uses the default cancel `fromStates` (no overrides).
  const reserve = await reserveFundsForDebit(db, env, {
    txid,
    payerBankId: req.payer.bank_id,
    amount: req.amount,
    payerAccountHash: req.payer.account_hash,
  });
  if (!reserve.ok) {
    if (reserve.stage === "H_TRANSITION") {
      return {
        result: "DECISION_REJECTED",
        txid,
        state: reserve.previousState ?? "NOT_FOUND",
        reason_code: "CAS_LOST",
      };
    }
    return {
      result: "DECISION_REJECTED",
      txid,
      state: "DECIDED_CANCEL",
      reason_code: reserve.reasonCode,
    };
  }
  const reservationId = reserve.reservationId;

  // 6. Finalize Decision + enqueue debit (shared with STANDARD via helper).
  const decision = await decideToSettleAndEnqueueDebit(db, env, {
    txid,
    payerBankId: req.payer.bank_id,
    payeeBankId: req.payee.bank_id,
    amount: req.amount,
    reservationId,
    now,
  });
  if (!decision.decided) {
    return {
      result: "DECISION_REJECTED",
      txid,
      state: decision.previousState ?? "NOT_FOUND",
      reason_code: "CAS_LOST",
    };
  }

  return {
    result: "DECISION_ACCEPTED",
    txid,
    state: "DECIDED_TO_SETTLE",
    decision_proof_ref: decision.decisionProofRef,
  };
}

/**
 * Resumes an EXPRESS transaction suspended on COUNTERPARTY_WINDOW_CLOSED
 * (Theme E: 24/365 operating windows), once the payee bank's
 * operating window has reopened. Called from the per-minute timeout sweep.
 *
 * Returns `{ ok: false, state: "PRECHECKED_SUSPENDED" }` (no state change)
 * if the payee bank is still closed.
 */
export async function resumeSuspendedExpress(
  txid: string,
  env: Env
): Promise<{ ok: boolean; state: string }> {
  const db = env.DB;
  const tx = await db
    .prepare(`SELECT state, reason_code, pending_request_json FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: string; reason_code: string | null; pending_request_json: string | null }>();
  if (!tx) return { ok: false, state: "NOT_FOUND" };
  if (tx.state !== "PRECHECKED_SUSPENDED" || tx.reason_code !== "COUNTERPARTY_WINDOW_CLOSED") {
    return { ok: false, state: tx.state };
  }
  if (!tx.pending_request_json) return { ok: false, state: tx.state };

  const req: PaymentInitiatedRequest = JSON.parse(tx.pending_request_json);
  const now = nowISO();
  if (!(await isBankOpenNow(req.payee.bank_id, db, new Date(now)))) {
    return { ok: false, state: "PRECHECKED_SUSPENDED" };
  }

  const resumed = await transitionWithLog(db, {
    txid,
    fromState: "PRECHECKED_SUSPENDED",
    toState: "PRECHECKED",
    eventType: "CounterpartyWindowReopened",
    payload: { txid },
    setColumns: { reason_code: null, pending_request_json: null },
  });
  if (!resumed.applied) {
    return { ok: false, state: resumed.previousState ?? "STATE_CONFLICT" };
  }

  // Re-verify the mandate on resume (Theme B). A window-closed suspension can sit
  // for an arbitrary time (24/365 windows span hours/days); the mandate may have
  // been revoked or expired meanwhile. Re-check before settling — a breach
  // re-suspends (PRECHECKED → PRECHECKED_SUSPENDED + Case) instead of settling
  // outside the delegated authority.
  if (
    (
      await mandatePrecheckOrSuspend(db, {
        txid,
        mandate_id: req.mandate_id ?? null,
        amount_value: req.amount.value,
        purpose: req.purpose ?? null,
        lane: req.lane,
      })
    ).suspended
  ) {
    return { ok: false, state: "PRECHECKED_SUSPENDED" };
  }

  const result = await continueExpressFromPrecheck(req, env, now);
  return { ok: true, state: result.state };
}
