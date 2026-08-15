/**
 * @file customer_api.test.ts — the smartphone bank-app's backend
 *       (bank/customer_api.ts), driven through the live bank router
 *       (router/bank.ts). Previously exercised by no test.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { handleBankApi } from "../../src/router/bank";

let d1: MockD1Database;
let env: any;

const BANK = "001";
// Use customer/account ids that the consolidated migration does NOT pre-seed,
// so these tests own their fixtures (seed already populates 001000000x).
const CUST1 = "TCUST-1";
const CUST2 = "TCUST-2";
const ACC1 = "0017770001";
const ACC2 = "0017770002";

function seedAccount(accId: string, customerId: string, name: string, status = "NORMAL") {
  d1.prepare(
    `INSERT INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
     VALUES (?, '001', ?, ?, 'SAVINGS', ?, '2026-01-01T00:00:00Z')`
  )
    .bind(accId, customerId, name, status)
    ._runSync();
}

let jseq = 0;
function seedJournal(
  accId: string,
  amount: number,
  txType: string,
  txid: string | null,
  valueDate = "2026-06-30"
) {
  jseq++;
  d1.prepare(
    `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, txid, tx_group_id, description, value_date, created_at)
     VALUES (?, '001', ?, ?, ?, ?, ?, NULL, ?, ?)`
  )
    .bind(
      `J-${jseq}`,
      accId,
      amount,
      txType,
      txid,
      `G-${jseq}`,
      valueDate,
      `2026-06-30T00:00:0${jseq}Z`
    )
    ._runSync();
}

function req(
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
  return handleBankApi(new Request(`http://x${path}`, init), path, method, env);
}

const authHeaders = (customerId = CUST1) => ({ "X-Bank-Id": BANK, "X-Customer-Id": customerId });

beforeEach(() => {
  ({ d1 } = createTestDb());
  env = { DB: d1, ZC_HMAC_SECRET: "test-secret" };
  jseq = 0;
});

describe("auth gating", () => {
  it("401 when customer headers are missing", async () => {
    const resp = await req("/bank/001/v1/me/accounts");
    expect(resp.status).toBe(401);
  });
});

describe("GET /v1/me/accounts", () => {
  it("lists the customer's non-closed accounts with summed balances", async () => {
    seedAccount(ACC1, CUST1, "田中 太郎");
    seedAccount(ACC2, CUST1, "田中 太郎", "CLOSED");
    seedJournal(ACC1, 10000, "CASH", null);
    seedJournal(ACC1, -3000, "CREDIT", "TX-x");

    const resp = await req("/bank/001/v1/me/accounts", "GET", { headers: authHeaders() });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.accounts).toHaveLength(1); // CLOSED excluded
    expect(body.accounts[0].account_id).toBe(ACC1);
    expect(body.accounts[0].balance).toBe(7000);
    expect(body.accounts[0].currency).toBe("JPY");
  });
});

describe("GET /v1/me/accounts/:id/balance", () => {
  it("returns the balance for an owned account", async () => {
    seedAccount(ACC1, CUST1, "田中 太郎");
    seedJournal(ACC1, 5000, "CASH", null);
    const resp = await req(`/bank/001/v1/me/accounts/${ACC1}/balance`, "GET", {
      headers: authHeaders(),
    });
    expect(resp.status).toBe(200);
    expect((await resp.json()).balance).toBe(5000);
  });

  it("404 when the account belongs to a different customer", async () => {
    seedAccount(ACC1, CUST1, "田中 太郎");
    const resp = await req(`/bank/001/v1/me/accounts/${ACC1}/balance`, "GET", {
      headers: authHeaders(CUST2),
    });
    expect(resp.status).toBe(404);
  });
});

describe("GET /v1/me/accounts/:id/transactions", () => {
  it("returns labeled journal entries (most recent first)", async () => {
    seedAccount(ACC1, CUST1, "田中 太郎");
    seedJournal(ACC1, 10000, "CASH", null); // 現金入金
    seedJournal(ACC1, -200, "INTEREST", null); // 利息 (label by type)

    const resp = await req(`/bank/001/v1/me/accounts/${ACC1}/transactions`, "GET", {
      headers: authHeaders(),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.transactions).toHaveLength(2);
    const labels = body.transactions.map((t: any) => t.label);
    expect(labels).toContain("現金入金");
    expect(labels).toContain("利息");
  });

  it("404 on a non-owned account", async () => {
    seedAccount(ACC1, CUST1, "田中 太郎");
    const resp = await req(`/bank/001/v1/me/accounts/${ACC1}/transactions`, "GET", {
      headers: authHeaders(CUST2),
    });
    expect(resp.status).toBe(404);
  });
});

describe("GET /v1/me/transfers/:txid (authorization)", () => {
  beforeEach(() => {
    seedAccount(ACC1, CUST1, "田中 太郎");
    seedAccount(ACC2, CUST2, "鈴木 一郎");
    d1.prepare(
      `INSERT INTO Transactions (txid, lane, state, amount_value, payer_bank_id, payer_account_hash, payee_bank_id, idempotency_key, created_at, updated_at)
       VALUES ('TX-OWN', 'EXPRESS', 'SETTLED', 5000, '001', ?, '002', 'idem-own', 't', 't')`
    )
      .bind(ACC1)
      ._runSync();
  });

  it("the paying customer can view it; payer_account_hash is not leaked", async () => {
    const resp = await req("/bank/001/v1/me/transfers/TX-OWN", "GET", {
      headers: authHeaders(CUST1),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.txid).toBe("TX-OWN");
    expect(body.state).toBe("SETTLED");
    expect(body).not.toHaveProperty("payer_account_hash");
  });

  it("a different customer at the same bank is forbidden (no horizontal escalation)", async () => {
    const resp = await req("/bank/001/v1/me/transfers/TX-OWN", "GET", {
      headers: authHeaders(CUST2),
    });
    expect(resp.status).toBe(403);
  });

  it("404 for an unknown txid", async () => {
    const resp = await req("/bank/001/v1/me/transfers/TX-NOPE", "GET", {
      headers: authHeaders(CUST1),
    });
    expect(resp.status).toBe(404);
  });

  it("a customer with no accounts at the bank is forbidden (fail-closed, not fail-open)", async () => {
    // Regression: previously the owner check was skipped when the caller owned
    // zero accounts, leaking any transfer at the bank to an accountless id.
    const resp = await req("/bank/001/v1/me/transfers/TX-OWN", "GET", {
      headers: authHeaders("TCUST-GHOST"),
    });
    expect(resp.status).toBe(403);
  });
});
