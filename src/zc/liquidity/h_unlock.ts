import { releaseH, getHReservation } from "../liquidity/h_model";
import { writeFinalityLog } from "../orchestrator";

export type HUnlockResult =
  | {
      ok: true;
      result: "H_RELEASED";
      txid: string;
      reservation_id: string;
      amount: number;
      event: "NoDebitRecordedProofSubmitted" | "HUnlockAuthorized";
    }
  | { ok: false; reason: string; message: string };

interface Releasable {
  reservationId: string;
  amount: number;
  state: string;
}

/**
 * Validate that `txid` holds a locked, unreleased H reservation that is safe to
 * release (i.e. `a`/`b` never occurred). Returns the reservation context or a
 * typed reason the caller can surface verbatim.
 */
async function loadReleasableH(
  db: D1Database,
  txid: string
): Promise<Releasable | { error: string; message: string }> {
  const tx = await db
    .prepare(`SELECT state, h_reservation_id FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: string; h_reservation_id: string | null }>();
  if (!tx) return { error: "TX_NOT_FOUND", message: `transaction ${txid} not found` };
  if (!tx.h_reservation_id)
    return { error: "NO_H_RESERVATION", message: `${txid} holds no H reservation` };

  const res = await getHReservation(tx.h_reservation_id, db);
  if (!res) return { error: "NO_H_RESERVATION", message: `reservation for ${txid} not found` };
  if (res.is_released)
    return { error: "ALREADY_RELEASED", message: `H for ${txid} is already released` };

  // Money-safety gate: never release H once funds have moved (a or b).
  if (
    tx.state === "PAYER_EXEC_CONFIRMED" ||
    tx.state === "PAYEE_EXEC_CONFIRMED" ||
    tx.state === "SETTLED"
  ) {
    return {
      error: "A_OR_B_CONFIRMED",
      message: `${txid} is ${tx.state}; funds moved — use Reversal, not H unlock`,
    };
  }
  const confirmed = await db
    .prepare(
      `SELECT 1 AS x FROM FinalityLog
       WHERE txid = ? AND event_type IN ('PayerExecConfirmed','PayeeExecConfirmed')
       LIMIT 1`
    )
    .bind(txid)
    .first<{ x: number }>();
  if (confirmed) {
    return {
      error: "A_OR_B_CONFIRMED",
      message: `${txid} recorded a/b execution in its history — use Reversal, not H unlock`,
    };
  }

  return { reservationId: tx.h_reservation_id, amount: res.amount, state: tx.state };
}

/**
 * Release H_locked on the strength of a payer-bank "no debit recorded" proof.
 * The HMAC signature is verified at the HTTP boundary (mirroring bank ingress);
 * this function performs the state gate, the release, and the paired audit write.
 */
export async function submitNoDebitProof(
  db: D1Database,
  txid: string,
  input: { proof_ref: string; bank_id: string }
): Promise<HUnlockResult> {
  if (!input.proof_ref) {
    return { ok: false, reason: "PROOF_REF_REQUIRED", message: "proof_ref is required" };
  }
  const r = await loadReleasableH(db, txid);
  if ("error" in r) return { ok: false, reason: r.error, message: r.message };

  const released = await releaseH(r.reservationId, db);
  if (!released) {
    return { ok: false, reason: "ALREADY_RELEASED", message: `H for ${txid} is already released` };
  }

  await writeFinalityLog(db, {
    txid,
    event_type: "NoDebitRecordedProofSubmitted",
    state_from: r.state,
    state_to: r.state, // H release is a side-ledger op; the Transactions state does not change
    payload_json: JSON.stringify({
      proof_ref: input.proof_ref,
      bank_id: input.bank_id,
      reservation_id: r.reservationId,
      amount: r.amount,
    }),
    txid_or_gtid: txid,
  });

  return {
    ok: true,
    result: "H_RELEASED",
    txid,
    reservation_id: r.reservationId,
    amount: r.amount,
    event: "NoDebitRecordedProofSubmitted",
  };
}

/**
 * Release H_locked under two-person operational control when no machine proof is
 * available. Requires two distinct approvers and an evidence reference for the
 * audit trail (§ 8.4.1).
 */
export async function authorizeHUnlock(
  db: D1Database,
  txid: string,
  input: {
    approver_1: string;
    approver_2: string;
    evidence_type: string;
    evidence_ref: string;
    case_id?: string;
  }
): Promise<HUnlockResult> {
  if (!input.approver_1 || !input.approver_2 || input.approver_1 === input.approver_2) {
    return {
      ok: false,
      reason: "FOUR_EYES_REQUIRED",
      message: "two distinct approvers are required for an operational H unlock",
    };
  }
  if (!input.evidence_type || !input.evidence_ref) {
    return {
      ok: false,
      reason: "EVIDENCE_REQUIRED",
      message: "evidence_type and evidence_ref are required for the audit trail",
    };
  }

  const r = await loadReleasableH(db, txid);
  if ("error" in r) return { ok: false, reason: r.error, message: r.message };

  const released = await releaseH(r.reservationId, db);
  if (!released) {
    return { ok: false, reason: "ALREADY_RELEASED", message: `H for ${txid} is already released` };
  }

  await writeFinalityLog(db, {
    txid,
    event_type: "HUnlockAuthorized",
    state_from: r.state,
    state_to: r.state,
    payload_json: JSON.stringify({
      approver_1: input.approver_1,
      approver_2: input.approver_2,
      evidence_type: input.evidence_type,
      evidence_ref: input.evidence_ref,
      case_id: input.case_id ?? null,
      reservation_id: r.reservationId,
      amount: r.amount,
    }),
    txid_or_gtid: txid,
  });

  return {
    ok: true,
    result: "H_RELEASED",
    txid,
    reservation_id: r.reservationId,
    amount: r.amount,
    event: "HUnlockAuthorized",
  };
}
