/**
 * @file HTLC fulfill core — HtlcFulfillResult + settleAfterPreimage, the shared
 *       settlement path once a preimage/attestation has been verified. Used by
 *       claim.ts and crosschain.ts.
 * @module zc/lanes/htlc/_fulfill
 */
import type { Env, HtlcContractRow } from "../../../types";
import { makeRequestId, REQUEST_PREFIX } from "../../../shared/request-id";
import { nowISO, businessDateJST, SYSTEM_UTC_OFFSET } from "../../../types";
import {
  callBankAuthorityCheck,
  callBankExecuteDebit,
  onPayerExecConfirmed,
  suspendTx,
} from "../../orchestrator";
import { transitionWithLog, OWNER_CHAIN_DEFAULT } from "../_helpers";
import { writeFinalityLog } from "../../orchestrator/finality";
import { newDecisionProofRef, newFinalityLogRef } from "../../../shared/proof";
import { lockH } from "../../liquidity/h_model";
import { getOrCreateDnsCycle } from "../../settlement/dns";
import { cancelHtlc } from "./cancel";

export interface HtlcFulfillResult {
  result: "ACCEPTED" | "REJECTED";
  htlc_id: string;
  state: string;
  reason_code?: string;
}

/**
 * Shared settlement path once a preimage has been verified against
 * `hashlock`: `fromState` → HTLC_FULFILL_REQUESTED → DECIDED_TO_SETTLE,
 * lockH, synchronous debit.
 *
 * Used by both `claimHtlc` (payee presents the preimage directly to ZC) and
 * `recordOnchainFulfillment` (テーマA: Watcher observes the preimage revealed
 * on the onchain escrow). The two paths share the same secret_hash →
 * settlement contract, so the same FULFILL_REQUESTED/DECIDED_TO_SETTLE/debit
 * sequence applies regardless of which side first reveals the preimage.
 */
export async function settleAfterPreimage(
  htlc: HtlcContractRow,
  fromState: "HTLC_LOCKED" | "HTLC_ONCHAIN_PENDING",
  fulfillEventType: string,
  fulfillPayloadExtra: Record<string, unknown>,
  fulfillSideUpdate: { sql: string; binds: Array<string | number | null> },
  env: Env
): Promise<HtlcFulfillResult> {
  const db = env.DB;
  const now = nowISO();

  // 単一所有者則: an HTLC_ONCHAIN_PENDING row is owned by the Watcher set
  // (stamped at recordCrossChainLock), so its exits — the fulfill transition
  // below and the recheck-NG cancel — are issued as 'CHAIN:default' and hand
  // ownership back to ZC in the same batch. The direct-claim path
  // (HTLC_LOCKED) is ZC-owned throughout.
  const isChainOwned = fromState === "HTLC_ONCHAIN_PENDING";
  const issuer = isChainOwned ? OWNER_CHAIN_DEFAULT : "ZC";

  // timelock is on or after the next (JST) business day → AML recheck
  const endOfToday = new Date(`${businessDateJST(now)}T23:59:59${SYSTEM_UTC_OFFSET}`);
  const needsRecheck = new Date(htlc.timelock) > endOfToday;
  if (needsRecheck) {
    const recheckResult = await callBankAuthorityCheck(
      htlc.payer_bank_id,
      {
        request_id: makeRequestId(REQUEST_PREFIX.RECHECK, htlc.txid),
        txid: htlc.txid,
        check_type: "RECHECK",
      },
      env
    );
    if (recheckResult.result === "NG") {
      await cancelHtlc(htlc.htlc_id, htlc.txid, "RECHECK_AUTHORITY_NG", db, env, issuer);
      return {
        result: "REJECTED",
        htlc_id: htlc.htlc_id,
        state: "DECIDED_CANCEL",
        reason_code: "RECHECK_AUTHORITY_NG",
      };
    }
    if (recheckResult.result !== "OK") {
      // No verdict — the payer bank's circuit is OPEN, or its ingress answered
      // with neither verdict. Settling here would mean releasing funds through a
      // screening step that never ran, which is the same fail-open the
      // pre-decision path closed with T_auth (docs/specs/20_method_design.md §3.3.1):
      // an unreachable screening host must not have the same effect as a clean
      // pass.
      //
      // **Refuse the claim; change nothing.** The claim path has no wait state to
      // park in, and inventing one would race the timelock — so the answer is to
      // leave the HTLC exactly as it was and let the claimant retry. That is not
      // a hidden deadline: this recheck only runs when the timelock reaches past
      // the end of the current business day (`needsRecheck` above), so a refused
      // claim has, by construction, the rest of the day or more to succeed. If
      // the bank never recovers, the outer timelock cancels and refunds the
      // payer — the same backstop that already governs an unclaimed HTLC.
      //
      // The residual risk is real and belongs to the cross-chain case: a payee
      // that already revealed the preimage on the other chain has given up its
      // secret and can only wait for the retry to land. That risk is accepted
      // deliberately — it is bounded by the timelock and recoverable by retry,
      // whereas settling to an unscreened party is neither.
      //
      // No CASE is opened from here: the claimant may retry every few seconds,
      // and bank unreachability already surfaces through the circuit breaker.
      const detail = (recheckResult as { reason_code?: string }).reason_code ?? "NO_VERDICT";
      console.warn(
        `[htlc/fulfill] AML recheck returned no verdict for htlc=${htlc.htlc_id} ` +
          `bank=${htlc.payer_bank_id} (${detail}) — refusing the claim, state unchanged`
      );
      // Evidence without a transition, exactly as an INVALID_PREIMAGE rejection
      // records itself (claim.ts): the refusal to settle is itself an auditable
      // act, and for an AML step it is the one a supervisor will ask about.
      await writeFinalityLog(db, {
        txid: htlc.txid,
        event_type: "HtlcClaimRejected",
        state_from: fromState,
        state_to: fromState,
        payload_json: JSON.stringify({
          htlc_id: htlc.htlc_id,
          reason_code: "RECHECK_AUTHORITY_UNAVAILABLE",
          detail,
        }),
        txid_or_gtid: htlc.txid,
      });
      return {
        result: "REJECTED",
        htlc_id: htlc.htlc_id,
        state: htlc.state,
        reason_code: "RECHECK_AUTHORITY_UNAVAILABLE",
      };
    }
  }

  // fromState → HTLC_FULFILL_REQUESTED via transitionWithLog. HtlcContracts
  // CAS rides in the same batch so the two state rows stay in lockstep.
  const fulfillReq = await transitionWithLog(db, {
    txid: htlc.txid,
    fromState,
    toState: "HTLC_FULFILL_REQUESTED",
    eventType: fulfillEventType,
    issuer,
    payload: { htlc_id: htlc.htlc_id, ...fulfillPayloadExtra },
    ...(isChainOwned ? { setColumns: { owner: "ZC" } } : {}),
    sideUpdates: [fulfillSideUpdate],
  });
  if (!fulfillReq.applied) {
    return {
      result: "REJECTED",
      htlc_id: htlc.htlc_id,
      state: fulfillReq.previousState ?? "NOT_FOUND",
      reason_code: "INVALID_STATE",
    };
  }

  // set dns_cycle_id
  const decisionProofRef = newDecisionProofRef();
  const finalityLogRef = newFinalityLogRef();
  const dnsCycleId = await getOrCreateDnsCycle(db, now);

  // HTLC_FULFILL_REQUESTED → DECIDED_TO_SETTLE. HtlcContracts CAS (and the
  // secret_verified flip) is appended as a side update so it commits atomically
  // with the canonical state advance.
  const decided = await transitionWithLog(db, {
    txid: htlc.txid,
    fromState: "HTLC_FULFILL_REQUESTED",
    toState: "DECIDED_TO_SETTLE",
    eventType: "DecidedToSettle",
    payload: { htlc_id: htlc.htlc_id, decision_proof_ref: decisionProofRef },
    setColumns: {
      decision_proof_ref: decisionProofRef,
      finality_log_ref: finalityLogRef,
      dns_cycle_id: dnsCycleId,
    },
    sideUpdates: [
      {
        sql: `UPDATE HtlcContracts SET state='DECIDED_TO_SETTLE', secret_verified=1, version=version+1, updated_at=? WHERE htlc_id=? AND state='HTLC_FULFILL_REQUESTED'`,
        binds: [now, htlc.htlc_id],
      },
    ],
  });
  if (decided.applied) {
    // lockH runs after a successful DECIDED_TO_SETTLE transition
    const txForH = await db
      .prepare(`SELECT h_reservation_id FROM Transactions WHERE txid = ?`)
      .bind(htlc.txid)
      .first<{ h_reservation_id: string | null }>();
    if (txForH?.h_reservation_id) {
      await lockH(txForH.h_reservation_id, db);
    }
  }

  // Since HTLC has a timelock, run debit synchronously to avoid queue delay risk
  const bankResp = await callBankExecuteDebit(
    htlc.payer_bank_id,
    {
      request_id: makeRequestId(REQUEST_PREFIX.EXECUTE_DEBIT, htlc.txid),
      txid: htlc.txid,
      amount: { value: htlc.amount_value, currency: "JPY" },
      decision_proof_ref: decisionProofRef,
    },
    env
  );

  if (bankResp.result === "OK") {
    await onPayerExecConfirmed(htlc.txid, JSON.stringify(bankResp.bank_proof_ref), env);
    return { result: "ACCEPTED", htlc_id: htlc.htlc_id, state: "PAYER_EXEC_CONFIRMED" };
  } else {
    await suspendTx(htlc.txid, "EXEC_DEBIT_FAILED", db);
    return {
      result: "REJECTED",
      htlc_id: htlc.htlc_id,
      state: "SUSPENDED",
      reason_code: "EXEC_DEBIT_FAILED",
    };
  }
}
