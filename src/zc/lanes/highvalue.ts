/**
 * @file HIGH_VALUE lane processing. Large-amount transfers with BOJ pre-fund
 *       checks and IGS settlement.
 *
 * Lane characteristics:
 *   - Bypasses H_RESERVED entirely (`PRECHECKED → DECIDED_TO_SETTLE` directly).
 *     This is the central-bank RTGS path: liquidity is checked against the
 *     payer bank's BOJ current-account balance, so H-limit accounting is not
 *     applicable. The state-machine table explicitly permits this edge
 *     (see `ALLOWED_TRANSITIONS.PRECHECKED`).
 *   - Settlement completes via IGS callback (`handleIgsCallback`).
 *
 * Migrated to use `transitionWithLog` / `cancelInFlightTx` so each transition
 * is validated and atomically logged.
 *
 * @module zc/lanes/highvalue
 */
// proof_type = PAYER_HV_ISOLATION_PROOF
import type { Env, PaymentInitiatedRequest } from "../../types";
import { nowISO } from "../../types";
import { settlementAccountId } from "../../shared/central_bank";
import { callBankNameCheck } from "../orchestrator";
import { authorityCheckOrMarkPending } from "./_authority_check";
import { newDecisionProofRef, newFinalityLogRef } from "../../shared/proof";
import { calcBalance } from "../../bank/ledger";
import { transitionWithLog, cancelInFlightTx } from "./_helpers";
import { mandatePrecheckOrSuspend } from "./_mandate_precheck";
import { checkIgsAdmission } from "../settlement/dns";
import { deferIgs, consumeThrottleBudget } from "../settlement/igs_hold";
import { makeRequestId, REQUEST_PREFIX } from "../../shared/request-id";

/** Reason codes a HIGH_VALUE tx can carry while parked in PRECHECKED_SUSPENDED
 *  by IGS admission control (igs_mode ring-fence). These are the *recoverable*
 *  suspensions: the tx was blocked only because a DNS cycle was held, so once
 *  the hold lifts (igs_mode → NORMAL) or the fairness budget frees, the tx must
 *  resume rather than strand. DNS_IGS_THROTTLED is the Mode-2 fairness deferral. */
const IGS_RESUMABLE_REASONS = new Set([
  "DNS_RINGFENCED",
  "DNS_HOLD_IGS_STOPPED",
  "DNS_IGS_THROTTLED",
]);

/** Shape needed to drive a HIGH_VALUE tx from PRECHECKED onward. */
interface HvPrecheckTx {
  txid: string;
  payer_bank_id: string;
  payee_bank_id: string;
  amount_value: number;
  payer_account_hash: string;
}

export function processHighValueIngress(req: PaymentInitiatedRequest) {
  return { result: "INGRESS_ACCEPTED" as const, txid: req.txid, state: "RECEIVED" as const };
}

/**
 * HIGH_VALUE asynchronous processing:
 * RECEIVED → PRECHECKED → DECIDED_TO_SETTLE → (a_HV) → waiting for IGS → b
 * (H_RESERVED is skipped, because it is backed by central-bank RTGS = BOJ prefunding)
 */
export async function advanceHighValue(txid: string, env: Env): Promise<void> {
  const db = env.DB;
  const now = nowISO();

  const tx = await db.prepare(`SELECT * FROM Transactions WHERE txid = ?`).bind(txid).first<{
    state: string;
    payer_bank_id: string;
    payee_bank_id: string;
    amount_value: number;
    payer_account_hash: string;
    payee_account_hash: string | null;
    pspr_ref: string | null;
    mandate_id: string | null;
    purpose: string | null;
    version: number;
  }>();
  if (!tx || tx.state !== "RECEIVED") return;

  // 1. PRECHECKED
  const prechecked = await transitionWithLog(db, {
    txid,
    fromState: "RECEIVED",
    toState: "PRECHECKED",
    eventType: "PreCheckPassed",
    payload: { txid },
  });
  if (!prechecked.applied) return;

  // 1b. Mandate scope check (Theme B). A delegated HIGH_VALUE instruction must
  // stay within its mandate's amount/purpose/lane scope — large-value is exactly
  // where an over-limit breach matters most. A breach suspends for ops review.
  if (
    (
      await mandatePrecheckOrSuspend(db, {
        txid,
        mandate_id: tx.mandate_id,
        amount_value: tx.amount_value,
        purpose: tx.purpose,
        lane: "HIGH_VALUE",
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
      skipReleaseH: true, // Because HV does not take an H reservation
    });
    return;
  }

  // 3. Name Check
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
    // PRECHECKED → PRECHECKED_SUSPENDED (bookkeeping state; ALLOWED_TRANSITIONS permits it).
    const suspended = await transitionWithLog(db, {
      txid,
      fromState: "PRECHECKED",
      toState: "PRECHECKED_SUSPENDED",
      eventType: "PreCheckSuspended",
      payload: { reason_code: "SUSPEND_NAMECHECK_PENDING" },
      setColumns: { reason_code: "SUSPEND_NAMECHECK_PENDING" },
    });
    if (!suspended.applied) return;
    return;
  }

  // 3b–6: admission → BOJ check → DECIDED_TO_SETTLE → ExecuteDebit. Shared with
  // resumeRingfencedIgs so the resume path settles via the exact same edges.
  await continueHighValueFromPrecheck({ txid, ...tx }, env);
}

/**
 * Drive a HIGH_VALUE tx from PRECHECKED through IGS admission, the BOJ prefund
 * check, the DECIDED_TO_SETTLE decision, and the ExecuteDebit enqueue. Extracted
 * from advanceHighValue so the ring-fence resume path reuses the identical
 * settlement edges (no second copy to drift).
 *
 * Returns `{ decided: true }` only when the tx reached DECIDED_TO_SETTLE and a
 * debit was enqueued.
 */
async function continueHighValueFromPrecheck(
  tx: HvPrecheckTx,
  env: Env
): Promise<{ decided: boolean; state: string }> {
  const db = env.DB;
  const now = nowISO();
  const { txid } = tx;

  // DNS ring-fence admission (igs_mode escalation, docs/specs/20_method_design.md §2.4 類型B). IGS
  // settles through the BOJ rail, so during a JPY DNS_HOLD it is gated by the
  // cycle's igs_mode: STOP halts all IGS; RINGFENCED halts only IGS that touches
  // a hold-causing (defaulting) participant — freezing the defaulter's central-
  // bank position until the cycle recovers. A blocked tx is suspended (not
  // settled); resumeRingfencedIgs revives it once the hold lifts.
  const admission = await checkIgsAdmission(
    db,
    tx.payer_bank_id,
    tx.payee_bank_id,
    tx.amount_value
  );
  if (!admission.admit) {
    const reasonCode = admission.reason_code ?? "DNS_RINGFENCED";
    const suspended = await transitionWithLog(db, {
      txid,
      fromState: "PRECHECKED",
      toState: "PRECHECKED_SUSPENDED",
      eventType: "PreCheckSuspended",
      payload: { reason_code: reasonCode, igs_mode: admission.igs_mode, defer: admission.defer },
      setColumns: { reason_code: reasonCode },
    });
    // Mode-2 fairness deferral: enqueue on the priority Defer queue so the sweep
    // re-injects it with a scheduled window (not just the plain suspend path).
    if (suspended.applied && admission.defer && admission.cycle_id) {
      await deferIgs(db, {
        txid,
        cycle_id: admission.cycle_id,
        payer_bank_id: tx.payer_bank_id,
        payee_bank_id: tx.payee_bank_id,
        amount_value: tx.amount_value,
        reason_code: reasonCode,
        priority: admission.priority,
      });
    }
    return { decided: false, state: "PRECHECKED_SUSPENDED" };
  }

  // BOJ balance check (prefunded RTGS).
  // The BOJ balance is negative because of liability accounting. `bojBalance + amount > 0` means insufficient funds.
  const bojBalance = await calcBalance(settlementAccountId(tx.payer_bank_id, "JPY"), db, "JPY");
  if (bojBalance + tx.amount_value > 0) {
    await cancelInFlightTx(db, {
      txid,
      reasonCode: "BOJ_INSUFFICIENT_FUNDS",
      fromStates: ["PRECHECKED"],
      skipReleaseH: true,
      payloadExtra: {
        boj_balance: bojBalance,
        amount: tx.amount_value,
        available: -bojBalance,
      },
    });
    return { decided: false, state: "DECIDED_CANCEL" };
  }

  // PRECHECKED → DECIDED_TO_SETTLE (skip H_RESERVED).
  // This direct transition is explicitly listed in ALLOWED_TRANSITIONS.PRECHECKED.
  const decisionProofRef = newDecisionProofRef();
  const finalityLogRef = newFinalityLogRef();
  const decided = await transitionWithLog(db, {
    txid,
    fromState: "PRECHECKED",
    toState: "DECIDED_TO_SETTLE",
    eventType: "DecidedToSettle",
    payload: { decision_proof_ref: decisionProofRef, lane: "HIGH_VALUE" },
    setColumns: {
      decision_proof_ref: decisionProofRef,
      finality_log_ref: finalityLogRef,
    },
  });
  if (!decided.applied) return { decided: false, state: decided.previousState ?? "STATE_CONFLICT" };

  // Mode-2 fairness accounting: a HIGH_VALUE that settled under RINGFENCED_PLUS
  // consumes this payer's `igs_throttle_budget` for the held cycle, so its next
  // IGS is deferred once the budget is spent (admission above).
  if (admission.igs_mode === "RINGFENCED_PLUS" && admission.cycle_id) {
    await consumeThrottleBudget(db, admission.cycle_id, tx.payer_bank_id, tx.amount_value);
  }

  // ExecuteDebit (a_HV: proof_type=PAYER_HV_ISOLATION_PROOF).
  // Pass payer_account_hash (HV does not go through reserve-funds, so the Bank side cannot identify the account).
  // Start IGS settlement after the debit is confirmed (onPayerExecConfirmed).
  await env.QUEUE.send({
    type: "ZC_BANK_DEBIT",
    payload: {
      txid,
      payer_bank_id: tx.payer_bank_id,
      payee_bank_id: tx.payee_bank_id,
      amount: { value: tx.amount_value, currency: "JPY" },
      decision_proof_ref: decisionProofRef,
      lane: "HIGH_VALUE",
      payer_account_hash: tx.payer_account_hash,
    },
    txid,
    attempt: 0,
    enqueued_at: now,
  });
  return { decided: true, state: "DECIDED_TO_SETTLE" };
}

/**
 * Resume a HIGH_VALUE (IGS) transaction that was parked in PRECHECKED_SUSPENDED
 * purely because a JPY DNS cycle was held and ring-fenced it (igs_mode
 * RINGFENCED/STOP). Once the cycle recovers (settleDns/resumeDns lifts igs_mode
 * back to NORMAL, or the ring-fence no longer names this tx's banks), the tx is
 * admissible again and must be driven to settlement — otherwise a transfer
 * blocked only for containment would strand forever (a liveness break: the
 * payer is never debited and the payee never credited even though nothing is
 * wrong with the instruction).
 *
 * Idempotent under at-least-once redelivery (the per-minute sweep can call this
 * repeatedly): the PRECHECKED_SUSPENDED → PRECHECKED CAS admits exactly one
 * caller; losers see `applied:false` and return without re-settling. Re-checks
 * admission BEFORE leaving the suspended state so a still-held cycle is a no-op
 * (no pointless state churn), and re-verifies the mandate on resume (a hold can
 * sit arbitrarily long; the delegated authority may have lapsed meanwhile),
 * mirroring resumeSuspendedExpress.
 */
export async function resumeRingfencedIgs(
  txid: string,
  env: Env
): Promise<{ ok: boolean; state: string }> {
  const db = env.DB;
  const tx = await db.prepare(`SELECT * FROM Transactions WHERE txid = ?`).bind(txid).first<{
    state: string;
    reason_code: string | null;
    payer_bank_id: string;
    payee_bank_id: string;
    amount_value: number;
    payer_account_hash: string;
    mandate_id: string | null;
    purpose: string | null;
  }>();
  if (!tx) return { ok: false, state: "NOT_FOUND" };
  if (tx.state !== "PRECHECKED_SUSPENDED" || !IGS_RESUMABLE_REASONS.has(tx.reason_code ?? "")) {
    return { ok: false, state: tx.state };
  }

  // Re-check admission while still suspended: if the hold has not lifted (or this
  // tx's bank is still ring-fenced / over its fairness budget), stay parked — no
  // state change. Amount is passed so a still-throttled tx remains deferred.
  const admission = await checkIgsAdmission(
    db,
    tx.payer_bank_id,
    tx.payee_bank_id,
    tx.amount_value
  );
  if (!admission.admit) return { ok: false, state: "PRECHECKED_SUSPENDED" };

  // PRECHECKED_SUSPENDED → PRECHECKED. The CAS is the dedup point under
  // at-least-once sweeps: only the first caller wins, so the tx is settled once.
  const resumed = await transitionWithLog(db, {
    txid,
    fromState: "PRECHECKED_SUSPENDED",
    toState: "PRECHECKED",
    eventType: "IgsRingfenceResumed",
    payload: { txid, igs_mode: admission.igs_mode },
    setColumns: { reason_code: null },
  });
  if (!resumed.applied) return { ok: false, state: resumed.previousState ?? "STATE_CONFLICT" };

  // Re-verify the mandate on resume (Theme B): a containment hold can outlast the
  // delegated authority. A breach re-suspends (PRECHECKED → PRECHECKED_SUSPENDED
  // + Case) instead of settling outside scope.
  if (
    (
      await mandatePrecheckOrSuspend(db, {
        txid,
        mandate_id: tx.mandate_id,
        amount_value: tx.amount_value,
        purpose: tx.purpose,
        lane: "HIGH_VALUE",
      })
    ).suspended
  ) {
    return { ok: false, state: "PRECHECKED_SUSPENDED" };
  }

  const result = await continueHighValueFromPrecheck(
    {
      txid,
      payer_bank_id: tx.payer_bank_id,
      payee_bank_id: tx.payee_bank_id,
      amount_value: tx.amount_value,
      payer_account_hash: tx.payer_account_hash,
    },
    env
  );
  return { ok: result.decided, state: result.state };
}
