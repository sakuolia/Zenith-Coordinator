/**
 * @file CUSTODY suspense auto-release (releaseRecoveredCustody / timeout sweep).
 *
 * When an incoming credit lands on a frozen/closed/missing payee account, the
 * funds are held in the bank's suspense account with SuspenseDetails status
 * CUSTODY. Previously the ONLY way out was a manual teller resolve
 * (handleSuspenseResolve) — a frozen account that was later unfrozen left the
 * customer's money in custody indefinitely. These tests cover the automated
 * release path added to the per-minute timeout sweep:
 *
 *   - account recovered (FROZEN -> NORMAL): CUSTODY -> SETTLED, customer
 *     credited, suspense account drained, per-bank zero-sum preserved
 *   - account still FROZEN: untouched
 *   - NOT_FOUND-style custody (account_id points at the suspense account
 *     itself): untouched — teller resolution only
 *   - idempotent: a second sweep does not double-credit
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { landSuspense, releaseRecoveredCustody } from "../../src/bank/suspense";
import { verifyZeroSum } from "../../src/bank/ledger";
import { runTimeoutSweep } from "../../src/cron/timeout_sweep";

const BANK = "001";
const CUSTOMER_ACC = "0010000001"; // seeded NORMAL/SAVINGS with 1,000,000
const SUSPENSE_ACC = "0010000000"; // seeded SUSPENSE system account
const SEED_BAL = 1_000_000;
const AMOUNT = 5_000;

let d1: MockD1Database;

function makeEnv(db: MockD1Database): any {
  return { DB: db, QUEUE: { send: async () => {} } };
}

async function balanceOf(db: MockD1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ?`)
    .bind(accountId)
    .first<{ b: number }>();
  return row?.b ?? 0;
}

async function suspenseStatus(db: MockD1Database, suspenseId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT status FROM SuspenseDetails WHERE suspense_id=?`)
    .bind(suspenseId)
    .first<{ status: string }>();
  return row?.status ?? null;
}

function setAccountStatus(db: MockD1Database, accountId: string, status: string) {
  db.prepare(`UPDATE BankAccounts SET status=? WHERE account_id=? AND bank_id=?`)
    .bind(status, accountId, BANK)
    ._runSync();
}

/** Land a CUSTODY credit on the (currently frozen) customer account. */
async function landFrozenCustody(db: MockD1Database, txid: string): Promise<string> {
  return landSuspense(db, {
    bankId: BANK,
    accountId: CUSTOMER_ACC,
    direction: "RECEIVE",
    amount: AMOUNT,
    txid,
    isCustody: true,
    custodyReason: "ACCOUNT_FROZEN",
  });
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
});

describe("releaseRecoveredCustody — account recovered", () => {
  it("credits the customer and settles the CUSTODY record once the account is NORMAL again", async () => {
    setAccountStatus(d1, CUSTOMER_ACC, "FROZEN");
    const suspId = await landFrozenCustody(d1, "TX-CUSTODY-1");
    expect(await suspenseStatus(d1, suspId)).toBe("CUSTODY");
    // While frozen: funds sit in the suspense account, customer untouched.
    expect(await balanceOf(d1, CUSTOMER_ACC)).toBe(SEED_BAL);
    expect(await balanceOf(d1, SUSPENSE_ACC)).toBe(AMOUNT);

    setAccountStatus(d1, CUSTOMER_ACC, "NORMAL");
    const released = await releaseRecoveredCustody(d1);

    expect(released).toBe(1);
    expect(await suspenseStatus(d1, suspId)).toBe("SETTLED");
    expect(await balanceOf(d1, CUSTOMER_ACC)).toBe(SEED_BAL + AMOUNT);
    expect(await balanceOf(d1, SUSPENSE_ACC)).toBe(0);
    expect(await verifyZeroSum(BANK, d1)).toBe(true);
  });

  it("records settled_at and keeps the journal pair under one tx_group_id", async () => {
    setAccountStatus(d1, CUSTOMER_ACC, "FROZEN");
    const suspId = await landFrozenCustody(d1, "TX-CUSTODY-2");
    setAccountStatus(d1, CUSTOMER_ACC, "NORMAL");

    await releaseRecoveredCustody(d1);

    const row = await d1
      .prepare(`SELECT settled_at FROM SuspenseDetails WHERE suspense_id=?`)
      .bind(suspId)
      .first<{ settled_at: string | null }>();
    expect(row?.settled_at).not.toBeNull();

    const journals = await d1
      .prepare(`SELECT account_id, amount FROM BankJournals WHERE tx_group_id=?`)
      .bind(`SUSP-AUTORESOLVE-${suspId}`)
      .all<{ account_id: string; amount: number }>();
    expect(journals.results).toHaveLength(2);
    const sum = journals.results.reduce((s, j) => s + j.amount, 0);
    expect(sum).toBe(0); // zero-sum pair: suspense(-) / customer(+)
  });

  it("is triggered by runTimeoutSweep (per-minute cron)", async () => {
    setAccountStatus(d1, CUSTOMER_ACC, "FROZEN");
    const suspId = await landFrozenCustody(d1, "TX-CUSTODY-3");
    setAccountStatus(d1, CUSTOMER_ACC, "NORMAL");

    await runTimeoutSweep(makeEnv(d1));

    expect(await suspenseStatus(d1, suspId)).toBe("SETTLED");
    expect(await balanceOf(d1, CUSTOMER_ACC)).toBe(SEED_BAL + AMOUNT);
  });
});

describe("releaseRecoveredCustody — non-recoverable records stay put", () => {
  it("does NOT touch a CUSTODY record whose account is still FROZEN", async () => {
    setAccountStatus(d1, CUSTOMER_ACC, "FROZEN");
    const suspId = await landFrozenCustody(d1, "TX-CUSTODY-4");

    const released = await releaseRecoveredCustody(d1);

    expect(released).toBe(0);
    expect(await suspenseStatus(d1, suspId)).toBe("CUSTODY");
    expect(await balanceOf(d1, CUSTOMER_ACC)).toBe(SEED_BAL);
  });

  it("does NOT touch a NOT_FOUND custody record (account_id = suspense account, teller-only)", async () => {
    // Mirrors bank/ingress.ts: when the payee account does not exist the
    // custody record is parked on the bank's own suspense account.
    const suspId = await landSuspense(d1, {
      bankId: BANK,
      accountId: SUSPENSE_ACC,
      direction: "RECEIVE",
      amount: AMOUNT,
      txid: "TX-CUSTODY-5",
      isCustody: true,
      custodyReason: "NOT_FOUND",
    });

    const released = await releaseRecoveredCustody(d1);

    expect(released).toBe(0);
    expect(await suspenseStatus(d1, suspId)).toBe("CUSTODY");
  });
});

describe("releaseRecoveredCustody — idempotency", () => {
  it("a second sweep does not double-credit", async () => {
    setAccountStatus(d1, CUSTOMER_ACC, "FROZEN");
    const suspId = await landFrozenCustody(d1, "TX-CUSTODY-6");
    setAccountStatus(d1, CUSTOMER_ACC, "NORMAL");

    expect(await releaseRecoveredCustody(d1)).toBe(1);
    expect(await releaseRecoveredCustody(d1)).toBe(0);

    expect(await balanceOf(d1, CUSTOMER_ACC)).toBe(SEED_BAL + AMOUNT);
    const journals = await d1
      .prepare(`SELECT COUNT(*) AS cnt FROM BankJournals WHERE tx_group_id=?`)
      .bind(`SUSP-AUTORESOLVE-${suspId}`)
      .first<{ cnt: number }>();
    expect(journals?.cnt).toBe(2);
    expect(await verifyZeroSum(BANK, d1)).toBe(true);
  });
});
