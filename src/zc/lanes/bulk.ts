/**
 * @file BULK/DEFERRED lane processing. High-volume batch transfers settled via
 *       DNS cycle.
 * @module zc/lanes/bulk
 */
import type { Env, PaymentInitiatedRequest } from "../../types";
import { reserveH, lockH } from "../liquidity/h_model";
import { callBankReserveFunds } from "../orchestrator";
import { newDecisionProofRef, newFinalityLogRef } from "../../shared/proof";
import { transitionWithLog, cancelInFlightTx } from "./_helpers";
import { mandatePrecheckOrSuspend } from "./_mandate_precheck";
import { makeRequestId, REQUEST_PREFIX } from "../../shared/request-id";

export function processBulkIngress(req: PaymentInitiatedRequest) {
  return { result: "INGRESS_ACCEPTED" as const, txid: req.txid, state: "RECEIVED" as const };
}

/**
 * Bulk batch processing: RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE
 * Called from the EOD batch or the window cutoff cron
 */
export async function advanceBulk(txid: string, env: Env): Promise<void> {
  const db = env.DB;

  // 1. RECEIVED → PRECHECKED
  const precheck = await transitionWithLog(db, {
    txid,
    fromState: "RECEIVED",
    toState: "PRECHECKED",
    eventType: "PreCheckPassed",
    payload: { txid },
  });
  if (!precheck.applied) return;

  // payer_bank_id / amount / account_hash are read together after PRECHECKED
  const tx = await db
    .prepare(
      `SELECT payer_bank_id, amount_value, payer_account_hash, mandate_id, purpose FROM Transactions WHERE txid = ?`
    )
    .bind(txid)
    .first<{
      payer_bank_id: string;
      amount_value: number;
      payer_account_hash: string;
      mandate_id: string | null;
      purpose: string | null;
    }>();
  if (!tx) return;

  // 1b. Mandate scope check (Theme B): a delegated BULK instruction must stay
  // within its mandate's amount/purpose/lane scope. A breach suspends for review.
  if (
    (
      await mandatePrecheckOrSuspend(db, {
        txid,
        mandate_id: tx.mandate_id,
        amount_value: tx.amount_value,
        purpose: tx.purpose,
        lane: "BULK",
      })
    ).suspended
  ) {
    return;
  }

  // 2. H-reserve
  const hResult = await reserveH(tx.payer_bank_id, txid, tx.amount_value, db);
  if (!hResult.ok) {
    await cancelInFlightTx(db, {
      txid,
      reasonCode: hResult.reason,
      fromStates: ["PRECHECKED"],
      skipReleaseH: true,
    });
    return;
  }
  const reservationId = hResult.reservation_id;

  const reserved = await transitionWithLog(db, {
    txid,
    fromState: "PRECHECKED",
    toState: "H_RESERVED",
    eventType: "HReserved",
    payload: { reservation_id: reservationId },
    setColumns: { h_reservation_id: reservationId },
  });
  if (!reserved.applied) return;

  // 3. Bank-side reserve-funds (create SuspenseDetails RESERVED)
  // Prevents execute-debit from failing with RESERVATION_NOT_FOUND
  const reserveResult = await callBankReserveFunds(
    tx.payer_bank_id,
    {
      request_id: makeRequestId(REQUEST_PREFIX.RESERVE_FUNDS, txid),
      txid,
      amount: { value: tx.amount_value, currency: "JPY" },
      account_hash: tx.payer_account_hash,
    },
    env
  );
  if (reserveResult.result === "ERROR") {
    await cancelInFlightTx(db, {
      txid,
      reasonCode: reserveResult.reason_code ?? "RESERVE_FAILED",
      fromStates: ["H_RESERVED"],
    });
    return;
  }

  // 4. Finalize Decision (Bulk decides immediately)
  // dns_cycle_id is managed centrally by kickDns, so do not set it here
  const decisionProofRef = newDecisionProofRef();
  const finalityLogRef = newFinalityLogRef();
  const decided = await transitionWithLog(db, {
    txid,
    fromState: "H_RESERVED",
    toState: "DECIDED_TO_SETTLE",
    eventType: "DecidedToSettle",
    payload: { decision_proof_ref: decisionProofRef },
    setColumns: {
      decision_proof_ref: decisionProofRef,
      finality_log_ref: finalityLogRef,
    },
  });
  if (!decided.applied) return;

  // lockH on DECIDED_TO_SETTLE (H_RESERVED → LOCKED)
  await lockH(reservationId, db);

  // DNS Execution runs in bulk at EOD (not enqueued)
}
