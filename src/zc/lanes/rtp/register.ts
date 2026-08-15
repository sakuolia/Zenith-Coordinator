/**
 * @file RTP request creation, payer notification, and attempt linking.
 * @module zc/lanes/rtp/register
 */
import type { BankRtpNotifyIngressRequest, Env, RtpRequestRow } from "../../../types";
import { nowISO } from "../../../types";
import { writeFinalityLog } from "../../orchestrator";

/**
 * Execute RTP Attempt: CREATED/NOTIFIED → TX_CREATED
 * Called when the payer initiates a transfer (POST /api/transfers with lane=RTP)
 */
export async function attemptRtp(rtpId: string, linkedTxid: string, env: Env): Promise<boolean> {
  const db = env.DB;
  const now = nowISO();

  const rtp = await db
    .prepare(`SELECT * FROM RtpRequests WHERE rtp_id = ?`)
    .bind(rtpId)
    .first<RtpRequestRow>();

  if (!rtp) return false;
  if (rtp.state !== "CREATED" && rtp.state !== "NOTIFIED") return false;
  if (new Date(rtp.expires_at) <= new Date(now)) {
    await db
      .prepare(`UPDATE RtpRequests SET state='EXPIRED', updated_at=? WHERE rtp_id=?`)
      .bind(now, rtpId)
      .run();
    return false;
  }
  if (rtp.attempt_count >= rtp.max_attempts) {
    await db
      .prepare(`UPDATE RtpRequests SET state='FAILED', updated_at=? WHERE rtp_id=?`)
      .bind(now, rtpId)
      .run();
    return false;
  }

  await db
    .prepare(
      `UPDATE RtpRequests SET state='TX_CREATED', attempt_count=attempt_count+1, linked_txid=?, updated_at=? WHERE rtp_id=?`
    )
    .bind(linkedTxid, now, rtpId)
    .run();

  return true;
}

/**
 * Mark RTP as complete (when txid becomes SETTLED)
 */
export async function settleRtp(rtpId: string, db: D1Database): Promise<void> {
  await db
    .prepare(`UPDATE RtpRequests SET state='COMPLETED', updated_at=? WHERE rtp_id=?`)
    .bind(nowISO(), rtpId)
    .run();
}

/**
 * Register an RTP request and deliver it to the paying bank.
 *
 * This is the **only** registration path. There used to be a second one
 * (`registerRtp`) that inserted the row and wrote `RtpRequested` but never
 * notified anyone; nothing called it, yet it stayed exported through two
 * barrels. Two ways to register the same thing, differing in whether the payer
 * is told, is a bug waiting for whoever fixes the wrong one — so the unused
 * half is gone rather than kept "just in case".
 */
export async function registerRtpRequest(
  db: D1Database,
  rtpId: string,
  payeeBankId: string,
  payerBankId: string,
  amount: { value: number; currency: string },
  expiresAt: string,
  _idempotencyKey: string,
  options: { payeeName?: string; description?: string; ediRef?: string; payeeAccountHash?: string },
  env: Env
): Promise<{ result: "REGISTERED" | "DUPLICATE"; rtpId: string }> {
  const now = nowISO();

  // Idempotency check: return DUPLICATE if an existing record is found
  const existing = await db
    .prepare(`SELECT rtp_id FROM RtpRequests WHERE rtp_id = ?`)
    .bind(rtpId)
    .first<{ rtp_id: string }>();

  if (existing) {
    return { result: "DUPLICATE", rtpId };
  }

  await db
    .prepare(`
    INSERT INTO RtpRequests
      (rtp_id, payee_bank_id, payer_bank_id, amount_value, state,
       attempt_count, max_attempts, expires_at,
       payee_name, description, edi_ref, payee_account_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'CREATED', 0, 3, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      rtpId,
      payeeBankId,
      payerBankId,
      amount.value,
      expiresAt,
      options.payeeName ?? null,
      options.description ?? null,
      options.ediRef ?? null,
      options.payeeAccountHash ?? null,
      now,
      now
    )
    .run();

  await writeFinalityLog(db, {
    txid: null,
    event_type: "RtpRequested",
    state_from: null,
    state_to: "CREATED",
    payload_json: JSON.stringify({
      rtp_id: rtpId,
      payee_bank_id: payeeBankId,
      payer_bank_id: payerBankId,
    }),
    txid_or_gtid: rtpId,
  });

  const notified = await notifyBankOfRtp(
    rtpId,
    payerBankId,
    payeeBankId,
    { value: amount.value, currency: amount.currency },
    expiresAt,
    { payeeName: options.payeeName, description: options.description },
    env
  );

  if (notified) {
    await db
      .prepare(`
      UPDATE RtpRequests SET state = 'NOTIFIED', notified_at = ?, updated_at = ?
      WHERE rtp_id = ? AND state = 'CREATED'
    `)
      .bind(now, now, rtpId)
      .run();
  }

  return { result: "REGISTERED", rtpId };
}

/**
 * Deliver the RTP notification to the paying bank (ingress command 10,
 * `rtp-notify`).
 *
 * This used to return `true` without calling anything, on the stated grounds
 * that "dynamic import is not possible under Workers bundle constraints" — which
 * is not so: every other ZC→bank call site reaches the handler with exactly this
 * `await import()` (`zc/events/credit_notify.ts`, `zc/orchestrator/bank_hub.ts`).
 * The effect was that command 10 of the thirteen ZC requires of a core
 * (`10_requirements.md` §7.2.1) was reachable only by an external HTTP POST, so
 * nothing in the system ever exercised the seam it defines.
 *
 * Delivery failure is not fatal: the payer bank can still pull the request
 * (`GET /api/rtp/incoming`), and the caller records `notified` on the RtpRequests
 * row, so a failed push degrades to the pull model rather than failing the
 * registration (`10_requirements.md` §7.2.1 command 9/10: `notify_mode=PULL` is
 * the baseline; push is the optional upgrade).
 */
/**
 * Build the `rtp-notify` ingress body. Exported so the seam test can drive the
 * handler with the object this call site actually sends
 * (`test/integration/ingress_commands.test.ts`).
 */
export function buildRtpNotifyPayload(
  rtpId: string,
  payerBankId: string,
  payeeBankId: string,
  amount: { value: number; currency: string },
  expiresAt: string,
  options: { payeeName?: string; description?: string }
): BankRtpNotifyIngressRequest {
  return {
    request_id: `RTP-NOTIFY-${rtpId}`,
    rtp_id: rtpId,
    payee_bank_id: payeeBankId,
    payer_bank_id: payerBankId,
    amount,
    expires_at: expiresAt,
    payee_name: options.payeeName,
    description: options.description,
  };
}

async function notifyBankOfRtp(
  rtpId: string,
  payerBankId: string,
  payeeBankId: string,
  amount: { value: number; currency: string },
  expiresAt: string,
  options: { payeeName?: string; description?: string },
  env: Env
): Promise<boolean> {
  const payload = buildRtpNotifyPayload(
    rtpId,
    payerBankId,
    payeeBankId,
    amount,
    expiresAt,
    options
  );
  try {
    const { handleBankIngress } = await import("../../../bank/ingress");
    const result = (await handleBankIngress(payerBankId, "rtp-notify", payload, env)) as {
      result?: string;
    };
    return result?.result === "NOTIFIED";
  } catch (err) {
    console.error("[rtp] rtp-notify delivery failed:", err);
    return false;
  }
}
