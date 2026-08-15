/**
 * @file RTP response handling — payer accepts (creates tx) or rejects.
 * @module zc/lanes/rtp/respond
 */
import type { Env, RtpRequestRow, RtpRespondRequest } from "../../../types";
import { nowISO } from "../../../types";
import { insertTxWithLog } from "../_helpers";

/**
 * RTP response processing (ACCEPTED / REJECTED)
 *
 * If the payer approves, automatically generate the RTP-linked transfer transaction and submit it to ZC.
 */
export async function respondToRtp(
  db: D1Database,
  rtpId: string,
  response: RtpRespondRequest,
  env: Env
): Promise<{ result: string; txid?: string }> {
  const now = nowISO();

  const rtp = await db
    .prepare(`
    SELECT * FROM RtpRequests WHERE rtp_id = ?
  `)
    .bind(rtpId)
    .first<
      RtpRequestRow & {
        payee_name?: string;
        description?: string;
        edi_ref?: string;
        payee_account_hash?: string;
      }
    >();

  if (!rtp) {
    return { result: "NOT_FOUND" };
  }

  // Case where already responded
  const alreadyDone: RtpRequestRow["state"][] = [
    "ACCEPTED",
    "DECLINED",
    "EXPIRED",
    "TX_CREATED",
    "COMPLETED",
    "FAILED",
  ];
  if (alreadyDone.includes(rtp.state)) {
    return { result: "ALREADY_RESPONDED", txid: rtp.linked_txid ?? undefined };
  }

  // Expiry check
  if (new Date(rtp.expires_at) <= new Date(now)) {
    await db
      .prepare(`
      UPDATE RtpRequests SET state = 'EXPIRED', updated_at = ? WHERE rtp_id = ?
    `)
      .bind(now, rtpId)
      .run();
    return { result: "EXPIRED" };
  }

  if (response.response === "REJECTED") {
    await db
      .prepare(`
      UPDATE RtpRequests
      SET state = 'DECLINED', response_type = 'REJECTED',
          payer_account_id = ?, responded_at = ?, updated_at = ?
      WHERE rtp_id = ?
    `)
      .bind(response.payer_account_id, now, now, rtpId)
      .run();

    return { result: "DECLINED" };
  }

  // ACCEPTED: automatically generate the transfer transaction
  const linkedTxid = `TX-${crypto.randomUUID()}`;

  // Combine creating the transfer Transaction + FinalityLog + transitioning RtpRequests to TX_CREATED
  // into a single db.batch(). The old implementation batched INSERT/UPDATE but awaited FinalityLog separately,
  // so there was a window where "the Transactions row exists but the RtpAccepted log is missing".
  // insertTxWithLog enforces ALLOWED_ENTRY_STATES = ['RECEIVED', ...], so
  // RTP joins the other lanes at the canonical RECEIVED entry point.
  await insertTxWithLog(db, {
    txid: linkedTxid,
    lane: "RTP",
    initialState: "RECEIVED",
    amount: { value: rtp.amount_value, currency: "JPY" },
    payerBankId: rtp.payer_bank_id,
    payerAccountHash: response.payer_account_id,
    payeeBankId: rtp.payee_bank_id,
    payeeAccountHash: rtp.payee_account_hash ?? "",
    idempotencyKey: response.idempotency_key,
    extraColumns: { purpose: "P2P" },
    eventType: "RtpAccepted",
    payload: { rtp_id: rtpId, linked_txid: linkedTxid },
    sideUpdates: [
      {
        sql: `UPDATE RtpRequests
              SET state = 'TX_CREATED', attempt_count = attempt_count + 1,
                  linked_txid = ?, linked_txid_new = ?, payer_account_id = ?, response_type = 'ACCEPTED',
                  responded_at = ?, updated_at = ?
              WHERE rtp_id = ?`,
        binds: [linkedTxid, linkedTxid, response.payer_account_id, now, now, rtpId],
      },
    ],
  });

  // Send to the orchestrator (advance settlement processing in the STANDARD flow)
  await env.QUEUE.send({
    type: "ZC_STATE_ADVANCE",
    payload: { txid: linkedTxid, action: "ADVANCE_STANDARD" },
    txid: linkedTxid,
    attempt: 0,
    enqueued_at: now,
  });

  return { result: "ACCEPTED", txid: linkedTxid };
}
