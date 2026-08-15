/**
 * @file Regression tests for daily_amount_last_reset_date auto-reset (B8).
 *
 * The daily transfer limit used to rely solely on the EOD cron job to reset
 * daily_amount_used to 0. If the cron was delayed or missed, the limit would
 * carry over into the next day, blocking all transfers. The fix detects a date
 * change on the first inbound request of each day and resets the counter inline.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { handlePostTransfers } from "../../src/zc/ingress";
import { type Env, businessDateJST, todayJST } from "../../src/types";

const PAYER_BANK = "001";
const PAYEE_BANK = "002";
const PAYER_ACCOUNT = "0010000001";
const PAYEE_ACCOUNT = "0020000001";

let d1: MockD1Database;

function makeEnv(): Env {
  return {
    DB: d1 as unknown as D1Database,
    QUEUE: { send: async () => {} } as any,
    R2: {} as any,
    ZC_HMAC_SECRET: "",
    VAULT_URL: "",
    VAULT_TOKEN: "",
  } as unknown as Env;
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("https://zc.example.com/api/transfers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validPayload(txid: string, idem: string, amount = 10000) {
  return {
    schema_version: "1.0",
    txid,
    idempotency_key: idem,
    lane: "EXPRESS",
    amount: { value: amount, currency: "JPY" },
    payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACCOUNT },
    payee: { bank_id: PAYEE_BANK, account_hash: PAYEE_ACCOUNT },
    purpose: "P2P",
  };
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;

  // Participants
  for (const bankId of [PAYER_BANK, PAYEE_BANK]) {
    d1.prepare(
      `INSERT OR REPLACE INTO Participants
       (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
       VALUES (?, 'Test Bank', '/bank/${bankId}', 10000000, 0, 1, '2025-01-01T00:00:00Z')`
    )
      .bind(bankId)
      ._runSync();
  }

  // Accounts
  const accounts = [
    [PAYER_ACCOUNT, PAYER_BANK],
    [PAYEE_ACCOUNT, PAYEE_BANK],
    [`${PAYER_BANK}0000000`, PAYER_BANK], // suspense
    [`${PAYER_BANK}-ZCS`, PAYER_BANK],
    [`${PAYEE_BANK}0000000`, PAYEE_BANK],
    [`${PAYEE_BANK}-ZCS`, PAYEE_BANK],
  ];
  for (const [acctId, bankId] of accounts) {
    d1.prepare(
      `INSERT OR IGNORE INTO BankAccounts
       (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'CUST', 'User', 'SAVINGS', 'NORMAL', '2025-01-01T00:00:00Z')`
    )
      .bind(acctId, bankId)
      ._runSync();
    d1.prepare(
      `INSERT OR IGNORE INTO BankJournals
       (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES (?, ?, ?, 5000000, 'CASH', 'INIT', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(`JNL-INIT-${acctId}`, bankId, acctId)
      ._runSync();
  }
});

// ---------------------------------------------------------------------------
// B8: daily limit auto-reset
// ---------------------------------------------------------------------------

describe("daily limit auto-reset on date change (B8)", () => {
  it("allows transfers when daily_amount_used was near-limit on a previous day (missed cron)", async () => {
    // Simulate: EOD cron never ran, daily_amount_used is at 90% of limit from yesterday.
    const DAILY_LIMIT = 100000;
    const yesterday = "2026-05-12"; // one day before today (2026-05-13 per system clock)

    d1.prepare(
      `UPDATE Participants
       SET daily_amount_limit = ?, daily_amount_used = ?, daily_amount_last_reset_date = ?
       WHERE bank_id = ?`
    )
      .bind(DAILY_LIMIT, 90000, yesterday, PAYER_BANK)
      ._runSync();

    const env = makeEnv();
    // This 10000-JPY transfer would fail if daily_amount_used were still 90000 of 100000,
    // but the auto-reset should clear it because last_reset_date != today.
    const resp = await handlePostTransfers(
      makeRequest(validPayload("TX-RESET-001", "ik-reset-001", 10000)),
      env
    );
    const json = await resp.clone().json<any>();

    // Should NOT be DAILY_LIMIT_EXCEEDED
    expect(json.reason_code).not.toBe("DAILY_LIMIT_EXCEEDED");
    // Might be H_LIMIT_EXCEEDED or accepted — either way the daily limit didn't fire
    expect(resp.status).not.toBe(422);
  });

  it("enforces the limit on same-day transfers (no stale carry-over)", async () => {
    const DAILY_LIMIT = 50000;
    const today = todayJST(); // matches businessDateJST() used by the app (transfers.ts)

    d1.prepare(
      `UPDATE Participants
       SET daily_amount_limit = ?, daily_amount_used = ?, daily_amount_last_reset_date = ?
       WHERE bank_id = ?`
    )
      .bind(DAILY_LIMIT, 50000, today, PAYER_BANK)
      ._runSync();

    const env = makeEnv();
    const resp = await handlePostTransfers(
      makeRequest(validPayload("TX-LIMIT-001", "ik-limit-001", 1000)),
      env
    );
    const json = await resp.clone().json<any>();

    expect(resp.status).toBe(422);
    expect(json.reason_code).toBe("DAILY_LIMIT_EXCEEDED");
  });

  it("stamps daily_amount_last_reset_date after auto-reset", async () => {
    const today = todayJST(); // matches businessDateJST() used by the app (transfers.ts)
    const yesterday = businessDateJST(new Date(Date.now() - 86400000).toISOString());

    d1.prepare(
      `UPDATE Participants
       SET daily_amount_limit = 1000000, daily_amount_used = 999000, daily_amount_last_reset_date = ?
       WHERE bank_id = ?`
    )
      .bind(yesterday, PAYER_BANK)
      ._runSync();

    const env = makeEnv();
    await handlePostTransfers(makeRequest(validPayload("TX-STAMP-001", "ik-stamp-001", 5000)), env);

    const row = await d1
      .prepare(
        `SELECT daily_amount_last_reset_date, daily_amount_used FROM Participants WHERE bank_id = ?`
      )
      .bind(PAYER_BANK)
      .first<{ daily_amount_last_reset_date: string | null; daily_amount_used: number }>();

    expect(row?.daily_amount_last_reset_date).toBe(today);
    // daily_amount_used should be 5000 (the amount of this first-transfer-of-the-day), not 999000+5000
    expect(row?.daily_amount_used).toBeLessThan(999000);
  });

  it("rejects first-of-day request when amount itself exceeds daily limit (B2 regression)", async () => {
    // Before fix: the reset UPDATE had no limit check, so a first-of-day request with
    // amount > daily_amount_limit would be accepted (daily_amount_used set to the over-limit amount).
    const DAILY_LIMIT = 50000;
    const yesterday = businessDateJST(new Date(Date.now() - 86400000).toISOString());

    d1.prepare(
      `UPDATE Participants
       SET daily_amount_limit = ?, daily_amount_used = 0, daily_amount_last_reset_date = ?
       WHERE bank_id = ?`
    )
      .bind(DAILY_LIMIT, yesterday, PAYER_BANK)
      ._runSync();

    const env = makeEnv();
    // amount (60000) > daily_amount_limit (50000)
    const resp = await handlePostTransfers(
      makeRequest(validPayload("TX-B2-001", "ik-b2-001", 60000)),
      env
    );
    const json = await resp.clone().json<any>();

    expect(resp.status).toBe(422);
    expect(json.reason_code).toBe("DAILY_LIMIT_EXCEEDED");

    // Confirm that daily_amount_used was NOT updated (the reset should not have applied)
    const row = await d1
      .prepare(
        `SELECT daily_amount_used, daily_amount_last_reset_date FROM Participants WHERE bank_id = ?`
      )
      .bind(PAYER_BANK)
      .first<{ daily_amount_used: number; daily_amount_last_reset_date: string | null }>();

    expect(row?.daily_amount_used).toBe(0);
    expect(row?.daily_amount_last_reset_date).toBe(yesterday);
  });
});
