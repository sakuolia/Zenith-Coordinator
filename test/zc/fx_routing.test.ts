/**
 * @file Tests for the FX quote store (src/zc/fx/quotes.ts) and best-route
 * engine (src/zc/fx/routing.ts): upsert/withdraw/validity-window semantics,
 * direct best-rate selection, single-bridge composition, payer- vs
 * payee-denominated routing, tradable-band filtering, and FX_NO_ROUTE.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  upsertQuote,
  getQuote,
  listActiveQuotes,
  withdrawQuote,
  type FxQuoteInput,
} from "../../src/zc/fx/quotes";
import { findBestRoute } from "../../src/zc/fx/routing";
import { RATE_SCALE } from "../../src/zc/fx/rates";

let db: MockD1Database;

beforeEach(() => {
  const { d1 } = createTestDb();
  db = d1;
});

const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

function quote(
  over: Partial<FxQuoteInput> &
    Pick<FxQuoteInput, "fxp_bank_id" | "from_currency" | "to_currency" | "rate">
): FxQuoteInput {
  return { valid_to: FAR_FUTURE, ...over };
}

describe("fx/quotes: upsert / get / withdraw", () => {
  it("inserts then supersedes the same FXP+pair in place", async () => {
    const q1 = await upsertQuote(
      db,
      quote({ fxp_bank_id: "002", from_currency: "JPY", to_currency: "USD", rate: 670_000 })
    );
    expect(q1.quote_id).toMatch(/^FXQ-/);
    expect(q1.status).toBe("ACTIVE");

    const q2 = await upsertQuote(
      db,
      quote({ fxp_bank_id: "002", from_currency: "JPY", to_currency: "USD", rate: 680_000 })
    );
    expect(q2.quote_id).toBe(q1.quote_id); // same row
    expect(q2.rate).toBe(680_000);
    expect(q2.version).toBe(1);

    const active = await listActiveQuotes(db, "JPY", "USD");
    expect(active).toHaveLength(1);
  });

  it("withdraw deactivates and hides from active listing", async () => {
    const q = await upsertQuote(
      db,
      quote({ fxp_bank_id: "002", from_currency: "JPY", to_currency: "USD", rate: 670_000 })
    );
    expect(await withdrawQuote(db, q.quote_id)).toBe(true);
    expect(await withdrawQuote(db, q.quote_id)).toBe(false); // idempotent
    expect(await listActiveQuotes(db, "JPY", "USD")).toHaveLength(0);
    expect((await getQuote(db, q.quote_id))!.status).toBe("WITHDRAWN");
  });

  it("excludes quotes outside their validity window", async () => {
    await upsertQuote(db, {
      fxp_bank_id: "002",
      from_currency: "JPY",
      to_currency: "USD",
      rate: 670_000,
      valid_from: "2020-01-01T00:00:00.000Z",
      valid_to: "2020-12-31T00:00:00.000Z",
    });
    expect(await listActiveQuotes(db, "JPY", "USD", "2026-06-19T00:00:00.000Z")).toHaveLength(0);
  });
});

describe("fx/routing: direct route", () => {
  beforeEach(async () => {
    // Two FXPs quote JPY→USD; 003 is better.
    await upsertQuote(
      db,
      quote({ fxp_bank_id: "002", from_currency: "JPY", to_currency: "USD", rate: 670_000 })
    );
    await upsertQuote(
      db,
      quote({ fxp_bank_id: "003", from_currency: "JPY", to_currency: "USD", rate: 680_000 })
    );
  });

  it("PAYER-denominated picks the highest rate (most USD received)", async () => {
    const r = await findBestRoute(db, {
      from_currency: "JPY",
      to_currency: "USD",
      amount: 1_000_000,
      denomination: "PAYER",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.hops).toHaveLength(1);
    expect(r.route.hops[0].fxp_bank_id).toBe("003");
    expect(r.route.amount_from).toBe(1_000_000);
    expect(r.route.amount_to).toBe(6_800); // 1e6 × 0.0068
    expect(r.route.effective_rate).toBe(680_000);
  });

  it("PAYEE-denominated picks the route that costs the least JPY", async () => {
    const r = await findBestRoute(db, {
      from_currency: "JPY",
      to_currency: "USD",
      amount: 6_800,
      denomination: "PAYEE",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.hops[0].fxp_bank_id).toBe("003"); // higher rate → fewer JPY
    expect(r.route.amount_to).toBe(6_800);
    expect(r.route.amount_from).toBe(1_000_000); // ceil(6800 × 1e8 / 680000)
  });

  it("filters out quotes whose band excludes the amount", async () => {
    await upsertQuote(db, {
      fxp_bank_id: "004",
      from_currency: "JPY",
      to_currency: "USD",
      rate: 700_000,
      min_amount: 10_000_000,
      valid_to: FAR_FUTURE,
    });
    // 004 has the best rate but min_amount excludes a 1,000,000 trade → 003 wins.
    const r = await findBestRoute(db, {
      from_currency: "JPY",
      to_currency: "USD",
      amount: 1_000_000,
      denomination: "PAYER",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.hops[0].fxp_bank_id).toBe("003");
  });
});

describe("fx/routing: bridge route", () => {
  it("composes from→C→to and reports the composed effective rate", async () => {
    // JPY→EUR (1.5e-2 → rate 1_500_000) then EUR→USD (1.1 → 110_000_000)
    await upsertQuote(
      db,
      quote({ fxp_bank_id: "002", from_currency: "JPY", to_currency: "EUR", rate: 1_500_000 })
    );
    await upsertQuote(
      db,
      quote({ fxp_bank_id: "003", from_currency: "EUR", to_currency: "USD", rate: 110_000_000 })
    );
    // No direct JPY→USD quote → only the bridge is available.
    const r = await findBestRoute(db, {
      from_currency: "JPY",
      to_currency: "USD",
      amount: 1_000_000,
      denomination: "PAYER",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.hops).toHaveLength(2);
    expect(r.route.hops[0].to_currency).toBe("EUR");
    expect(r.route.hops[1].from_currency).toBe("EUR");
    // mid = 1e6 × 0.015 = 15_000 EUR; to = 15_000 × 1.1 = 16_500 USD
    expect(r.route.hops[0].amount_out).toBe(15_000);
    expect(r.route.amount_to).toBe(16_500);
    expect(r.route.effective_rate).toBe(1_650_000); // 0.015 × 1.1 = 0.0165
  });

  it("prefers a direct route when it beats the bridge, ties to fewer hops", async () => {
    await upsertQuote(
      db,
      quote({ fxp_bank_id: "002", from_currency: "JPY", to_currency: "EUR", rate: 1_500_000 })
    );
    await upsertQuote(
      db,
      quote({ fxp_bank_id: "003", from_currency: "EUR", to_currency: "USD", rate: 110_000_000 })
    );
    // Direct JPY→USD at exactly the composed rate (0.0165) → tie on amount_to, direct wins.
    await upsertQuote(
      db,
      quote({ fxp_bank_id: "004", from_currency: "JPY", to_currency: "USD", rate: 1_650_000 })
    );
    const r = await findBestRoute(db, {
      from_currency: "JPY",
      to_currency: "USD",
      amount: 1_000_000,
      denomination: "PAYER",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.hops).toHaveLength(1);
    expect(r.route.hops[0].fxp_bank_id).toBe("004");
  });

  it("does not bridge when max_bridge_hops=0", async () => {
    await upsertQuote(
      db,
      quote({ fxp_bank_id: "002", from_currency: "JPY", to_currency: "EUR", rate: 1_500_000 })
    );
    await upsertQuote(
      db,
      quote({ fxp_bank_id: "003", from_currency: "EUR", to_currency: "USD", rate: 110_000_000 })
    );
    const r = await findBestRoute(db, {
      from_currency: "JPY",
      to_currency: "USD",
      amount: 1_000_000,
      denomination: "PAYER",
      max_bridge_hops: 0,
    });
    expect(r.ok).toBe(false);
  });
});

describe("fx/routing: no route", () => {
  it("returns FX_NO_ROUTE when no quote prices the pair", async () => {
    const r = await findBestRoute(db, {
      from_currency: "JPY",
      to_currency: "USD",
      amount: 1_000_000,
      denomination: "PAYER",
    });
    expect(r).toEqual({ ok: false, reason: "FX_NO_ROUTE" });
  });

  it("returns FX_NO_ROUTE for same-currency (no FX needed)", async () => {
    const r = await findBestRoute(db, {
      from_currency: "JPY",
      to_currency: "JPY",
      amount: 1_000_000,
      denomination: "PAYER",
    });
    expect(r).toEqual({ ok: false, reason: "FX_NO_ROUTE" });
  });

  it("identity rate round-trips the amount", async () => {
    await upsertQuote(
      db,
      quote({ fxp_bank_id: "002", from_currency: "JPY", to_currency: "USD", rate: RATE_SCALE })
    );
    const r = await findBestRoute(db, {
      from_currency: "JPY",
      to_currency: "USD",
      amount: 12_345,
      denomination: "PAYER",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.amount_to).toBe(12_345);
  });
});
