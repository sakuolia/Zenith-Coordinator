/**
 * @file FX transfer assembly + initiation. Turns a routing decision into the
 * concrete on-ledger transaction that settles a cross-currency payment.
 *
 * The realization (docs/specs/20_method_design.md §4, §5): an FX transfer is an **FXP-conduit
 * GTID**. Each currency segment of the route becomes one PAYER/PAYEE leg pair —
 * payer→FXP in the source currency, FXP→FXP across each bridge currency, and
 * FXP→payee in the target currency. Because every currency appears on both
 * sides (the FXP is a conduit), each currency balances on its own, so the
 * existing GTID lane settles the whole thing atomically with per-currency H and
 * per-currency central-bank finality — no change to the settlement core.
 *
 * This module owns only the *construction* (pure {@link buildFxGtidLegs}) and
 * the *initiation* ({@link initiateFxTransfer}: validate the quotes are live,
 * record the FX facts in FxTransfers, register the conduit GTID). Settlement and
 * finalization are the GTID lane's job, driven by the orchestrator/cron exactly
 * as for any other GTID.
 *
 * @module zc/fx/transfer
 */
import type { Env, GtidLegInput } from "../../types";
import { nowISO } from "../../types";
import { sha256hex } from "../../shared/hmac";
import { DomainError } from "../../shared/errors";
import { registerGtid } from "../lanes/gtid";
import type { FxRoute } from "./routing";
import { getQuote } from "./quotes";

/** A counterparty to an FX transfer: the bank and the account that moves funds. */
export interface FxParty {
  bank_id: string;
  account_hash: string;
}

export interface BuildFxLegsParams {
  gtid: string;
  payer: FxParty;
  payee: FxParty;
  /**
   * Resolve the FXP's funded settlement account for a given currency. An FXP on
   * hop k receives `hop.from_currency` and pays `hop.to_currency`, so it is
   * asked for an account in each of those currencies.
   */
  resolveFxpAccount: (fxpBankId: string, currency: string) => string;
}

/**
 * One currency segment of an FX route: funds move `from` → `to` in `currency`.
 * Edge `e` carries the amount entering hop `e` (or the final hop's output for the
 * payee edge). The chain is payer → fxp0 → … → payee.
 */
export interface FxEdge {
  /** 0-based position along the chain (0 = payer→fxp0, last = fxp→payee). */
  index: number;
  currency: string;
  amount: number;
  from: FxParty;
  to: FxParty;
}

/**
 * Decompose an {@link FxRoute} into its currency segments (edges). For a route
 * with hops `h0…h(n-1)` the funds flow payer → fxp0 → fxp1 → … → payee, yielding
 * `n+1` edges:
 *
 *  - edge 0:        payer → fxp0   in h0.from_currency, amount h0.amount_in
 *  - edge i (1..n-1): fxp(i-1) → fxp(i) in hi.from_currency, amount hi.amount_in
 *  - edge n:        fxp(n-1) → payee in h(n-1).to_currency, amount h(n-1).amount_out
 *
 * Each currency appears in exactly one edge (routing guarantees from, bridge,
 * and to are distinct).
 */
export function buildFxEdges(route: FxRoute, p: BuildFxLegsParams): FxEdge[] {
  const hops = route.hops;
  if (hops.length === 0)
    throw new DomainError("FX_NO_ROUTE", "route has no hops", { gtid: p.gtid });

  const n = hops.length;
  /** Party at node index (0 = payer, 1..n = fxp_{i-1}, n+1 = payee). */
  const partyAt = (nodeIdx: number, currency: string): FxParty => {
    if (nodeIdx === 0) return p.payer;
    if (nodeIdx === n + 1) return p.payee;
    const fxpBankId = hops[nodeIdx - 1]!.fxp_bank_id;
    return { bank_id: fxpBankId, account_hash: p.resolveFxpAccount(fxpBankId, currency) };
  };

  const edges: FxEdge[] = [];
  for (let e = 0; e <= n; e++) {
    const currency = e < n ? hops[e]!.from_currency : hops[n - 1]!.to_currency;
    const amount = e < n ? hops[e]!.amount_in : hops[n - 1]!.amount_out;
    edges.push({
      index: e,
      currency,
      amount,
      from: partyAt(e, currency),
      to: partyAt(e + 1, currency),
    });
  }
  return edges;
}

/**
 * Materialize an {@link FxRoute} into FXP-conduit GTID legs: each currency
 * segment ({@link buildFxEdges}) becomes a balanced PAYER/PAYEE leg pair. Since
 * each currency appears in exactly one segment, per-currency there is exactly one
 * payer and one payee — the GTID lane's per-currency decomposition pairs them
 * unambiguously.
 */
export function buildFxGtidLegs(route: FxRoute, p: BuildFxLegsParams): GtidLegInput[] {
  const legs: GtidLegInput[] = [];
  for (const edge of buildFxEdges(route, p)) {
    const tag = String(edge.index).padStart(2, "0");
    legs.push({
      leg_id: `${p.gtid}~L${tag}P`,
      role: "PAYER",
      bank_id: edge.from.bank_id,
      account_hash: edge.from.account_hash,
      amount: { value: edge.amount, currency: edge.currency },
    });
    legs.push({
      leg_id: `${p.gtid}~L${tag}Q`,
      role: "PAYEE",
      bank_id: edge.to.bank_id,
      account_hash: edge.to.account_hash,
      amount: { value: edge.amount, currency: edge.currency },
    });
  }
  return legs;
}

/** Reconstruct GTID legs directly from persisted FX edges (claim-time path). */
export function edgesToGtidLegs(gtid: string, edges: FxEdge[]): GtidLegInput[] {
  const legs: GtidLegInput[] = [];
  for (const edge of edges) {
    const tag = String(edge.index).padStart(2, "0");
    legs.push({
      leg_id: `${gtid}~L${tag}P`,
      role: "PAYER",
      bank_id: edge.from.bank_id,
      account_hash: edge.from.account_hash,
      amount: { value: edge.amount, currency: edge.currency },
    });
    legs.push({
      leg_id: `${gtid}~L${tag}Q`,
      role: "PAYEE",
      bank_id: edge.to.bank_id,
      account_hash: edge.to.account_hash,
      amount: { value: edge.amount, currency: edge.currency },
    });
  }
  return legs;
}

export interface InitiateFxTransferParams {
  gtid: string;
  route: FxRoute;
  payer: FxParty;
  payee: FxParty;
  resolveFxpAccount: (fxpBankId: string, currency: string) => string;
  idempotency_key: string;
  /** Optional pre-supplied 64-hex hashlock; one is generated when omitted. */
  hashlock?: string;
  expires_at?: string;
}

export interface InitiateFxTransferResult {
  gtid: string;
  hashlock: string;
  amount_from: number;
  amount_to: number;
  effective_rate: number;
}

/** Random 32-byte hex secret (the HTLC preimage). */
function generateSecret(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Initiate a cross-currency FX transfer for an already-selected route. Verifies
 * every quote on the route is still ACTIVE and unexpired (else FX_QUOTE_EXPIRED),
 * records the FX facts in FxTransfers, and registers the FXP-conduit GTID. The
 * caller advances/settles the GTID through the normal lane machinery.
 */
export async function initiateFxTransfer(
  env: Env,
  params: InitiateFxTransferParams
): Promise<InitiateFxTransferResult> {
  const db = env.DB;
  const now = nowISO();
  const { route } = params;

  // Quote liveness: a route accepted by the payer must still be valid when we
  // commit it; a lapsed quote means the rate is stale → reject (docs/specs/20_method_design.md §5).
  for (const hop of route.hops) {
    const q = await getQuote(db, hop.quote_id);
    if (!q || q.status !== "ACTIVE" || q.valid_to < now || q.valid_from > now) {
      throw new DomainError("FX_QUOTE_EXPIRED", "a quote on the route is no longer valid", {
        gtid: params.gtid,
        quote_id: hop.quote_id,
      });
    }
  }

  const secret = params.hashlock ? undefined : generateSecret();
  const hashlock = params.hashlock ?? (await sha256hex(secret!));

  const legs = buildFxGtidLegs(route, {
    gtid: params.gtid,
    payer: params.payer,
    payee: params.payee,
    resolveFxpAccount: params.resolveFxpAccount,
  });

  // Record the FX facts before registering the GTID, so the GTID always has its
  // FX context (route, locked quotes, hashlock) for status/audit/atomicity.
  const quoteIds = route.hops.map((h) => h.quote_id).join(",");
  await db
    .prepare(
      `INSERT OR IGNORE INTO FxTransfers
         (gtid, from_currency, to_currency, amount_from, amount_to, effective_rate,
          hashlock, route_json, quote_ids, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'INITIATED', ?, ?)`
    )
    .bind(
      params.gtid,
      route.from_currency,
      route.to_currency,
      route.amount_from,
      route.amount_to,
      route.effective_rate,
      hashlock,
      JSON.stringify(route),
      quoteIds,
      now,
      now
    )
    .run();

  await registerGtid(
    {
      gtid: params.gtid,
      legs,
      idempotency_key: params.idempotency_key,
      expires_at: params.expires_at,
    },
    env
  );

  return {
    gtid: params.gtid,
    hashlock,
    amount_from: route.amount_from,
    amount_to: route.amount_to,
    effective_rate: route.effective_rate,
  };
}

/** A persisted FX transfer record (FxTransfers row). */
export interface FxTransferRecord {
  gtid: string;
  from_currency: string;
  to_currency: string;
  amount_from: number;
  amount_to: number;
  effective_rate: number;
  hashlock: string;
  route_json: string;
  quote_ids: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/** Fetch the FX transfer record for a gtid, or null. */
export async function getFxTransfer(env: Env, gtid: string): Promise<FxTransferRecord | null> {
  return await env.DB.prepare(`SELECT * FROM FxTransfers WHERE gtid = ?`)
    .bind(gtid)
    .first<FxTransferRecord>();
}
