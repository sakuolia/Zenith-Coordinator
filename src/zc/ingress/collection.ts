/**
 * @file collection.ts — HTTP handlers for continuous collection.
 *
 * Callers are always participant banks. A payee (the collecting business) is
 * not a ZC participant — they are a customer of their bank, and both the
 * instruction and the result travel through it. There is deliberately no path
 * here that a payee could call directly.
 *
 * @module zc/ingress/collection
 */
import type { CollectionMode, Env } from "../../types";
import { DomainError, errorResponse } from "../../shared/errors";
import { json, jsonError } from "./_shared";
import type { RegisterMandateParams } from "../../shared/mandate";
import {
  registerDebitMandate,
  revokeDebitMandate,
  updateCaps,
  type CollectionCaps,
} from "../collection/mandate";
import { amendNotice, registerNotice, withdrawNotice, type LadderRung } from "../collection/notice";
import { decideAdditionalAuth } from "../collection/reauth";
import {
  collectionProfileOf,
  getCollection,
  getDebitMandate,
  listAuthorisedDebits,
} from "../collection/query";
import type { LegacyProfile } from "../../bank/legacy/adapter";

/** Map a handler's `{result:'ERROR', reason_code}` onto the shared catalog. */
function fromReasonCode(reasonCode: string, message: string): Response {
  return errorResponse(new DomainError(reasonCode, message));
}

export async function handleRegisterDebitMandate(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    payer_bank_id?: string;
    payer_account_alias?: string;
    payee_bank_id?: string;
    payee_account_hash?: string;
    product_ref?: string;
    charge_mode?: "PERIODIC" | "ITEMIZED";
    period_cycle?: "MONTHLY" | "YEARLY" | null;
    collection_mode?: CollectionMode;
    notice_days_min?: number;
    amend_freeze_hours?: number;
    ladder_max?: number;
    caps?: CollectionCaps;
    eligibility_attestation_id?: string | null;
    mandate?: Omit<RegisterMandateParams, "principalParticipantId" | "granteeRef">;
  } | null;

  if (
    !body?.payer_bank_id ||
    !body.payer_account_alias ||
    !body.payee_bank_id ||
    !body.payee_account_hash ||
    !body.product_ref ||
    !body.mandate
  ) {
    return jsonError(
      400,
      "MISSING_FIELD",
      "payer/payee identity, product_ref and mandate required"
    );
  }

  try {
    const out = await registerDebitMandate(env, {
      payerBankId: body.payer_bank_id,
      payerAccountAlias: body.payer_account_alias,
      payeeBankId: body.payee_bank_id,
      payeeAccountHash: body.payee_account_hash,
      productRef: body.product_ref,
      chargeMode: body.charge_mode ?? "PERIODIC",
      periodCycle: body.period_cycle ?? "MONTHLY",
      collectionMode: body.collection_mode ?? "SCHEDULED",
      noticeDaysMin: body.notice_days_min ?? 0,
      amendFreezeHours: body.amend_freeze_hours ?? 24,
      ladderMax: body.ladder_max ?? 3,
      caps: body.caps ?? {},
      eligibilityAttestationId: body.eligibility_attestation_id ?? null,
      mandate: body.mandate,
    });
    if (out.result === "ERROR") return fromReasonCode(out.reason_code, out.message);
    return json(200, out);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function handleUpdateCaps(
  ddMandateId: string,
  req: Request,
  env: Env
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    caps?: CollectionCaps;
    mandate?: RegisterMandateParams;
  } | null;
  if (!body?.caps) return jsonError(400, "MISSING_FIELD", "caps required");
  try {
    const out = await updateCaps(env.DB, ddMandateId, body.caps, body.mandate ?? null);
    if (out.result === "ERROR") return fromReasonCode(out.reason_code, out.message);
    return json(200, out);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function handleRevokeDebitMandate(
  ddMandateId: string,
  req: Request,
  env: Env
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { reason?: string } | null;
  const out = await revokeDebitMandate(env.DB, ddMandateId, {
    reason: body?.reason,
    actor: req.headers.get("X-Bank-Id") ? `BANK_${req.headers.get("X-Bank-Id")}` : "ZC",
  });
  if (!out) return jsonError(404, "DD_MANDATE_NOT_FOUND", "contract not found");
  return json(200, out);
}

export async function handleGetDebitMandate(ddMandateId: string, env: Env): Promise<Response> {
  const view = await getDebitMandate(env.DB, ddMandateId);
  if (!view) return jsonError(404, "DD_MANDATE_NOT_FOUND", "contract not found");
  return json(200, view);
}

export async function handleListDebitMandates(req: Request, env: Env): Promise<Response> {
  const alias = new URL(req.url).searchParams.get("payer_account_alias");
  if (!alias) return jsonError(400, "MISSING_FIELD", "payer_account_alias required");
  return json(200, { debit_mandates: await listAuthorisedDebits(env.DB, alias) });
}

export async function handleRegisterCollection(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    dd_mandate_id?: string;
    charge_ref?: string;
    rungs?: LadderRung[];
    edi_ref?: string | null;
    priority_hint?: number | null;
    idempotency_key?: string;
  } | null;
  if (!body?.dd_mandate_id || !body.charge_ref || !body.rungs || !body.idempotency_key) {
    return jsonError(
      400,
      "MISSING_FIELD",
      "dd_mandate_id, charge_ref, rungs and idempotency_key required"
    );
  }
  try {
    const out = await registerNotice(env, {
      ddMandateId: body.dd_mandate_id,
      chargeRef: body.charge_ref,
      rungs: body.rungs,
      ediRef: body.edi_ref ?? null,
      priorityHint: body.priority_hint ?? null,
      idempotencyKey: body.idempotency_key,
    });
    if (out.result === "ERROR") return fromReasonCode(out.reason_code, out.message);
    return json(200, out);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function handleAmendCollection(
  collectionId: string,
  req: Request,
  env: Env
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    amount?: number;
    latefee?: number;
    due_date?: string;
  } | null;
  const out = await amendNotice(env.DB, collectionId, {
    amount: body?.amount,
    latefee: body?.latefee,
    dueDate: body?.due_date,
  });
  if (out.result === "ERROR") return fromReasonCode(out.reason_code, out.message);
  return json(200, out);
}

export async function handleWithdrawCollection(
  collectionId: string,
  req: Request,
  env: Env
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { reason?: string } | null;
  const out = await withdrawNotice(env.DB, collectionId, body?.reason);
  if (out.result === "ERROR") {
    return fromReasonCode(out.reason_code ?? "STATE_GUARD", out.message ?? "cannot withdraw");
  }
  return json(200, { result: "WITHDRAWN", collection_id: collectionId });
}

export async function handleGetCollection(collectionId: string, env: Env): Promise<Response> {
  const view = await getCollection(env.DB, collectionId);
  if (!view) return jsonError(404, "COLLECTION_NOT_FOUND", "collection not found");
  return json(200, view);
}

export async function handleAdditionalAuth(
  collectionId: string,
  req: Request,
  env: Env
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    decision?: "APPROVE" | "DECLINE";
    mandate?: RegisterMandateParams;
  } | null;
  if (!body?.decision) return jsonError(400, "MISSING_FIELD", "decision required");
  try {
    const out = await decideAdditionalAuth(env, {
      collectionId,
      decision: body.decision,
      mandate: body.mandate,
    });
    if (out.result === "ERROR") return fromReasonCode(out.reason_code, out.message);
    return json(200, out);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function handleCollectionProfile(bankId: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare(`SELECT * FROM LegacyProfiles WHERE bank_id = ?`)
    .bind(bankId)
    .first<Record<string, unknown>>();
  const profile: LegacyProfile | null = row
    ? {
        bank_id: row.bank_id as string,
        role: row.role as LegacyProfile["role"],
        reservation_mode: row.reservation_mode as LegacyProfile["reservation_mode"],
        settlement_mode: row.settlement_mode as LegacyProfile["settlement_mode"],
        notify_mode: row.notify_mode as LegacyProfile["notify_mode"],
        sync_reserve: row.sync_reserve === 1,
        realtime_name_check: row.realtime_name_check === 1,
        batch_ingest: row.batch_ingest === 1,
        window_open_hour: (row.window_open_hour as number | null) ?? null,
        window_close_hour: (row.window_close_hour as number | null) ?? null,
      }
    : null;
  return json(200, collectionProfileOf(bankId, profile));
}
