/**
 * @file _reserve_funds.ts — shared H-reserve → H_RESERVED → bank reserve-funds.
 *
 * EXPRESS (`continueExpressFromPrecheck`) and STANDARD (`advanceStandard`,
 * `resumeFromNameCheckSuspended`) all run the identical three-step liquidity
 * commit once a tx is past PRECHECKED and name-checked:
 *   1. `reserveH` against the payer bank's H-limit,
 *   2. CAS-advance PRECHECKED → H_RESERVED (atomically logged), then
 *   3. call the payer bank's reserve-funds.
 * Each failure cancels the in-flight tx. This block was copy-pasted in three
 * places; centralizing it removes the drift risk.
 *
 * Scope note — only this contiguous block is shared. The surrounding steps
 * deliberately differ per lane and stay inline: EXPRESS sends `vault_ref` on the
 * authority check and *cancels* on a name mismatch, whereas STANDARD omits
 * `vault_ref` and *suspends* (PRECHECKED_SUSPENDED) on a name mismatch. Folding
 * those in would change observable behaviour, so they are left to the caller.
 *
 * The cancel `fromStates` are caller-supplied because EXPRESS uses
 * `cancelInFlightTx`'s broad default set while STANDARD scopes each cancel to a
 * single state (`["PRECHECKED"]` / `["H_RESERVED"]`). Passing them through keeps
 * the exact prior CAS guard for every caller.
 *
 * @module zc/lanes/_reserve_funds
 */
import type { Env } from "../../types";
import { reserveH } from "../liquidity/h_model";
import { callBankReserveFunds } from "../orchestrator";
import { transitionWithLog, cancelInFlightTx } from "./_helpers";
import { makeRequestId, REQUEST_PREFIX } from "../../shared/request-id";

export interface ReserveFundsArgs {
  txid: string;
  payerBankId: string;
  amount: { value: number; currency: string };
  payerAccountHash: string;
  /**
   * `fromStates` for the cancel issued when H-reservation fails. Omit to use
   * `cancelInFlightTx`'s default set (EXPRESS); STANDARD passes `["PRECHECKED"]`.
   */
  hReserveCancelFromStates?: string[];
  /**
   * `fromStates` for the cancel issued when reserve-funds errors. Omit for the
   * default set (EXPRESS); STANDARD passes `["H_RESERVED"]`.
   */
  reserveFundsCancelFromStates?: string[];
}

/**
 * Outcome of the reserve sequence. On `ok` the caller proceeds to the decision
 * with `reservationId`. On failure the tx has already been cancelled
 * (H_RESERVE / RESERVE_FUNDS stages) or lost the CAS (H_TRANSITION, no cancel);
 * each caller maps the stage to its own return shape — the helper does not
 * format a lane-specific result.
 */
export type ReserveFundsResult =
  | { ok: true; reservationId: string }
  | { ok: false; stage: "H_RESERVE"; reasonCode: string }
  | { ok: false; stage: "H_TRANSITION"; previousState: string | null }
  // RESERVE_FUNDS carries the *raw* bank reason_code (may be undefined): the
  // internal cancel falls back to "RESERVE_FAILED", but EXPRESS surfaces the
  // raw value in its response — keep them distinct to preserve that exactly.
  | { ok: false; stage: "RESERVE_FUNDS"; reasonCode: string | undefined };

/**
 * reserveH → CAS PRECHECKED→H_RESERVED → callBankReserveFunds, cancelling on any
 * failure. Behaviour-identical to the inline blocks it replaces (same HReserved
 * FinalityLog event, same `h_reservation_id` write, same reserve-funds request,
 * same cancel reason codes and — via the caller-supplied `fromStates` — the same
 * cancel CAS guards).
 */
export async function reserveFundsForDebit(
  db: D1Database,
  env: Env,
  args: ReserveFundsArgs
): Promise<ReserveFundsResult> {
  // 1. H reservation.
  const hResult = await reserveH(args.payerBankId, args.txid, args.amount.value, db);
  if (!hResult.ok) {
    await cancelInFlightTx(db, {
      txid: args.txid,
      reasonCode: hResult.reason,
      ...(args.hReserveCancelFromStates ? { fromStates: args.hReserveCancelFromStates } : {}),
    });
    return { ok: false, stage: "H_RESERVE", reasonCode: hResult.reason };
  }
  const reservationId = hResult.reservation_id;

  // 2. PRECHECKED → H_RESERVED.
  const reserved = await transitionWithLog(db, {
    txid: args.txid,
    fromState: "PRECHECKED",
    toState: "H_RESERVED",
    eventType: "HReserved",
    payload: { reservation_id: reservationId },
    setColumns: { h_reservation_id: reservationId },
  });
  if (!reserved.applied) {
    return { ok: false, stage: "H_TRANSITION", previousState: reserved.previousState };
  }

  // 3. Bank reserve-funds.
  const reserveResult = await callBankReserveFunds(
    args.payerBankId,
    {
      request_id: makeRequestId(REQUEST_PREFIX.RESERVE_FUNDS, args.txid),
      txid: args.txid,
      amount: args.amount,
      account_hash: args.payerAccountHash,
    },
    env
  );
  if (reserveResult.result === "ERROR") {
    await cancelInFlightTx(db, {
      txid: args.txid,
      reasonCode: reserveResult.reason_code ?? "RESERVE_FAILED",
      ...(args.reserveFundsCancelFromStates
        ? { fromStates: args.reserveFundsCancelFromStates }
        : {}),
    });
    return { ok: false, stage: "RESERVE_FUNDS", reasonCode: reserveResult.reason_code };
  }

  return { ok: true, reservationId };
}
