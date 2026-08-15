/**
 * @file ingress_handlers.test.ts — HTTP handler-layer coverage for the ZC
 *       ingress wrappers that no test drove: htlc_auth validation/admin-auth
 *       (zc/ingress/htlc_auth.ts), participant/bank admin (zc/ingress/admin.ts),
 *       and the simulator setup (zc/ingress/sim.ts → bank/ingress/admin.ts).
 *
 * The htlc_auth *core* (request/approve/capture lane logic) is already covered
 * by test/zc/htlc_auth_*.test.ts; here we pin the wrappers' validation, admin
 * authorization, status codes, and 404s.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { handleZcApi } from "../../src/router/zc";
import { handleInternal } from "../../src/router/internal";

let d1: MockD1Database;
let env: any;
const ADMIN = "test-secret";
const CRON = "test-cron-secret";

function zc(
  path: string,
  method = "GET",
  opts: { headers?: Record<string, string>; body?: any } = {}
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }
  return handleZcApi(new Request(`http://x${path}`, init), path, method, env);
}

beforeEach(() => {
  ({ d1 } = createTestDb());
  env = { DB: d1, ZC_HMAC_SECRET: ADMIN, CRON_SECRET: CRON };
});

describe("POST /api/transfers — lane=HTLC is rejected before any side effect", () => {
  // 32_api_contracts.md § POST /api/transfers: the HTLC lane has its own entry
  // point because PaymentInitiated cannot carry hashlock/timelock. The contract
  // additionally requires the rejection to happen *before* the idempotency
  // claim, the daily_amount_used increment and the Transactions/PaymentInitiated
  // write — otherwise the caller burns daily quota and an orphan RECEIVED row is
  // left behind that nothing advances (design principle 4).
  const body = (over: Record<string, unknown> = {}) => ({
    schema_version: "1.0",
    message_type: "EVENT",
    name: "PaymentInitiated",
    message_id: "m-htlc-lane",
    idempotency_key: "TX:TX-HTLC-LANE:PaymentInitiated:001",
    occurred_at: "2026-01-01T00:00:00Z",
    txid: "TX-HTLC-LANE",
    lane: "HTLC",
    amount: { value: 1000, currency: "JPY" },
    payer: { bank_id: "001", account_hash: "h:payer" },
    payee: { bank_id: "002", account_hash: "h:payee" },
    purpose: "P2P",
    ...over,
  });

  let enqueued: unknown[];

  beforeEach(() => {
    d1.prepare(
      `INSERT OR REPLACE INTO Participants
         (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active,
          registered_at, daily_amount_limit, daily_amount_used, daily_amount_last_reset_date)
       VALUES ('001', 'Payer Bank', '/bank/001', 1000000, 0, 1,
               '2025-01-01T00:00:00Z', 500000, 0, '2026-01-01')`
    )._runSync();
    // The STANDARD path enqueues ZC_STATE_ADVANCE; the HTLC rejection must not.
    enqueued = [];
    env.QUEUE = { send: async (m: unknown) => void enqueued.push(m) };
  });

  it("422 USE_HTLC_ENDPOINT, and nothing is enqueued", async () => {
    const resp = await zc("/api/transfers", "POST", { body: body() });
    expect(resp.status).toBe(422);
    const json = await resp.json();
    expect(json.reason_code).toBe("USE_HTLC_ENDPOINT");
    // Unregistered in REASON_CODE_CATEGORY on purpose: jsonError derives the
    // category from the status (422 → VALIDATION).
    expect(json.category).toBe("VALIDATION");
    expect(enqueued).toHaveLength(0);
  });

  it("writes no Transactions row and no PaymentInitiated FinalityLog entry", async () => {
    await zc("/api/transfers", "POST", { body: body() });

    const tx = await d1
      .prepare(`SELECT COUNT(*) AS n FROM Transactions WHERE txid = ?`)
      .bind("TX-HTLC-LANE")
      .first<{ n: number }>();
    expect(tx?.n).toBe(0);

    const log = await d1
      .prepare(`SELECT COUNT(*) AS n FROM FinalityLog WHERE txid = ?`)
      .bind("TX-HTLC-LANE")
      .first<{ n: number }>();
    expect(log?.n).toBe(0);
  });

  it("does not consume the payer's daily limit", async () => {
    await zc("/api/transfers", "POST", { body: body() });

    const p = await d1
      .prepare(`SELECT daily_amount_used FROM Participants WHERE bank_id = '001'`)
      .first<{ daily_amount_used: number }>();
    expect(p?.daily_amount_used).toBe(0);
  });

  it("does not burn the idempotency key — a corrected STANDARD retry still lands", async () => {
    await zc("/api/transfers", "POST", { body: body() });
    const retry = await zc("/api/transfers", "POST", { body: body({ lane: "STANDARD" }) });

    // The rejection must not have claimed the key, so the corrected request is
    // processed on its own merits rather than replaying the stored rejection.
    expect(retry.status).toBe(200);
    expect((await retry.json()).result).toBe("INGRESS_ACCEPTED");
  });
});

describe("htlc_auth ingress validation", () => {
  it("400 MISSING_FIELDS when auth-request body is incomplete", async () => {
    const resp = await zc("/api/htlc/auth-request", "POST", { body: { auth_id: "A1" } });
    expect(resp.status).toBe(400);
    expect((await resp.json()).reason_code).toBe("MISSING_FIELDS");
  });

  it("400 MISSING_FIELDS when approve/capture omit idempotency_key", async () => {
    const approve = await zc("/api/htlc/auth/A1/approve", "POST", { body: {} });
    expect(approve.status).toBe(400);
    const capture = await zc("/api/htlc/HTLC-1/capture", "POST", { body: {} });
    expect(capture.status).toBe(400);
  });

  it("404 for an unknown auth request", async () => {
    // Party-scoped read: an identified participant gets the same 404 as a
    // non-party would (S-7), which is the point.
    const resp = await zc("/api/htlc/auth/A-NONE", "GET", {
      headers: { "X-Bank-Id": "001", "X-Purpose-Code": "P01" },
    });
    expect(resp.status).toBe(404);
  });

  it("lists auth requests (empty) without error, for the operator", async () => {
    // Aggregate read: operator-scoped (S-5/S-7, §3.3.2.2.3 forbids participant全件検索).
    const resp = await zc("/api/htlc/auth-requests", "GET", {
      headers: { "X-Cron-Secret": CRON, "X-Purpose-Code": "P06" },
    });
    expect(resp.status).toBe(200);
    expect((await resp.json()).auth_requests).toEqual([]);
  });
});

describe("POST /api/cases/:case_id/update — the state is validated before it is written", () => {
  // updateCase CASes the value straight into Cases.state, so an unchecked string
  // would put the CASE ledger into a state the case state machine does not know
  // (and EntityStateLog would faithfully record the corruption).
  it("rejects a state outside the update domain", async () => {
    const resp = await zc("/api/cases/CASE-1/update", "POST", { body: { state: "NONSENSE" } });
    expect(resp.status).toBe(400);
    expect((await resp.json()).reason_code).toBe("INVALID_STATE");
  });

  it("rejects OPEN — a resolved CASE is re-worked as a new CASE, not rewound", async () => {
    const resp = await zc("/api/cases/CASE-1/update", "POST", { body: { state: "OPEN" } });
    expect(resp.status).toBe(400);
  });

  it("rejects a missing state rather than writing undefined", async () => {
    const resp = await zc("/api/cases/CASE-1/update", "POST", { body: {} });
    expect(resp.status).toBe(400);
  });

  it("accepts the documented states", async () => {
    for (const state of ["IN_PROGRESS", "RESOLVED", "ESCALATED"]) {
      const resp = await zc("/api/cases/CASE-1/update", "POST", { body: { state } });
      expect(resp.status, state).toBe(200);
    }
  });
});

describe("htlc_auth whitelist admin authorization", () => {
  const body = { payee_bank_id: "002", payee_account_hash: "h:payee" };

  it("403 without an admin key", async () => {
    const resp = await zc("/api/htlc/auth-whitelist", "POST", { body });
    expect(resp.status).toBe(403);
  });

  it("400 INVALID_TEMPLATE_ID when eligibility_template_id is malformed", async () => {
    const resp = await zc("/api/htlc/auth-whitelist", "POST", {
      headers: { "X-Admin-Key": ADMIN },
      body: { ...body, eligibility_template_id: "BAD-1" },
    });
    expect(resp.status).toBe(400);
    expect((await resp.json()).reason_code).toBe("INVALID_TEMPLATE_ID");
  });

  it("201 registers with a valid admin key, then lists the entry", async () => {
    const reg = await zc("/api/htlc/auth-whitelist", "POST", {
      headers: { "X-Admin-Key": ADMIN },
      body,
    });
    expect(reg.status).toBe(201);

    const list = await zc("/api/htlc/auth-whitelist", "GET");
    expect(list.status).toBe(200);
    expect((await list.json()).whitelist.length).toBeGreaterThanOrEqual(1);
  });

  it("404 revoking an unknown whitelist id (with admin key)", async () => {
    const resp = await zc("/api/htlc/auth-whitelist/WL-NONE", "DELETE", {
      headers: { "X-Admin-Key": ADMIN },
    });
    expect(resp.status).toBe(404);
  });
});

describe("participant & bank admin handlers", () => {
  it("registers a participant (201) and persists it", async () => {
    const resp = await zc("/api/participants/register", "POST", {
      body: {
        bank_id: "077",
        bank_name: "テスト銀行",
        ingress_base_url: "/bank/077",
        h_limit: 100000000,
      },
    });
    expect(resp.status).toBe(201);
    expect((await resp.json()).result).toBe("REGISTERED");
    const row = await d1
      .prepare(`SELECT bank_name FROM Participants WHERE bank_id='077'`)
      .first<{ bank_name: string }>();
    expect(row?.bank_name).toBe("テスト銀行");
  });

  it("lists the seeded banks", async () => {
    const resp = await zc("/api/banks", "GET");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    const banks = body.banks ?? body;
    expect(Array.isArray(banks) ? banks.length : 0).toBeGreaterThanOrEqual(2);
  });
});

describe("simulator setup (internal)", () => {
  it("provisions a small synthetic environment end-to-end", async () => {
    const path = "/internal/sim/setup";
    const resp = await handleInternal(
      new Request(`http://x${path}`, {
        method: "POST",
        body: JSON.stringify({ bank_count: 1, accounts_per_bank: 2 }),
        headers: { "X-Cron-Secret": CRON, "Content-Type": "application/json" },
      }),
      path,
      "POST",
      env
    );
    expect(resp.status).toBe(200);
    // seed creates 001/002; sim adds bank 003 → a new participant exists.
    const added = await d1
      .prepare(`SELECT COUNT(*) AS n FROM Participants WHERE bank_id='003'`)
      .first<{ n: number }>();
    expect(added?.n).toBe(1);
  });
});
