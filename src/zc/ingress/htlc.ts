/**
 * @file ZC ingress — HTLC handlers (create / claim / attest / conditions / cross-chain).
 * @module zc/ingress/htlc
 */
import type {
  Env,
  HtlcAttestClaimRequest,
  HtlcClaimRequest,
  HtlcConditionsClaimRequest,
  HtlcCreateRequest,
  HtlcCrossChainLockRequest,
  HtlcOnchainFulfillmentRequest,
} from "../../types";
import {
  parseBody,
  validateHtlcAttestClaim,
  validateHtlcClaim,
  validateHtlcCreate,
  validateHtlcCrossChainLock,
  validateHtlcOnchainFulfillment,
} from "../../shared/validator";
import { completeIdempotency, resolveIdempotency } from "../../shared/idempotency";
import {
  claimHtlc,
  claimHtlcByAttestation,
  claimHtlcByConditions,
  createHtlc,
  recordCrossChainLock,
  recordOnchainFulfillment,
} from "../lanes/htlc";
import { json, jsonError } from "./_shared";

// ---------------------------------------------------------------------------
// POST /api/htlc/create
// ---------------------------------------------------------------------------
export async function handlePostHtlcCreate(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<HtlcCreateRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "Request body must be valid JSON");
  const v = validateHtlcCreate(body);
  if (!v.ok) return jsonError(400, v.reason_code!, v.message!);

  const idem = await resolveIdempotency(body.idempotency_key, body, env.DB);
  if (idem.status === "CONFLICT")
    return jsonError(
      409,
      "IDEMPOTENCY_KEY_CONFLICT",
      "idempotency_key was already used with a different request body"
    );
  if (idem.status === "REPLAY") return json(200, idem.response);

  const result = await createHtlc(body, env);
  await completeIdempotency(body.idempotency_key, result, env.DB);
  return json(201, result);
}

// ---------------------------------------------------------------------------
// POST /api/htlc/:htlc_id/claim
// ---------------------------------------------------------------------------
export async function handlePostHtlcClaim(
  req: Request,
  htlcId: string,
  env: Env
): Promise<Response> {
  const body = await parseBody<HtlcClaimRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  const v = validateHtlcClaim(body);
  if (!v.ok) return jsonError(400, v.reason_code!, v.message!);

  const idem = await resolveIdempotency(body.idempotency_key, body, env.DB);
  if (idem.status === "CONFLICT")
    return jsonError(
      409,
      "IDEMPOTENCY_KEY_CONFLICT",
      "idempotency_key was already used with a different request body"
    );
  if (idem.status === "REPLAY") return json(200, idem.response);

  const result = await claimHtlc({ ...body, htlc_id: htlcId }, env);
  await completeIdempotency(body.idempotency_key, result, env.DB);
  return json(200, result);
}

// ---------------------------------------------------------------------------
// POST /api/htlc/:htlc_id/claim-by-attestation (テーマC)
// ---------------------------------------------------------------------------
export async function handlePostHtlcAttestClaim(
  req: Request,
  htlcId: string,
  env: Env
): Promise<Response> {
  const body = await parseBody<HtlcAttestClaimRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  const v = validateHtlcAttestClaim(body);
  if (!v.ok) return jsonError(400, v.reason_code!, v.message!);

  const idem = await resolveIdempotency(body.idempotency_key, body, env.DB);
  if (idem.status === "CONFLICT")
    return jsonError(
      409,
      "IDEMPOTENCY_KEY_CONFLICT",
      "idempotency_key was already used with a different request body"
    );
  if (idem.status === "REPLAY") return json(200, idem.response);

  const result = await claimHtlcByAttestation({ ...body, htlc_id: htlcId }, env);
  await completeIdempotency(body.idempotency_key, result, env.DB);
  return json(200, result);
}

// ---------------------------------------------------------------------------
// POST /api/htlc/:htlc_id/claim-by-conditions (AND/OR programmability)
// ---------------------------------------------------------------------------
export async function handlePostHtlcConditionsClaim(
  req: Request,
  htlcId: string,
  env: Env
): Promise<Response> {
  const body = await parseBody<HtlcConditionsClaimRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  if (!Array.isArray(body.attestations) || body.attestations.length === 0)
    return jsonError(400, "ATTESTATIONS_REQUIRED", "attestations[] must be a non-empty array");
  if (!body.idempotency_key)
    return jsonError(400, "IDEMPOTENCY_KEY_REQUIRED", "idempotency_key is required");

  const idem = await resolveIdempotency(body.idempotency_key, body, env.DB);
  if (idem.status === "CONFLICT")
    return jsonError(
      409,
      "IDEMPOTENCY_KEY_CONFLICT",
      "idempotency_key was already used with a different request body"
    );
  if (idem.status === "REPLAY") return json(200, idem.response);

  const result = await claimHtlcByConditions({ ...body, htlc_id: htlcId }, env);
  await completeIdempotency(body.idempotency_key, result, env.DB);
  return json(200, result);
}

// ---------------------------------------------------------------------------
// POST /api/htlc/:htlc_id/cross-chain-lock (テーマA, Watcher-only)
// ---------------------------------------------------------------------------
export async function handlePostHtlcCrossChainLock(
  req: Request,
  htlcId: string,
  env: Env
): Promise<Response> {
  const body = await parseBody<HtlcCrossChainLockRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  const v = validateHtlcCrossChainLock(body);
  if (!v.ok) return jsonError(400, v.reason_code!, v.message!);

  const idem = await resolveIdempotency(body.idempotency_key, body, env.DB);
  if (idem.status === "CONFLICT")
    return jsonError(
      409,
      "IDEMPOTENCY_KEY_CONFLICT",
      "idempotency_key was already used with a different request body"
    );
  if (idem.status === "REPLAY") return json(200, idem.response);

  const result = await recordCrossChainLock({ ...body, htlc_id: htlcId }, env);
  await completeIdempotency(body.idempotency_key, result, env.DB);
  return json(200, result);
}

// ---------------------------------------------------------------------------
// POST /api/htlc/:htlc_id/onchain-fulfillment (テーマA, Watcher-only)
// ---------------------------------------------------------------------------
export async function handlePostHtlcOnchainFulfillment(
  req: Request,
  htlcId: string,
  env: Env
): Promise<Response> {
  const body = await parseBody<HtlcOnchainFulfillmentRequest>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  const v = validateHtlcOnchainFulfillment(body);
  if (!v.ok) return jsonError(400, v.reason_code!, v.message!);

  const idem = await resolveIdempotency(body.idempotency_key, body, env.DB);
  if (idem.status === "CONFLICT")
    return jsonError(
      409,
      "IDEMPOTENCY_KEY_CONFLICT",
      "idempotency_key was already used with a different request body"
    );
  if (idem.status === "REPLAY") return json(200, idem.response);

  const result = await recordOnchainFulfillment({ ...body, htlc_id: htlcId }, env);
  await completeIdempotency(body.idempotency_key, result, env.DB);
  return json(200, result);
}
