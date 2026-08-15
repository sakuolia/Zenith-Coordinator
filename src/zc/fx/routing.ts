/**
 * @file FX best-route engine. Given a cross-currency request, selects the
 * cheapest route across FXP quotes — either a **direct** hop (from→to) or a
 * **bridge** through one intermediate currency (from→C→to, PvPvP, docs/specs/20_method_design.md
 * §3.3). "Cheapest" = most to_currency for a fixed payer amount, or least
 * from_currency for a fixed payee amount.
 *
 * Pure selection logic over rates.ts + quotes.ts; it commits nothing. The
 * returned {@link FxRoute} carries the per-hop FXP/quote/amount breakdown the
 * execution layer needs to build the HTLC-linked legs, plus an `expires_at`
 * (the earliest quote expiry on the route) for the payer's accept window.
 *
 * @module zc/fx/routing
 */
import { nowISO } from "../../types";
import { convertForward, convertBackward, composeRates } from "./rates";
import { type FxQuote, listActiveQuotes, listActiveQuotesFrom } from "./quotes";

/** Whether the fixed amount is the payer's (source) or the payee's (target). */
export type Denomination = "PAYER" | "PAYEE";

/** One FXP conversion in a route. */
export interface FxHop {
  fxp_bank_id: string;
  from_currency: string;
  to_currency: string;
  /** amount entering this hop, in from_currency. */
  amount_in: number;
  /** amount leaving this hop, in to_currency. */
  amount_out: number;
  quote_id: string;
  /** directional rate used, × RATE_SCALE. */
  rate: number;
}

/** A complete from→to route (1 hop direct, 2 hops bridged). */
export interface FxRoute {
  from_currency: string;
  to_currency: string;
  /** total source amount the payer pays, in from_currency. */
  amount_from: number;
  /** total target amount the payee receives, in to_currency. */
  amount_to: number;
  /** composed effective rate(from→to), × RATE_SCALE (display/compare). */
  effective_rate: number;
  hops: FxHop[];
  /** earliest quote expiry across the hops (the route's accept window). */
  expires_at: string;
}

export interface RouteRequest {
  from_currency: string;
  to_currency: string;
  /** fixed amount: in from_currency when PAYER-denominated, else in to_currency. */
  amount: number;
  denomination: Denomination;
  /** intermediate-currency hops allowed (0 = direct only). Default 1. */
  max_bridge_hops?: number;
  /** evaluation instant (quote validity window). Default now. */
  at?: string;
}

export type RouteResult = { ok: true; route: FxRoute } | { ok: false; reason: "FX_NO_ROUTE" };

/** True if `fromAmount` (in the quote's from_currency) is within the quote's tradable band. */
function amountInBand(fromAmount: number, q: FxQuote): boolean {
  if (fromAmount < q.min_amount) return false;
  if (q.max_amount != null && fromAmount > q.max_amount) return false;
  return true;
}

/** The earlier of two RFC3339 timestamps. */
function earlier(a: string, b: string): string {
  return a <= b ? a : b;
}

/**
 * Build a single-hop route from a quote, or null if the amount is out of band.
 * PAYER: amount = amount_in (from); PAYEE: amount = amount_out (to).
 */
function directRouteFromQuote(
  q: FxQuote,
  amount: number,
  denomination: Denomination
): FxRoute | null {
  let amountFrom: number;
  let amountTo: number;
  if (denomination === "PAYER") {
    amountFrom = amount;
    amountTo = convertForward(amount, q.rate);
  } else {
    amountTo = amount;
    amountFrom = convertBackward(amount, q.rate);
  }
  if (!amountInBand(amountFrom, q)) return null;
  return {
    from_currency: q.from_currency,
    to_currency: q.to_currency,
    amount_from: amountFrom,
    amount_to: amountTo,
    effective_rate: q.rate,
    hops: [
      {
        fxp_bank_id: q.fxp_bank_id,
        from_currency: q.from_currency,
        to_currency: q.to_currency,
        amount_in: amountFrom,
        amount_out: amountTo,
        quote_id: q.quote_id,
        rate: q.rate,
      },
    ],
    expires_at: q.valid_to,
  };
}

/**
 * Build a two-hop bridge route from→C→to using quotes `q1` (from→C) and `q2`
 * (C→to), or null if either hop is out of band. Amounts flow forward for
 * PAYER-denominated and backward (target-pinned) for PAYEE-denominated, so the
 * binding rounding direction matches the single-hop case.
 */
function bridgeRouteFromQuotes(
  q1: FxQuote,
  q2: FxQuote,
  amount: number,
  denomination: Denomination
): FxRoute | null {
  let amountFrom: number;
  let amountMid: number;
  let amountTo: number;

  if (denomination === "PAYER") {
    amountFrom = amount;
    amountMid = convertForward(amountFrom, q1.rate);
    amountTo = convertForward(amountMid, q2.rate);
  } else {
    amountTo = amount;
    amountMid = convertBackward(amountTo, q2.rate);
    amountFrom = convertBackward(amountMid, q1.rate);
  }

  if (!amountInBand(amountFrom, q1)) return null; // hop1 band is in from_currency
  if (!amountInBand(amountMid, q2)) return null; // hop2 band is in C (q2.from_currency)

  return {
    from_currency: q1.from_currency,
    to_currency: q2.to_currency,
    amount_from: amountFrom,
    amount_to: amountTo,
    effective_rate: composeRates(q1.rate, q2.rate),
    hops: [
      {
        fxp_bank_id: q1.fxp_bank_id,
        from_currency: q1.from_currency,
        to_currency: q1.to_currency,
        amount_in: amountFrom,
        amount_out: amountMid,
        quote_id: q1.quote_id,
        rate: q1.rate,
      },
      {
        fxp_bank_id: q2.fxp_bank_id,
        from_currency: q2.from_currency,
        to_currency: q2.to_currency,
        amount_in: amountMid,
        amount_out: amountTo,
        quote_id: q2.quote_id,
        rate: q2.rate,
      },
    ],
    expires_at: earlier(q1.valid_to, q2.valid_to),
  };
}

/** A route is better when the payer receives more / pays less; ties break to fewer hops. */
function isBetter(candidate: FxRoute, incumbent: FxRoute, denomination: Denomination): boolean {
  if (denomination === "PAYER") {
    if (candidate.amount_to !== incumbent.amount_to) {
      return candidate.amount_to > incumbent.amount_to;
    }
  } else {
    if (candidate.amount_from !== incumbent.amount_from) {
      return candidate.amount_from < incumbent.amount_from;
    }
  }
  return candidate.hops.length < incumbent.hops.length;
}

/**
 * Select the best route for a cross-currency request. Considers all ACTIVE,
 * in-window direct quotes and (up to `max_bridge_hops` intermediate currencies)
 * bridge routes, returning the cheapest. `FX_NO_ROUTE` if none price the amount
 * within band (or `from === to`, which needs no FX).
 */
export async function findBestRoute(db: D1Database, req: RouteRequest): Promise<RouteResult> {
  if (req.from_currency === req.to_currency) return { ok: false, reason: "FX_NO_ROUTE" };
  const at = req.at ?? nowISO();
  const maxBridgeHops = req.max_bridge_hops ?? 1;

  let best: FxRoute | null = null;

  // Direct candidates.
  const direct = await listActiveQuotes(db, req.from_currency, req.to_currency, at);
  for (const q of direct) {
    const route = directRouteFromQuote(q, req.amount, req.denomination);
    if (route && (!best || isBetter(route, best, req.denomination))) best = route;
  }

  // Bridge candidates (one intermediate currency C: from→C, C→to).
  if (maxBridgeHops >= 1) {
    const firstLegs = await listActiveQuotesFrom(db, req.from_currency, at);
    for (const q1 of firstLegs) {
      const mid = q1.to_currency;
      if (mid === req.from_currency || mid === req.to_currency) continue; // not a bridge
      const secondLegs = await listActiveQuotes(db, mid, req.to_currency, at);
      for (const q2 of secondLegs) {
        const route = bridgeRouteFromQuotes(q1, q2, req.amount, req.denomination);
        if (route && (!best || isBetter(route, best, req.denomination))) best = route;
      }
    }
  }

  return best ? { ok: true, route: best } : { ok: false, reason: "FX_NO_ROUTE" };
}
