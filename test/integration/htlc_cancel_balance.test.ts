/**
 * @file htlc_cancel_balance.test.ts — HTLC cancel restores payer suspense balance.
 *
 * Verifies that when an HTLC is cancelled (either directly or via timelock
 * expiry), the payer's suspense reservation is released back to the checking
 * account, leaving all balance invariants intact:
 *
 *   1. payer customer Δ == 0   (net zero movement — no loss on cancel)
 *   2. payer suspense Δ == 0   (funds returned from suspense to customer)
 *   3. per-bank ledger zero-sum (double-entry preserved)
 *
 * Two cancel paths are exercised:
 *   A. Direct cancel after HTLC_LOCKED (cancelHtlc with reasonCode)
 *   B. Timelock-expired cancel triggered via claimHtlc (past timelock date)
 *
 * This is the regression guard for the bank-side release-reserve flow that
 * runs inside cancelHtlc when `env` is provided.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { createHtlc, cancelHtlc, claimHtlc } from "../../src/zc/lanes/htlc";
import { processQueueMessage } from "../../src/zc/orchestrator";

// ---------------------------------------------------------------------------
// Test rig (mirrors balance_invariants.test.ts conventions)
// ---------------------------------------------------------------------------

const BANK_A = "001";
const BANK_B = "002";
const ACC_A = "0010000001"; // payer (seeded with 1,000,000)
const ACC_B = "0020000001"; // payee
const SUSP_A = "0010000000"; // payer bank suspense account
const SEED_BAL = 1_000_000;

let d1: MockD1Database;

interface TestEnv {
  DB: MockD1Database;
  QUEUE: { _sink: any[]; send: (m: any) => Promise<void> };
  ZC_HMAC_SECRET: string;
}

function makeEnv(db: MockD1Database): TestEnv {
  const sink: any[] = [];
  return {
    DB: db,
    QUEUE: {
      _sink: sink,
      send: async (m: any) => {
        sink.push(m);
      },
    },
    ZC_HMAC_SECRET: "test-secret",
  };
}

async function drain(env: TestEnv, max = 20): Promise<void> {
  let n = 0;
  while (env.QUEUE._sink.length > 0 && n < max) {
    const msg = env.QUEUE._sink.shift()!;
    await processQueueMessage(msg, env as any);
    n++;
  }
  if (n >= max) throw new Error("drain: queue did not converge");
}

function seedParticipant(db: MockD1Database, bankId: string) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 10000000, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId)
    ._runSync();
}

async function balanceOf(db: MockD1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ?`)
    .bind(accountId)
    .first<{ b: number }>();
  return row?.b ?? 0;
}

async function bankSum(db: MockD1Database, bankId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE bank_id = ?`)
    .bind(bankId)
    .first<{ b: number }>();
  return row?.b ?? 0;
}

async function expectZeroSum(db: MockD1Database) {
  expect(await bankSum(db, BANK_A)).toBe(0);
  expect(await bankSum(db, BANK_B)).toBe(0);
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  seedParticipant(d1, BANK_A);
  seedParticipant(d1, BANK_B);
});

// ---------------------------------------------------------------------------
// Path A: Direct cancel after HTLC_LOCKED
// Flow: createHtlc → ZC_BANK_RESERVE (lockHtlc → reserve-funds) → cancelHtlc
// ---------------------------------------------------------------------------

describe("HTLC direct cancel balance (HTLC_LOCKED → CANCELLED)", () => {
  it("payer Δ=0 and suspense Δ=0 after direct cancel", async () => {
    const env = makeEnv(d1);
    const amount = 50_000;
    const farFuture = new Date(Date.now() + 24 * 3600_000).toISOString();

    const created = await createHtlc(
      {
        htlc_id: "HTLC-CANCEL-001",
        idempotency_key: "IK-HTLC-CANCEL-001",
        amount: { value: amount, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock: farFuture,
      } as any,
      env as any
    );
    expect(created.result).toBe("CREATED");

    // Drain: ZC_BANK_RESERVE → lockHtlc → callBankReserveFunds (moves payer funds to suspense)
    await drain(env);

    const lockedState = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id = ?`)
      .bind("HTLC-CANCEL-001")
      .first<{ state: string }>();
    expect(lockedState?.state).toBe("HTLC_LOCKED");

    // After locking: payer customer should be -amount (moved to suspense).
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, SUSP_A)).toBe(amount);

    // Cancel the HTLC (with env so bank release-reserve is called).
    const txRow = await d1
      .prepare(`SELECT txid FROM HtlcContracts WHERE htlc_id = ?`)
      .bind("HTLC-CANCEL-001")
      .first<{ txid: string }>();
    await cancelHtlc("HTLC-CANCEL-001", txRow!.txid, "MANUAL_CANCEL", d1 as any, env as any);

    // After cancel: payer customer must be back to SEED_BAL, suspense must be 0.
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL);
    expect(await balanceOf(d1, SUSP_A)).toBe(0);
    await expectZeroSum(d1);

    const cancelledState = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind(txRow!.txid)
      .first<{ state: string }>();
    expect(cancelledState?.state).toBe("CANCELLED");
  });

  it("payee balance is untouched after payer cancel", async () => {
    const env = makeEnv(d1);
    const amount = 30_000;
    const farFuture = new Date(Date.now() + 24 * 3600_000).toISOString();

    const created = await createHtlc(
      {
        htlc_id: "HTLC-CANCEL-002",
        idempotency_key: "IK-HTLC-CANCEL-002",
        amount: { value: amount, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock: farFuture,
      } as any,
      env as any
    );
    await drain(env);

    const txRow = await d1
      .prepare(`SELECT txid FROM HtlcContracts WHERE htlc_id = ?`)
      .bind("HTLC-CANCEL-002")
      .first<{ txid: string }>();
    await cancelHtlc("HTLC-CANCEL-002", txRow!.txid, "MANUAL_CANCEL", d1 as any, env as any);

    // Payee must be completely unaffected.
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL);
    await expectZeroSum(d1);
  });
});

// ---------------------------------------------------------------------------
// Path B: Timelock-expired cancel triggered by claimHtlc
// Flow: createHtlc → lock → claimHtlc(past timelock) → cancelHtlc(TIMELOCK_EXPIRED)
// ---------------------------------------------------------------------------

describe("HTLC timelock-expired cancel balance", () => {
  it("payer Δ=0 and suspense Δ=0 after TIMELOCK_EXPIRED via claimHtlc", async () => {
    const env = makeEnv(d1);
    const amount = 40_000;
    // Use a past timelock so the check in lockHtlc passes but claimHtlc cancels.
    // lockHtlc checks: if timelock < now → cancel without env (no suspense yet).
    // We need the HTLC to reach HTLC_LOCKED first, then expire.
    // Strategy: create with future timelock, lock it, then directly call
    // claimHtlc with a hashlock that will fail the preimage check — but first
    // manipulate the timelock to be in the past so claimHtlc hits the expiry branch.
    const nearFuture = new Date(Date.now() + 10 * 3600_000).toISOString();

    const created = await createHtlc(
      {
        htlc_id: "HTLC-TIMELOCK-001",
        idempotency_key: "IK-HTLC-TIMELOCK-001",
        amount: { value: amount, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock: nearFuture,
        hashlock: "a".repeat(64),
      } as any,
      env as any
    );
    expect(created.result).toBe("CREATED");

    // Lock the HTLC (bank suspense reserved).
    await drain(env);
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);

    // Backdate the timelock in DB so claimHtlc sees it as expired.
    const pastISO = "2000-01-01T00:00:00Z";
    d1.prepare(`UPDATE HtlcContracts SET timelock = ? WHERE htlc_id = ?`)
      .bind(pastISO, "HTLC-TIMELOCK-001")
      ._runSync();

    // claimHtlc detects expired timelock → calls cancelHtlc(env) → bank release-reserve.
    const claim = await claimHtlc(
      {
        htlc_id: "HTLC-TIMELOCK-001",
        preimage: "00".repeat(32),
        idempotency_key: "IK-HTLC-CLAIM-TIMELOCK-001",
      } as any,
      env as any
    );
    expect(claim.result).toBe("REJECTED");
    expect(claim.reason_code).toBe("TIMELOCK_EXPIRED");

    // Payer must be fully restored.
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL);
    expect(await balanceOf(d1, SUSP_A)).toBe(0);
    // Payee untouched.
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL);
    await expectZeroSum(d1);
  });
});
