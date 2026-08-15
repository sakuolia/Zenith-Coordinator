/**
 * @file STANDARD lane processing. Async multi-step flow: PreCheck -> H-Reserve
 *       -> Authorization -> Decision -> Debit -> Credit -> Settle.
 *
 * Migrated to use `transitionWithLog` / `cancelInFlightTx` so each state
 * advance is validated against `ALLOWED_TRANSITIONS` and atomically logged.
 *
 * @module zc/lanes/standard
 */
import type { Env, PaymentInitiatedRequest } from "../../types";
import { nowISO } from "../../types";
import { callBankNameCheck, callBankReleaseReserve } from "../orchestrator";
import { authorityCheckOrMarkPending } from "./_authority_check";
import { transitionWithLog, cancelInFlightTx } from "./_helpers";
import { mandatePrecheckOrSuspend } from "./_mandate_precheck";
import { reserveFundsForDebit } from "./_reserve_funds";
import { decideToSettleAndEnqueueDebit } from "./_decide_and_enqueue";
import { makeRequestId, REQUEST_PREFIX } from "../../shared/request-id";

export interface StandardIngressResult {
  result: "INGRESS_ACCEPTED";
  txid: string;
  state: "RECEIVED";
}

/**
 * Standard lane intake: return RECEIVED (synchronous)
 * Subsequent processing (PreCheck → NameCheck → AuthorityCheck) runs asynchronously via the queue
 */
export function processStandardIngress(req: PaymentInitiatedRequest): StandardIngressResult {
  return { result: "INGRESS_ACCEPTED", txid: req.txid, state: "RECEIVED" };
}

/**
 * Standard asynchronous processing: RECEIVED → PRECHECKED → (PRECHECKED_SUSPENDED) → H_RESERVED → DECIDED_TO_SETTLE
 * Called from the queue consumer
 */
export async function advanceStandard(txid: string, env: Env): Promise<void> {
  const db = env.DB;

  const tx = await db.prepare(`SELECT * FROM Transactions WHERE txid = ?`).bind(txid).first<{
    state: string;
    payer_bank_id: string;
    payee_bank_id: string;
    amount_value: number;
    pspr_ref: string | null;
    payer_account_hash: string;
    payee_account_hash: string | null;
    version: number;
    expires_at: string | null;
    purpose: string | null;
    mandate_id: string | null;
    lane: string;
  }>();
  if (!tx) return;
  if (tx.state !== "RECEIVED") return; // Already advanced

  // 1. PRECHECKED
  const prechecked = await transitionWithLog(db, {
    txid,
    fromState: "RECEIVED",
    toState: "PRECHECKED",
    eventType: "PreCheckPassed",
    payload: { txid },
  });
  if (!prechecked.applied) return; // Another call already performed the transition first

  // 1b. Mandate check (Theme B: delegated-mandate scoping) — see express.ts
  // for rationale. Breaches suspend the transaction rather than hard-rejecting.
  if (
    (
      await mandatePrecheckOrSuspend(db, {
        txid,
        mandate_id: tx.mandate_id,
        amount_value: tx.amount_value,
        purpose: tx.purpose,
        lane: tx.lane,
      })
    ).suspended
  ) {
    return;
  }

  // 2. AML Authority Check. A non-verdict parks the tx in PRECHECKED under
  // T_auth rather than letting it through (src/zc/lanes/_authority_check.ts).
  const auth = await authorityCheckOrMarkPending(env, {
    txid,
    payerBankId: tx.payer_bank_id,
  });
  if (auth.outcome === "PENDING") return;
  if (auth.outcome === "NG") {
    await cancelInFlightTx(db, {
      txid,
      reasonCode: auth.reason_code,
      fromStates: ["PRECHECKED"],
    });
    return;
  }

  // 3. Name Check (Standard presents account info → account holder name result)
  const nameResult = await callBankNameCheck(
    tx.payee_bank_id,
    {
      request_id: makeRequestId(REQUEST_PREFIX.NAME_CHECK, txid),
      txid,
      pspr_ref: tx.pspr_ref ?? undefined,
      account_hash: tx.payee_account_hash ?? "",
    },
    env
  );
  if (nameResult.result === "MISMATCH") {
    // Transition the account holder name verification result to PRECHECKED_SUSPENDED and wait (customer final confirmation)
    await transitionWithLog(db, {
      txid,
      fromState: "PRECHECKED",
      toState: "PRECHECKED_SUSPENDED",
      eventType: "PreCheckSuspended",
      payload: { reason_code: "SUSPEND_NAMECHECK_PENDING" },
      setColumns: { reason_code: "SUSPEND_NAMECHECK_PENDING" },
    });
    return;
  }

  // 4-5. H reservation → H_RESERVED → Bank reserve-funds (shared via helper).
  // STANDARD scopes each cancel to a single state (matching the prior guards).
  const reserve = await reserveFundsForDebit(db, env, {
    txid,
    payerBankId: tx.payer_bank_id,
    amount: { value: tx.amount_value, currency: "JPY" },
    payerAccountHash: tx.payer_account_hash,
    hReserveCancelFromStates: ["PRECHECKED"],
    reserveFundsCancelFromStates: ["H_RESERVED"],
  });
  if (!reserve.ok) return;

  // 6. Awaiting payer final authorization (Standard-specific)
  // A REFUND purpose (Reversal TX) originates from OPS and has no natural approver, so it is auto-authorized.
  // Other transactions wait in the H_RESERVED state until the originating bank (or customer) calls
  // POST /api/transfers/:txid/authorize.
  // Core principle: ZC is not a decision maker but a state relay. The final authorization of a transfer is delegated to the originating bank.
  if (tx.purpose === "REFUND") {
    await authorizeStandard(txid, true, env);
  }
}

/**
 * Called from the /authorize endpoint: H_RESERVED → DECIDED_TO_SETTLE
 */
export async function authorizeStandard(
  txid: string,
  authorized: boolean,
  env: Env
): Promise<{ ok: boolean; state: string; decision_proof_ref?: string }> {
  const db = env.DB;
  const now = nowISO();

  const tx = await db
    .prepare(
      `SELECT state, payer_bank_id, payee_bank_id, amount_value, h_reservation_id, version FROM Transactions WHERE txid = ?`
    )
    .bind(txid)
    .first<{
      state: string;
      payer_bank_id: string;
      payee_bank_id: string;
      amount_value: number;
      h_reservation_id: string | null;
      version: number;
    }>();
  if (!tx || tx.state !== "H_RESERVED") return { ok: false, state: tx?.state ?? "NOT_FOUND" };

  if (!authorized) {
    await cancelInFlightTx(db, { txid, reasonCode: "CANCEL_BY_PAYER", fromStates: ["H_RESERVED"] });
    // On H_RESERVED cancellation, reserve-funds already succeeded, so release the bank's segregated deposit
    const suspense = await db
      .prepare(
        `SELECT suspense_id FROM SuspenseDetails WHERE txid=? AND bank_id=? AND status='RESERVED' AND direction='PAY' LIMIT 1`
      )
      .bind(txid, tx.payer_bank_id)
      .first<{ suspense_id: string }>();
    if (suspense) {
      await callBankReleaseReserve(
        tx.payer_bank_id,
        {
          request_id: makeRequestId(REQUEST_PREFIX.CANCEL_RELEASE, txid),
          txid,
          reservation_ref: suspense.suspense_id,
        },
        env
      ).catch((e) => console.error(`[authorizeStandard] release-reserve failed: ${e}`));
    }
    return { ok: true, state: "DECIDED_CANCEL" };
  }

  // Finalize Decision + enqueue debit (shared with EXPRESS via helper).
  const decision = await decideToSettleAndEnqueueDebit(db, env, {
    txid,
    payerBankId: tx.payer_bank_id,
    payeeBankId: tx.payee_bank_id,
    amount: { value: tx.amount_value, currency: "JPY" },
    reservationId: tx.h_reservation_id,
    now,
  });
  if (!decision.decided) {
    return { ok: false, state: decision.previousState ?? "STATE_CONFLICT" };
  }

  return { ok: true, state: "DECIDED_TO_SETTLE", decision_proof_ref: decision.decisionProofRef };
}

/**
 * Resume after an account holder name mismatch suspension: PRECHECKED_SUSPENDED → PRECHECKED → H_RESERVED
 * Runs when the originating bank calls /resume-namecheck after customer confirmation.
 */
export async function resumeFromNameCheckSuspended(
  txid: string,
  env: Env
): Promise<{ ok: boolean; state: string }> {
  const db = env.DB;

  const tx = await db.prepare(`SELECT * FROM Transactions WHERE txid = ?`).bind(txid).first<{
    state: string;
    payer_bank_id: string;
    amount_value: number;
    payer_account_hash: string;
    mandate_id: string | null;
    purpose: string | null;
    lane: string;
    version: number;
  }>();
  if (!tx) return { ok: false, state: "NOT_FOUND" };
  if (tx.state !== "PRECHECKED_SUSPENDED") return { ok: false, state: tx.state };

  // PRECHECKED_SUSPENDED → PRECHECKED (account holder name check override approval)
  const resumed = await transitionWithLog(db, {
    txid,
    fromState: "PRECHECKED_SUSPENDED",
    toState: "PRECHECKED",
    eventType: "NameCheckOverridden",
    payload: { txid },
    setColumns: { reason_code: null },
  });
  if (!resumed.applied) return { ok: false, state: "STATE_CONFLICT" };

  // Re-verify the mandate on resume (Theme B). A name-check suspension can sit
  // for an arbitrary time awaiting customer confirmation; the mandate may have
  // been revoked or expired meanwhile. Re-check before re-committing funds —
  // a breach re-suspends (PRECHECKED → PRECHECKED_SUSPENDED + Case).
  if (
    (
      await mandatePrecheckOrSuspend(db, {
        txid,
        mandate_id: tx.mandate_id,
        amount_value: tx.amount_value,
        purpose: tx.purpose,
        lane: tx.lane,
      })
    ).suspended
  ) {
    return { ok: false, state: "PRECHECKED_SUSPENDED" };
  }

  // H reservation → H_RESERVED → Bank reserve-funds (shared via helper).
  const reserve = await reserveFundsForDebit(db, env, {
    txid,
    payerBankId: tx.payer_bank_id,
    amount: { value: tx.amount_value, currency: "JPY" },
    payerAccountHash: tx.payer_account_hash,
    hReserveCancelFromStates: ["PRECHECKED"],
    reserveFundsCancelFromStates: ["H_RESERVED"],
  });
  if (!reserve.ok) {
    // H_TRANSITION lost the CAS (no cancel); H_RESERVE / RESERVE_FUNDS already cancelled.
    return reserve.stage === "H_TRANSITION"
      ? { ok: false, state: "STATE_CONFLICT" }
      : { ok: true, state: "DECIDED_CANCEL" };
  }

  return { ok: true, state: "H_RESERVED" };
}
