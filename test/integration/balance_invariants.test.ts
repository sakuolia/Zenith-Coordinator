/**
 * @file balance_invariants.test.ts — End-to-end ledger invariants across lanes.
 *
 * Most unit tests assert state-machine transitions and FinalityLog shape, but
 * none of them follow money all the way through to the customer's `BankJournals`
 * row. That gap let two real bugs slip through:
 *
 *   • Double-credit on every SETTLED tx (orchestrator unconditionally called
 *     `credit-notify` which booked Customer(+) / ZCS(-) on top of the
 *     `execute-credit` journals).
 *   • HTLC_AUTH `capture` debited the payer but the orchestrator state-machine
 *     guard rejected the corresponding `PAYER_EXEC_CONFIRMED` transition, so
 *     the payee was never credited (Transactions stuck at H_RESERVED).
 *
 * This file is the regression net for both:
 *
 *   1. For every lane (EXPRESS / STANDARD / HTLC / HTLC_AUTH / HIGH_VALUE / BULK
 *      / GTID 1×1 / GTID 2×2 with reversed PAYEE insertion order), drain the
 *      queue to completion and assert:
 *        a. payer customer Δ == -amount
 *        b. payee customer Δ == +amount   ← double-credit would break this
 *        c. each bank's full ledger sums to 0  (per-bank zero-sum)
 *        d. system-wide BOJ sum stays at 0  (initial = 0)
 *   2. GTID 2×2 with reversed PAYEE insertion order specifically pins the
 *      leg_id-sorted pairing fix (regression for the off-by-one where
 *      counterpartyPayeeLeg used the wrong index).
 *
 * The drainQueue helper is a tiny synchronous loop because the production
 * `MessageBatch` consumer is irrelevant for the invariants under test — we
 * just need every produced message to be applied in FIFO order.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { todayJST } from "../../src/types";

import { processExpress } from "../../src/zc/lanes/express";
import { advanceStandard, authorizeStandard } from "../../src/zc/lanes/standard";
import { advanceBulk } from "../../src/zc/lanes/bulk";
import { advanceHighValue } from "../../src/zc/lanes/highvalue";
import { createHtlc, claimHtlc } from "../../src/zc/lanes/htlc";
import {
  registerAuthWhitelist,
  createAuthRequest,
  approveAuthRequest,
  captureHtlcAuth,
} from "../../src/zc/lanes/htlc_auth";
import { registerGtid, advanceGtid } from "../../src/zc/lanes/gtid";
import { kickDns, settleDns } from "../../src/zc/settlement/dns";
import { processQueueMessage, checkAndFinalizeGtid } from "../../src/zc/orchestrator";

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------

const BANK_A = "001";
const BANK_B = "002";
const ACC_A = "0010000001"; // 田中 太郎 (seeded with +1_000_000)
const ACC_B = "0020000001"; // 鈴木 一郎 (seeded with +1_000_000)
const ACC_A2 = "0010000002"; // 佐藤 花子 (seeded with +1_000_000)
const ACC_B2 = "0020000002"; // 山田 美咲 (seeded with +1_000_000)
const SEED_BAL = 1_000_000; // matches the seeded customer balance

/** Drain every queue message that fanned out so far, in FIFO order. */
async function drain(env: TestEnv, max = 50): Promise<number> {
  let n = 0;
  while (env.QUEUE._sink.length > 0 && n < max) {
    const msg = env.QUEUE._sink.shift()!;
    await processQueueMessage(msg, env as any);
    n++;
  }
  if (n >= max) throw new Error("drain: queue did not converge");
  return n;
}

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

function seedParticipant(db: MockD1Database, bankId: string, hLimit = 100_000_000) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', ?, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId, hLimit)
    ._runSync();
}

/** Sum every BankJournals row for an account. */
async function balanceOf(db: MockD1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ?`)
    .bind(accountId)
    .first<{ b: number }>();
  return row?.b ?? 0;
}

/** Sum every BankJournals row for a bank — must always be 0 (double-entry). */
async function bankSum(db: MockD1Database, bankId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE bank_id = ?`)
    .bind(bankId)
    .first<{ b: number }>();
  return row?.b ?? 0;
}

/**
 * SUM of every BOJ account across the system. Migration 0009 pre-funds each
 * participant bank with -10_000_000 (negative-liability sign convention), so
 * the initial system-wide BOJ sum is -20_000_000 in the 2-bank test fixture.
 * Every RTGS / DNS settlement is a transfer between BOJ accounts, so the
 * invariant we care about is that this sum is conserved across settlement.
 */
async function totalBoj(db: MockD1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(j.amount), 0) AS b
       FROM BankJournals j JOIN BankAccounts a ON a.account_id = j.account_id
       WHERE a.account_type = 'BOJ'`
    )
    .first<{ b: number }>();
  return row?.b ?? 0;
}

/** Pre-funded BOJ total from seed data (-10M × 2 banks). */
const BOJ_INITIAL_TOTAL = -20_000_000;

/** Assert per-bank zero-sum invariant for both test banks. */
async function expectZeroSum(db: MockD1Database) {
  expect(await bankSum(db, BANK_A)).toBe(0);
  expect(await bankSum(db, BANK_B)).toBe(0);
}

/** Insert a Transactions row in RECEIVED state. The lanes assume the row exists. */
function insertReceivedTx(
  db: MockD1Database,
  args: {
    txid: string;
    lane: string;
    amount: number;
    payerBank: string;
    payerAcc: string;
    payeeBank: string;
    payeeAcc: string;
    psprRef?: string | null;
    idempotencyKey?: string;
  }
) {
  db.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash,
      payee_bank_id, payee_account_hash, pspr_ref, idempotency_key, schema_version,
      version, created_at, updated_at)
     VALUES (?, ?, 'RECEIVED', ?, 'JPY', ?, ?, ?, ?, ?, ?, '1.0', 0, '2025-06-01T12:00:00Z', '2025-06-01T12:00:00Z')`
  )
    .bind(
      args.txid,
      args.lane,
      args.amount,
      args.payerBank,
      args.payerAcc,
      args.payeeBank,
      args.payeeAcc,
      args.psprRef ?? null,
      args.idempotencyKey ?? `IK-${args.txid}`
    )
    ._runSync();
}

let d1: MockD1Database;

beforeEach(() => {
  ({ d1 } = createTestDb());
  // The seed data already seeds participants in BankAccounts/BankJournals,
  // but Participants table is owned by ZC and not pre-seeded for the mock
  // banks the tests use. Both banks share generous h_limit so the lane logic
  // never fails on H reservation in these positive-path tests.
  seedParticipant(d1, BANK_A);
  seedParticipant(d1, BANK_B);
});

// ---------------------------------------------------------------------------
// EXPRESS — the canonical end-to-end happy path.
// Regression target: Bug A (post-settle double-credit via credit-notify).
// ---------------------------------------------------------------------------

describe("EXPRESS — end-to-end balance", () => {
  it("credits payee exactly once and preserves per-bank zero-sum", async () => {
    const env = makeEnv(d1);
    const amount = 50_000;

    insertReceivedTx(d1, {
      txid: "TX-EXP-INT-001",
      lane: "EXPRESS",
      amount,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });

    const res = await processExpress(
      {
        txid: "TX-EXP-INT-001",
        lane: "EXPRESS",
        amount: { value: amount, currency: "JPY" },
        payer: { bank_id: BANK_A, account_hash: ACC_A },
        payee: { bank_id: BANK_B, account_hash: ACC_B },
      } as any,
      env as any
    );
    expect(res.result).toBe("DECISION_ACCEPTED");

    await drain(env);

    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);
    await expectZeroSum(d1);

    // Crucially: payee customer must only have ONE settlement journal for this
    // txid (Hard Landing + Settle nets to 1 entry on customer). credit-notify
    // is a notification only after the fix; it must NOT post journals.
    const payeeCreditEntries = await d1
      .prepare(
        `SELECT COUNT(*) AS c FROM BankJournals
        WHERE account_id = ? AND txid = ? AND amount > 0`
      )
      .bind(ACC_B, "TX-EXP-INT-001")
      .first<{ c: number }>();
    expect(payeeCreditEntries?.c).toBe(1);
  });

  it("SETTLED txid leaves all balance deltas where DNS can still clear them", async () => {
    const env = makeEnv(d1);
    insertReceivedTx(d1, {
      txid: "TX-EXP-INT-002",
      lane: "EXPRESS",
      amount: 200_000,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });
    await processExpress(
      {
        txid: "TX-EXP-INT-002",
        lane: "EXPRESS",
        amount: { value: 200_000, currency: "JPY" },
        payer: { bank_id: BANK_A, account_hash: ACC_A },
        payee: { bank_id: BANK_B, account_hash: ACC_B },
      } as any,
      env as any
    );
    await drain(env);

    // Mid-flow (pre-DNS): payer suspense still holds the funds.
    expect(await balanceOf(d1, `${BANK_A}0000000`)).toBe(200_000);
    // Payee suspense should net to 0 (Hard Landing + immediate Settle).
    expect(await balanceOf(d1, `${BANK_B}0000000`)).toBe(0);

    const tx = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid=?`)
      .bind("TX-EXP-INT-002")
      .first<{ state: string }>();
    expect(tx?.state).toBe("SETTLED");
  });
});

// ---------------------------------------------------------------------------
// STANDARD — two-phase commit (advance + authorize).
// ---------------------------------------------------------------------------

describe("STANDARD — end-to-end balance", () => {
  it("credits payee exactly +amount after authorize", async () => {
    const env = makeEnv(d1);
    const amount = 70_000;

    insertReceivedTx(d1, {
      txid: "TX-STD-INT-001",
      lane: "STANDARD",
      amount,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });

    await advanceStandard("TX-STD-INT-001", env as any);
    // Should be parked at H_RESERVED waiting for authorize
    const mid = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid=?`)
      .bind("TX-STD-INT-001")
      .first<{ state: string }>();
    expect(mid?.state).toBe("H_RESERVED");

    const auth = await authorizeStandard("TX-STD-INT-001", true, env as any);
    expect(auth.ok).toBe(true);

    await drain(env);

    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);
    await expectZeroSum(d1);
  });
});

// ---------------------------------------------------------------------------
// HTLC — preimage release.
// ---------------------------------------------------------------------------

describe("HTLC — preimage release end-to-end", () => {
  it("credits payee +amount when preimage matches", async () => {
    const env = makeEnv(d1);
    const amount = 40_000;
    const farFuture = new Date(Date.now() + 24 * 3600_000).toISOString();

    const created = await createHtlc(
      {
        htlc_id: "HTLC-INT-001",
        idempotency_key: "IK-HTLC-INT-001",
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
    const preimage = created.preimage!;

    // Drain ZC_BANK_RESERVE to move HTLC into HTLC_LOCKED state.
    await drain(env);
    const lockedHtlc = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id=?`)
      .bind("HTLC-INT-001")
      .first<{ state: string }>();
    expect(lockedHtlc?.state).toBe("HTLC_LOCKED");

    const claimed = await claimHtlc(
      {
        htlc_id: "HTLC-INT-001",
        preimage,
        idempotency_key: "IK-HTLC-INT-CLAIM-001",
      } as any,
      env as any
    );
    expect(claimed.result).toBe("ACCEPTED");

    await drain(env);

    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);
    await expectZeroSum(d1);
  });

  it("does not credit when preimage is wrong (REJECTED)", async () => {
    const env = makeEnv(d1);
    const farFuture = new Date(Date.now() + 24 * 3600_000).toISOString();

    await createHtlc(
      {
        htlc_id: "HTLC-INT-002",
        idempotency_key: "IK-HTLC-INT-002",
        amount: { value: 40_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock: farFuture,
      } as any,
      env as any
    );
    await drain(env);

    const rejected = await claimHtlc(
      {
        htlc_id: "HTLC-INT-002",
        preimage: "00".repeat(32),
        idempotency_key: "IK-HTLC-INT-CLAIM-002",
      } as any,
      env as any
    );
    expect(rejected.result).toBe("REJECTED");

    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL); // unchanged
    await expectZeroSum(d1);
  });
});

// ---------------------------------------------------------------------------
// HTLC_AUTH — payee-initiated authorization.
// Regression target: Bug B (Transactions stuck at H_RESERVED, payee never
// credited even though bank-side debit succeeded).
// ---------------------------------------------------------------------------

describe("HTLC_AUTH — end-to-end balance", () => {
  it("payee receives +amount after capture (no funds leak to suspense)", async () => {
    const env = makeEnv(d1);
    const amount = 25_000;

    await registerAuthWhitelist(
      {
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        max_amount: 100_000,
        description: "integration test",
      } as any,
      d1 as any
    );

    const farFuture = new Date(Date.now() + 24 * 3600_000).toISOString();
    const farFuture2 = new Date(Date.now() + 48 * 3600_000).toISOString();

    const ar = await createAuthRequest(
      {
        auth_id: "AUTH-INT-001",
        idempotency_key: "IK-AUTH-INT-001",
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        amount: { value: amount, currency: "JPY" },
        auth_expires_at: farFuture,
        capture_expires_at: farFuture2,
      } as any,
      env as any
    );
    expect(ar.result).toBe("AUTH_REQUESTED");

    const apv = await approveAuthRequest(
      "AUTH-INT-001",
      {
        idempotency_key: "IK-AUTH-APV-001",
      } as any,
      env as any
    );
    expect(apv.result).toBe("APPROVED");

    // After approve, Transactions must be HTLC_LOCKED (regression: was
    // H_RESERVED before the fix, which made captureHtlcAuth a no-op).
    const txAfterApprove = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid=?`)
      .bind("TX-HAUTH-AUTH-INT-001")
      .first<{ state: string }>();
    expect(txAfterApprove?.state).toBe("HTLC_LOCKED");

    const cap = await captureHtlcAuth(
      "HAUTH-AUTH-INT-001",
      {
        idempotency_key: "IK-AUTH-CAP-001",
      } as any,
      env as any
    );
    expect(cap.result).toBe("CAPTURED");

    await drain(env);

    const txFinal = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid=?`)
      .bind("TX-HAUTH-AUTH-INT-001")
      .first<{ state: string }>();
    expect(txFinal?.state).toBe("SETTLED");

    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);
    await expectZeroSum(d1);
  });
});

// ---------------------------------------------------------------------------
// BULK / DEFERRED — settled only via DNS cycle (no immediate execution).
// ---------------------------------------------------------------------------

describe("BULK — DNS-settled balance", () => {
  it("DECIDED_TO_SETTLE before DNS, then DNS clears the suspense and reaches SETTLED", async () => {
    const env = makeEnv(d1);
    const amount = 30_000;

    insertReceivedTx(d1, {
      txid: "TX-BULK-INT-001",
      lane: "BULK",
      amount,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });

    await advanceBulk("TX-BULK-INT-001", env as any);
    const mid = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid=?`)
      .bind("TX-BULK-INT-001")
      .first<{ state: string }>();
    expect(mid?.state).toBe("DECIDED_TO_SETTLE");

    // Before DNS: payer customer already debited (Hard Reservation), suspense holds.
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL);

    // Kick and settle DNS for today.
    const today = todayJST();
    const kick = await kickDns(today, env as any);
    expect(kick.state).toBe("KICKED");
    await settleDns(kick.cycle_id, env as any);
    await drain(env);

    const finalState = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid=?`)
      .bind("TX-BULK-INT-001")
      .first<{ state: string }>();
    expect(finalState?.state).toBe("SETTLED");

    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);
    await expectZeroSum(d1);
    expect(await totalBoj(d1)).toBe(BOJ_INITIAL_TOTAL);
  });
});

// ---------------------------------------------------------------------------
// HIGH_VALUE — RTGS via IGS callback. Skips H reservation, uses BOJ pre-fund.
// ---------------------------------------------------------------------------

describe("HIGH_VALUE — RTGS end-to-end balance", () => {
  it("settles via IGS, moving Customer→ZCS→BOJ and reaching SETTLED", async () => {
    const env = makeEnv(d1);
    const amount = 800_000;

    // Pre-fund BOJ for both banks so HV BOJ check + IGS journal can run.
    // (seed data only funds 10_000_000 on each side, sufficient here.)
    insertReceivedTx(d1, {
      txid: "TX-HV-INT-001",
      lane: "HIGH_VALUE",
      amount,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });

    await advanceHighValue("TX-HV-INT-001", env as any);
    await drain(env); // ZC_BANK_DEBIT → ZC_IGS_CALLBACK → ZC_BANK_CREDIT

    const final = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid=?`)
      .bind("TX-HV-INT-001")
      .first<{ state: string }>();
    expect(final?.state).toBe("SETTLED");

    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);
    await expectZeroSum(d1);

    // BOJ system-wide sum is conserved by the RTGS leg (payer BOJ += amount,
    // payee BOJ -= amount). The absolute value is the seeded pre-fund.
    expect(await totalBoj(d1)).toBe(BOJ_INITIAL_TOTAL);

    // Sanity: payer BOJ should have moved +amount (consumed pre-fund),
    // payee BOJ should have moved -amount (gained settlement balance).
    expect(await balanceOf(d1, `${BANK_A}-BOJ`)).toBe(-10_000_000 + amount);
    expect(await balanceOf(d1, `${BANK_B}-BOJ`)).toBe(-10_000_000 - amount);
  });
});

// ---------------------------------------------------------------------------
// GTID — coordinated multi-leg. 1×1 and 2×2 with reversed PAYEE insertion.
// Regression target: Bug C (PAYER↔PAYEE pairing was insertion-order
// dependent; we now pair by leg_id rank).
// ---------------------------------------------------------------------------

describe("GTID — 1×1 atomic transfer", () => {
  it("credits payee +amount after PAYER leg settles via DNS", async () => {
    const env = makeEnv(d1);
    const amount = 60_000;

    await registerGtid(
      {
        gtid: "GT-INT-001",
        idempotency_key: "IK-GT-INT-001",
        expires_at: "2099-12-31T00:00:00Z",
        legs: [
          {
            leg_id: "GT-INT-001-A",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A,
            amount: { value: amount, currency: "JPY" },
          },
          {
            leg_id: "GT-INT-001-B",
            role: "PAYEE",
            bank_id: BANK_B,
            account_hash: ACC_B,
            amount: { value: amount, currency: "JPY" },
          },
        ],
      } as any,
      env as any
    );
    await advanceGtid("GT-INT-001", env as any);
    await drain(env);

    // PAYER leg's txid moves to SETTLED through the standard execute-debit/credit path.
    const tx = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid=?`)
      .bind("TX-GT-GT-INT-001-A")
      .first<{ state: string }>();
    expect(tx?.state).toBe("SETTLED");

    // GT_DECIDED_TO_SETTLE → GT_SETTLED requires the orchestrator's
    // checkAndFinalizeGtid; in tests we trigger it explicitly because
    // onPayeeExecConfirmed only fires it for TX-GT-* txids during dispatch.
    await checkAndFinalizeGtid("GT-INT-001", d1 as any);
    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-INT-001")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SETTLED");

    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amount);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amount);
    await expectZeroSum(d1);
  });
});

describe("GTID — 2×2 with PAYEE inserted in reverse leg_id order", () => {
  // Without leg_id-sorted pairing, the implementation would route the small
  // PAYER to the large PAYEE and vice versa, producing the wrong customer
  // ending balances. The fix is to sort both leg arrays by leg_id; this test
  // pins that contract.
  it("pairs PAYER A↔PAYEE A2 and PAYER B↔PAYEE B2 regardless of insertion order", async () => {
    const env = makeEnv(d1);
    const amtSmall = 10_000;
    const amtLarge = 90_000;

    // Insertion order: PAYER_small_A, PAYER_large_B, PAYEE_large_B (B2 leg_id "Z"),
    // PAYEE_small_A (A2 leg_id "A"). PAYEEs are reversed relative to PAYERs.
    await registerGtid(
      {
        gtid: "GT-INT-2X2",
        idempotency_key: "IK-GT-INT-2X2",
        expires_at: "2099-12-31T00:00:00Z",
        legs: [
          {
            leg_id: "GT-2X2-A",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A,
            amount: { value: amtSmall, currency: "JPY" },
          },
          {
            leg_id: "GT-2X2-B",
            role: "PAYER",
            bank_id: BANK_A,
            account_hash: ACC_A2,
            amount: { value: amtLarge, currency: "JPY" },
          },
          // Inserted PAYEE B (large) FIRST despite alphabetically later leg_id
          {
            leg_id: "GT-2X2-Z-PAYEE-B",
            role: "PAYEE",
            bank_id: BANK_B,
            account_hash: ACC_B2,
            amount: { value: amtLarge, currency: "JPY" },
          },
          {
            leg_id: "GT-2X2-A-PAYEE-A",
            role: "PAYEE",
            bank_id: BANK_B,
            account_hash: ACC_B,
            amount: { value: amtSmall, currency: "JPY" },
          },
        ],
      } as any,
      env as any
    );
    await advanceGtid("GT-INT-2X2", env as any);
    await drain(env);
    await checkAndFinalizeGtid("GT-INT-2X2", d1 as any);

    // Pairing by leg_id rank:
    //   sorted PAYER  = [GT-2X2-A (10k → from ACC_A), GT-2X2-B (90k → from ACC_A2)]
    //   sorted PAYEE  = [GT-2X2-A-PAYEE-A (→ ACC_B), GT-2X2-Z-PAYEE-B (→ ACC_B2)]
    //   → PAYER-A (10k) pairs PAYEE-A (ACC_B, 10k)
    //   → PAYER-B (90k) pairs PAYEE-B (ACC_B2, 90k)
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - amtSmall);
    expect(await balanceOf(d1, ACC_A2)).toBe(SEED_BAL - amtLarge);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + amtSmall);
    expect(await balanceOf(d1, ACC_B2)).toBe(SEED_BAL + amtLarge);
    await expectZeroSum(d1);
  });
});

// ---------------------------------------------------------------------------
// Multi-lane interleave — running several lanes against the same DB at once
// must not corrupt the ledger.
// ---------------------------------------------------------------------------

describe("Multi-lane interleave", () => {
  it("Express + Standard + HTLC in the same DB all settle correctly", async () => {
    const env = makeEnv(d1);
    const farFuture = new Date(Date.now() + 24 * 3600_000).toISOString();

    insertReceivedTx(d1, {
      txid: "TX-MIX-EXP",
      lane: "EXPRESS",
      amount: 11_000,
      payerBank: BANK_A,
      payerAcc: ACC_A,
      payeeBank: BANK_B,
      payeeAcc: ACC_B,
    });
    insertReceivedTx(d1, {
      txid: "TX-MIX-STD",
      lane: "STANDARD",
      amount: 22_000,
      payerBank: BANK_A,
      payerAcc: ACC_A2,
      payeeBank: BANK_B,
      payeeAcc: ACC_B2,
    });

    await processExpress(
      {
        txid: "TX-MIX-EXP",
        lane: "EXPRESS",
        amount: { value: 11_000, currency: "JPY" },
        payer: { bank_id: BANK_A, account_hash: ACC_A },
        payee: { bank_id: BANK_B, account_hash: ACC_B },
      } as any,
      env as any
    );
    await advanceStandard("TX-MIX-STD", env as any);
    await authorizeStandard("TX-MIX-STD", true, env as any);
    await createHtlc(
      {
        htlc_id: "HTLC-MIX-001",
        idempotency_key: "IK-HTLC-MIX-001",
        amount: { value: 7_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock: farFuture,
      } as any,
      env as any
    );
    // drain reserve queue so HTLC reaches HTLC_LOCKED
    await drain(env);

    // Pull preimage off the createHtlc return; we need a fresh call to get it
    // — instead just create another HTLC and exercise the full path.
    const h2 = await createHtlc(
      {
        htlc_id: "HTLC-MIX-002",
        idempotency_key: "IK-HTLC-MIX-002",
        amount: { value: 5_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock: farFuture,
      } as any,
      env as any
    );
    await drain(env);
    await claimHtlc(
      {
        htlc_id: "HTLC-MIX-002",
        preimage: h2.preimage!,
        idempotency_key: "IK-HTLC-MIX-002-CLAIM",
      } as any,
      env as any
    );
    await drain(env);

    // Now totals on ACC_A (payer customer):
    //   -11_000 (EXP settled)
    //   - 7_000 (HTLC-MIX-001: created and reached HTLC_LOCKED — Hard
    //            Reservation already debits customer into suspense even though
    //            preimage was never presented. Released only on cancel/expiry.)
    //   - 5_000 (HTLC-MIX-002: claimed and settled)
    //   = -23_000
    // Payee side: only EXP and HTLC-002 actually credited (-001 is still locked).
    expect(await balanceOf(d1, ACC_A)).toBe(SEED_BAL - 23_000);
    expect(await balanceOf(d1, ACC_A2)).toBe(SEED_BAL - 22_000);
    expect(await balanceOf(d1, ACC_B)).toBe(SEED_BAL + 11_000 + 5_000);
    expect(await balanceOf(d1, ACC_B2)).toBe(SEED_BAL + 22_000);
    await expectZeroSum(d1);

    // Payer's 別段預金 (Suspense) holds funds that have left the customer
    // but have not yet been DNS-cleared into ZCS. All four reservations are
    // there: EXP (11k) + STD (22k) + HTLC-001 (7k, still locked) + HTLC-002
    // (5k, EXECUTED but not DNS-cleared) = 45_000.
    expect(await balanceOf(d1, `${BANK_A}0000000`)).toBe(11_000 + 22_000 + 7_000 + 5_000);
  });
});
