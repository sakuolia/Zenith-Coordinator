/**
 * @file ZC Core API router (/api/*).
 * @module router/zc
 */
import bankApiYaml from "../openapi/bank-api";
import zcApiYaml from "../openapi/zc-api";
import { newUUID } from "../shared/idempotency";
import { revokeMandate } from "../shared/mandate";
import {
  handleAdditionalAuth,
  handleAmendCollection,
  handleCollectionProfile,
  handleGetCollection,
  handleGetDebitMandate,
  handleListDebitMandates,
  handleRegisterCollection,
  handleRegisterDebitMandate,
  handleRevokeDebitMandate,
  handleUpdateCaps,
  handleWithdrawCollection,
} from "../zc/ingress/collection";
import type {
  AccountVerifyBatchRequest,
  AccountVerifyRequest,
  CrossBorderSendRequest,
  CrossBorderStatus,
  EdiRegisterRequest,
  Env,
  IgsCallbackInput,
  ProxyRegisterRequest,
  ProxyType,
  QrGenerateRequest,
  QrPayRequest,
  RichDataStoreRequest,
  RtpRespondRequest,
} from "../types";
import { nowISO } from "../types";
import { CASE_UPDATE_STATES, isCaseUpdateState, updateCase } from "../zc/cases/case";
import { getReversalById, getReversals, requestReversal } from "../zc/cases/reversal";
import type { ReversalRequest } from "../zc/cases/reversal";
import {
  batchVerify,
  getVerificationResult,
  requestAccountVerification,
} from "../zc/directory/account_verify";
import {
  deactivateProxy,
  registerProxy,
  resolveProxy as resolveProxyLookup,
} from "../zc/directory/proxy";
import { registerPspr } from "../zc/directory/pspr";
import { generateQrCode, getQrCode, processQrPayment } from "../zc/directory/qr";
import { createSseResponse } from "../zc/events/stream";
import { getGtidEvents, getRecentEvents, getTxEvents } from "../zc/events/trace";
import { verifyChainWithCosign, recordFinalityCosign } from "../zc/finality/finality_anchor";
import type { RecordFinalityCosignParams } from "../zc/finality/finality_anchor";
import {
  handleClaimFxTransfer,
  handleDeleteFxRate,
  handleGetFxTransfer,
  handleListFxRates,
  handlePostFxQuote,
  handlePostFxTransfer,
  handlePutFxRate,
  handleRefundFxTransfer,
} from "../zc/fx/api";
import {
  handleAccountNameLookup,
  handleAddBank,
  handleBankAccounts,
  handleDeleteBank,
  handleGetHtlcAuthRequest,
  handleHtlcAuthApprove,
  handleHtlcAuthDecline,
  handleHtlcAuthRequest,
  handleHtlcCapture,
  handleHtlcVoid,
  handleListAuthWhitelist,
  handleListBanks,
  handleListHtlcAuthRequests,
  handlePostAuthorize,
  handlePostCancel,
  handlePostGtidRegister,
  handlePostHtlcAttestClaim,
  handlePostHtlcClaim,
  handlePostHtlcConditionsClaim,
  handlePostHtlcCreate,
  handlePostHtlcCrossChainLock,
  handlePostHtlcOnchainFulfillment,
  handlePostParticipantRegister,
  handlePostResumeNameCheck,
  handlePostRtpRequest,
  handlePostTransfers,
  handleRegisterAuthWhitelist,
  handleRevokeAuthWhitelist,
  json,
  jsonError,
} from "../zc/ingress";
import { getCircuitStatus, listCircuitStates, resetCircuit } from "../zc/platform/circuit_breaker";
import { explainTransaction } from "../zc/query/explain";
import {
  handleGetCase,
  handleGetDnsHoldDetail,
  handleGetDnsPosition,
  handleGetDnsStatus,
  handleGetGtid,
  handleGetHtlc,
  handleGetSystemMode,
  handleGetTransaction,
  handleListGtids,
  handleListHtlcs,
  handleListTransactions,
} from "../zc/query/query";
import { narrateTransaction } from "../zc/query/story";
import { dryRunMandate, simulateConditionExpr } from "../zc/query/simulate";
import {
  getCrossBorderTransaction,
  initiateCrossBorderTransfer,
  updateCrossBorderStatus,
} from "../zc/richdata/cross_border";
import { getEdiByRef, getEdiByTxid, registerEdiRecord } from "../zc/richdata/edi";
import { getRichData, listRichDataByTxid, storeRichData } from "../zc/richdata/richdata";
import { respondToRtp } from "../zc/rtp";
import { assertParty, authorizeAggregateRead, authorizeRead } from "../zc/platform/access";
import { classifyRead } from "../zc/platform/access_routes";
import { getBojPositions } from "../zc/settlement/dns";
import { handleIgsCallback } from "../zc/settlement/igs";

// =========================================================================
// ZC routing
// =========================================================================
export async function handleZcApi(
  req: Request,
  path: string,
  method: string,
  env: Env
): Promise<Response> {
  // GET /api/openapi/*.yaml -- API specification
  const yamlHeaders = {
    "Content-Type": "text/yaml; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  };
  if (method === "GET" && path === "/api/openapi/zc.yaml")
    return new Response(zcApiYaml, { headers: yamlHeaders });
  if (method === "GET" && path === "/api/openapi/bank.yaml")
    return new Response(bankApiYaml, { headers: yamlHeaders });

  // -----------------------------------------------------------------------
  // Query access gate (requirements S-5 / S-7, `zc/platform/access.ts`)
  //
  // One choke point, deliberately: the same reasoning as the write side, where
  // read-only degradation and the single-owner rule share `assertWritableDb`
  // (`30_internal_design.md` §5.6). A per-route check would leave the next
  // endpoint ungated by omission; here an endpoint is gated unless the route
  // table says why it is public, and an invariant test enforces that.
  // -----------------------------------------------------------------------
  if (method === "GET") {
    const guarded = classifyRead(path);
    if (guarded) {
      if (guarded.kind === "AGGREGATE") {
        const gate = await authorizeAggregateRead(req, env, guarded.resource);
        if (!gate.ok) return gate.response;
      } else {
        const gate = await authorizeRead(req, env, guarded.resource);
        if (!gate.ok) return gate.response;
        const refusal = await assertParty(
          env,
          gate.grant,
          guarded.resource,
          guarded.lookup,
          guarded.id
        );
        if (refusal) return refusal;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Programmability dry-run (read-only; no writes, no fund movement)
  // -----------------------------------------------------------------------

  // POST /api/conditions/validate  — structural validation of a condition_expr
  if (method === "POST" && path === "/api/conditions/validate") {
    const body = (await req.json().catch(() => null)) as { condition_expr?: unknown } | null;
    if (!body || body.condition_expr === undefined)
      return jsonError(400, "INVALID_JSON", "condition_expr is required");
    const r = simulateConditionExpr(body.condition_expr);
    return json(200, { valid: r.valid, error: r.error, required_templates: r.required_templates });
  }

  // POST /api/conditions/simulate  — evaluate a condition_expr against a
  // hypothetical satisfied-template set (which branches gate, what is missing)
  if (method === "POST" && path === "/api/conditions/simulate") {
    const body = (await req.json().catch(() => null)) as {
      condition_expr?: unknown;
      satisfied?: unknown;
    } | null;
    if (!body || body.condition_expr === undefined)
      return jsonError(400, "INVALID_JSON", "condition_expr is required");
    if (body.satisfied !== undefined && !Array.isArray(body.satisfied))
      return jsonError(400, "INVALID_JSON", "satisfied must be an array of template_id strings");
    const satisfied = (body.satisfied as string[] | undefined)?.map(String) ?? [];
    const r = simulateConditionExpr(body.condition_expr, satisfied);
    if (!r.valid) return jsonError(400, "CONDITION_EXPR_INVALID", r.error ?? "invalid expression");
    return json(200, r);
  }

  // POST /api/mandates/check  — dry-run a mandate against an instruction scope
  if (method === "POST" && path === "/api/mandates/check") {
    const body = (await req.json().catch(() => null)) as {
      mandate_id?: string;
      amount?: number;
      purpose?: string;
      lane?: string;
      now?: string;
    } | null;
    if (!body || typeof body.mandate_id !== "string")
      return jsonError(400, "INVALID_JSON", "mandate_id is required");
    const result = await dryRunMandate(
      env.DB,
      body.mandate_id,
      { amount: body.amount, purpose: body.purpose, lane: body.lane },
      body.now
    );
    return json(200, result);
  }

  // POST /api/mandates/:mandate_id/revoke
  const mandateRevokeMatch = /^\/api\/mandates\/([^/]+)\/revoke$/.exec(path);
  if (method === "POST" && mandateRevokeMatch) {
    const body = (await req.json().catch(() => null)) as { reason?: string } | null;
    const revoked = await revokeMandate(env.DB, decodeURIComponent(mandateRevokeMatch[1]!), {
      reason: body?.reason,
      actor: req.headers.get("X-Bank-Id") ? `BANK_${req.headers.get("X-Bank-Id")}` : "ZC",
    });
    if (!revoked) return jsonError(404, "MANDATE_NOT_FOUND", "mandate not found");
    return json(200, {
      result: "REVOKED",
      mandate_id: decodeURIComponent(mandateRevokeMatch[1]!),
      revoked_at: revoked.revoked_at,
      already: revoked.already,
    });
  }

  // ----- 継続収納（口座振替） ---------------------------------------------
  // Callers are participant banks; a collecting business reaches ZC only
  // through the bank that holds its account (10_requirements.md §3.2.8.8-4).
  if (method === "POST" && path === "/api/debit-mandates")
    return handleRegisterDebitMandate(req, env);
  if (method === "GET" && path === "/api/debit-mandates") return handleListDebitMandates(req, env);

  const ddCapsMatch = /^\/api\/debit-mandates\/([^/]+)\/caps$/.exec(path);
  if (method === "PATCH" && ddCapsMatch)
    return handleUpdateCaps(decodeURIComponent(ddCapsMatch[1]!), req, env);

  const ddMatch = /^\/api\/debit-mandates\/([^/]+)$/.exec(path);
  if (ddMatch) {
    const id = decodeURIComponent(ddMatch[1]!);
    if (method === "DELETE") return handleRevokeDebitMandate(id, req, env);
    if (method === "GET") return handleGetDebitMandate(id, env);
  }

  if (method === "POST" && path === "/api/collections") return handleRegisterCollection(req, env);

  const collectionAuthMatch = /^\/api\/collections\/([^/]+)\/additional-auth$/.exec(path);
  if (method === "POST" && collectionAuthMatch)
    return handleAdditionalAuth(decodeURIComponent(collectionAuthMatch[1]!), req, env);

  const collectionMatch = /^\/api\/collections\/([^/]+)$/.exec(path);
  if (collectionMatch) {
    const id = decodeURIComponent(collectionMatch[1]!);
    if (method === "PATCH") return handleAmendCollection(id, req, env);
    if (method === "DELETE") return handleWithdrawCollection(id, req, env);
    if (method === "GET") return handleGetCollection(id, env);
  }

  const profileMatch = /^\/api\/directory\/banks\/([^/]+)\/collection-profile$/.exec(path);
  if (method === "GET" && profileMatch)
    return handleCollectionProfile(decodeURIComponent(profileMatch[1]!), env);

  // POST /api/transfers
  if (method === "POST" && path === "/api/transfers") return handlePostTransfers(req, env);

  // POST /api/htlc/create
  if (method === "POST" && path === "/api/htlc/create") return handlePostHtlcCreate(req, env);

  // POST /api/htlc/auth-request  receiving-side authorization request
  if (method === "POST" && path === "/api/htlc/auth-request")
    return handleHtlcAuthRequest(req, env);

  // GET /api/htlc/auth-requests  authorization request list
  if (method === "GET" && path === "/api/htlc/auth-requests")
    return handleListHtlcAuthRequests(req, env);

  // GET /api/stream/connect  (Rafiki-style Streaming Websocket)
  if (method === "GET" && path === "/api/stream/connect") {
    const id = env.STREAM_DO?.idFromName("global-stream-1");
    if (!id || !env.STREAM_DO) return jsonError(500, "NO_DO", "STREAM_DO unavailable");
    const stub = env.STREAM_DO.get(id);
    return stub.fetch(req);
  }

  // GET /api/als/lookup  (Mojaloop-style Account Lookup Service)
  if (method === "GET" && path === "/api/als/lookup") {
    const alias = new URL(req.url).searchParams.get("alias");
    if (!alias) return jsonError(400, "BAD_REQUEST", "?alias= required");
    const { lookupAlias } = await import("../zc/directory/als");
    const res = await lookupAlias(alias, env);
    if (!res) return jsonError(404, "NOT_FOUND", "Alias not found");
    return json(200, res);
  }

  // GET/POST/DELETE /api/htlc/auth-whitelist  whitelist management
  if (path === "/api/htlc/auth-whitelist") {
    if (method === "GET") return handleListAuthWhitelist(env);
    if (method === "POST") return handleRegisterAuthWhitelist(req, env);
  }
  const whitelistDeleteMatch = path.match(/^\/api\/htlc\/auth-whitelist\/([^/]+)$/);
  if (method === "DELETE" && whitelistDeleteMatch)
    return handleRevokeAuthWhitelist(whitelistDeleteMatch[1]!, req, env);

  // GET /api/htlc/auth/:auth_id  authorization request detail
  const htlcAuthGetMatch = path.match(/^\/api\/htlc\/auth\/([^/]+)$/);
  if (method === "GET" && htlcAuthGetMatch)
    return handleGetHtlcAuthRequest(htlcAuthGetMatch[1]!, env);

  // POST /api/htlc/auth/:auth_id/approve  originating-side approval
  const htlcAuthApproveMatch = path.match(/^\/api\/htlc\/auth\/([^/]+)\/approve$/);
  if (method === "POST" && htlcAuthApproveMatch)
    return handleHtlcAuthApprove(req, htlcAuthApproveMatch[1]!, env);

  // POST /api/htlc/auth/:auth_id/decline  originating-side decline
  const htlcAuthDeclineMatch = path.match(/^\/api\/htlc\/auth\/([^/]+)\/decline$/);
  if (method === "POST" && htlcAuthDeclineMatch)
    return handleHtlcAuthDecline(req, htlcAuthDeclineMatch[1]!, env);

  // POST /api/htlc/:htlc_id/claim
  const htlcClaimMatch = path.match(/^\/api\/htlc\/([^/]+)\/claim$/);
  if (method === "POST" && htlcClaimMatch) return handlePostHtlcClaim(req, htlcClaimMatch[1]!, env);

  // POST /api/htlc/:htlc_id/claim-by-attestation (テーマC)
  const htlcAttestClaimMatch = path.match(/^\/api\/htlc\/([^/]+)\/claim-by-attestation$/);
  if (method === "POST" && htlcAttestClaimMatch)
    return handlePostHtlcAttestClaim(req, htlcAttestClaimMatch[1]!, env);

  // POST /api/htlc/:htlc_id/claim-by-conditions (AND/OR programmability)
  const htlcConditionsClaimMatch = path.match(/^\/api\/htlc\/([^/]+)\/claim-by-conditions$/);
  if (method === "POST" && htlcConditionsClaimMatch)
    return handlePostHtlcConditionsClaim(req, htlcConditionsClaimMatch[1]!, env);

  // POST /api/htlc/:htlc_id/cross-chain-lock (テーマA, Watcher-only)
  const htlcCrossChainLockMatch = path.match(/^\/api\/htlc\/([^/]+)\/cross-chain-lock$/);
  if (method === "POST" && htlcCrossChainLockMatch)
    return handlePostHtlcCrossChainLock(req, htlcCrossChainLockMatch[1]!, env);

  // POST /api/htlc/:htlc_id/onchain-fulfillment (テーマA, Watcher-only)
  const htlcOnchainFulfillmentMatch = path.match(/^\/api\/htlc\/([^/]+)\/onchain-fulfillment$/);
  if (method === "POST" && htlcOnchainFulfillmentMatch)
    return handlePostHtlcOnchainFulfillment(req, htlcOnchainFulfillmentMatch[1]!, env);

  // POST /api/htlc/:htlc_id/capture  receiving-side capture (authorization type)
  const htlcCaptureMatch = path.match(/^\/api\/htlc\/([^/]+)\/capture$/);
  if (method === "POST" && htlcCaptureMatch)
    return handleHtlcCapture(req, htlcCaptureMatch[1]!, env);

  // POST /api/htlc/:htlc_id/void  void (authorization cancellation)
  const htlcVoidMatch = path.match(/^\/api\/htlc\/([^/]+)\/void$/);
  if (method === "POST" && htlcVoidMatch) return handleHtlcVoid(req, htlcVoidMatch[1]!, env);

  // GET /api/htlc  (list)
  if (method === "GET" && path === "/api/htlc") return handleListHtlcs(req, env);

  // GET /api/htlc/:htlc_id
  const htlcGetMatch = path.match(/^\/api\/htlc\/([^/]+)$/);
  if (method === "GET" && htlcGetMatch) return handleGetHtlc(htlcGetMatch[1]!, env);

  // GET /api/transactions/:txid/events  transaction event log
  const txEventsMatch = path.match(/^\/api\/transactions\/([^/]+)\/events$/);
  if (method === "GET" && txEventsMatch) {
    const events = await getTxEvents(txEventsMatch[1]!, env.DB);
    return json(200, { txid: txEventsMatch[1], events });
  }

  // GET /api/transactions/:txid/explain  human-readable explanation of state transitions + tampering detection
  const txExplainMatch = path.match(/^\/api\/transactions\/([^/]+)\/explain$/);
  if (method === "GET" && txExplainMatch) {
    const result = await explainTransaction(env.DB, txExplainMatch[1]!);
    if (!result) return jsonError(404, "NOT_FOUND", `txid ${txExplainMatch[1]} not found`);
    return json(200, result);
  }

  // GET /api/transactions/:txid/story  narrative + Mermaid sequence diagram + soundness
  const txStoryMatch = path.match(/^\/api\/transactions\/([^/]+)\/story$/);
  if (method === "GET" && txStoryMatch) {
    const result = await narrateTransaction(env.DB, txStoryMatch[1]!);
    if (!result) return jsonError(404, "NOT_FOUND", `txid ${txStoryMatch[1]} not found`);
    return json(200, result);
  }

  // GET /api/transactions/:txid/verify  FinalityLog hash chain + co-sign validation
  const txVerifyMatch = path.match(/^\/api\/transactions\/([^/]+)\/verify$/);
  if (method === "GET" && txVerifyMatch) {
    const result = await verifyChainWithCosign(env.DB, txVerifyMatch[1]!);
    return json(200, result);
  }

  // GET /api/gtid/:gtid/verify  hash chain + co-sign validation for GTID
  const gtidVerifyMatch = path.match(/^\/api\/gtid\/([^/]+)\/verify$/);
  if (method === "GET" && gtidVerifyMatch) {
    const result = await verifyChainWithCosign(env.DB, gtidVerifyMatch[1]!);
    return json(200, result);
  }

  // GET /api/dns/:cycle_id/verify  hash chain + co-sign validation for a DNS cycle
  const dnsVerifyMatch = path.match(/^\/api\/dns\/([^/]+)\/verify$/);
  if (method === "GET" && dnsVerifyMatch) {
    const result = await verifyChainWithCosign(env.DB, dnsVerifyMatch[1]!);
    return json(200, result);
  }

  // POST /api/finality/cosign  participant co-signs a TX/GTID/DNS chain's current tip
  if (method === "POST" && path === "/api/finality/cosign") {
    const body = (await req.json().catch(() => null)) as
      | (RecordFinalityCosignParams & Record<string, unknown>)
      | null;
    if (!body || typeof body.chainId !== "string" || typeof body.participantId !== "string") {
      return jsonError(400, "INVALID_JSON", "chainId and participantId are required");
    }
    // recordFinalityCosign throws typed DomainErrors (COSIGN_*, KEY_*,
    // EXTERNAL_SIGNATURE_INVALID, …) which the top-level handler maps to status.
    const row = await recordFinalityCosign(env.DB, {
      chainId: body.chainId,
      participantId: body.participantId,
      signerKeyId: body.signerKeyId,
      nonce: body.nonce,
      occurredAt: body.occurredAt,
      signatureB64: body.signatureB64,
    });
    return json(200, row);
  }

  // GET /api/events  global event log (most recent N entries)
  if (method === "GET" && path === "/api/events") {
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const events = await getRecentEvents(env.DB, limit, offset);
    return json(200, { events });
  }

  // POST /api/gtid/register
  if (method === "POST" && path === "/api/gtid/register") return handlePostGtidRegister(req, env);

  // ----- Cross-currency FX (docs/specs/30_internal_design.md §9) -----
  // PUT/GET /api/fx/rates  — FXP quote upsert / pair listing
  if (path === "/api/fx/rates") {
    if (method === "PUT") return handlePutFxRate(req, env);
    if (method === "GET") return handleListFxRates(new URL(req.url), env);
  }
  // DELETE /api/fx/rates/:quote_id  — withdraw a quote
  const fxRateDeleteMatch = path.match(/^\/api\/fx\/rates\/([^/]+)$/);
  if (method === "DELETE" && fxRateDeleteMatch)
    return handleDeleteFxRate(fxRateDeleteMatch[1]!, env);
  // POST /api/fx/quote  — best-route price discovery
  if (method === "POST" && path === "/api/fx/quote") return handlePostFxQuote(req, env);
  // POST /api/fx/transfers  — initiate an FX transfer (immediate, or bind_htlc to lock)
  if (method === "POST" && path === "/api/fx/transfers") return handlePostFxTransfer(req, env);
  // POST /api/fx/transfers/:gtid/claim  — reveal the secret (HTLC-bound settle)
  const fxClaimMatch = path.match(/^\/api\/fx\/transfers\/([^/]+)\/claim$/);
  if (method === "POST" && fxClaimMatch) return handleClaimFxTransfer(req, fxClaimMatch[1]!, env);
  // POST /api/fx/transfers/:gtid/refund  — refund after timelock (HTLC-bound)
  const fxRefundMatch = path.match(/^\/api\/fx\/transfers\/([^/]+)\/refund$/);
  if (method === "POST" && fxRefundMatch) return handleRefundFxTransfer(fxRefundMatch[1]!, env);
  // GET /api/fx/transfers/:gtid  — FX transfer status
  const fxTransferGetMatch = path.match(/^\/api\/fx\/transfers\/([^/]+)$/);
  if (method === "GET" && fxTransferGetMatch)
    return handleGetFxTransfer(fxTransferGetMatch[1]!, env);

  // GET /api/gtid (list)
  if (method === "GET" && path === "/api/gtid") return handleListGtids(req, env);

  // GET /api/gtid/:gtid/events  (match /events first)
  const gtidEventsMatch = path.match(/^\/api\/gtid\/([^/]+)\/events$/);
  if (method === "GET" && gtidEventsMatch) {
    const events = await getGtidEvents(gtidEventsMatch[1]!, env.DB);
    return json(200, { gtid: gtidEventsMatch[1], events });
  }

  // GET /api/gtid/:gtid
  const gtidMatch = path.match(/^\/api\/gtid\/([^/]+)$/);
  if (method === "GET" && gtidMatch) return handleGetGtid(gtidMatch[1]!, env);

  // GET /api/rtp/incoming?account=XXXXXXXXXX  list of incoming requests (payer side)
  if (method === "GET" && path === "/api/rtp/incoming") {
    const account = new URL(req.url).searchParams.get("account") ?? "";

    // Validate that account is bank_id(3) + account_number(7) = 10 characters
    if (!account || account.length !== 10) {
      return jsonError(
        400,
        "INVALID_ACCOUNT_FORMAT",
        "account parameter must be exactly 10 characters (bank_id + account_number)"
      );
    }

    const payerBankId = account.slice(0, 3);
    const now = new Date().toISOString();
    // Because the RTP consolidation removed RtpRequestRows, the payer-side incoming
    // list also references RtpRequests directly.
    const rows = await env.DB.prepare(`
      SELECT rtp_id, payee_bank_id, payer_bank_id, amount_value, state AS rtp_status,
             payee_name, description, expires_at, notified_at, created_at
      FROM RtpRequests
      WHERE payer_bank_id = ?
        AND state IN ('CREATED', 'NOTIFIED')
        AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 50
    `)
      .bind(payerBankId, now)
      .all<Record<string, unknown>>();
    return json(200, { requests: rows.results });
  }

  // POST /api/rtp/request
  if (method === "POST" && path === "/api/rtp/request") return handlePostRtpRequest(req, env);

  // POST /api/transfers/:txid/authorize
  const authMatch = path.match(/^\/api\/transfers\/([^/]+)\/authorize$/);
  if (method === "POST" && authMatch) return handlePostAuthorize(req, authMatch[1]!, env);

  // POST /api/transfers/:txid/cancel
  const cancelMatch = path.match(/^\/api\/transfers\/([^/]+)\/cancel$/);
  if (method === "POST" && cancelMatch) return handlePostCancel(req, cancelMatch[1]!, env);

  // POST /api/transfers/:txid/resume-namecheck
  const resumeNamecheckMatch = path.match(/^\/api\/transfers\/([^/]+)\/resume-namecheck$/);
  if (method === "POST" && resumeNamecheckMatch)
    return handlePostResumeNameCheck(req, resumeNamecheckMatch[1]!, env);

  // POST /api/transfers/:txid/no-debit-proof  H_locked automatic release (proof-of-non-execution, §8.4.1)
  // Like the bank ingress, validate X-ZC-Signature (signed proof originating from PayerBank).
  const noDebitMatch = path.match(/^\/api\/transfers\/([^/]+)\/no-debit-proof$/);
  if (method === "POST" && noDebitMatch) {
    const body = (await req.json().catch(() => null)) as {
      proof_ref?: string;
      bank_id?: string;
    } | null;
    // Authenticate before validating fields, matching the bank-ingress HTTP
    // wrapper's order (handleBankIngressHttp) — an unsigned/unauthenticated
    // caller must not learn which body fields are missing.
    if (env.ZC_HMAC_SECRET) {
      const signature = req.headers.get("X-ZC-Signature");
      if (!signature) return jsonError(401, "MISSING_SIGNATURE", "X-ZC-Signature required");
      const { verifySignatureRotating } = await import("../shared/secret_rotation");
      if (!(await verifySignatureRotating(body, signature, env)))
        return jsonError(401, "INVALID_SIGNATURE", "signature verification failed");
    }
    if (!body?.proof_ref) return jsonError(400, "PROOF_REF_REQUIRED", "proof_ref is required");
    const { submitNoDebitProof } = await import("../zc/liquidity/h_unlock");
    const result = await submitNoDebitProof(env.DB, noDebitMatch[1]!, {
      proof_ref: body.proof_ref,
      bank_id: body.bank_id ?? "UNKNOWN",
    });
    return json(result.ok ? 200 : 422, result);
  }

  // POST /api/transfers/:txid/credit-failed-proof  cause-of-action proof that opens
  // the Reversal gate (docs/specs/10_requirements.md §4.3.0 第1層). Payee-bank signed, like no-debit-proof.
  const creditFailedMatch = path.match(/^\/api\/transfers\/([^/]+)\/credit-failed-proof$/);
  if (method === "POST" && creditFailedMatch) {
    const body = (await req.json().catch(() => null)) as {
      proof_ref?: string;
      bank_id?: string;
      reason_code?: string;
    } | null;
    // Authenticate before validating fields (same order as no-debit-proof): an
    // unauthenticated caller must not learn which fields are missing.
    if (env.ZC_HMAC_SECRET) {
      const signature = req.headers.get("X-ZC-Signature");
      if (!signature) return jsonError(401, "MISSING_SIGNATURE", "X-ZC-Signature required");
      const { verifySignatureRotating } = await import("../shared/secret_rotation");
      if (!(await verifySignatureRotating(body, signature, env)))
        return jsonError(401, "INVALID_SIGNATURE", "signature verification failed");
    }
    if (!body?.proof_ref) return jsonError(400, "PROOF_REF_REQUIRED", "proof_ref is required");
    const { submitCreditFailedProof } = await import("../zc/cases/reversal");
    const result = await submitCreditFailedProof(env.DB, creditFailedMatch[1]!, {
      proof_ref: body.proof_ref,
      bank_id: body.bank_id ?? "UNKNOWN",
      reason_code: body.reason_code,
    });
    return json(result.ok ? 200 : 422, result);
  }

  // POST /api/transfers/:txid/h-unlock-authorize  H_locked operational release (four-eyes, §8.4.1)
  const hUnlockMatch = path.match(/^\/api\/transfers\/([^/]+)\/h-unlock-authorize$/);
  if (method === "POST" && hUnlockMatch) {
    const body = (await req.json().catch(() => null)) as {
      approver_1?: string;
      approver_2?: string;
      evidence_type?: string;
      evidence_ref?: string;
      case_id?: string;
    } | null;
    if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
    const { authorizeHUnlock } = await import("../zc/liquidity/h_unlock");
    const result = await authorizeHUnlock(env.DB, hUnlockMatch[1]!, {
      approver_1: body.approver_1 ?? "",
      approver_2: body.approver_2 ?? "",
      evidence_type: body.evidence_type ?? "",
      evidence_ref: body.evidence_ref ?? "",
      case_id: body.case_id,
    });
    return json(result.ok ? 200 : 422, result);
  }

  // POST /api/transfers/:txid/misrecord-correct  誤記録訂正 (§13.4: 唯一の超例外)
  // Four-eyes + evidence + time-window controlled correction of an erroneously
  // recorded `a`. Not a cancel/Reversal — funds did not move.
  const misrecordMatch = path.match(/^\/api\/transfers\/([^/]+)\/misrecord-correct$/);
  if (method === "POST" && misrecordMatch) {
    const body = (await req.json().catch(() => null)) as {
      approver_1?: string;
      approver_2?: string;
      evidence_type?: string;
      evidence_ref?: string;
      note?: string;
    } | null;
    if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
    const { correctMisrecord } = await import("../zc/finality/misrecord");
    const result = await correctMisrecord(env.DB, misrecordMatch[1]!, {
      approver_1: body.approver_1 ?? "",
      approver_2: body.approver_2 ?? "",
      evidence_type: body.evidence_type ?? "",
      evidence_ref: body.evidence_ref ?? "",
      note: body.note,
    });
    return json(result.ok ? 200 : 422, result);
  }

  // GET /api/transactions (list)
  if (method === "GET" && path === "/api/transactions") return handleListTransactions(req, env);

  // GET /api/transactions/:txid
  const txidMatch = path.match(/^\/api\/transactions\/([^/]+)$/);
  if (method === "GET" && txidMatch) return handleGetTransaction(txidMatch[1]!, env);

  // GET /api/dns/:business_date/status
  const dnsStatusMatch = path.match(/^\/api\/dns\/([^/]+)\/status$/);
  if (method === "GET" && dnsStatusMatch) return handleGetDnsStatus(dnsStatusMatch[1]!, env);

  // GET /api/dns/:business_date/position
  const dnsPosMatch = path.match(/^\/api\/dns\/([^/]+)\/position$/);
  if (method === "GET" && dnsPosMatch) return handleGetDnsPosition(dnsPosMatch[1]!, env);

  // GET /api/dns/:business_date/hold_detail — closed domain (defaulting bank /
  // supervisor / central bank / ZC ops). Every refusal is 404, never 403.
  const dnsHoldDetailMatch = path.match(/^\/api\/dns\/([^/]+)\/hold_detail$/);
  if (method === "GET" && dnsHoldDetailMatch) {
    return handleGetDnsHoldDetail(req, dnsHoldDetailMatch[1]!, env);
  }

  // GET /api/system-mode
  if (method === "GET" && path === "/api/system-mode") return handleGetSystemMode(env);

  // GET /api/boj/positions — query each participating bank's BOJ deposit (BOJ) balance (public API)
  // Report "Topic 7: How funds settlement and clearing should work" — balance monitoring for the prefunded RTGS scheme
  if (method === "GET" && path === "/api/boj/positions") {
    const positions = await getBojPositions(env.DB);
    return json(200, { positions, as_of: nowISO() });
  }

  // GET /api/cases/:case_id
  const caseMatch = path.match(/^\/api\/cases\/([^/]+)$/);
  if (method === "GET" && caseMatch) return handleGetCase(caseMatch[1]!, env);

  // POST /api/cases/:case_id/update
  const caseUpdateMatch = path.match(/^\/api\/cases\/([^/]+)\/update$/);
  if (method === "POST" && caseUpdateMatch) {
    const body = (await req.json().catch(() => null)) as { state?: unknown } | null;
    // Validate before writing: `updateCase` CASes the value straight into
    // Cases.state, so an unchecked string would put the CASE ledger into a
    // state the case state machine does not know — and EntityStateLog would
    // faithfully record the corruption.
    if (!isCaseUpdateState(body?.state)) {
      return jsonError(
        400,
        "INVALID_STATE",
        `state must be one of ${CASE_UPDATE_STATES.join(" | ")}`
      );
    }
    await updateCase(env.DB, caseUpdateMatch[1]!, body.state);
    return json(200, { result: "UPDATED" });
  }

  // -----------------------------------------------------------------------
  // Reversal (remedial transaction)
  // -----------------------------------------------------------------------

  // POST /api/reversals
  if (method === "POST" && path === "/api/reversals") {
    const body = await req.json<ReversalRequest>();
    const result = await requestReversal(body, env);
    return json(result.result === "REVERSAL_CREATED" ? 201 : 422, result);
  }

  // GET /api/reversals/:reversal_id
  const revIdMatch = path.match(/^\/api\/reversals\/([^/]+)$/);
  if (method === "GET" && revIdMatch) {
    const rev = await getReversalById(revIdMatch[1]!, env.DB);
    if (!rev) return jsonError(404, "NOT_FOUND", "reversal not found");
    return json(200, rev);
  }

  // GET /api/transactions/:txid/reversals
  const txRevMatch = path.match(/^\/api\/transactions\/([^/]+)\/reversals$/);
  if (method === "GET" && txRevMatch) {
    const revs = await getReversals(txRevMatch[1]!, env.DB);
    return json(200, { original_txid: txRevMatch[1], reversals: revs });
  }

  // -----------------------------------------------------------------------
  // Circuit Breaker (participating bank connectivity monitoring)
  // -----------------------------------------------------------------------

  // GET /api/circuit-breaker
  if (method === "GET" && path === "/api/circuit-breaker") {
    const states = await listCircuitStates(env.DB);
    return json(200, { circuit_breakers: states });
  }

  // GET /api/circuit-breaker/:bank_id
  const cbMatch = path.match(/^\/api\/circuit-breaker\/([^/]+)$/);
  if (method === "GET" && cbMatch) {
    const status = await getCircuitStatus(cbMatch[1]!, env.DB);
    if (!status)
      return json(200, {
        bank_id: cbMatch[1],
        state: "CLOSED",
        consecutive_failures: 0,
        total_requests: 0,
        total_successes: 0,
        total_failures: 0,
        total_denied: 0,
        half_open_inflight: 0,
        last_success_at: null,
      });
    return json(200, status);
  }

  // POST /api/circuit-breaker/:bank_id/reset  (ops override)
  const cbResetMatch = path.match(/^\/api\/circuit-breaker\/([^/]+)\/reset$/);
  if (method === "POST" && cbResetMatch) {
    await resetCircuit(cbResetMatch[1]!, env.DB);
    return json(200, { result: "RESET", bank_id: cbResetMatch[1] });
  }

  // POST /api/pspr/register
  if (method === "POST" && path === "/api/pspr/register") {
    const body = (await req.json()) as {
      pspr_ref: string;
      payee_bank_id: string;
      account_hash: string;
      expires_at: string;
    };
    const result = await registerPspr(
      env.DB,
      body.pspr_ref,
      body.payee_bank_id,
      body.account_hash,
      body.expires_at
    );
    return json(201, result);
  }

  // POST /api/participants/register
  if (method === "POST" && path === "/api/participants/register")
    return handlePostParticipantRegister(req, env);

  // --- Bank administration ---
  // GET /api/banks
  if (method === "GET" && path === "/api/banks") return handleListBanks(env);

  // POST /api/banks/add
  if (method === "POST" && path === "/api/banks/add") return handleAddBank(req, env);

  // DELETE /api/banks/:bankId
  const bankDeleteMatch = path.match(/^\/api\/banks\/([^/]+)$/);
  if (method === "DELETE" && bankDeleteMatch) return handleDeleteBank(bankDeleteMatch[1]!, env);

  // GET /api/banks/:bankId/accounts
  const bankAcctsMatch = path.match(/^\/api\/banks\/([^/]+)\/accounts$/);
  if (method === "GET" && bankAcctsMatch) return handleBankAccounts(bankAcctsMatch[1]!, env);

  // GET /api/accounts/:accountId/name  account holder name lookup
  const nameMatch = path.match(/^\/api\/accounts\/([^/]+)\/name$/);
  if (method === "GET" && nameMatch) return handleAccountNameLookup(nameMatch[1]!, env);

  // POST /api/rtp/:rtpId/respond
  const rtpRespondMatch = path.match(/^\/api\/rtp\/([^/]+)\/respond$/);
  if (method === "POST" && rtpRespondMatch) {
    const body = await req.json<RtpRespondRequest>();
    const result = await respondToRtp(env.DB, rtpRespondMatch[1]!, body, env);
    return json(200, result);
  }

  // --- Account Verification ---
  // POST /api/account-verify/batch  (must come before /:verificationId)
  if (method === "POST" && path === "/api/account-verify/batch") {
    const body = await req.json<AccountVerifyBatchRequest>();
    const bankId = req.headers.get("X-Bank-Id") ?? "UNKNOWN";
    const results = await batchVerify(
      env.DB,
      { ...body, request_bank_id: body.request_bank_id ?? bankId },
      env
    );
    return json(200, results);
  }

  // POST /api/account-verify
  if (method === "POST" && path === "/api/account-verify") {
    const body = await req.json<AccountVerifyRequest>();
    const bankId = req.headers.get("X-Bank-Id") ?? "UNKNOWN";
    const result = await requestAccountVerification(
      env.DB,
      { ...body, request_bank_id: body.request_bank_id ?? bankId },
      env
    );
    return json(200, result);
  }

  // GET /api/account-verify/:verificationId
  const acctVerifyMatch = path.match(/^\/api\/account-verify\/([^/]+)$/);
  if (method === "GET" && acctVerifyMatch) {
    const result = await getVerificationResult(env.DB, acctVerifyMatch[1]!);
    if (!result) return jsonError(404, "NOT_FOUND", "verification not found");
    return json(200, result);
  }

  // --- EDI ---
  // POST /api/edi/register
  if (method === "POST" && path === "/api/edi/register") {
    const body = await req.json<EdiRegisterRequest>();
    const bankId = req.headers.get("X-Bank-Id") ?? "UNKNOWN";
    const result = await registerEdiRecord(env.DB, body, bankId);
    return json(201, result);
  }

  // GET /api/edi/tx/:txid  (must come before /api/edi/:ediRef)
  const ediTxMatch = path.match(/^\/api\/edi\/tx\/([^/]+)$/);
  if (method === "GET" && ediTxMatch) {
    const result = await getEdiByTxid(env.DB, ediTxMatch[1]!);
    if (!result) return jsonError(404, "NOT_FOUND", "EDI record not found");
    return json(200, result);
  }

  // GET /api/edi/:ediRef
  const ediRefMatch = path.match(/^\/api\/edi\/([^/]+)$/);
  if (method === "GET" && ediRefMatch) {
    const result = await getEdiByRef(env.DB, ediRefMatch[1]!);
    if (!result) return jsonError(404, "NOT_FOUND", "EDI record not found");
    return json(200, result);
  }

  // --- Proxy ---
  // POST /api/proxy/register
  if (method === "POST" && path === "/api/proxy/register") {
    const body = await req.json<ProxyRegisterRequest>();
    const result = await registerProxy(env.DB, body);
    return json(201, result);
  }

  // GET /api/proxy/resolve
  if (method === "GET" && path === "/api/proxy/resolve") {
    const url2 = new URL(req.url);
    const proxyType = (url2.searchParams.get("proxy_type") ??
      url2.searchParams.get("type")) as ProxyType | null;
    const proxyValue = url2.searchParams.get("proxy_value") ?? url2.searchParams.get("value") ?? "";
    if (!proxyType || !proxyValue)
      return jsonError(400, "INVALID_PARAMS", "proxy_type and proxy_value required");
    const result = await resolveProxyLookup(env.DB, proxyType, proxyValue);
    if (!result) return jsonError(404, "NOT_FOUND", "proxy not found");
    return json(200, result);
  }

  // DELETE /api/proxy/:proxyId
  const proxyDeleteMatch = path.match(/^\/api\/proxy\/([^/]+)$/);
  if (method === "DELETE" && proxyDeleteMatch) {
    await deactivateProxy(env.DB, proxyDeleteMatch[1]!);
    return json(200, { result: "DEACTIVATED" });
  }

  // --- QR ---
  // POST /api/qr/generate
  if (method === "POST" && path === "/api/qr/generate") {
    const body = await req.json<QrGenerateRequest>();
    const result = await generateQrCode(env.DB, body, env);
    return json(201, result);
  }

  // POST /api/qr/pay  (must come before /api/qr/:qrRef)
  if (method === "POST" && path === "/api/qr/pay") {
    const body = await req.json<QrPayRequest>();
    const result = await processQrPayment(env.DB, body, env);
    if (!result.valid) return jsonError(400, "QR_INVALID", result.error ?? "QR payment failed");

    // QR validation OK → launch the actual transfer processing
    const qr = result.qrRow!;
    const txid = `TX-${newUUID()}`;
    const zcReq = new Request("http://internal/api/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_version: "1.0",
        message_type: "EVENT",
        name: "PaymentInitiated",
        message_id: newUUID(),
        idempotency_key: body.idempotency_key ?? newUUID(),
        occurred_at: nowISO(),
        txid,
        lane: "EXPRESS",
        amount: { value: result.effectiveAmount, currency: qr.amount_currency ?? "JPY" },
        payer: { bank_id: body.payer_bank_id, account_hash: body.payer_account_id },
        payee: { bank_id: qr.payee_bank_id, account_hash: qr.payee_account_id },
        purpose: "MERCHANT",
        qr_ref: qr.qr_ref,
      }),
    });
    return handlePostTransfers(zcReq, env);
  }

  // GET /api/qr/:qrRef
  const qrRefMatch = path.match(/^\/api\/qr\/([^/]+)$/);
  if (method === "GET" && qrRefMatch) {
    const result = await getQrCode(env.DB, qrRefMatch[1]!);
    if (!result) return jsonError(404, "NOT_FOUND", "QR code not found");
    return json(200, result);
  }

  // --- Rich Data ---
  // POST /api/richdata/store
  if (method === "POST" && path === "/api/richdata/store") {
    const body = await req.json<RichDataStoreRequest>();
    const bankId = req.headers.get("X-Bank-Id") ?? "UNKNOWN";
    const result = await storeRichData(env.DB, body, bankId, env);
    return json(201, result);
  }

  // GET /api/richdata/tx/:txid  (must come before /api/richdata/:dataRef)
  const richDataTxMatch = path.match(/^\/api\/richdata\/tx\/([^/]+)$/);
  if (method === "GET" && richDataTxMatch) {
    const result = await listRichDataByTxid(env.DB, richDataTxMatch[1]!);
    return json(200, result);
  }

  // GET /api/richdata/:dataRef
  const richDataRefMatch = path.match(/^\/api\/richdata\/([^/]+)$/);
  if (method === "GET" && richDataRefMatch) {
    const result = await getRichData(env.DB, richDataRefMatch[1]!);
    if (!result) return jsonError(404, "NOT_FOUND", "rich data not found");
    return json(200, result);
  }

  // --- Cross-Border ---
  // POST /api/cross-border/send
  if (method === "POST" && path === "/api/cross-border/send") {
    const body = await req.json<CrossBorderSendRequest>();
    try {
      const result = await initiateCrossBorderTransfer(env.DB, body, env);
      return json(201, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("FATF R16 validation failed")) {
        return jsonError(400, "FATF_VALIDATION_ERROR", msg);
      }
      if (msg.startsWith("Unsupported foreign_currency")) {
        return jsonError(400, "INVALID_CURRENCY", msg);
      }
      if (msg.startsWith("foreign_amount must be")) {
        return jsonError(400, "INVALID_AMOUNT", msg);
      }
      throw err;
    }
  }

  // POST /api/cross-border/:cbTxid/callback  (must come before /:cbTxid)
  const cbCallbackMatch = path.match(/^\/api\/cross-border\/([^/]+)\/callback$/);
  if (method === "POST" && cbCallbackMatch) {
    const body = await req.json<{ status: CrossBorderStatus; foreign_ref?: string }>();
    await updateCrossBorderStatus(env.DB, cbCallbackMatch[1]!, body.status, body.foreign_ref);
    return json(200, { result: "UPDATED" });
  }

  // GET /api/cross-border/:cbTxid
  const cbTxidMatch = path.match(/^\/api\/cross-border\/([^/]+)$/);
  if (method === "GET" && cbTxidMatch) {
    const result = await getCrossBorderTransaction(env.DB, cbTxidMatch[1]!);
    if (!result) return jsonError(404, "NOT_FOUND", "cross-border transaction not found");
    return json(200, result);
  }

  // --- SSE ---
  // GET /api/sse/events/:bankId
  const sseMatch = path.match(/^\/api\/sse\/events\/([^/]+)$/);
  if (method === "GET" && sseMatch) return createSseResponse(env.DB, sseMatch[1]!);

  // --- IGS ---
  // POST /api/igs/callback
  if (method === "POST" && path === "/api/igs/callback") {
    const body = await req.json<IgsCallbackInput>();
    await handleIgsCallback(env.DB, body, env);
    return json(200, { result: "OK" });
  }

  return jsonError(404, "NOT_FOUND", `ZC API ${method} ${path} not found`);
}
