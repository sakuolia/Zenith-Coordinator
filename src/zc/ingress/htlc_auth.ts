/**
 * @file ZC ingress — HTLC-Auth handlers (request / approve / capture / void / whitelist).
 * @module zc/ingress/htlc_auth
 */
import type { Env, HtlcAuthRequestInput, HtlcAuthWhitelistRegisterRequest } from "../../types";
import { parseBody } from "../../shared/validator";
import { timingSafeEqualStr } from "../../shared/hmac";
import { matchesAcceptedSecret } from "../../shared/secret_rotation";
import {
  approveAuthRequest,
  captureHtlcAuth,
  createAuthRequest,
  declineAuthRequest,
  getAuthRequest,
  listAuthRequests,
  listAuthWhitelist,
  registerAuthWhitelist,
  revokeAuthWhitelist,
  voidHtlcAuth,
} from "../lanes/htlc_auth";
import { json, jsonError } from "./_shared";

// ---------------------------------------------------------------------------
// HTLC Auth (payee-initiated, authorization-style) handlers
// ---------------------------------------------------------------------------

/** POST /api/htlc/auth-request  Payee sends an authorization request */
export async function handleHtlcAuthRequest(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<HtlcAuthRequestInput>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  if (
    !body.auth_id ||
    !body.payee_bank_id ||
    !body.payee_account_hash ||
    !body.payer_bank_id ||
    !body.payer_account_hash ||
    !body.amount ||
    !body.auth_expires_at ||
    !body.capture_expires_at ||
    !body.idempotency_key
  ) {
    return jsonError(
      400,
      "MISSING_FIELDS",
      "auth_id, payee/payer info, amount, expires_at, idempotency_key required"
    );
  }
  const result = await createAuthRequest(body, env);
  if (result.result === "ERROR") return jsonError(400, result.reason_code!, result.reason_code!);
  return json(201, result);
}

/** POST /api/htlc/auth/:auth_id/approve  Payer approves */
export async function handleHtlcAuthApprove(
  req: Request,
  authId: string,
  env: Env
): Promise<Response> {
  const body = await parseBody<{ idempotency_key: string }>(req);
  if (!body?.idempotency_key) return jsonError(400, "MISSING_FIELDS", "idempotency_key required");
  const result = await approveAuthRequest(authId, { idempotency_key: body.idempotency_key }, env);
  if (result.result === "ERROR") return jsonError(400, result.reason_code!, result.reason_code!);
  return json(200, result);
}

/** POST /api/htlc/auth/:auth_id/decline  Payer declines */
export async function handleHtlcAuthDecline(
  req: Request,
  authId: string,
  env: Env
): Promise<Response> {
  const body = await parseBody<{ reason?: string; idempotency_key: string }>(req);
  if (!body?.idempotency_key) return jsonError(400, "MISSING_FIELDS", "idempotency_key required");
  const result = await declineAuthRequest(
    authId,
    { reason: body.reason, idempotency_key: body.idempotency_key },
    env
  );
  if (result.result === "ERROR") return jsonError(400, result.reason_code!, result.reason_code!);
  return json(200, result);
}

/** POST /api/htlc/:htlc_id/capture  Payee captures (fetches preimage from Vault and auto-claims) */
export async function handleHtlcCapture(req: Request, htlcId: string, env: Env): Promise<Response> {
  const body = await parseBody<{ idempotency_key: string }>(req);
  if (!body?.idempotency_key) return jsonError(400, "MISSING_FIELDS", "idempotency_key required");
  const result = await captureHtlcAuth(htlcId, { idempotency_key: body.idempotency_key }, env);
  if (result.result === "ERROR") return jsonError(400, result.reason_code!, result.reason_code!);
  return json(200, result);
}

/** POST /api/htlc/:htlc_id/void  Payee or payer voids (cancels) */
export async function handleHtlcVoid(req: Request, htlcId: string, env: Env): Promise<Response> {
  const body = await parseBody<{ reason?: string; idempotency_key: string }>(req);
  if (!body?.idempotency_key) return jsonError(400, "MISSING_FIELDS", "idempotency_key required");
  const result = await voidHtlcAuth(
    htlcId,
    { reason: body.reason, idempotency_key: body.idempotency_key },
    env
  );
  if (result.result === "ERROR") return jsonError(400, result.reason_code!, result.reason_code!);
  return json(200, result);
}

/** GET /api/htlc/auth-requests  List authorization requests */
export async function handleListHtlcAuthRequests(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const rows = await listAuthRequests(env.DB, {
    payer_bank_id: url.searchParams.get("payer_bank_id") ?? undefined,
    payee_bank_id: url.searchParams.get("payee_bank_id") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    limit: parseInt(url.searchParams.get("limit") ?? "50", 10),
  });
  return json(200, { auth_requests: rows });
}

/** GET /api/htlc/auth/:auth_id  Authorization request details */
export async function handleGetHtlcAuthRequest(authId: string, env: Env): Promise<Response> {
  const row = await getAuthRequest(authId, env.DB);
  if (!row) return jsonError(404, "NOT_FOUND", `auth_id ${authId} not found`);
  return json(200, row);
}

/**
 * Verify admin-level authorization for privileged operations.
 * Checks ZC_ADMIN_KEY header first; falls back to ZC_HMAC_SECRET if ZC_ADMIN_KEY is unset.
 */
function isAdminAuthorized(req: Request, env: Env): boolean {
  const provided =
    req.headers.get("X-Admin-Key") ??
    req.headers.get("X-Api-Key") ??
    req.headers.get("Authorization")?.replace("Bearer ", "");
  // A dedicated admin key is compared on its own; the ZC_HMAC_SECRET fallback
  // goes through the rotation window so an admin call is not the one path that
  // breaks mid-rotation. Both comparisons are constant-time.
  if (env.ZC_ADMIN_KEY) return !!provided && timingSafeEqualStr(env.ZC_ADMIN_KEY, provided);
  return matchesAcceptedSecret(provided, env);
}

/**
 * Is the caller the bank that holds this merchant's account?
 *
 * Vetting a merchant (KYB, credit, sanctions) belongs to the participant bank
 * that opened its account and accepts its instructions — not to ZC. ZC assessing
 * a merchant would contradict the system's own scope ("identity, credit and
 * limits are each participant's own discretion") and would do so on strictly
 * worse information than the bank already holds.
 *
 * The check is therefore *self*-scoped: a bank may register merchants of its
 * own, and only its own. Without the `payee_bank_id` equality a participant
 * could whitelist an account at another bank, which is the very thing the
 * whitelist exists to prevent.
 *
 * See docs/specs/10_requirements.md §3.2.3.1-3 (and §3.2.8.8 for the same division
 * of labour in continuous collection).
 */
function isOwningPayeeBank(req: Request, payeeBankId: string | undefined): boolean {
  const callerBankId = req.headers.get("X-Bank-Id");
  return !!callerBankId && !!payeeBankId && callerBankId === payeeBankId;
}

/**
 * POST /api/htlc/auth-whitelist  Register a merchant.
 *
 * Accepted from the merchant's own participant bank, or from the ZC operator
 * (retained for seeding and operational repair, not because ZC is the vetting
 * authority).
 */
export async function handleRegisterAuthWhitelist(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<HtlcAuthWhitelistRegisterRequest>(req);
  if (!isOwningPayeeBank(req, body?.payee_bank_id) && !isAdminAuthorized(req, env)) {
    return jsonError(
      403,
      "FORBIDDEN",
      "merchant registration is the payee bank's act: call as X-Bank-Id = payee_bank_id (or as the operator)"
    );
  }
  if (!body?.payee_bank_id || !body.payee_account_hash) {
    return jsonError(400, "MISSING_FIELDS", "payee_bank_id, payee_account_hash required");
  }
  if (body.eligibility_template_id !== undefined && !/^TPL-/.test(body.eligibility_template_id)) {
    return jsonError(400, "INVALID_TEMPLATE_ID", "eligibility_template_id must start with TPL-");
  }
  const result = await registerAuthWhitelist(body, env.DB);
  return json(201, result);
}

/**
 * DELETE /api/htlc/auth-whitelist/:whitelist_id  Withdraw a merchant.
 *
 * Same authority as registration — the bank that vetted the merchant is the one
 * that withdraws it — resolved from the stored entry rather than the request, so
 * a caller cannot name someone else's merchant.
 */
export async function handleRevokeAuthWhitelist(
  whitelistId: string,
  req: Request,
  env: Env
): Promise<Response> {
  const owner = await env.DB.prepare(
    `SELECT payee_bank_id FROM HtlcAuthWhitelist WHERE whitelist_id = ?`
  )
    .bind(whitelistId)
    .first<{ payee_bank_id: string }>();
  if (!isOwningPayeeBank(req, owner?.payee_bank_id) && !isAdminAuthorized(req, env)) {
    return jsonError(
      403,
      "FORBIDDEN",
      "merchant withdrawal is the payee bank's act: call as X-Bank-Id = payee_bank_id (or as the operator)"
    );
  }
  const ok = await revokeAuthWhitelist(whitelistId, env.DB);
  if (!ok) return jsonError(404, "NOT_FOUND", `whitelist_id ${whitelistId} not found`);
  return json(200, { result: "REVOKED", whitelist_id: whitelistId });
}

/** GET /api/htlc/auth-whitelist  List whitelist entries */
export async function handleListAuthWhitelist(env: Env): Promise<Response> {
  const rows = await listAuthWhitelist(env.DB);
  return json(200, { whitelist: rows });
}
