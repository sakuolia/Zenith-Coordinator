/**
 * @file misrecord.ts — MisrecordCorrected: the "唯一の超例外" record-correction
 *       path for an erroneously recorded `a` (docs/specs/10_requirements.md § 13.4).
 *
 * The ONLY record correction the system permits is the one for "ZC障害により a
 * 到達が誤って記録された" — a `PayerExecConfirmed` (`a`) that ZC wrote even though
 * the payer bank never actually debited. This is NOT a cancellation and NOT a
 * Reversal: funds did not move, so there is nothing to reverse; the erroneous
 * audit record is *corrected* (appended to, never rewritten) and the transaction
 * converges into a CASE so it can be re-driven correctly.
 *
 * The spec fixes three mandatory controls (§ 13.4): a **time window**, **four-eyes
 * approval**, and an **evidence reference** — all appended to the FinalityLog so
 * the correction is provable if later disputed. The one hard money-safety gate:
 * if `b` (PAYEE_EXEC_CONFIRMED) ever occurred the boundary is irreversible and a
 * Reversal (new tx), not a correction, is the only instrument — mirroring the
 * a/b gate in h_unlock.ts. Whether the debit truly never happened is exactly what
 * the four-eyes operators attest with their evidence (the spec delegates that
 * determination to the controls, not to an automated ledger forensic).
 *
 * @module zc/misrecord
 */
import { nowISO } from "../../types";
import { writeFinalityLog } from "../orchestrator";
import { transitionWithLog } from "../lanes/_helpers";
import { openCase } from "../cases/case";
import { MISRECORD_CORRECTION_WINDOW_SEC } from "../../shared/constants";

export type MisrecordResult =
  | {
      ok: true;
      result: "MISRECORD_CORRECTED";
      txid: string;
      case_id: string;
      state_from: string;
      state_to: string;
    }
  | { ok: false; reason: string; message: string };

export interface MisrecordInput {
  approver_1: string;
  approver_2: string;
  evidence_type: string;
  evidence_ref: string;
  /** Free-text note for the CASE / audit payload. */
  note?: string;
}

/**
 * Correct an erroneously recorded `a` (§ 13.4). Verifies the four-eyes + evidence
 * + time-window controls and the b-irreversibility gate, appends a
 * `MisrecordCorrected` event, moves a live `PAYER_EXEC_CONFIRMED` back to
 * SUSPENDED (a CASE is opened either way), and returns the corrected context.
 *
 * Idempotency: the PAYER_EXEC_CONFIRMED → SUSPENDED CAS admits exactly one
 * corrector; once a tx is already SUSPENDED with reason MISRECORD_CORRECTED a
 * repeat call is rejected (ALREADY_CORRECTED) rather than appending duplicates.
 */
export async function correctMisrecord(
  db: D1Database,
  txid: string,
  input: MisrecordInput
): Promise<MisrecordResult> {
  // Control 1: four-eyes (two distinct approvers).
  if (!input.approver_1 || !input.approver_2 || input.approver_1 === input.approver_2) {
    return {
      ok: false,
      reason: "FOUR_EYES_REQUIRED",
      message: "two distinct approvers are required for a misrecord correction",
    };
  }
  // Control 2: evidence reference.
  if (!input.evidence_type || !input.evidence_ref) {
    return {
      ok: false,
      reason: "EVIDENCE_REQUIRED",
      message: "evidence_type and evidence_ref are required (§13.4)",
    };
  }

  const tx = await db
    .prepare(`SELECT state, reason_code FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: string; reason_code: string | null }>();
  if (!tx) return { ok: false, reason: "TX_NOT_FOUND", message: `transaction ${txid} not found` };

  // Already corrected → idempotent reject (no duplicate audit append).
  if (tx.reason_code === "MISRECORD_CORRECTED") {
    return {
      ok: false,
      reason: "ALREADY_CORRECTED",
      message: `${txid} was already misrecord-corrected`,
    };
  }

  // Money-safety gate: after b the boundary is irreversible → use a Reversal.
  if (tx.state === "PAYEE_EXEC_CONFIRMED" || tx.state === "SETTLED") {
    return {
      ok: false,
      reason: "B_CONFIRMED",
      message: `${txid} is ${tx.state}; b is irreversible — use a Reversal, not a correction`,
    };
  }
  const bInHistory = await db
    .prepare(
      `SELECT 1 AS x FROM FinalityLog WHERE txid = ? AND event_type = 'PayeeExecConfirmed' LIMIT 1`
    )
    .bind(txid)
    .first<{ x: number }>();
  if (bInHistory) {
    return {
      ok: false,
      reason: "B_CONFIRMED",
      message: `${txid} recorded b in its history — use a Reversal, not a correction`,
    };
  }

  // Precondition: there must be an `a` to correct. Find the erroneous
  // PayerExecConfirmed; the most recent one anchors the time window.
  const aRecord = await db
    .prepare(
      `SELECT occurred_at FROM FinalityLog
       WHERE txid = ? AND event_type = 'PayerExecConfirmed'
       ORDER BY event_seq DESC LIMIT 1`
    )
    .bind(txid)
    .first<{ occurred_at: string }>();
  if (!aRecord) {
    return {
      ok: false,
      reason: "NO_MISRECORD",
      message: `${txid} has no recorded a (PayerExecConfirmed) to correct`,
    };
  }

  // Control 3: time window — a correction is only allowed close to the erroneous
  // record, so a long-settled history cannot be reopened as a "correction".
  const ageSec = (Date.parse(nowISO()) - Date.parse(aRecord.occurred_at)) / 1000;
  if (ageSec > MISRECORD_CORRECTION_WINDOW_SEC) {
    return {
      ok: false,
      reason: "WINDOW_EXPIRED",
      message: `the erroneous a is ${Math.floor(ageSec)}s old, past the ${MISRECORD_CORRECTION_WINDOW_SEC}s correction window`,
    };
  }

  const payload = {
    approver_1: input.approver_1,
    approver_2: input.approver_2,
    evidence_type: input.evidence_type,
    evidence_ref: input.evidence_ref,
    note: input.note ?? null,
    corrected_event: "PayerExecConfirmed",
    corrected_at: aRecord.occurred_at,
  };

  const stateFrom = tx.state;
  let stateTo = tx.state;

  if (tx.state === "PAYER_EXEC_CONFIRMED") {
    // Live erroneous `a`: move back to SUSPENDED (allowed transition) under the
    // MisrecordCorrected event, so the row leaves the false `a` state.
    const moved = await transitionWithLog(db, {
      txid,
      fromState: "PAYER_EXEC_CONFIRMED",
      toState: "SUSPENDED",
      eventType: "MisrecordCorrected",
      payload,
      setColumns: { reason_code: "MISRECORD_CORRECTED" },
    });
    if (!moved.applied) {
      return {
        ok: false,
        reason: "STATE_CONFLICT",
        message: `${txid} changed state concurrently (${moved.previousState})`,
      };
    }
    stateTo = "SUSPENDED";
  } else if (tx.state === "SUSPENDED") {
    // The erroneous `a` already aged into SUSPENDED. The state is already correct;
    // record the correction (append-only) and stamp the reason.
    await db
      .prepare(
        `UPDATE Transactions SET reason_code='MISRECORD_CORRECTED', updated_at=? WHERE txid=? AND state='SUSPENDED'`
      )
      .bind(nowISO(), txid)
      .run();
    await writeFinalityLog(db, {
      txid,
      event_type: "MisrecordCorrected",
      state_from: "SUSPENDED",
      state_to: "SUSPENDED",
      payload_json: JSON.stringify(payload),
      txid_or_gtid: txid,
    });
  } else {
    // a recorded but the row is in some other state (e.g. raced to FAILED_EXECUTION).
    return {
      ok: false,
      reason: "NOT_CORRECTABLE",
      message: `${txid} is ${tx.state}; only a live PAYER_EXEC_CONFIRMED or SUSPENDED a-misrecord is correctable`,
    };
  }

  // Converge into a CASE so the correction is tracked to resolution (design
  // principle #4: an unexplained state is forbidden). The H reservation, if any,
  // is released through the existing h_unlock path (no debit ⇒ NoDebitProof).
  const caseId = await openCase(db, {
    related_txid: txid,
    reason_code: "MISRECORD_CORRECTED",
    description: `誤記録訂正 (§13.4): ${input.evidence_type}=${input.evidence_ref}; approvers=${input.approver_1},${input.approver_2}`,
    opened_by: "OPS",
  });

  return {
    ok: true,
    result: "MISRECORD_CORRECTED",
    txid,
    case_id: caseId,
    state_from: stateFrom,
    state_to: stateTo,
  };
}
