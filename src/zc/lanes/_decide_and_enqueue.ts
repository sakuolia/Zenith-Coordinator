/**
 * @file _decide_and_enqueue.ts — shared H_RESERVED → DECIDED_TO_SETTLE commit.
 *
 * EXPRESS and STANDARD reach the settlement decision through an identical
 * sequence once funds are H-reserved: mint the decision/finality proof refs,
 * attach the DNS cycle, CAS-advance H_RESERVED → DECIDED_TO_SETTLE (atomically
 * logged), switch the H reservation RESERVED → LOCKED, and enqueue the
 * ZC_BANK_DEBIT execution. This used to be copy-pasted verbatim in
 * `continueExpressFromPrecheck` and `authorizeStandard`; centralizing it keeps
 * the two paths from drifting.
 *
 * Scope: this helper covers ONLY the H_RESERVED → DECIDED_TO_SETTLE path.
 * HIGH_VALUE deliberately does NOT use it — it decides from PRECHECKED (skipping
 * H_RESERVED and the H reservation entirely), carries no DNS cycle, runs IGS
 * fairness-budget accounting, and enqueues a different debit payload
 * (lane + payer_account_hash, no reservation_id). Folding that in would require
 * branching flags that obscure both paths, so HIGH_VALUE keeps its own copy.
 *
 * @module zc/lanes/_decide_and_enqueue
 */
import type { Env } from "../../types";
import { lockH } from "../liquidity/h_model";
import { newDecisionProofRef, newFinalityLogRef } from "../../shared/proof";
import { getOrCreateDnsCycle } from "../settlement/dns";
import { transitionWithLog } from "./_helpers";

export interface DecideAndEnqueueArgs {
  txid: string;
  payerBankId: string;
  payeeBankId: string;
  amount: { value: number; currency: string };
  /**
   * The H reservation to switch RESERVED → LOCKED once the decision commits.
   * Null is tolerated for the (in practice unreachable from H_RESERVED) case
   * where the row carries no reservation: `lockH` is skipped and the queued
   * `reservation_id` stays null, matching the prior STANDARD guard exactly.
   */
  reservationId: string | null;
  /** Timestamp shared with the FinalityLog/queue entry (one `nowISO()` per flow). */
  now: string;
}

/**
 * Result of the decision commit. On success the caller maps `decisionProofRef`
 * into its own return shape; on failure it applies its own fallback state /
 * reason_code to `previousState` (EXPRESS and STANDARD differ here, so the
 * helper returns the raw snapshot rather than pre-formatting it).
 */
export type DecideAndEnqueueResult =
  | { decided: true; decisionProofRef: string }
  | { decided: false; previousState: string | null };

/**
 * Commit H_RESERVED → DECIDED_TO_SETTLE and enqueue the debit execution.
 *
 * Behaviour-identical to the inline blocks it replaces: same FinalityLog
 * `DecidedToSettle` event + payload, same `decision_proof_ref` /
 * `finality_log_ref` / `dns_cycle_id` column writes, same `lockH`, same
 * ZC_BANK_DEBIT queue payload. A lost CAS short-circuits before `lockH` and the
 * enqueue, exactly as before.
 */
export async function decideToSettleAndEnqueueDebit(
  db: D1Database,
  env: Env,
  args: DecideAndEnqueueArgs
): Promise<DecideAndEnqueueResult> {
  const decisionProofRef = newDecisionProofRef();
  const finalityLogRef = newFinalityLogRef();
  // Set dns_cycle_id on DECIDED_TO_SETTLE (needed for H release at DNS settlement).
  const dnsCycleId = await getOrCreateDnsCycle(db, args.now);

  const decided = await transitionWithLog(db, {
    txid: args.txid,
    fromState: "H_RESERVED",
    toState: "DECIDED_TO_SETTLE",
    eventType: "DecidedToSettle",
    payload: { decision_proof_ref: decisionProofRef },
    setColumns: {
      decision_proof_ref: decisionProofRef,
      finality_log_ref: finalityLogRef,
      dns_cycle_id: dnsCycleId,
    },
  });
  if (!decided.applied) {
    return { decided: false, previousState: decided.previousState };
  }

  // Switch H reservation RESERVED → LOCKED (held until DNS settlement).
  if (args.reservationId) {
    await lockH(args.reservationId, db);
  }

  // Enqueue Execution asynchronously.
  await env.QUEUE.send({
    type: "ZC_BANK_DEBIT",
    payload: {
      payer_bank_id: args.payerBankId,
      payee_bank_id: args.payeeBankId,
      txid: args.txid,
      amount: args.amount,
      decision_proof_ref: decisionProofRef,
      reservation_id: args.reservationId,
    },
    txid: args.txid,
    attempt: 0,
    enqueued_at: args.now,
  });

  return { decided: true, decisionProofRef };
}
