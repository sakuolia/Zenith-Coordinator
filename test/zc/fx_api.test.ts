/**
 * @file Tests for the FX HTTP API handlers (src/zc/fx/api.ts): quote upsert
 * with the FXP capability gate, price discovery, transfer initiation (authoritative
 * re-pricing, fxp_accounts requirement, idempotency), and status read.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  handlePutFxRate,
  handleDeleteFxRate,
  handleListFxRates,
  handlePostFxQuote,
  handlePostFxTransfer,
  handleClaimFxTransfer,
  handleRefundFxTransfer,
  handleGetFxTransfer,
} from "../../src/zc/fx/api";

const FXP_BANK = "002";
const PAYER_BANK = "001";
const PAYER_ACC = "0010000001";
const PAYEE_ACC = "0010000002";
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

let d1: MockD1Database;
let env: any;

function seedParticipant(db: MockD1Database, bankId: string, isFxp = false) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, is_fx_provider, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 100000000, 0, 1, ?, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId, isFxp ? 1 : 0)
    ._runSync();
}

function req(method: string, body?: unknown): Request {
  return new Request("https://zc.test/api/fx", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  ({ d1 } = createTestDb());
  env = { DB: d1, QUEUE: { send: async () => {} }, ZC_HMAC_SECRET: "test-secret" };
  seedParticipant(d1, PAYER_BANK, false);
  seedParticipant(d1, FXP_BANK, true);
  d1.prepare(
    `INSERT OR REPLACE INTO ParticipantCurrencyLimits (bank_id, currency, h_limit, h_used)
     VALUES (?, 'USD', 10000000, 0)`
  )
    .bind(FXP_BANK)
    ._runSync();
  // FXP USD prefunding (0020000002) so its USD leg can pay under the
  // currency-scoped leg-ready funds check. Booked account(+)/ZCS(-) in USD to
  // keep the bank per-currency zero-sum.
  for (const [acct, amt] of [
    ["0020000002", 10_000_000],
    [`${FXP_BANK}-ZCS`, -10_000_000],
  ] as const) {
    d1.prepare(
      `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, amount_currency, tx_type, tx_group_id, value_date, created_at)
       VALUES (?, ?, ?, ?, 'USD', 'CASH', 'PF-FXP-USD', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(`JNL-PF-${acct}`, FXP_BANK, acct, amt)
      ._runSync();
  }
});

async function postRate(): Promise<Response> {
  return handlePutFxRate(
    req("PUT", {
      fxp_bank_id: FXP_BANK,
      from_currency: "JPY",
      to_currency: "USD",
      rate: 670_000,
      valid_to: FAR_FUTURE,
    }),
    env
  );
}

describe("PUT /api/fx/rates", () => {
  it("accepts a quote from a registered FX provider", async () => {
    const res = await postRate();
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result).toBe("QUOTE_ACCEPTED");
    expect(body.quote.quote_id).toMatch(/^FXQ-/);
    expect(body.quote.rate).toBe(670_000);
  });

  it("rejects a non-FX-provider bank with 401 (UNAUTHORIZED → AUTH category)", async () => {
    const res = await handlePutFxRate(
      req("PUT", {
        fxp_bank_id: PAYER_BANK,
        from_currency: "JPY",
        to_currency: "USD",
        rate: 670_000,
        valid_to: FAR_FUTURE,
      }),
      env
    );
    // UNAUTHORIZED is an AUTH-category reason_code, which the error catalog maps
    // to 401 (not 403). Was previously a hardcoded 403.
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).reason_code).toBe("UNAUTHORIZED");
  });

  it("rejects a non-positive rate", async () => {
    const res = await handlePutFxRate(
      req("PUT", {
        fxp_bank_id: FXP_BANK,
        from_currency: "JPY",
        to_currency: "USD",
        rate: 0,
        valid_to: FAR_FUTURE,
      }),
      env
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).reason_code).toBe("INVALID_FX_RATE");
  });

  it("lists and withdraws quotes", async () => {
    await postRate();
    const listRes = await handleListFxRates(
      new URL("https://zc.test/api/fx/rates?from=JPY&to=USD"),
      env
    );
    const list = (await listRes.json()) as any;
    expect(list.quotes).toHaveLength(1);

    const quoteId = list.quotes[0].quote_id;
    const delRes = await handleDeleteFxRate(quoteId, env);
    expect(delRes.status).toBe(200);

    const list2 = (await (
      await handleListFxRates(new URL("https://zc.test/api/fx/rates?from=JPY&to=USD"), env)
    ).json()) as any;
    expect(list2.quotes).toHaveLength(0);
  });
});

describe("POST /api/fx/quote", () => {
  it("returns the best route", async () => {
    await postRate();
    const res = await handlePostFxQuote(
      req("POST", {
        from_currency: "JPY",
        to_currency: "USD",
        amount: 1_000_000,
        denomination: "PAYER",
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result).toBe("ROUTE_FOUND");
    expect(body.route.amount_to).toBe(6_700);
    expect(body.route.hops[0].fxp_bank_id).toBe(FXP_BANK);
  });

  it("returns 409 FX_NO_ROUTE when nothing prices the pair", async () => {
    const res = await handlePostFxQuote(
      req("POST", {
        from_currency: "JPY",
        to_currency: "USD",
        amount: 1_000_000,
        denomination: "PAYER",
      }),
      env
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).reason_code).toBe("FX_NO_ROUTE");
  });
});

describe("POST /api/fx/transfers", () => {
  const transferBody = (over: Record<string, unknown> = {}) => ({
    gtid: "GT-FXAPI-1",
    idempotency_key: "IK-FXAPI-1",
    from_currency: "JPY",
    to_currency: "USD",
    amount: 1_000_000,
    denomination: "PAYER",
    payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACC },
    payee: { bank_id: PAYER_BANK, account_hash: PAYEE_ACC },
    fxp_accounts: { [`${FXP_BANK}:JPY`]: "0020000001", [`${FXP_BANK}:USD`]: "0020000002" },
    expires_at: "2099-12-31T00:00:00Z",
    ...over,
  });

  it("initiates an FX transfer and records FxTransfers", async () => {
    await postRate();
    const res = await handlePostFxTransfer(req("POST", transferBody()), env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.result).toBe("FX_TRANSFER_INITIATED");
    expect(body.amount_to).toBe(6_700);
    expect(body.hashlock).toMatch(/^[0-9a-f]{64}$/);

    const statusRes = await handleGetFxTransfer("GT-FXAPI-1", env);
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as any;
    expect(status.status).toBe("INITIATED");
    expect(status.legs.length).toBe(4);
  });

  it("rejects when an FXP currency account is missing (400)", async () => {
    await postRate();
    const res = await handlePostFxTransfer(
      req("POST", transferBody({ fxp_accounts: { [`${FXP_BANK}:JPY`]: "0020000001" } })),
      env
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).reason_code).toBe("FX_FXP_ACCOUNT_MISSING");
  });

  it("replays idempotently", async () => {
    await postRate();
    const first = (await (
      await handlePostFxTransfer(req("POST", transferBody()), env)
    ).json()) as any;
    const second = (await (
      await handlePostFxTransfer(req("POST", transferBody()), env)
    ).json()) as any;
    expect(second.result).toBe(first.result);
    expect(second.hashlock).toBe(first.hashlock);
  });

  it("returns 409 when no route exists", async () => {
    const res = await handlePostFxTransfer(req("POST", transferBody()), env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).reason_code).toBe("FX_NO_ROUTE");
  });
});

describe("POST /api/fx/transfers (bind_htlc) + claim/refund", () => {
  const htlcBody = (over: Record<string, unknown> = {}) => ({
    gtid: "GT-FXHTLC-1",
    idempotency_key: "IK-FXHTLC-1",
    from_currency: "JPY",
    to_currency: "USD",
    amount: 1_000_000,
    denomination: "PAYER",
    bind_htlc: true,
    payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACC },
    payee: { bank_id: PAYER_BANK, account_hash: PAYEE_ACC },
    fxp_accounts: { [`${FXP_BANK}:JPY`]: "0020000001", [`${FXP_BANK}:USD`]: "0020000002" },
    ...over,
  });

  it("locks the transfer (deferred settlement) and exposes leg locks", async () => {
    await postRate();
    const res = await handlePostFxTransfer(req("POST", htlcBody()), env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.result).toBe("FX_TRANSFER_LOCKED");
    expect(body.hashlock).toMatch(/^[0-9a-f]{64}$/);
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);

    const status = (await (await handleGetFxTransfer("GT-FXHTLC-1", env)).json()) as any;
    expect(status.status).toBe("LOCKED");
    expect(status.leg_locks).toHaveLength(2);
    expect(status.leg_locks.every((l: any) => l.state === "LOCKED")).toBe(true);
    expect(status.gtid_state).toBeNull(); // no GTID until claim
  });

  it("claims with the secret and triggers settlement", async () => {
    await postRate();
    const lockBody = (await (
      await handlePostFxTransfer(req("POST", htlcBody()), env)
    ).json()) as any;
    const res = await handleClaimFxTransfer(
      req("POST", { secret: lockBody.secret }),
      "GT-FXHTLC-1",
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result).toBe("FX_TRANSFER_CLAIMED");
    expect(body.gtid_state).toBe("GT_DECIDED_TO_SETTLE");

    const status = (await (await handleGetFxTransfer("GT-FXHTLC-1", env)).json()) as any;
    expect(status.leg_locks.every((l: any) => l.state === "CLAIMED")).toBe(true);
  });

  it("rejects a wrong secret (400 PREIMAGE_MISMATCH)", async () => {
    await postRate();
    await handlePostFxTransfer(req("POST", htlcBody()), env);
    const res = await handleClaimFxTransfer(
      req("POST", { secret: "00".repeat(32) }),
      "GT-FXHTLC-1",
      env
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).reason_code).toBe("PREIMAGE_MISMATCH");
  });

  it("refuses to refund before the timelock (409)", async () => {
    await postRate();
    await handlePostFxTransfer(req("POST", htlcBody()), env);
    const res = await handleRefundFxTransfer("GT-FXHTLC-1", env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).reason_code).toBe("STATE_GUARD");
  });
});

describe("GET /api/fx/transfers/:gtid", () => {
  it("404s for an unknown transfer", async () => {
    const res = await handleGetFxTransfer("GT-UNKNOWN", env);
    expect(res.status).toBe(404);
  });
});
