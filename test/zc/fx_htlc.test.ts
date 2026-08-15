/**
 * @file Tests for the FX HTLC binding (src/zc/fx/htlc.ts) — cross-rail
 * atomicity via a shared hashlock with staggered timelocks.
 *
 * Covers: lock (staggered timelocks, deferred settlement), claim (secret →
 * cascade → GTID settles, with real customer balances), wrong-secret rejection,
 * idempotent claim, timeout refund (no money moves), the refund timelock guard,
 * and the mutual exclusion of claim vs refund.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { processQueueMessage } from "../../src/zc/orchestrator";
import { sha256hex } from "../../src/shared/hmac";
import { upsertQuote } from "../../src/zc/fx/quotes";
import { findBestRoute } from "../../src/zc/fx/routing";
import {
  lockFxTransfer,
  claimFxTransfer,
  refundFxTransfer,
  getFxLegLocks,
  sweepExpiredFxLocks,
  FX_HTLC_BASE_TIMEOUT_MS,
  FX_HTLC_HOP_MARGIN_MS,
  FX_SETTLING_TIMEOUT_MS,
  settlingDeadline,
  sweepStuckFxSettling,
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

/** Prefund an account in a currency (account(+)/ZCS(-), per-currency zero-sum). */
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
  // FXP prefunds USD to pay its USD leg (currency-scoped funds check).
  seedCcyBalance(d1, FXP_BANK, FXP_USD_ACC, 10_000_000, "USD");
});

async function lock(gtid: string, amount = 500_000) {
  await upsertQuote(d1, {
    fxp_bank_id: FXP_BANK,
    from_currency: "JPY",
    to_currency: "USD",
    rate: RATE,
    valid_to: FAR_FUTURE,
  });
  const routed = await findBestRoute(d1, {
    from_currency: "JPY",
    to_currency: "USD",
    amount,
    denomination: "PAYER",
  });
  if (!routed.ok) throw new Error("no route");
  return lockFxTransfer(env as any, {
    gtid,
    route: routed.route,
    payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACC },
    payee: { bank_id: PAYER_BANK, account_hash: PAYEE_ACC },
    resolveFxpAccount,
  });
}

describe("lockFxTransfer", () => {
  it("locks each leg under one hashlock with staggered (upstream-later) timelocks and defers settlement", async () => {
    const res = await lock("GT-HTLC-1");
    expect(res.hashlock).toMatch(/^[0-9a-f]{64}$/);
    expect(res.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.legs).toBe(2);

    const legs = await getFxLegLocks(env as any, "GT-HTLC-1");
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.state === "LOCKED")).toBe(true);
    expect(new Set(legs.map((l) => l.hashlock)).size).toBe(1); // shared hashlock
    // Upstream (payer, leg 0) timelock is later than downstream (payee, leg 1).
    expect(legs[0]!.timelock > legs[1]!.timelock).toBe(true);

    // Deferred settlement: no GTID yet.
    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-HTLC-1'`)
      .first();
    expect(gt).toBeNull();
    expect((await getFxTransfer(env as any, "GT-HTLC-1"))!.status).toBe("LOCKED");
    // No money has moved.
    expect(await balanceOf(d1, PAYER_ACC)).toBe(SEED_BAL);
  });
});

describe("claimFxTransfer", () => {
  it("settles all legs atomically when the secret is revealed", async () => {
    const { secret } = await lock("GT-HTLC-2");
    const res = await claimFxTransfer(env as any, "GT-HTLC-2", secret!);
    await drain(env);

    expect(res.status).toBe("SETTLED");
    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-HTLC-2'`)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SETTLED");

    const legs = await getFxLegLocks(env as any, "GT-HTLC-2");
    expect(legs.every((l) => l.state === "CLAIMED")).toBe(true);
    expect((await getFxTransfer(env as any, "GT-HTLC-2"))!.status).toBe("SETTLED");

    // Real customer balances moved (payer −JPY, payee +USD).
    expect(await balanceOf(d1, PAYER_ACC)).toBe(SEED_BAL - 500_000);
    expect(await balanceOf(d1, PAYEE_ACC)).toBe(SEED_BAL + 3_350);
  });

  it("rejects a wrong secret and settles nothing", async () => {
    await lock("GT-HTLC-3");
    const wrong = await sha256hex("not-the-secret");
    await expect(claimFxTransfer(env as any, "GT-HTLC-3", wrong)).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.reason_code === "PREIMAGE_MISMATCH"
    );
    const legs = await getFxLegLocks(env as any, "GT-HTLC-3");
    expect(legs.every((l) => l.state === "LOCKED")).toBe(true);
    expect(await balanceOf(d1, PAYER_ACC)).toBe(SEED_BAL);
  });

  it("is idempotent on a second claim", async () => {
    const { secret } = await lock("GT-HTLC-4");
    const first = await claimFxTransfer(env as any, "GT-HTLC-4", secret!);
    await drain(env);
    const second = await claimFxTransfer(env as any, "GT-HTLC-4", secret!);
    expect(first.already).toBe(false);
    expect(second.already).toBe(true);
    expect(second.status).toBe("SETTLED");
    expect(await balanceOf(d1, PAYER_ACC)).toBe(SEED_BAL - 500_000); // not double-debited
  });
});

describe("refundFxTransfer", () => {
  it("refunds all legs after the timelock and moves no money", async () => {
    await lock("GT-HTLC-5");
    const afterExpiry = new Date(
      Date.now() + FX_HTLC_BASE_TIMEOUT_MS + 3 * FX_HTLC_HOP_MARGIN_MS
    ).toISOString();
    const res = await refundFxTransfer(env as any, "GT-HTLC-5", afterExpiry);

    expect(res.status).toBe("REFUNDED");
    expect(res.refunded_legs).toBe(2);
    const legs = await getFxLegLocks(env as any, "GT-HTLC-5");
    expect(legs.every((l) => l.state === "REFUNDED")).toBe(true);
    expect((await getFxTransfer(env as any, "GT-HTLC-5"))!.status).toBe("REFUNDED");
    // No GTID, no money moved.
    expect(
      await d1.prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-HTLC-5'`).first()
    ).toBeNull();
    expect(await balanceOf(d1, PAYER_ACC)).toBe(SEED_BAL);
  });

  it("refuses to refund before the timelock expires", async () => {
    await lock("GT-HTLC-6");
    await expect(
      refundFxTransfer(env as any, "GT-HTLC-6", new Date().toISOString())
    ).rejects.toSatisfy((e: unknown) => isDomainError(e) && e.reason_code === "STATE_GUARD");
  });

  it("sweeps only expired, still-LOCKED transfers (cron path)", async () => {
    await lock("GT-SWEEP-A");
    await lock("GT-SWEEP-B");
    const { secret } = await lock("GT-SWEEP-C");
    await claimFxTransfer(env as any, "GT-SWEEP-C", secret!); // C is claimed, not sweepable
    await drain(env);

    // Before expiry: nothing swept.
    expect(await sweepExpiredFxLocks(env as any, new Date().toISOString())).toBe(0);

    const afterExpiry = new Date(
      Date.now() + FX_HTLC_BASE_TIMEOUT_MS + 3 * FX_HTLC_HOP_MARGIN_MS
    ).toISOString();
    expect(await sweepExpiredFxLocks(env as any, afterExpiry)).toBe(2); // A and B only

    expect(
      (await getFxLegLocks(env as any, "GT-SWEEP-A")).every((l) => l.state === "REFUNDED")
    ).toBe(true);
    expect(
      (await getFxLegLocks(env as any, "GT-SWEEP-B")).every((l) => l.state === "REFUNDED")
    ).toBe(true);
    expect(
      (await getFxLegLocks(env as any, "GT-SWEEP-C")).every((l) => l.state === "CLAIMED")
    ).toBe(true);

    // Idempotent: a second sweep refunds nothing more.
    expect(await sweepExpiredFxLocks(env as any, afterExpiry)).toBe(0);
  });

  it("cannot refund a claimed transfer, nor claim a refunded one", async () => {
    const { secret } = await lock("GT-HTLC-7");
    await claimFxTransfer(env as any, "GT-HTLC-7", secret!);
    await drain(env);
    const afterExpiry = new Date(
      Date.now() + FX_HTLC_BASE_TIMEOUT_MS + 3 * FX_HTLC_HOP_MARGIN_MS
    ).toISOString();
    await expect(refundFxTransfer(env as any, "GT-HTLC-7", afterExpiry)).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.reason_code === "STATE_GUARD"
    );

    const { secret: s8 } = await lock("GT-HTLC-8");
    await refundFxTransfer(env as any, "GT-HTLC-8", afterExpiry);
    await expect(claimFxTransfer(env as any, "GT-HTLC-8", s8!)).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.reason_code === "FX_ALREADY_REFUNDED"
    );
  });
});

// ---------------------------------------------------------------------------
// SETTLING is bounded: the CAS gate that makes claim and refund mutually
// exclusive also creates a window where neither can happen. Both halves below —
// refusing to open a settlement that cannot finish, and converging one that did
// not — fail against a build without them.
// ---------------------------------------------------------------------------
describe("SETTLING is bounded (第3の所定時間)", () => {
  it("settlingDeadline takes the earlier of the fixed bound and one hop before the upstream timelock", () => {
    const t0 = "2026-01-01T00:00:00.000Z";
    // Upstream timelock far out ⇒ the 6h bound binds.
    const farTimelock = new Date(Date.parse(t0) + 72 * 3600_000).toISOString();
    expect(settlingDeadline(t0, farTimelock)).toBe(
      new Date(Date.parse(t0) + FX_SETTLING_TIMEOUT_MS).toISOString()
    );
    // Upstream timelock close ⇒ (timelock − hop margin) binds instead.
    const nearTimelock = new Date(Date.parse(t0) + 13 * 3600_000).toISOString();
    expect(settlingDeadline(t0, nearTimelock)).toBe(
      new Date(Date.parse(nearTimelock) - FX_HTLC_HOP_MARGIN_MS).toISOString()
    );
  });

  it("refuses a claim with too little time left and takes the cancel side instead", async () => {
    const { secret } = await lock("GT-SETTLING-1");
    // Pull every leg's timelock inside one hop margin of now: settlement started
    // here could not finish before the upstream leg becomes unclaimable.
    const soon = new Date(Date.now() + 60_000).toISOString();
    await d1
      .prepare(`UPDATE FxLegLocks SET timelock=? WHERE gtid='GT-SETTLING-1'`)
      .bind(soon)
      .run();

    await expect(claimFxTransfer(env as any, "GT-SETTLING-1", secret!)).rejects.toSatisfy(
      (e: unknown) => isDomainError(e) && e.reason_code === "FX_CLAIM_WINDOW_EXPIRED"
    );

    // Cancel side taken: refunded, never parked in SETTLING, no money moved.
    expect((await getFxTransfer(env as any, "GT-SETTLING-1"))!.status).toBe("REFUNDED");
    expect(
      (await getFxLegLocks(env as any, "GT-SETTLING-1")).every((l) => l.state === "REFUNDED")
    ).toBe(true);
    expect(await balanceOf(d1, PAYER_ACC)).toBe(SEED_BAL);
  });

  it("converges a transfer stranded in SETTLING to GT_SUSPENDED + a CASE", async () => {
    const { secret } = await lock("GT-SETTLING-2");
    await claimFxTransfer(env as any, "GT-SETTLING-2", secret!);
    await drain(env);

    // Re-create the crash-mid-claim shape: the gate was taken and the legs
    // cascaded to CLAIMED, but the saga never reached SETTLED. sweepExpiredFxLocks
    // cannot see this — its filter is `FxLegLocks.state='LOCKED'`.
    const stuckSince = new Date(Date.now() - 7 * 3600_000).toISOString();
    await d1
      .prepare(`UPDATE FxTransfers SET status='SETTLING', updated_at=? WHERE gtid='GT-SETTLING-2'`)
      .bind(stuckSince)
      .run();
    await d1
      .prepare(
        `UPDATE GtidTransactions SET state='GT_DECIDED_TO_SETTLE' WHERE gtid='GT-SETTLING-2'`
      )
      .run();

    const now = new Date().toISOString();
    expect(await sweepExpiredFxLocks(env as any, now)).toBe(0); // invisible to the LOCKED sweep
    expect(await sweepStuckFxSettling(env as any, now)).toBe(1);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid='GT-SETTLING-2'`)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SUSPENDED");
    const c = await d1
      .prepare(`SELECT reason_code, state FROM Cases WHERE related_gtid='GT-SETTLING-2'`)
      .first<{ reason_code: string; state: string }>();
    expect(c?.reason_code).toBe("FX_SETTLING_STUCK");
    expect(c?.state).toBe("OPEN");

    // Idempotent: an open CASE for the same condition is not duplicated.
    expect(await sweepStuckFxSettling(env as any, now)).toBe(0);
  });

  it("leaves a SETTLING transfer alone before its deadline", async () => {
    const { secret } = await lock("GT-SETTLING-3");
    await claimFxTransfer(env as any, "GT-SETTLING-3", secret!);
    await drain(env);
    await d1
      .prepare(`UPDATE FxTransfers SET status='SETTLING', updated_at=? WHERE gtid='GT-SETTLING-3'`)
      .bind(new Date().toISOString())
      .run();

    expect(await sweepStuckFxSettling(env as any, new Date().toISOString())).toBe(0);
  });
});
