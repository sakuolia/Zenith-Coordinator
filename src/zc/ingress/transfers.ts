/**
 * @file ZC ingress — payment-initiation handlers (transfers / gtid / rtp / authorize / cancel / resume).
 * @module zc/ingress/transfers
 */
import type {
  Env,
  GtidRegisterRequest,
  PaymentInitiatedRequest,
  RtpRequestInput,
  TransferAuthorizeRequest,
  TransferCancelRequest,
} from "../../types";
import { makeRequestId, REQUEST_PREFIX } from "../../shared/request-id";
import { nowISO, businessDateJST } from "../../types";
import {
  parseBody,
  validateGtidRegister,
  validatePaymentInitiated,
  validateRtpRequest,
} from "../../shared/validator";
import { completeIdempotency, resolveIdempotency } from "../../shared/idempotency";
import { validateFatfR16 } from "../../shared/fatf_validator";
import { processExpress } from "../lanes/express";
import {
  authorizeStandard,
  processStandardIngress,
  resumeFromNameCheckSuspended,
} from "../lanes/standard";
import { processBulkIngress } from "../lanes/bulk";
import { registerGtid } from "../lanes/gtid";
import { attemptRtp, registerRtpRequest } from "../lanes/rtp";
import { processHighValueIngress } from "../lanes/highvalue";
import { callBankReleaseReserve } from "../orchestrator";
import { buildFinalityLogConditionalInsert, prepareFinalityLogRow } from "../orchestrator/finality";
import { cancelInFlightTx } from "../lanes/_helpers";
import { linkEdiToTransaction } from "../richdata/edi";
import { resolveProxy } from "../directory/proxy";
import { DEFAULT_HV_THRESHOLD } from "../../shared/constants";
import { json, jsonError } from "./_shared";

// ---------------------------------------------------------------------------
// POST /api/transfers
// ---------------------------------------------------------------------------
export async function handlePostTransfers(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<PaymentInitiatedRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "Request body must be valid JSON");

  // Proxy resolution: resolve alias (phone/email/national_id) to account_hash
  if (body.proxy_type && body.proxy_value && !body.payee.account_hash) {
    const proxyResult = await resolveProxy(env.DB, body.proxy_type, body.proxy_value);
    if (!proxyResult)
      return jsonError(
        422,
        "PROXY_NOT_FOUND",
        `proxy ${body.proxy_type}:${body.proxy_value} not found`
      );
    body.payee.account_hash = `h:${proxyResult.account_id}`;
    if (!body.payee.bank_id) body.payee.bank_id = proxyResult.bank_id;
  }

  const validation = validatePaymentInitiated(body);
  if (!validation.ok) return jsonError(400, validation.reason_code!, validation.message!);

  // `lane=HTLC` is not served here: HTLC needs a hashlock/timelock that this
  // payload cannot carry, so it has its own endpoint. Reject *before* any side
  // effect — the idempotency claim, the daily_amount_used increment and the
  // Transactions/PaymentInitiated insert all live below. Rejecting after them
  // burned daily quota and left an orphan RECEIVED row that nothing advances,
  // which is exactly the "state nobody can explain" that design principle 4
  // forbids. Contract: 32_api_contracts.md § POST /api/transfers.
  if (body.lane === "HTLC") {
    return jsonError(422, "USE_HTLC_ENDPOINT", "HTLC lane must use POST /api/htlc/create endpoint");
  }

  // FATF R.16 validation for all cross-border lanes (not just HIGH_VALUE)
  if (body.is_cross_border === 1 || body.is_cross_border === true) {
    if (!body.fatf_data)
      return jsonError(
        400,
        "FATF_DATA_REQUIRED",
        "fatf_data is required for cross-border transfers"
      );
    const fatfValidation = validateFatfR16(body.fatf_data);
    if (!fatfValidation.valid)
      return jsonError(400, "FATF_VALIDATION_FAILED", fatfValidation.errors.join("; "));
  }

  const db = env.DB;
  const idempKey = body.idempotency_key;
  const idem = await resolveIdempotency(idempKey, body, db);
  if (idem.status === "CONFLICT")
    return jsonError(
      409,
      "IDEMPOTENCY_KEY_CONFLICT",
      "idempotency_key was already used with a different request body"
    );
  if (idem.status === "REPLAY") return json(200, idem.response);

  // Amount limit check / RECEIVE_ONLY participation type check
  // On a 'no such column' error caused by an unapplied migration, log details and fall back
  let participant: {
    tx_amount_limit?: number | null;
    daily_amount_limit?: number | null;
    daily_amount_used?: number;
    daily_amount_last_reset_date?: string | null;
    participation_mode?: string | null;
    hv_threshold?: number | null;
  } | null = null;
  try {
    participant = await db
      .prepare(
        `SELECT tx_amount_limit, daily_amount_limit, daily_amount_used, daily_amount_last_reset_date, participation_mode, hv_threshold FROM Participants WHERE bank_id = ?`
      )
      .bind(body.payer.bank_id)
      .first<{
        tx_amount_limit: number | null;
        daily_amount_limit: number | null;
        daily_amount_used: number;
        daily_amount_last_reset_date: string | null;
        participation_mode: string | null;
        hv_threshold: number | null;
      }>();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no such column")) {
      // When the migration is unapplied: limits are not enforced and the RECEIVE_ONLY check is not performed
      console.error(
        `[ingress] Schema incomplete: missing columns in Participants table. Migration 0010+ may not have been applied. Error: ${msg}`
      );
      participant = {
        tx_amount_limit: null,
        daily_amount_limit: null,
        daily_amount_used: 0,
        participation_mode: null,
        hv_threshold: null,
      };
    } else {
      throw e;
    }
  }

  // A destination-only participating bank (RECEIVE_ONLY) cannot be a remittance originator
  if (participant?.participation_mode === "RECEIVE_ONLY") {
    await completeIdempotency(
      idempKey,
      { result: "REJECTED", reason_code: "PARTICIPATION_MODE_RECEIVE_ONLY" },
      db
    );
    return jsonError(
      422,
      "PARTICIPATION_MODE_RECEIVE_ONLY",
      `bank ${body.payer.bank_id} is registered as RECEIVE_ONLY and cannot initiate transfers`
    );
  }

  if (participant?.tx_amount_limit != null && body.amount.value > participant.tx_amount_limit) {
    await completeIdempotency(
      idempKey,
      { result: "REJECTED", reason_code: "AMOUNT_EXCEEDS_TX_LIMIT" },
      db
    );
    return jsonError(
      422,
      "AMOUNT_EXCEEDS_TX_LIMIT",
      `amount ${body.amount.value} exceeds per-transaction limit ${participant.tx_amount_limit}`
    );
  }

  if (participant?.daily_amount_limit != null) {
    // Atomic limit gate (same shape as h_used in h_model.ts). daily_amount_used
    // is intentionally kept as a materialized counter rather than derived from
    // SUM(today's transactions) — a SUM-then-check would race under concurrent
    // payments. Reset is handled in the EOD cron and the per-request first-of-
    // day branch below.
    let success = false;
    try {
      const today = businessDateJST(); // 'YYYY-MM-DD'

      // Auto-reset on the day's first request even if the EOD cron failed or was delayed.
      // If daily_amount_last_reset_date is on or before today, reset used to 0 before adding.
      // Perform the date check and the addition in a single statement to prevent TOCTOU.
      if (participant.daily_amount_last_reset_date !== today) {
        const upd = await db
          .prepare(
            `UPDATE Participants
           SET daily_amount_used = ?, daily_amount_last_reset_date = ?
           WHERE bank_id = ? AND daily_amount_last_reset_date IS NOT ? AND ? <= daily_amount_limit`
          )
          .bind(body.amount.value, today, body.payer.bank_id, today, body.amount.value)
          .run();
        success = upd.meta.changes > 0;
        if (!success) {
          // Another isolate already reset and incremented — fall through to normal increment.
          const upd2 = await db
            .prepare(
              `UPDATE Participants SET daily_amount_used = daily_amount_used + ?
             WHERE bank_id = ? AND daily_amount_used + ? <= daily_amount_limit`
            )
            .bind(body.amount.value, body.payer.bank_id, body.amount.value)
            .run();
          success = upd2.meta.changes > 0;
        }
      } else {
        // Add atomically; on overflow rows=0
        const upd = await db
          .prepare(
            `UPDATE Participants SET daily_amount_used = daily_amount_used + ?
           WHERE bank_id = ? AND daily_amount_used + ? <= daily_amount_limit`
          )
          .bind(body.amount.value, body.payer.bank_id, body.amount.value)
          .run();
        success = upd.meta.changes > 0;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("no such column")) {
        // When the schema is incomplete: log a warning and continue with no limits (for convenience in dev environments)
        console.error(
          `[ingress] Schema incomplete: daily_amount_used column missing. Migration 0010+ may not have been applied. Daily limits will be ignored. Error: ${msg}`
        );
        success = true;
      } else {
        throw e;
      }
    }

    if (!success) {
      await completeIdempotency(
        idempKey,
        { result: "REJECTED", reason_code: "DAILY_LIMIT_EXCEEDED" },
        db
      );
      return jsonError(
        422,
        "DAILY_LIMIT_EXCEEDED",
        "daily transfer limit exceeded for this participant"
      );
    }
  }

  // HIGH_VALUE auto-escalation (docs/specs/10_requirements.md §3.2.7, institutional
  // parameter PR-HV-THRESHOLD — docs/specs/30_internal_design.md §12.9).
  // For STANDARD or EXPRESS, when the amount is at or above the threshold, automatically switch to the HIGH_VALUE lane.
  // Threshold priority: participating bank setting (hv_threshold) > environment variable (ZC_HV_THRESHOLD) > default (100 million yen)
  const hvThreshold =
    participant?.hv_threshold ??
    (env.ZC_HV_THRESHOLD ? parseInt(env.ZC_HV_THRESHOLD, 10) : null) ??
    DEFAULT_HV_THRESHOLD;
  if ((body.lane === "STANDARD" || body.lane === "EXPRESS") && body.amount.value >= hvThreshold) {
    body.lane = "HIGH_VALUE";
  }

  // Insert Transactions record
  const now = nowISO();
  const isCrossBorder = body.is_cross_border === 1 || body.is_cross_border === true ? 1 : 0;
  const fatfDataJson = isCrossBorder && body.fatf_data ? JSON.stringify(body.fatf_data) : null;
  const fatf16Applicable = isCrossBorder && body.fatf_data ? 1 : 0;
  // Atomic INSERT + paired FinalityLog write (single db.batch, conditional INSERT
  // gated on changes()>0) — avoids the window where the Transactions row exists
  // without its PaymentInitiated audit record.
  const paymentInitiatedLogRow = await prepareFinalityLogRow(db, {
    txid: body.txid,
    event_type: "PaymentInitiated",
    state_from: null,
    state_to: "RECEIVED",
    payload_json: JSON.stringify({ txid: body.txid, lane: body.lane, amount: body.amount }),
    txid_or_gtid: body.txid,
  });

  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO Transactions
       (txid, lane, state, amount_value, amount_currency,
        payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
        pspr_ref, purpose, idempotency_key, schema_version, expires_at,
        is_cross_border, fatf_data_json, fatf16_applicable, mandate_id,
        version, created_at, updated_at, pending_since)
       VALUES (?, ?, 'RECEIVED', ?, 'JPY', ?, ?, ?, ?, ?, ?, ?, '1.0', ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      )
      .bind(
        body.txid,
        body.lane,
        body.amount.value,
        body.payer.bank_id,
        body.payer.account_hash,
        body.payee.bank_id,
        body.payee.account_hash ?? null,
        body.pspr_ref ?? null,
        body.purpose,
        idempKey,
        body.expires_at ?? null,
        isCrossBorder,
        fatfDataJson,
        fatf16Applicable,
        body.mandate_id ?? null,
        now,
        now,
        // The row enters at RECEIVED, so T_precheck starts now. `pending_since`
        // rather than `updated_at`: see src/cron/timeout_sweep.ts.
        now
      ),
    buildFinalityLogConditionalInsert(db, paymentInitiatedLogRow),
  ]);

  let result: unknown;
  switch (body.lane) {
    case "EXPRESS":
      result = await processExpress(body, env);
      break;
    case "STANDARD":
      result = processStandardIngress(body);
      await env.QUEUE.send({
        type: "ZC_STATE_ADVANCE",
        payload: { txid: body.txid, action: "ADVANCE_STANDARD" },
        txid: body.txid,
        attempt: 0,
        enqueued_at: now,
      });
      break;
    case "BULK":
    case "DEFERRED":
      result = processBulkIngress(body);
      await env.QUEUE.send({
        type: "ZC_STATE_ADVANCE",
        payload: { txid: body.txid, action: "ADVANCE_BULK" },
        txid: body.txid,
        attempt: 0,
        enqueued_at: now,
      });
      break;
    case "HIGH_VALUE":
      result = processHighValueIngress(body);
      await env.QUEUE.send({
        type: "ZC_STATE_ADVANCE",
        payload: { txid: body.txid, action: "ADVANCE_HV" },
        txid: body.txid,
        attempt: 0,
        enqueued_at: now,
      });
      break;
    case "RTP":
      result = { result: "INGRESS_ACCEPTED", txid: body.txid, state: "RECEIVED" };
      // RTP: link the RTP request to the remittance TX (REQUESTED → ATTEMPTED)
      if (body.pspr_ref) {
        await attemptRtp(body.pspr_ref, body.txid, env);
      }
      // Proceed with settlement processing using the same flow as STANDARD
      await env.QUEUE.send({
        type: "ZC_STATE_ADVANCE",
        payload: { txid: body.txid, action: "ADVANCE_STANDARD" },
        txid: body.txid,
        attempt: 0,
        enqueued_at: now,
      });
      break;
    // `case "HTLC"` is unreachable: rejected above, before any side effect.
    default:
      result = { result: "INGRESS_ACCEPTED", txid: body.txid, state: "RECEIVED" };
  }

  // EDI integration: if edi_ref is specified, link it to the transaction
  const bodyWithEdi = body as { edi_ref?: string };
  if (bodyWithEdi.edi_ref) {
    await linkEdiToTransaction(db, body.txid, bodyWithEdi.edi_ref).catch((e) =>
      console.error(`[ingress] linkEdiToTransaction failed: ${e}`)
    );
  }

  await completeIdempotency(idempKey, result, db);
  return json(200, result);
}

// ---------------------------------------------------------------------------
// POST /api/gtid/register
// ---------------------------------------------------------------------------
export async function handlePostGtidRegister(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<GtidRegisterRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  const v = validateGtidRegister(body);
  if (!v.ok) return jsonError(400, v.reason_code!, v.message!);

  const idem = await resolveIdempotency(body.idempotency_key, body, env.DB);
  if (idem.status === "CONFLICT")
    return jsonError(
      409,
      "IDEMPOTENCY_KEY_CONFLICT",
      "idempotency_key was already used with a different request body"
    );
  if (idem.status === "REPLAY") return json(200, idem.response);

  const result = await registerGtid(body, env);
  await completeIdempotency(body.idempotency_key, result, env.DB);
  return json(201, result);
}

// ---------------------------------------------------------------------------
// POST /api/rtp/request
// ---------------------------------------------------------------------------
export async function handlePostRtpRequest(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<RtpRequestInput>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  const v = validateRtpRequest(body);
  if (!v.ok) return jsonError(400, v.reason_code!, v.message!);

  const idem = await resolveIdempotency(body.idempotency_key, body, env.DB);
  if (idem.status === "CONFLICT")
    return jsonError(
      409,
      "IDEMPOTENCY_KEY_CONFLICT",
      "idempotency_key was already used with a different request body"
    );
  if (idem.status === "REPLAY") return json(200, idem.response);

  const result = await registerRtpRequest(
    env.DB,
    body.rtp_id,
    body.payee_bank_id,
    body.payer_bank_id,
    body.amount,
    body.expires_at,
    body.idempotency_key,
    {
      payeeName: body.payee_name,
      description: body.description,
      payeeAccountHash: body.payee_account,
    },
    env
  );
  const resp = {
    result: result.result === "REGISTERED" ? "INGRESS_ACCEPTED" : "DUPLICATE",
    rtp_id: result.rtpId,
    state: "REQUESTED",
  };
  await completeIdempotency(body.idempotency_key, resp, env.DB);
  return json(201, resp);
}

// ---------------------------------------------------------------------------
// POST /api/transfers/:txid/authorize
// ---------------------------------------------------------------------------
export async function handlePostAuthorize(req: Request, txid: string, env: Env): Promise<Response> {
  const body = await parseBody<TransferAuthorizeRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");

  const result = await authorizeStandard(txid, body.authorized ?? false, env);
  return json(200, result);
}

// ---------------------------------------------------------------------------
// POST /api/transfers/:txid/cancel
// ---------------------------------------------------------------------------
export async function handlePostCancel(req: Request, txid: string, env: Env): Promise<Response> {
  const body = await parseBody<TransferCancelRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");

  const db = env.DB;
  const now = nowISO();
  const tx = await db
    .prepare(
      `SELECT state, h_reservation_id, payer_bank_id, version FROM Transactions WHERE txid = ?`
    )
    .bind(txid)
    .first<{
      state: string;
      h_reservation_id: string | null;
      payer_bank_id: string;
      version: number;
    }>();

  if (!tx) return jsonError(404, "NOT_FOUND", `txid ${txid} not found`);

  const cancelableStates = ["RECEIVED", "PRECHECKED", "PRECHECKED_SUSPENDED", "H_RESERVED"];
  if (!cancelableStates.includes(tx.state)) {
    return jsonError(409, "INVALID_STATE", `Cannot cancel tx in state ${tx.state}`);
  }

  // CAS + FinalityLog + H release + finalize are consolidated into cancelInFlightTx.
  // Only the bank-side segregated deposit release is ingress-specific, so it is called separately.
  const cancelled = await cancelInFlightTx(db, {
    txid,
    reasonCode: body.reason_code,
    fromStates: cancelableStates,
  });
  if (!cancelled) {
    return jsonError(
      409,
      "STATE_CONFLICT",
      `Cancel conflict: tx ${txid} was concurrently modified`
    );
  }

  await callBankReleaseReserve(
    tx.payer_bank_id,
    {
      request_id: makeRequestId(REQUEST_PREFIX.CANCEL, txid),
      txid,
      reservation_ref: tx.h_reservation_id ?? txid,
    },
    env
  ).catch((e) => console.error(`[cancel] release-reserve failed: ${e}`));

  return json(200, { result: "CANCELLED", txid, state: "CANCELLED" });
}

// ---------------------------------------------------------------------------
// POST /api/transfers/:txid/resume-namecheck
// ---------------------------------------------------------------------------
export async function handlePostResumeNameCheck(
  _req: Request,
  txid: string,
  env: Env
): Promise<Response> {
  const result = await resumeFromNameCheckSuspended(txid, env);
  if (!result.ok) {
    if (result.state === "NOT_FOUND") return jsonError(404, "NOT_FOUND", `txid ${txid} not found`);
    if (result.state === "STATE_CONFLICT")
      return jsonError(409, "STATE_CONFLICT", `Concurrent modification on txid ${txid}`);
    return jsonError(409, "INVALID_STATE", `Cannot resume txid ${txid} in state ${result.state}`);
  }
  return json(200, { result: "RESUMED", txid, state: result.state });
}
