/**
 * @file Integration tests for src/bank/ledger.ts
 *
 * Verifies double-entry zero-sum invariants, balance calculation,
 * and interest accrual.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  insertJournalGroup,
  calcBalance,
  verifyZeroSum,
  applyDailyInterest,
  snapshotDailyBalance,
} from "../../src/bank/ledger";

const BANK_ID = "001";

let d1: MockD1Database;

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  // 初期データ（JNL-INIT-001-*）がロード済み
});

describe("insertJournalGroup", () => {
  it("inserts zero-sum entries without throwing", async () => {
    await expect(
      insertJournalGroup(d1 as any, {
        bankId: BANK_ID,
        txGroupId: "TEST-GROUP-001",
        entries: [
          { accountId: "0010000001", amount: 50_000, txType: "TRANSFER" },
          { accountId: "001-ZCS", amount: -50_000, txType: "TRANSFER" },
        ],
        valueDate: "2025-06-01",
      })
    ).resolves.toBeUndefined();
  });

  it("throws on non-zero-sum entries", async () => {
    await expect(
      insertJournalGroup(d1 as any, {
        bankId: BANK_ID,
        txGroupId: "TEST-GROUP-BAD",
        entries: [
          { accountId: "0010000001", amount: 50_000, txType: "TRANSFER" },
          { accountId: "001-ZCS", amount: -49_999, txType: "TRANSFER" }, // off by 1
        ],
        valueDate: "2025-06-01",
      })
    ).rejects.toThrow("Zero-sum violation");
  });

  it("inserts entries and they appear in calcBalance", async () => {
    const before = await calcBalance("0010000001", d1 as any);
    await insertJournalGroup(d1 as any, {
      bankId: BANK_ID,
      txGroupId: "TEST-GROUP-002",
      entries: [
        { accountId: "0010000001", amount: 30_000, txType: "TRANSFER" },
        { accountId: "001-ZCS", amount: -30_000, txType: "TRANSFER" },
      ],
      valueDate: "2025-06-01",
    });
    const after = await calcBalance("0010000001", d1 as any);
    expect(after - before).toBe(30_000);
  });
});

describe("calcBalance", () => {
  it("returns the correct balance for an account with initial data", async () => {
    // 0010000001 has two initial entries of +1,000,000 each in the seed
    const balance = await calcBalance("0010000001", d1 as any);
    expect(balance).toBe(1_000_000);
  });

  it("returns 0 for an account with no entries", async () => {
    const balance = await calcBalance("nonexistent-account", d1 as any);
    expect(balance).toBe(0);
  });

  it("sums positive and negative entries correctly", async () => {
    await insertJournalGroup(d1 as any, {
      bankId: BANK_ID,
      txGroupId: "CALC-TEST",
      entries: [
        { accountId: "0010000001", amount: -200_000, txType: "TRANSFER" },
        { accountId: "001-ZCS", amount: 200_000, txType: "TRANSFER" },
      ],
      valueDate: "2025-06-02",
    });
    const balance = await calcBalance("0010000001", d1 as any);
    expect(balance).toBe(800_000); // 1,000,000 - 200,000
  });
});

describe("verifyZeroSum", () => {
  it("returns true for the initial seed data", async () => {
    const ok = await verifyZeroSum(BANK_ID, d1 as any);
    expect(ok).toBe(true);
  });

  it("returns true after adding a zero-sum journal", async () => {
    await insertJournalGroup(d1 as any, {
      bankId: BANK_ID,
      txGroupId: "ZS-TEST-001",
      entries: [
        { accountId: "0010000001", amount: 10_000, txType: "TRANSFER" },
        { accountId: "001-ZCS", amount: -10_000, txType: "TRANSFER" },
      ],
      valueDate: "2025-06-01",
    });
    expect(await verifyZeroSum(BANK_ID, d1 as any)).toBe(true);
  });

  it("returns false after directly injecting an unbalanced entry", async () => {
    // Bypass insertJournalGroup to simulate a corruption scenario
    d1.prepare(
      `INSERT INTO BankJournals
       (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES ('BAD-ENTRY', ?, '0010000001', 1, 'TRANSFER', 'BAD', '2025-06-01', '2025-06-01T00:00:00Z')`
    )
      .bind(BANK_ID)
      ._runSync();
    expect(await verifyZeroSum(BANK_ID, d1 as any)).toBe(false);
  });
});

describe("currency dimensioning", () => {
  it("persists the group-level currency on every entry", async () => {
    await insertJournalGroup(d1 as any, {
      bankId: BANK_ID,
      txGroupId: "CCY-GROUP",
      currency: "USD",
      entries: [
        { accountId: "0010000002", amount: 1_000, txType: "TRANSFER" },
        { accountId: "001-ZCS", amount: -1_000, txType: "TRANSFER" },
      ],
      valueDate: "2025-06-01",
    });
    const rows = await d1
      .prepare(`SELECT amount_currency FROM BankJournals WHERE tx_group_id='CCY-GROUP'`)
      .all<{ amount_currency: string }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every((r) => r.amount_currency === "USD")).toBe(true);
  });

  it("validates zero-sum independently per currency (mixed group allowed)", async () => {
    // JPY pair and USD pair each balance on their own.
    await expect(
      insertJournalGroup(d1 as any, {
        bankId: BANK_ID,
        txGroupId: "PVP-OK",
        entries: [
          { accountId: "0010000001", amount: -100_000, txType: "TRANSFER", currency: "JPY" },
          { accountId: "001-ZCS", amount: 100_000, txType: "TRANSFER", currency: "JPY" },
          { accountId: "0010000002", amount: 1_000, txType: "TRANSFER", currency: "USD" },
          { accountId: "001-ZCS", amount: -1_000, txType: "TRANSFER", currency: "USD" },
        ],
        valueDate: "2025-06-01",
      })
    ).resolves.toBeUndefined();
  });

  it("throws when one currency in a mixed group is unbalanced even if the raw total is zero", async () => {
    // JPY nets +1 and USD nets -1: total across currencies is 0 but each leg is off.
    await expect(
      insertJournalGroup(d1 as any, {
        bankId: BANK_ID,
        txGroupId: "PVP-BAD",
        entries: [
          { accountId: "0010000001", amount: 1, txType: "TRANSFER", currency: "JPY" },
          { accountId: "0010000002", amount: -1, txType: "TRANSFER", currency: "USD" },
        ],
        valueDate: "2025-06-01",
      })
    ).rejects.toThrow("Zero-sum violation");
  });

  it("calcBalance isolates currencies on a shared (non-segregated) account", async () => {
    const jpyBefore = await calcBalance("001-ZCS", d1 as any, "JPY");
    const allBefore = await calcBalance("001-ZCS", d1 as any);
    await insertJournalGroup(d1 as any, {
      bankId: BANK_ID,
      txGroupId: "SHARED-JPY",
      entries: [
        { accountId: "001-ZCS", amount: 50_000, txType: "TRANSFER", currency: "JPY" },
        { accountId: "0010000001", amount: -50_000, txType: "TRANSFER", currency: "JPY" },
      ],
      valueDate: "2025-06-01",
    });
    await insertJournalGroup(d1 as any, {
      bankId: BANK_ID,
      txGroupId: "SHARED-USD",
      entries: [
        { accountId: "001-ZCS", amount: 700, txType: "TRANSFER", currency: "USD" },
        { accountId: "0010000002", amount: -700, txType: "TRANSFER", currency: "USD" },
      ],
      valueDate: "2025-06-01",
    });
    // The shared ZCS account holds both currencies; per-currency reads stay separate.
    expect(await calcBalance("001-ZCS", d1 as any, "JPY")).toBe(jpyBefore + 50_000);
    expect(await calcBalance("001-ZCS", d1 as any, "USD")).toBe(700);
    // Omitting the currency sums everything (legacy behaviour).
    expect(await calcBalance("001-ZCS", d1 as any)).toBe(allBefore + 50_700);
  });

  it("verifyZeroSum catches a per-currency imbalance masked by the cross-currency total", async () => {
    // +1 JPY and -1 USD: SUM(amount) across all rows is 0, but neither currency balances.
    d1.prepare(
      `INSERT INTO BankJournals
       (journal_id, bank_id, account_id, amount, amount_currency, tx_type, tx_group_id, value_date, created_at)
       VALUES ('BAD-JPY', ?, '0010000001', 1, 'JPY', 'TRANSFER', 'BADCCY', '2025-06-01', '2025-06-01T00:00:00Z'),
              ('BAD-USD', ?, '0010000002', -1, 'USD', 'TRANSFER', 'BADCCY', '2025-06-01', '2025-06-01T00:00:00Z')`
    )
      .bind(BANK_ID, BANK_ID)
      ._runSync();
    expect(await verifyZeroSum(BANK_ID, d1 as any)).toBe(false);
  });
});

describe("applyDailyInterest", () => {
  it("credits interest to savings accounts and debits retained earnings", async () => {
    const beforeBalance = await calcBalance("0010000001", d1 as any);
    await applyDailyInterest(BANK_ID, "2025-06-01", d1 as any);
    const afterBalance = await calcBalance("0010000001", d1 as any);

    // annual_rate=0.001, daily = 0.001/360 ≈ 0.0000028
    // interest = floor(1_000_000 * 0.001 / 360) = floor(2.78) = 2
    expect(afterBalance - beforeBalance).toBe(2);
  });

  it("preserves zero-sum after interest accrual", async () => {
    await applyDailyInterest(BANK_ID, "2025-06-01", d1 as any);
    expect(await verifyZeroSum(BANK_ID, d1 as any)).toBe(true);
  });

  it("does not credit interest for accounts with zero balance", async () => {
    // Drain account 0010000002 to zero first
    const balance = await calcBalance("0010000002", d1 as any);
    await insertJournalGroup(d1 as any, {
      bankId: BANK_ID,
      txGroupId: "DRAIN",
      entries: [
        { accountId: "0010000002", amount: -balance, txType: "TRANSFER" },
        { accountId: "001-ZCS", amount: balance, txType: "TRANSFER" },
      ],
      valueDate: "2025-06-01",
    });
    const before = await calcBalance("0010000002", d1 as any);
    await applyDailyInterest(BANK_ID, "2025-06-01", d1 as any);
    const after = await calcBalance("0010000002", d1 as any);
    expect(after).toBe(before);
  });
});

describe("snapshotDailyBalance", () => {
  it("stores the current balance as a daily snapshot", async () => {
    await snapshotDailyBalance("0010000001", "2025-06-01", d1 as any);
    const row = await d1
      .prepare(
        `SELECT end_of_day_balance FROM DailyBalances WHERE account_id=? AND snapshot_date=?`
      )
      .bind("0010000001", "2025-06-01")
      .first<{ end_of_day_balance: number }>();
    expect(row?.end_of_day_balance).toBe(1_000_000);
  });

  it("overwrites an existing snapshot (INSERT OR REPLACE)", async () => {
    await snapshotDailyBalance("0010000001", "2025-06-01", d1 as any);
    // Add a transaction and re-snapshot
    await insertJournalGroup(d1 as any, {
      bankId: BANK_ID,
      txGroupId: "SNAP-UPDATE",
      entries: [
        { accountId: "0010000001", amount: 5_000, txType: "TRANSFER" },
        { accountId: "001-ZCS", amount: -5_000, txType: "TRANSFER" },
      ],
      valueDate: "2025-06-01",
    });
    await snapshotDailyBalance("0010000001", "2025-06-01", d1 as any);
    const row = await d1
      .prepare(
        `SELECT end_of_day_balance FROM DailyBalances WHERE account_id=? AND snapshot_date=?`
      )
      .bind("0010000001", "2025-06-01")
      .first<{ end_of_day_balance: number }>();
    expect(row?.end_of_day_balance).toBe(1_005_000);
  });
});
