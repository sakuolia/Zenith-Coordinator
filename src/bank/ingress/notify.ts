/**
 * @module bank/ingress/notify
 * @description Notification ingress commands: credit-notify (9), rtp-notify
 * (10). Pure notification layers — credit-notify MUST NOT touch the ledger
 * (the credit journals were already booked by execute-credit).
 */
import type { Env, BankCreditNotifyIngressRequest, BankRtpNotifyIngressRequest } from "../../types";
import { nowISO } from "../../types";
import { getAccountByHash } from "../suspense";
import { auditLog, checkIdempotency, saveResponse } from "./_shared";

export type { BankCreditNotifyIngressRequest, BankRtpNotifyIngressRequest };

/**
 * **Command 9: credit-notify** — Post-settlement credit *notification* delivery.
 *
 * Pure notification layer: confirms to the payee bank that ZC has reached
 * SETTLED state for this txid so the bank can fire downstream signals
 * (customer push, EDI delivery, mobile alert, MT940 reporting, etc.). The
 * actual customer credit journals were already booked synchronously by
 * `execute-credit` (Hard Landing → segregated deposit(-) / ordinary account(+)). Booking again
 * here would double-credit the payee, so this handler MUST NOT touch the
 * ledger — see the regression test in `test/integration/balance_invariants.test.ts`.
 *
 * @param bankId - Payee bank identifier
 * @param req    - Contains txid, payee_account_hash, amount, payer info
 * @param env    - Worker environment bindings
 * @returns DELIVERED with notification_id, or ERROR if the payee account
 *          cannot be resolved (so the ZC retry loop can investigate).
 */
export async function bankCreditNotify(
  bankId: string,
  req: BankCreditNotifyIngressRequest,
  env: Env
): Promise<
  { result: "DELIVERED"; notification_id: string } | { result: "ERROR"; reason_code: string }
> {
  const db = env.DB;
  const idempResult = await checkIdempotency(req.request_id, bankId, req.txid, "credit-notify", db);
  if (idempResult.existing)
    return idempResult.response as { result: "DELIVERED"; notification_id: string };

  // Only confirm the existence of the Payee account. If it is not SAVINGS, a custody-handled credit
  // should still remain in the segregated deposit as of execute-credit, so return ERROR and have the ZC side
  // record it as a delivery failure.
  const account = await getAccountByHash(bankId, req.payee_account_hash, db);
  if (!account || account.account_type !== "SAVINGS") {
    const resp = { result: "ERROR" as const, reason_code: "ACCOUNT_NOT_FOUND" };
    await saveResponse(req.request_id, resp, db);
    return resp;
  }

  const resp = { result: "DELIVERED" as const, notification_id: req.notification_id };
  await saveResponse(req.request_id, resp, db);
  await auditLog(db, {
    bank_id: bankId,
    txid: req.txid,
    request_id: req.request_id,
    command: "credit-notify",
    status: "OK",
    amount: req.amount.value,
    account_id: account.account_id,
    details: { notification_id: req.notification_id, payer_bank_id: req.payer_bank_id },
  });
  return resp;
}

// ---------------------------------------------------------------------------
// 10. rtp-notify  RTP request notification (store the notification on the payer bank side)
// ---------------------------------------------------------------------------
export async function bankRtpNotify(
  bankId: string,
  req: BankRtpNotifyIngressRequest,
  env: Env
): Promise<{ result: "NOTIFIED"; rtp_id: string } | { result: "ERROR"; reason_code: string }> {
  const db = env.DB;
  const idempResult = await checkIdempotency(req.request_id, bankId, null, "rtp-notify", db);
  if (idempResult.existing) return idempResult.response as { result: "NOTIFIED"; rtp_id: string };

  const now = nowISO();

  // The RTP consolidation removed RtpRequestRows and consolidated the notification
  // storage of both the ZC and the payer side into RtpRequests. This handler, to represent that the payer bank received
  // rtp-notify from ZC, performs an INSERT if not yet registered, and if already registered
  // advances CREATED → NOTIFIED (idempotent).
  await db
    .prepare(`
    INSERT INTO RtpRequests
      (rtp_id, payee_bank_id, payer_bank_id, amount_value, state,
       attempt_count, max_attempts, payee_name, description, expires_at,
       notified_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'NOTIFIED', 0, 3, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(rtp_id) DO UPDATE SET
      state = CASE WHEN RtpRequests.state = 'CREATED' THEN 'NOTIFIED' ELSE RtpRequests.state END,
      notified_at = COALESCE(RtpRequests.notified_at, excluded.notified_at),
      updated_at = excluded.updated_at
  `)
    .bind(
      req.rtp_id,
      req.payee_bank_id,
      req.payer_bank_id,
      req.amount.value,
      req.payee_name ?? null,
      req.description ?? null,
      req.expires_at,
      now,
      now,
      now
    )
    .run();

  const resp = { result: "NOTIFIED" as const, rtp_id: req.rtp_id };
  await saveResponse(req.request_id, resp, db);
  await auditLog(db, {
    bank_id: bankId,
    txid: null,
    request_id: req.request_id,
    command: "rtp-notify",
    status: "OK",
    amount: req.amount.value,
    details: {
      rtp_id: req.rtp_id,
      payee_bank_id: req.payee_bank_id,
      payer_bank_id: req.payer_bank_id,
      expires_at: req.expires_at,
    },
  });
  return resp;
}
