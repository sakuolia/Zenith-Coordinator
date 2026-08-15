/**
 * @file orchestrator.ts - ZC State Machine Core & Bank Call Hub
 *
 * Public API barrel: imports from domain sub-modules and defines the queue
 * dispatcher and execution confirmation handlers that tie them together.
 *
 * Sub-modules (each independently importable):
 *   orchestrator/state_machine.ts  — isValidTransition, ALLOWED_TRANSITIONS
 *   orchestrator/finality.ts       — writeFinalityLog, finalizeCancelledTx, suspendTx
 *   orchestrator/gtid.ts           — checkAndFinalizeGtid
 *   orchestrator/bank_hub.ts       — callBank* functions
 */

import type { Env, LaneType, TxState, QueueMessage, BankDebitSettledRequest } from "../types";
import { makeRequestId, REQUEST_PREFIX } from "../shared/request-id";
import { nowISO } from "../types";
import { releaseH } from "./liquidity/h_model";
import { openCase, autoResolveCaseForTx } from "./cases/case";
import { logTxEvent } from "./events/trace";
import { createCreditNotification, deliverNotification } from "./events/credit_notify";
import { publishEvent } from "./events/stream";

// ---------------------------------------------------------------------------
// Sub-module imports (used internally and re-exported below)
// ---------------------------------------------------------------------------
import { isValidTransition, ALLOWED_TRANSITIONS } from "./orchestrator/state_machine";
import type { FinalityLogEntry } from "./orchestrator/finality";
import { writeFinalityLog, finalizeCancelledTx, suspendTx } from "./orchestrator/finality";
import { checkAndFinalizeGtid } from "./orchestrator/gtid";
import { transitionWithLog } from "./lanes/_helpers";
import {
  callBankReserveFunds,
  callBankExecuteDebit,
  callBankExecuteCredit,
  callBankReleaseReserve,
  callBankLegReadyCheck,
  callBankAuthorityCheck,
  callBankNameCheck,
} from "./orchestrator/bank_hub";

/**
 * State reason_code for "the participant's adapter is unreachable", as opposed
 * to "the participant refused the posting".
 *
 * Both used to land on `EXEC_DEBIT_FAILED` / `EXEC_CREDIT_FAILED`, which made an
 * outage indistinguishable from a genuine execution failure. That mattered
 * operationally: docs/specs/20_method_design.md §10.9.3.6 aggregates one incident CASE
 * per `CAUSE:{participant_id}:{reason_code}`, so with the two collapsed, a single
 * bank going dark produced N execution-failure CASEs instead of one outage CASE —
 * the ticket explosion §10.7.2 exists to prevent.
 *
 * A circuit-open response is not a decision by the bank; it is ZC declining to
 * call it. Naming it separately is what lets the sweep, the CASE aggregation and
 * the counter-desk wording tell "come back later" from "this payment failed".
 */
const SUSPEND_ADAPTER_DOWN = "SUSPEND_ADAPTER_DOWN";

/** True when a bank response means "we never reached the core" (breaker open). */
function isAdapterUnreachable(resp: unknown): boolean {
  return (resp as { reason_code?: string } | null)?.reason_code === "CIRCUIT_OPEN";
}

// ---------------------------------------------------------------------------
// Re-exports — all existing import paths remain valid without changes
// ---------------------------------------------------------------------------
export {
  isValidTransition,
  ALLOWED_TRANSITIONS,
  writeFinalityLog,
  finalizeCancelledTx,
  suspendTx,
  checkAndFinalizeGtid,
  callBankReserveFunds,
  callBankExecuteDebit,
  callBankExecuteCredit,
  callBankReleaseReserve,
  callBankLegReadyCheck,
  callBankAuthorityCheck,
  callBankNameCheck,
};
export type { FinalityLogEntry };

// ---------------------------------------------------------------------------
// State transition processing after Execution completes
// ---------------------------------------------------------------------------

/**
 * Handle payer execution confirmation (proof "a").
 * Records the payer bank proof, transitions to PAYER_EXEC_CONFIRMED,
 * then enqueues the payee credit (proof "b") for asynchronous processing.
 */
export async function onPayerExecConfirmed(
  txid: string,
  bankProofRefJson: string,
  env: Env
): Promise<void> {
  const db = env.DB;
  const now = nowISO();

  const tx = await db
    .prepare(
      `SELECT state, lane, payee_bank_id, payee_account_hash, amount_value, amount_currency, decision_proof_ref, version FROM Transactions WHERE txid = ?`
    )
    .bind(txid)
    .first<{
      state: TxState;
      lane: string;
      payee_bank_id: string;
      payee_account_hash: string | null;
      amount_value: number;
      amount_currency: string;
      decision_proof_ref: string | null;
      version: number;
    }>();
  if (!tx) return;

  if (!isValidTransition(tx.state, "PAYER_EXEC_CONFIRMED")) {
    console.error(
      `[orchestrator] Invalid transition ${tx.state} → PAYER_EXEC_CONFIRMED for ${txid}`
    );
    return;
  }

  // Atomic CAS + paired FinalityLog write (single db.batch via transitionWithLog) —
  // avoids the window where the state advance commits without its audit record.
  const transition = await transitionWithLog(db, {
    txid,
    fromState: tx.state,
    toState: "PAYER_EXEC_CONFIRMED",
    eventType: "PayerExecConfirmed",
    setColumns: { payer_bank_proof_ref: bankProofRefJson },
    payload: { payer_bank_proof_ref: JSON.parse(bankProofRefJson) },
  });

  if (!transition.applied) return;

  await autoResolveCaseForTx(db, txid);

  // In the HIGH_VALUE lane, the IGS callback (handleIgsCallback) enqueues ZC_BANK_CREDIT
  if (tx.lane !== "HIGH_VALUE") {
    await env.QUEUE.send({
      type: "ZC_BANK_CREDIT",
      payload: {
        txid,
        payee_bank_id: tx.payee_bank_id,
        payee_account_hash: tx.payee_account_hash ?? undefined,
        // Carry the tx's real currency: a cross-currency FX leg credits the
        // payee in the leg currency (e.g. USD), not JPY. Hardcoding JPY here
        // landed the payee's USD on the wrong rail.
        amount: { value: tx.amount_value, currency: tx.amount_currency },
        decision_proof_ref: tx.decision_proof_ref ?? "",
      },
      txid,
      attempt: 0,
      enqueued_at: now,
    });
  }
}

/**
 * Build the `debit-settled` ingress body (command 11).
 *
 * Exported for the seam test. This body used to be an inline object literal
 * handed to `handleBankIngress(payload: unknown)`, which is precisely the shape
 * of the `account-verify` defect: the caller and the handler each described the
 * command, nothing compared the two descriptions, and a rename on either side
 * would have reached the handler as `undefined` with every existing test still
 * green (`test/integration/ingress_commands.test.ts`).
 */
export function buildDebitSettledPayload(
  txid: string,
  payeeBankId: string,
  amount: { value: number; currency: string },
  settledAt: string
): BankDebitSettledRequest {
  return {
    request_id: `DEBIT-SETTLED-${txid}`,
    txid,
    amount,
    payee_bank_id: payeeBankId,
    settled_at: settledAt,
  };
}

/**
 * Handle payee execution confirmation (proof "b").
 * Records the payee bank proof, transitions through PAYEE_EXEC_CONFIRMED to
 * SETTLED, publishes SSE events, and triggers credit notification delivery.
 */
export async function onPayeeExecConfirmed(
  txid: string,
  bankProofRefJson: string,
  env: Env
): Promise<void> {
  const db = env.DB;
  const now = nowISO();

  const tx = await db
    .prepare(
      `SELECT state, lane, h_reservation_id, payee_bank_id, payee_account_hash, payer_bank_id, amount_value, amount_currency, purpose, edi_ref, version, external_settlement_status FROM Transactions WHERE txid = ?`
    )
    .bind(txid)
    .first<{
      state: TxState;
      lane: string;
      h_reservation_id: string | null;
      payee_bank_id: string;
      payee_account_hash: string | null;
      payer_bank_id: string;
      amount_value: number;
      amount_currency: string;
      purpose: string | null;
      edi_ref: string | null;
      version: number;
      external_settlement_status: string;
    }>();
  if (!tx) return;

  if (!isValidTransition(tx.state, "PAYEE_EXEC_CONFIRMED")) return;

  // HIGH_VALUE invariant: reject the b confirmation unless external_settlement_status = 'SETTLED'
  // (spec: "transition to PAYEE_EXEC_CONFIRMED(b) is allowed only when external_settlement_status == SETTLED")
  if (tx.lane === "HIGH_VALUE" && tx.external_settlement_status !== "SETTLED") {
    console.error(
      `[orchestrator] HV invariant violated for ${txid}: external_settlement_status=${tx.external_settlement_status}, expected SETTLED`
    );
    return;
  }

  // Atomic CAS + paired FinalityLog write (single db.batch via transitionWithLog) —
  // avoids the window where the state advance commits without its audit record.
  const transition = await transitionWithLog(db, {
    txid,
    fromState: tx.state,
    toState: "PAYEE_EXEC_CONFIRMED",
    eventType: "PayeeExecConfirmed",
    setColumns: { payee_bank_proof_ref: bankProofRefJson },
    payload: { payee_bank_proof_ref: JSON.parse(bankProofRefJson) },
  });

  if (!transition.applied) return;

  await autoResolveCaseForTx(db, txid);

  // Transition to SETTLED (atomic CAS + paired FinalityLog write)
  const settledTransition = await transitionWithLog(db, {
    txid,
    fromState: "PAYEE_EXEC_CONFIRMED",
    toState: "SETTLED",
    eventType: "Settled",
    payload: { txid },
  });
  if (!settledTransition.applied) return;

  await publishEvent(db, tx.payee_bank_id, "TX_STATE_CHANGED", { txid, newState: "SETTLED" });

  let notificationId: string | null = null;
  let notificationDelivered = false;
  try {
    notificationId = await createCreditNotification(
      db,
      txid,
      tx.payee_bank_id,
      tx.payee_account_hash ?? "",
      { value: tx.amount_value, currency: tx.amount_currency },
      tx.payer_bank_id,
      tx.purpose ?? null,
      tx.edi_ref ?? null
    );
    await deliverNotification(db, notificationId, env);
    notificationDelivered = true;
    await publishEvent(db, tx.payee_bank_id, "CREDIT_RECEIVED", { txid, amount: tx.amount_value });
  } catch (err) {
    console.error(`[orchestrator] credit notification failed for ${txid}:`, err);
  }
  await writeFinalityLog(db, {
    txid,
    event_type: "CreditNotificationAttempted",
    state_from: "SETTLED",
    state_to: "SETTLED",
    payload_json: JSON.stringify({
      notification_id: notificationId,
      delivered: notificationDelivered,
      payee_bank_id: tx.payee_bank_id,
    }),
    txid_or_gtid: txid,
  });

  try {
    const { handleBankIngress } = await import("../bank/ingress");
    await handleBankIngress(
      tx.payer_bank_id,
      "debit-settled",
      buildDebitSettledPayload(
        txid,
        tx.payee_bank_id,
        { value: tx.amount_value, currency: tx.amount_currency },
        now
      ),
      env
    );
  } catch (err) {
    console.error(`[orchestrator] debit-settled notification failed for ${txid}:`, err);
  }

  // Reversal cascade: look up by ReversalRecords.reversal_txid instead of a
  // txid prefix so future txid format changes do not silently skip the
  // completion callback.
  const reversalRow = await db
    .prepare(`SELECT reversal_id FROM ReversalRecords WHERE reversal_txid = ? LIMIT 1`)
    .bind(txid)
    .first<{ reversal_id: string }>();
  if (reversalRow) {
    const { completeReversal } = await import("./cases/reversal");
    await completeReversal(txid, db).catch((e) =>
      console.error(`[orchestrator] completeReversal failed for ${txid}:`, e)
    );
  }

  // GTID cascade: query GtidLegs by txid (the foreign-key already exists)
  // instead of inferring lane membership from a txid prefix.
  const leg = await db
    .prepare(`SELECT gtid FROM GtidLegs WHERE txid = ?`)
    .bind(txid)
    .first<{ gtid: string }>();
  if (leg) {
    await checkAndFinalizeGtid(leg.gtid, db);
  }
}

// ---------------------------------------------------------------------------
// Queue message dispatcher
// ---------------------------------------------------------------------------

/**
 * Central queue message dispatcher. Routes at-least-once messages to the
 * appropriate handler based on message type. Re-throws errors to trigger
 * queue retry (at-least-once delivery guarantee).
 */
export async function processQueueMessage(msg: QueueMessage, env: Env): Promise<void> {
  try {
    switch (msg.type) {
      case "ZC_BANK_RESERVE": {
        const p = msg.payload as { htlc_id: string; txid: string };
        const { lockHtlc } = await import("./lanes/htlc");
        await lockHtlc(p.htlc_id, env);
        break;
      }
      case "ZC_BANK_DEBIT": {
        const p = msg.payload as {
          txid: string;
          payer_bank_id: string;
          payee_bank_id: string;
          amount: { value: number; currency: string };
          decision_proof_ref: string;
          reservation_id?: string;
          lane?: LaneType;
          payer_account_hash?: string;
        };
        const t0 = Date.now();
        const bankResp = await callBankExecuteDebit(
          p.payer_bank_id,
          {
            request_id: makeRequestId(REQUEST_PREFIX.EXECUTE_DEBIT, p.txid),
            txid: p.txid,
            amount: p.amount,
            decision_proof_ref: p.decision_proof_ref,
            h_reservation: p.reservation_id
              ? { reservation_id: p.reservation_id, mode: "RESERVED" }
              : undefined,
            lane: p.lane,
            payer_account_hash: p.payer_account_hash,
          },
          env
        );
        await logTxEvent(env.DB, {
          txid: p.txid,
          actor: `BANK_${p.payer_bank_id}`,
          action: "EXECUTE_DEBIT",
          status: bankResp.result === "OK" ? "OK" : "NG",
          reason_code:
            bankResp.result !== "OK"
              ? ((bankResp as unknown as Record<string, unknown>).reason_code as string | undefined)
              : null,
          amount: p.amount.value,
          bank_id: p.payer_bank_id,
          duration_ms: Date.now() - t0,
        });
        if (bankResp.result === "OK") {
          await onPayerExecConfirmed(p.txid, JSON.stringify(bankResp.bank_proof_ref), env);
          if (p.lane === "HIGH_VALUE") {
            const { initiateIgsSettlement } = await import("./settlement/igs");
            const { transferOwnership, OWNER_VENUE_BOJ } = await import("./lanes/_helpers");
            // 単一所有者則 (§5.2 handoff #3): the money leg moves to the
            // settlement venue, so `external_settlement_status='REQUESTED'`
            // and `owner='VENUE:BOJ'` are stamped in ONE batch. While the
            // venue owns the row, ZC cannot suspend it (the docs/specs/30_internal_design.md §5.1 二元帳乖離カタログ #1
            // divergence becomes a type error, not a sweep exclusion).
            // The CAS also dedupes at-least-once ZC_BANK_DEBIT redelivery:
            // a second delivery finds owner != 'ZC' and must not submit a
            // second IGS instruction for the same tx.
            const handoff = await transferOwnership(env.DB, {
              txid: p.txid,
              fromOwner: "ZC",
              toOwner: OWNER_VENUE_BOJ,
              payload: { reason: "IGS_SUBMISSION" },
              setColumns: { external_settlement_status: "REQUESTED" },
            });
            if (handoff.applied) {
              await initiateIgsSettlement(
                env.DB,
                p.txid,
                { value: p.amount.value, currency: p.amount.currency },
                p.payer_bank_id,
                p.payee_bank_id,
                env
              );
            }
          }
        } else {
          await suspendTx(
            p.txid,
            isAdapterUnreachable(bankResp) ? SUSPEND_ADAPTER_DOWN : "EXEC_DEBIT_FAILED",
            env.DB,
            {
              bank_id: p.payer_bank_id,
              bank_result: (bankResp as unknown as Record<string, unknown>).result,
              bank_reason_code: (bankResp as unknown as Record<string, unknown>).reason_code,
            }
          );
        }
        break;
      }
      case "ZC_BANK_CREDIT": {
        const p = msg.payload as {
          txid: string;
          payee_bank_id: string;
          amount: { value: number; currency: string };
          decision_proof_ref: string;
          payee_account_hash?: string;
        };
        const t1 = Date.now();
        const bankResp = await callBankExecuteCredit(
          p.payee_bank_id,
          {
            request_id: makeRequestId(REQUEST_PREFIX.EXECUTE_CREDIT, p.txid),
            txid: p.txid,
            amount: p.amount,
            decision_proof_ref: p.decision_proof_ref,
            payee_account_hash: p.payee_account_hash,
          },
          env
        );
        await logTxEvent(env.DB, {
          txid: p.txid,
          actor: `BANK_${p.payee_bank_id}`,
          action: "EXECUTE_CREDIT",
          status:
            bankResp.result === "OK"
              ? "OK"
              : bankResp.result === "PENDING_APPROVAL"
                ? "PENDING"
                : "NG",
          reason_code:
            bankResp.result === "FILTER_REJECTED"
              ? bankResp.reason_code
              : bankResp.result === "PENDING_APPROVAL"
                ? "AWAITING_PAYEE_APPROVAL"
                : null,
          amount: p.amount.value,
          bank_id: p.payee_bank_id,
          details:
            bankResp.result === "PENDING_APPROVAL"
              ? { approval_id: bankResp.approval_id }
              : undefined,
          duration_ms: Date.now() - t1,
        });
        if (bankResp.result === "OK") {
          await onPayeeExecConfirmed(p.txid, JSON.stringify(bankResp.bank_proof_ref), env);
        } else if (bankResp.result === "PENDING_APPROVAL") {
          await suspendTx(p.txid, "AWAITING_PAYEE_APPROVAL", env.DB);
          await writeFinalityLog(env.DB, {
            txid: p.txid,
            event_type: "FilterPending",
            state_from: "PAYER_EXEC_CONFIRMED",
            state_to: "SUSPENDED",
            payload_json: JSON.stringify({ approval_id: bankResp.approval_id }),
            txid_or_gtid: p.txid,
          });
        } else if (bankResp.result === "FILTER_REJECTED") {
          await suspendTx(p.txid, "PAYEE_FILTER_REJECTED", env.DB);
          await writeFinalityLog(env.DB, {
            txid: p.txid,
            event_type: "FilterRejected",
            state_from: "PAYER_EXEC_CONFIRMED",
            state_to: "SUSPENDED",
            payload_json: JSON.stringify({
              filter_id: bankResp.filter_id,
              reason_code: bankResp.reason_code,
            }),
            txid_or_gtid: p.txid,
          });
        } else {
          await suspendTx(
            p.txid,
            isAdapterUnreachable(bankResp) ? SUSPEND_ADAPTER_DOWN : "EXEC_CREDIT_FAILED",
            env.DB,
            {
              bank_id: p.payee_bank_id,
              bank_result: (bankResp as unknown as Record<string, unknown>).result,
              bank_reason_code: (bankResp as unknown as Record<string, unknown>).reason_code,
            }
          );
        }
        break;
      }
      case "ZC_RESUME_CREDIT": {
        const p = msg.payload as {
          txid: string;
          payee_bank_id: string;
          payee_account_hash?: string;
        };
        const resumeRequestId = `CREDIT-RESUME-${p.txid}`;
        const txInfo = await env.DB.prepare(
          `SELECT amount_value, amount_currency, decision_proof_ref, payee_account_hash FROM Transactions WHERE txid=?`
        )
          .bind(p.txid)
          .first<{
            amount_value: number;
            amount_currency: string;
            decision_proof_ref: string | null;
            payee_account_hash: string | null;
          }>();
        if (!txInfo) {
          console.error("[ZC_RESUME_CREDIT] txid not found:", p.txid);
          break;
        }
        const bankResp = await callBankExecuteCredit(
          p.payee_bank_id,
          {
            request_id: resumeRequestId,
            txid: p.txid,
            amount: { value: txInfo.amount_value, currency: txInfo.amount_currency },
            decision_proof_ref: txInfo.decision_proof_ref ?? "",
            payee_account_hash: p.payee_account_hash ?? txInfo.payee_account_hash ?? undefined,
          },
          env
        );
        if (bankResp.result === "OK") {
          await onPayeeExecConfirmed(p.txid, JSON.stringify(bankResp.bank_proof_ref), env);
        } else {
          console.error(`[ZC_RESUME_CREDIT] retry failed: ${JSON.stringify(bankResp)}`);
          const resumeFailReason = "EXEC_CREDIT_FAILED_ON_RESUME";
          await env.DB.prepare(
            `UPDATE Transactions SET reason_code=?, updated_at=?, version=version+1 WHERE txid=? AND state='SUSPENDED'`
          )
            .bind(resumeFailReason, nowISO(), p.txid)
            .run();
          await writeFinalityLog(env.DB, {
            txid: p.txid,
            event_type: "ResumeCreditFailed",
            state_from: "SUSPENDED",
            state_to: "SUSPENDED",
            payload_json: JSON.stringify({
              reason_code: resumeFailReason,
              bank_id: p.payee_bank_id,
              bank_result: (bankResp as unknown as Record<string, unknown>).result,
              bank_reason_code: (bankResp as unknown as Record<string, unknown>).reason_code,
            }),
            txid_or_gtid: p.txid,
          });
          await openCase(env.DB, {
            related_txid: p.txid,
            reason_code: resumeFailReason,
            opened_by: "ZC",
            description: `Resume credit failed after payee approval: ${JSON.stringify(bankResp)}`,
          });
        }
        break;
      }
      case "ZC_BANK_RELEASE": {
        const p = msg.payload as { reservation_id: string; txid?: string; bank_id?: string };
        await releaseH(p.reservation_id, env.DB);
        if (p.txid && p.bank_id) {
          await callBankReleaseReserve(
            p.bank_id,
            {
              request_id: makeRequestId(REQUEST_PREFIX.RELEASE_RESERVE, p.reservation_id),
              txid: p.txid,
              reservation_ref: p.reservation_id,
            },
            env
          ).catch((e) => console.error(`[ZC_BANK_RELEASE] release-reserve failed: ${e}`));
        }
        break;
      }
      case "ZC_BANK_LEG_READY": {
        const p = msg.payload as { gtid: string };
        const { advanceGtid } = await import("./lanes/gtid");
        await advanceGtid(p.gtid, env);
        break;
      }
      case "ZC_STATE_ADVANCE": {
        const p = msg.payload as { txid: string; action: string };
        if (p.action === "ADVANCE_STANDARD") {
          const { advanceStandard } = await import("./lanes/standard");
          await advanceStandard(p.txid, env);
        } else if (p.action === "ADVANCE_BULK") {
          const { advanceBulk } = await import("./lanes/bulk");
          await advanceBulk(p.txid, env);
        } else if (p.action === "ADVANCE_HV") {
          const { advanceHighValue } = await import("./lanes/highvalue");
          await advanceHighValue(p.txid, env);
        } else if (p.action === "AUTO_AUTHORIZE") {
          const { authorizeStandard } = await import("./lanes/standard");
          await authorizeStandard(p.txid, true, env);
        }
        break;
      }
      case "ZC_IGS_CALLBACK": {
        const p = msg.payload as import("../types").IgsCallbackInput;
        const { handleIgsCallback } = await import("./settlement/igs");
        await handleIgsCallback(env.DB, p, env);
        break;
      }
      default:
        console.error("[queue] Unknown message type:", msg.type);
    }
  } catch (err) {
    console.error("[queue] Error processing message:", err);
    throw err;
  }
}
