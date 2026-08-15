/**
 * @file concurrent_races.test.ts — interleaved-execution race tests.
 *
 * WHAT THIS IS. The suite's D1 mock is better-sqlite3: synchronous and
 * single-threaded, so true OS-thread parallelism is not available and these
 * tests do NOT claim to reproduce it. What they DO reproduce is the class of
 * bug that single-truth payment code actually has to survive: two in-flight
 * operations interleaving their read → decide → write sequences against the
 * same rows. Because the production code awaits the DB at every step and the
 * mock's `run`/`first`/`all` are async, driving two operations with
 * `Promise.all` makes the event loop interleave them at those await points —
 * exactly the windows where a check-then-act (TOCTOU) race lives. Each SQLite
 * statement still executes atomically, which mirrors how a single-row CAS
 * behaves on a real backend, so a correct CAS-gated flow must yield exactly one
 * outcome no matter how the two are interleaved.
 *
 * WHAT IT DOES NOT COVER. Lock contention, deadlocks, write-write conflicts
 * under genuine parallelism, and a distributed backend's isolation semantics
 * are out of scope here — those need the real store (see docs/specs/30_internal_design.md).
 * These tests pin the *logical* race: no partial settlement, no double
 * settlement, exactly-once money movement, under adversarial interleaving.
 *
 * The headline target is the FX claim/refund multi-operation boundary
 * (src/zc/fx/htlc.ts), whose mutual exclusion rests on a single authoritative
 * CAS on FxTransfers.status. Run on the pre-CAS code, the claim-vs-refund test
 * fails (both proceed); with the gate, exactly one wins.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { processQueueMessage } from "../../src/zc/orchestrator";
import { upsertQuote } from "../../src/zc/fx/quotes";
import { findBestRoute } from "../../src/zc/fx/routing";
import {
  lockFxTransfer,
  claimFxTransfer,
  refundFxTransfer,
  getFxLegLocks,
  FX_HTLC_BASE_TIMEOUT_MS,
  FX_HTLC_HOP_MARGIN_MS,
} from "../../src/zc/fx/htlc";
import { getFxTransfer } from "../../src/zc/fx/transfer";
import { isDomainError } from "../../src/shared/errors";

const PAYER_BANK = "001";
const FXP_BANK = "002";
const PAYER_ACC = "0010000001";
const PAYEE_ACC = "0010000002";
const FXP_JPY_ACC = "0020000001";
const FXP_USD_ACC = "0020000002";
const SEED_BAL = 1_000_000;
const RATE = 670_000;
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

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
      send: async (m) => {
        sink.push(m);
      },
    },
    ZC_HMAC_SECRET: "test-secret",
  };
}

async function drain(env: TestEnv, max = 80): Promise<void> {
  let n = 0;
  while (env.QUEUE._sink.length > 0 && n < max) {
    await processQueueMessage(env.QUEUE._sink.shift()!, env as any);
    n++;
  }
  if (n >= max) throw new Error("drain: did not converge");
}

function seedParticipant(db: MockD1Database, bankId: string) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 100000000, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId)
    ._runSync();
}

function seedCurrencyLimit(db: MockD1Database, bankId: string, currency: string) {
  db.prepare(
    `INSERT OR REPLACE INTO ParticipantCurrencyLimits (bank_id, currency, h_limit, h_used)
     VALUES (?, ?, 100000000, 0)`
  )
    .bind(bankId, currency)
    ._runSync();
}

function seedCcyBalance(
  db: MockD1Database,
  bankId: string,
  accountId: string,
  amount: number,
  currency: string
) {
  for (const [acct, amt] of [
    [accountId, amount],
    [`${bankId}-ZCS`, -amount],
  ] as const) {
    db.prepare(
      `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, amount_currency, tx_type, tx_group_id, value_date, created_at)
       VALUES (?, ?, ?, ?, ?, 'CASH', ?, '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(
        `JNL-PF-${accountId}-${currency}-${amt}`,
        bankId,
        acct,
        amt,
        currency,
        `PF-${accountId}-${currency}`
      )
      ._runSync();
  }
}

async function balanceOf(db: MockD1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ?`)
    .bind(accountId)
    .first<{ b: number }>();
  return row?.b ?? 0;
}

const resolveFxpAccount = (_bankId: string, currency: string): string =>
  currency === "JPY" ? FXP_JPY_ACC : FXP_USD_ACC;

let d1: MockD1Database;
let env: TestEnv;

beforeEach(() => {
  ({ d1 } = createTestDb());
  env = makeEnv(d1);
  seedParticipant(d1, PAYER_BANK);
  seedParticipant(d1, FXP_BANK);
  seedCurrencyLimit(d1, FXP_BANK, "USD");
  seedCcyBalance(d1, FXP_BANK, FXP_USD_ACC, 10_000_000, "USD");
});

async function routeJpyUsd(amount = 500_000) {
  await upsertQuote(d1, {
    fxp_bank_id: FXP_BANK,
    from_currency: "JPY",
    to_currency: "USD",
    rate: RATE,
    valid_to: FAR_FUTURE,
  });
  const r = await findBestRoute(d1, {
    from_currency: "JPY",
    to_currency: "USD",
    amount,
    denomination: "PAYER",
  });
  if (!r.ok) throw new Error("no route");
  return r.route;
}

const parties = {
  payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACC },
  payee: { bank_id: PAYER_BANK, account_hash: PAYEE_ACC },
  resolveFxpAccount,
};

const afterExpiry = () =>
  new Date(Date.now() + FX_HTLC_BASE_TIMEOUT_MS + 3 * FX_HTLC_HOP_MARGIN_MS).toISOString();

describe("concurrent FX claim vs refund (interleaved via Promise.all)", () => {
  it("settles XOR refunds — never both, never partial — for every interleaving", async () => {
    // Both operations are eligible at once: a valid secret AND an expired
    // timelock. Fire them concurrently; the event loop interleaves their
    // read→decide→write steps at each awaited DB call.
    const { secret } = await lockFxTransfer(env as any, {
      gtid: "GT-RACE-1",
      route: await routeJpyUsd(),
      ...parties,
    });

    const [claimRes, refundRes] = await Promise.allSettled([
      claimFxTransfer(env as any, "GT-RACE-1", secret!),
      refundFxTransfer(env as any, "GT-RACE-1", afterExpiry()),
    ]);
    await drain(env);

    const claimWon = claimRes.status === "fulfilled";
    const refundWon =
      refundRes.status === "fulfilled" &&
      (refundRes.value as { refunded_legs: number }).refunded_legs > 0;

    // Exactly one side may take effect.
    expect(claimWon).not.toBe(refundWon);

    const legs = await getFxLegLocks(env as any, "GT-RACE-1");
    const transfer = (await getFxTransfer(env as any, "GT-RACE-1"))!;
    const payer = await balanceOf(d1, PAYER_ACC);
    const payee = await balanceOf(d1, PAYEE_ACC);

    if (claimWon) {
      // The loser (refund) must have been refused; legs all CLAIMED; money moved once.
      expect(
        refundRes.status === "rejected" ||
          (refundRes.value as { refunded_legs: number }).refunded_legs === 0
      ).toBe(true);
      expect(legs.every((l) => l.state === "CLAIMED")).toBe(true);
      expect(transfer.status).toBe("SETTLED");
      expect(payer).toBe(SEED_BAL - 500_000);
      expect(payee).toBe(SEED_BAL + 3_350);
    } else {
      // Refund won: claim was rejected; legs all REFUNDED; no money moved.
      expect(claimRes.status).toBe("rejected");
      if (claimRes.status === "rejected") {
        expect(
          isDomainError(claimRes.reason) && claimRes.reason.reason_code === "FX_ALREADY_REFUNDED"
        ).toBe(true);
      }
      expect(legs.every((l) => l.state === "REFUNDED")).toBe(true);
      expect(transfer.status).toBe("REFUNDED");
      expect(payer).toBe(SEED_BAL);
      expect(payee).toBe(SEED_BAL);
    }
  });
});

describe("concurrent duplicate FX claims (interleaved via Promise.all)", () => {
  it("settles exactly once and never double-debits, no matter the interleaving", async () => {
    const { secret } = await lockFxTransfer(env as any, {
      gtid: "GT-RACE-2",
      route: await routeJpyUsd(),
      ...parties,
    });

    const results = await Promise.allSettled([
      claimFxTransfer(env as any, "GT-RACE-2", secret!),
      claimFxTransfer(env as any, "GT-RACE-2", secret!),
      claimFxTransfer(env as any, "GT-RACE-2", secret!),
    ]);
    await drain(env);

    // All three claims succeed (idempotent), and exactly one did the settling work.
    const fulfilled = results.filter((r) => r.status === "fulfilled") as Array<
      PromiseFulfilledResult<{ status: string; already: boolean }>
    >;
    expect(fulfilled).toHaveLength(3);
    expect(fulfilled.every((r) => r.value.status === "SETTLED")).toBe(true);
    expect(fulfilled.filter((r) => r.value.already === false)).toHaveLength(1);

    const legs = await getFxLegLocks(env as any, "GT-RACE-2");
    expect(legs.every((l) => l.state === "CLAIMED")).toBe(true);
    // Money moved exactly once despite three concurrent claims.
    expect(await balanceOf(d1, PAYER_ACC)).toBe(SEED_BAL - 500_000);
    expect(await balanceOf(d1, PAYEE_ACC)).toBe(SEED_BAL + 3_350);
  });
});
