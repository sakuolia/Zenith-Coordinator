/**
 * @file FX HTTP API handlers (docs/specs/30_internal_design.md §9). Thin request/response glue over
 * the FX modules:
 *
 *   PUT    /api/fx/rates              FXP posts/updates a directional quote
 *   DELETE /api/fx/rates/:quote_id    FXP withdraws a quote
 *   GET    /api/fx/rates?from=&to=    list active quotes for a pair
 *   POST   /api/fx/quote              best-route price discovery (no commit)
 *   POST   /api/fx/transfers          initiate a cross-currency FX transfer
 *   GET    /api/fx/transfers/:gtid    FX transfer status (FX facts + GTID state)
 *
 * Routing/validation only; the heavy lifting is in rates/quotes/routing/transfer.
 *
 * @module zc/fx/api
 */
import type { Env } from "../../types";
import { parseBody } from "../../shared/validator";
import { completeIdempotency, resolveIdempotency } from "../../shared/idempotency";
import { MAX_AMOUNT_VALUE } from "../../shared/constants";
import { isDomainError } from "../../shared/errors";
import { json, jsonError } from "../ingress";
import { RATE_SCALE } from "./rates";
import { upsertQuote, withdrawQuote, listActiveQuotes, type FxQuoteInput } from "./quotes";
import { findBestRoute, type Denomination } from "./routing";
import { initiateFxTransfer, getFxTransfer, type FxParty } from "./transfer";
import { lockFxTransfer, claimFxTransfer, refundFxTransfer, getFxLegLocks } from "./htlc";

const ISO_CCY = /^[A-Z]{3}$/;

function isDenomination(v: unknown): v is Denomination {
  return v === "PAYER" || v === "PAYEE";
}

// ---------------------------------------------------------------------------
// PUT /api/fx/rates — upsert a directional quote
// ---------------------------------------------------------------------------
interface FxRateUpsertBody {
  fxp_bank_id?: string;
  from_currency?: string;
  to_currency?: string;
  rate?: number;
  min_amount?: number;
  max_amount?: number | null;
  valid_from?: string;
  valid_to?: string;
}

export async function handlePutFxRate(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<FxRateUpsertBody>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  if (!body.fxp_bank_id) return jsonError(400, "MISSING_FIELD", "fxp_bank_id required");
  if (!body.from_currency || !ISO_CCY.test(body.from_currency))
    return jsonError(400, "INVALID_CURRENCY", "from_currency must be ISO 4217");
  if (!body.to_currency || !ISO_CCY.test(body.to_currency))
    return jsonError(400, "INVALID_CURRENCY", "to_currency must be ISO 4217");
  if (body.from_currency === body.to_currency)
    return jsonError(400, "INVALID_CURRENCY", "from_currency and to_currency must differ");
  if (typeof body.rate !== "number" || !Number.isInteger(body.rate) || body.rate <= 0)
    return jsonError(400, "INVALID_FX_RATE", "rate must be a positive integer (× RATE_SCALE)");
  if (!body.valid_to || Number.isNaN(Date.parse(body.valid_to)))
    return jsonError(400, "INVALID_REQUEST", "valid_to must be RFC3339");
  if (body.min_amount != null && (!Number.isInteger(body.min_amount) || body.min_amount < 0))
    return jsonError(400, "INVALID_AMOUNT", "min_amount must be a non-negative integer");
  if (body.max_amount != null && (!Number.isInteger(body.max_amount) || body.max_amount < 0))
    return jsonError(400, "INVALID_AMOUNT", "max_amount must be a non-negative integer");

  // FXP capability gate: only a registered FX provider may post rates.
  const fxp = await env.DB.prepare(
    `SELECT is_fx_provider, is_active FROM Participants WHERE bank_id = ?`
  )
    .bind(body.fxp_bank_id)
    .first<{ is_fx_provider: number; is_active: number }>();
  if (!fxp) return jsonError(404, "PARTICIPANT_NOT_FOUND", `bank ${body.fxp_bank_id} not found`);
  if (fxp.is_active === 0) return jsonError(409, "STATE_GUARD", "FXP is inactive");
  if (fxp.is_fx_provider === 0)
    // AUTH-category reason_code → 401 per the error-catalog mapping in
    // docs/specs/32_api_contracts.md (UNAUTHORIZED is authentication, not a 403 resource
    // forbiddance). Was previously a hardcoded 403, contradicting the catalog.
    return jsonError(401, "UNAUTHORIZED", "bank is not registered as an FX provider");

  const input: FxQuoteInput = {
    fxp_bank_id: body.fxp_bank_id,
    from_currency: body.from_currency,
    to_currency: body.to_currency,
    rate: body.rate,
    min_amount: body.min_amount,
    max_amount: body.max_amount ?? null,
    valid_from: body.valid_from,
    valid_to: body.valid_to,
  };
  const quote = await upsertQuote(env.DB, input);
  return json(200, { result: "QUOTE_ACCEPTED", quote });
}

// ---------------------------------------------------------------------------
// DELETE /api/fx/rates/:quote_id — withdraw
// ---------------------------------------------------------------------------
export async function handleDeleteFxRate(quoteId: string, env: Env): Promise<Response> {
  const withdrawn = await withdrawQuote(env.DB, quoteId);
  if (!withdrawn) return jsonError(404, "NOT_FOUND", `active quote ${quoteId} not found`);
  return json(200, { result: "QUOTE_WITHDRAWN", quote_id: quoteId });
}

// ---------------------------------------------------------------------------
// GET /api/fx/rates?from=&to= — list active quotes for a pair
// ---------------------------------------------------------------------------
export async function handleListFxRates(url: URL, env: Env): Promise<Response> {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return jsonError(400, "MISSING_FIELD", "from and to query params required");
  const quotes = await listActiveQuotes(env.DB, from, to);
  return json(200, { from_currency: from, to_currency: to, quotes });
}

// ---------------------------------------------------------------------------
// POST /api/fx/quote — best-route price discovery
// ---------------------------------------------------------------------------
interface FxQuoteReqBody {
  from_currency?: string;
  to_currency?: string;
  amount?: number;
  denomination?: string;
  max_bridge_hops?: number;
}

export async function handlePostFxQuote(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<FxQuoteReqBody>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  if (!body.from_currency || !ISO_CCY.test(body.from_currency))
    return jsonError(400, "INVALID_CURRENCY", "from_currency must be ISO 4217");
  if (!body.to_currency || !ISO_CCY.test(body.to_currency))
    return jsonError(400, "INVALID_CURRENCY", "to_currency must be ISO 4217");
  if (
    typeof body.amount !== "number" ||
    !Number.isInteger(body.amount) ||
    body.amount <= 0 ||
    body.amount > MAX_AMOUNT_VALUE
  )
    return jsonError(
      400,
      "INVALID_AMOUNT",
      `amount must be a positive integer <= ${MAX_AMOUNT_VALUE}`
    );
  if (!isDenomination(body.denomination))
    return jsonError(400, "INVALID_REQUEST", "denomination must be PAYER or PAYEE");

  const result = await findBestRoute(env.DB, {
    from_currency: body.from_currency,
    to_currency: body.to_currency,
    amount: body.amount,
    denomination: body.denomination,
    max_bridge_hops: body.max_bridge_hops,
  });
  if (!result.ok) return jsonError(409, "FX_NO_ROUTE", "no FXP route prices this request");
  return json(200, { result: "ROUTE_FOUND", rate_scale: RATE_SCALE, route: result.route });
}

// ---------------------------------------------------------------------------
// POST /api/fx/transfers — initiate
// ---------------------------------------------------------------------------
interface FxTransferReqBody {
  gtid?: string;
  idempotency_key?: string;
  from_currency?: string;
  to_currency?: string;
  amount?: number;
  denomination?: string;
  payer?: FxParty;
  payee?: FxParty;
  /** FXP liquidity accounts keyed "<bankId>:<currency>". */
  fxp_accounts?: Record<string, string>;
  max_bridge_hops?: number;
  expires_at?: string;
  /** Optional adverse-movement guard: reject if the priced effective rate is worse. */
  min_effective_rate?: number;
  /**
   * When true, lock the legs under a shared hashlock and DEFER settlement until
   * /claim (cross-rail atomicity, docs/specs/30_internal_design.md §13 P2) instead of settling now.
   */
  bind_htlc?: boolean;
}

function validParty(p: FxParty | undefined): p is FxParty {
  return !!p && typeof p.bank_id === "string" && typeof p.account_hash === "string";
}

export async function handlePostFxTransfer(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<FxTransferReqBody>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  if (!body.gtid || !/^GT-/.test(body.gtid))
    return jsonError(400, "INVALID_GTID", "gtid must start with GT-");
  if (!body.idempotency_key)
    return jsonError(400, "MISSING_IDEMPOTENCY_KEY", "idempotency_key required");
  if (!body.from_currency || !ISO_CCY.test(body.from_currency))
    return jsonError(400, "INVALID_CURRENCY", "from_currency must be ISO 4217");
  if (!body.to_currency || !ISO_CCY.test(body.to_currency))
    return jsonError(400, "INVALID_CURRENCY", "to_currency must be ISO 4217");
  if (
    typeof body.amount !== "number" ||
    !Number.isInteger(body.amount) ||
    body.amount <= 0 ||
    body.amount > MAX_AMOUNT_VALUE
  )
    return jsonError(
      400,
      "INVALID_AMOUNT",
      `amount must be a positive integer <= ${MAX_AMOUNT_VALUE}`
    );
  if (!isDenomination(body.denomination))
    return jsonError(400, "INVALID_REQUEST", "denomination must be PAYER or PAYEE");
  if (!validParty(body.payer))
    return jsonError(400, "MISSING_FIELD", "payer {bank_id, account_hash} required");
  if (!validParty(body.payee))
    return jsonError(400, "MISSING_FIELD", "payee {bank_id, account_hash} required");

  const idem = await resolveIdempotency(body.idempotency_key, body, env.DB);
  if (idem.status === "CONFLICT")
    return jsonError(
      409,
      "IDEMPOTENCY_KEY_CONFLICT",
      "idempotency_key was already used with a different request body"
    );
  if (idem.status === "REPLAY") return json(200, idem.response);

  // Authoritative re-pricing: never trust a client-submitted route. Re-run the
  // engine and (optionally) guard against adverse rate movement since the quote.
  const routed = await findBestRoute(env.DB, {
    from_currency: body.from_currency,
    to_currency: body.to_currency,
    amount: body.amount,
    denomination: body.denomination,
    max_bridge_hops: body.max_bridge_hops,
  });
  if (!routed.ok) {
    const resp = { result: "REJECTED", reason_code: "FX_NO_ROUTE" };
    await completeIdempotency(body.idempotency_key, resp, env.DB);
    return jsonError(409, "FX_NO_ROUTE", "no FXP route prices this request");
  }
  const route = routed.route;
  if (body.min_effective_rate != null && route.effective_rate < body.min_effective_rate) {
    const resp = { result: "REJECTED", reason_code: "FX_RATE_MISMATCH" };
    await completeIdempotency(body.idempotency_key, resp, env.DB);
    return jsonError(
      409,
      "FX_RATE_MISMATCH",
      "best available rate is worse than min_effective_rate"
    );
  }

  // Every FXP currency leg needs a funded settlement account from the caller.
  const accounts = body.fxp_accounts ?? {};
  for (const hop of route.hops) {
    for (const ccy of [hop.from_currency, hop.to_currency]) {
      if (!accounts[`${hop.fxp_bank_id}:${ccy}`]) {
        const resp = { result: "REJECTED", reason_code: "FX_FXP_ACCOUNT_MISSING" };
        await completeIdempotency(body.idempotency_key, resp, env.DB);
        return jsonError(
          400,
          "FX_FXP_ACCOUNT_MISSING",
          `fxp_accounts missing entry for ${hop.fxp_bank_id}:${ccy}`
        );
      }
    }
  }

  try {
    if (body.bind_htlc) {
      // Cross-rail atomic path: lock the legs; settlement waits for /claim.
      const locked = await lockFxTransfer(env, {
        gtid: body.gtid,
        route,
        payer: body.payer,
        payee: body.payee,
        resolveFxpAccount: (bankId, ccy) => accounts[`${bankId}:${ccy}`]!,
      });
      const resp = { result: "FX_TRANSFER_LOCKED", ...locked, route };
      await completeIdempotency(body.idempotency_key, resp, env.DB);
      return json(201, resp);
    }
    const result = await initiateFxTransfer(env, {
      gtid: body.gtid,
      route,
      payer: body.payer,
      payee: body.payee,
      resolveFxpAccount: (bankId, ccy) => accounts[`${bankId}:${ccy}`]!,
      idempotency_key: body.idempotency_key,
      expires_at: body.expires_at,
    });
    const resp = { result: "FX_TRANSFER_INITIATED", ...result, route };
    await completeIdempotency(body.idempotency_key, resp, env.DB);
    return json(201, resp);
  } catch (e) {
    if (isDomainError(e)) {
      const resp = { result: "REJECTED", reason_code: e.reason_code };
      await completeIdempotency(body.idempotency_key, resp, env.DB);
      return jsonError(409, e.reason_code, e.message);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// POST /api/fx/transfers/:gtid/claim — reveal the secret (HTLC-bound settle)
// ---------------------------------------------------------------------------
export async function handleClaimFxTransfer(
  req: Request,
  gtid: string,
  env: Env
): Promise<Response> {
  const body = await parseBody<{ secret?: string }>(req);
  if (!body?.secret) return jsonError(400, "MISSING_FIELD", "secret required");
  try {
    const result = await claimFxTransfer(env, gtid, body.secret);
    return json(200, { result: "FX_TRANSFER_CLAIMED", ...result });
  } catch (e) {
    if (isDomainError(e)) {
      const status =
        e.reason_code === "PREIMAGE_MISMATCH"
          ? 400
          : e.reason_code === "GTID_NOT_FOUND"
            ? 404
            : 409;
      return jsonError(status, e.reason_code, e.message);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// POST /api/fx/transfers/:gtid/refund — refund after timelock (HTLC-bound)
// ---------------------------------------------------------------------------
export async function handleRefundFxTransfer(gtid: string, env: Env): Promise<Response> {
  try {
    const result = await refundFxTransfer(env, gtid);
    return json(200, { result: "FX_TRANSFER_REFUNDED", ...result });
  } catch (e) {
    if (isDomainError(e)) {
      const status = e.reason_code === "GTID_NOT_FOUND" ? 404 : 409;
      return jsonError(status, e.reason_code, e.message);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// GET /api/fx/transfers/:gtid — status
// ---------------------------------------------------------------------------
export async function handleGetFxTransfer(gtid: string, env: Env): Promise<Response> {
  const rec = await getFxTransfer(env, gtid);
  if (!rec) return jsonError(404, "GTID_NOT_FOUND", `FX transfer ${gtid} not found`);

  const gt = await env.DB.prepare(`SELECT state FROM GtidTransactions WHERE gtid = ?`)
    .bind(gtid)
    .first<{ state: string }>();
  const legs = await env.DB.prepare(
    `SELECT leg_id, role, bank_id, amount_value, leg_currency, state FROM GtidLegs WHERE gtid = ? ORDER BY leg_id`
  )
    .bind(gtid)
    .all<{
      leg_id: string;
      role: string;
      bank_id: string;
      amount_value: number;
      leg_currency: string;
      state: string;
    }>();
  // HTLC-bound transfers carry per-leg lock state (LOCKED/CLAIMED/REFUNDED).
  const locks = await getFxLegLocks(env, gtid);

  return json(200, {
    gtid,
    status: rec.status,
    from_currency: rec.from_currency,
    to_currency: rec.to_currency,
    amount_from: rec.amount_from,
    amount_to: rec.amount_to,
    effective_rate: rec.effective_rate,
    hashlock: rec.hashlock,
    quote_ids: rec.quote_ids.split(","),
    gtid_state: gt?.state ?? null,
    legs: legs.results ?? [],
    leg_locks: locks.map((l) => ({
      leg_index: l.leg_index,
      currency: l.currency,
      amount: l.amount,
      timelock: l.timelock,
      state: l.state,
    })),
  });
}
