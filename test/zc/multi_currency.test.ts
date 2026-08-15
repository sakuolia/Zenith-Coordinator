/**
 * @file Multi-currency / international interoperability tests
 *       (Theme D).
 *
 * Covers:
 * - reserveH/releaseH/getHStatus for a non-JPY currency, backed by
 *   ParticipantCurrencyLimits (independent from Participants.h_limit/h_used)
 * - H_LIMIT_EXCEEDED when no ParticipantCurrencyLimits row exists
 * - registerGtid persists leg_currency (default 'JPY' for legacy requests,
 *   explicit currency otherwise)
 * - validateGtidRegister rejects an unsupported leg currency
 * - PvP as a 4-leg GTID (2 currencies): GT_DECIDED_TO_SETTLE with per-currency
 *   H reservations and per-currency DNS cycle assignment (DNS-JPY-* / DNS-USD-*)
 * - AMOUNT_BALANCE_MISMATCH still fires for a per-currency-group mismatch
 * - existing single-currency GTID flows are unaffected (leg_currency='JPY')
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { registerGtid, advanceGtid } from "../../src/zc/lanes/gtid";
import { reserveH, releaseH, getHStatus } from "../../src/zc/liquidity/h_model";
import { validateGtidRegister } from "../../src/shared/validator";

function makeEnv(db: MockD1Database): any {
  return {
    DB: db,
    QUEUE: { send: async () => {} },
    ZC_HMAC_SECRET: "test-secret",
  };
}

const BANK_A = "001";
const BANK_B = "002";
const ACCOUNT_A = "0010000001";
const ACCOUNT_B = "0020000001";
const ACCOUNT_A2 = "0010000002";
const ACCOUNT_B2 = "0020000002";
const H_LIMIT = 1_000_000;

let d1: MockD1Database;

function seedParticipant(db: MockD1Database, bankId: string, hLimit = H_LIMIT) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', ?, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId, hLimit)
    ._runSync();
}

function seedCurrencyLimit(db: MockD1Database, bankId: string, currency: string, hLimit: number) {
  db.prepare(
    `INSERT OR REPLACE INTO ParticipantCurrencyLimits (bank_id, currency, h_limit, h_used)
     VALUES (?, ?, ?, 0)`
  )
    .bind(bankId, currency, hLimit)
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

function seedAccount(db: MockD1Database, bankId: string, accountId: string, balance = 500_000) {
  db.prepare(
    `INSERT OR IGNORE INTO BankAccounts
     (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
     VALUES (?, ?, ?, 'Test User', 'SAVINGS', 'NORMAL', '2025-01-01T00:00:00Z')`
  )
    .bind(accountId, bankId, `CUST-${accountId}`)
    ._runSync();

  if (balance > 0) {
    db.prepare(
      `INSERT INTO BankJournals
       (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES (?, ?, ?, ?, 'CASH', 'INIT', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(`JNL-INIT-${accountId}`, bankId, accountId, balance)
      ._runSync();
    db.prepare(
      `INSERT INTO BankJournals
       (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES (?, ?, ?, ?, 'CASH', 'INIT', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(`JNL-INIT-ZCS-${accountId}`, bankId, `${bankId}-ZCS`, -balance)
      ._runSync();
  }
}

function makeTwoLegRequest(gtid: string, amount = 100_000, currency = "JPY") {
  return {
    gtid,
    expires_at: "2099-12-31T00:00:00Z",
    legs: [
      {
        leg_id: `${gtid}-LEG-PAYER`,
        role: "PAYER" as const,
        bank_id: BANK_A,
        account_hash: ACCOUNT_A,
        amount: { value: amount, currency },
      },
      {
        leg_id: `${gtid}-LEG-PAYEE`,
        role: "PAYEE" as const,
        bank_id: BANK_B,
        account_hash: ACCOUNT_B,
        amount: { value: amount, currency },
      },
    ],
  };
}

/** Build a 4-leg PvP GTID: JPY leg pair (A payer→B payee) + USD leg pair (B payer→A payee). */
function makePvpRequest(gtid: string, jpyAmount = 100_000, usdAmount = 1_000) {
  return {
    gtid,
    expires_at: "2099-12-31T00:00:00Z",
    idempotency_key: `IDEM-${gtid}`,
    legs: [
      {
        leg_id: `${gtid}-LEG-JPY-PAYER`,
        role: "PAYER" as const,
        bank_id: BANK_A,
        account_hash: ACCOUNT_A,
        amount: { value: jpyAmount, currency: "JPY" },
      },
      {
        leg_id: `${gtid}-LEG-JPY-PAYEE`,
        role: "PAYEE" as const,
        bank_id: BANK_B,
        account_hash: ACCOUNT_B,
        amount: { value: jpyAmount, currency: "JPY" },
      },
      {
        leg_id: `${gtid}-LEG-USD-PAYER`,
        role: "PAYER" as const,
        bank_id: BANK_B,
        account_hash: ACCOUNT_B2,
        amount: { value: usdAmount, currency: "USD" },
      },
      {
        leg_id: `${gtid}-LEG-USD-PAYEE`,
        role: "PAYEE" as const,
        bank_id: BANK_A,
        account_hash: ACCOUNT_A2,
        amount: { value: usdAmount, currency: "USD" },
      },
    ],
  };
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  seedParticipant(d1, BANK_A);
  seedParticipant(d1, BANK_B);
  seedAccount(d1, BANK_A, ACCOUNT_A);
  seedAccount(d1, BANK_B, ACCOUNT_B);
  seedAccount(d1, BANK_A, ACCOUNT_A2);
  seedAccount(d1, BANK_B, ACCOUNT_B2);
  // BANK_B's USD payer leg (ACCOUNT_B2) pays USD, so it must hold USD prefunding
  // — the leg-ready funds check is now scoped to the leg's currency.
  seedCcyBalance(d1, BANK_B, ACCOUNT_B2, 1_000_000, "USD");
});

// ---------------------------------------------------------------------------
// h_model: non-JPY currency support
// ---------------------------------------------------------------------------

describe("reserveH / releaseH / getHStatus — non-JPY currency", () => {
  it("returns H_LIMIT_EXCEEDED with zero limit when no ParticipantCurrencyLimits row exists", async () => {
    const result = await reserveH(BANK_A, "TX-USD-001", 1_000, d1, "USD");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("H_LIMIT_EXCEEDED");
      if (result.reason === "H_LIMIT_EXCEEDED") {
        expect(result.h_limit).toBe(0);
        expect(result.available).toBe(0);
      }
    }
  });

  it("reserves against ParticipantCurrencyLimits without touching Participants.h_used", async () => {
    seedCurrencyLimit(d1, BANK_A, "USD", 10_000);

    const result = await reserveH(BANK_A, "TX-USD-002", 1_000, d1, "USD");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.h_used_after).toBe(1_000);
      expect(result.h_limit).toBe(10_000);
    }

    // JPY h_used on Participants is untouched
    const jpyStatus = await getHStatus(BANK_A, d1);
    expect(jpyStatus?.h_used).toBe(0);

    const usdStatus = await getHStatus(BANK_A, d1, "USD");
    expect(usdStatus?.h_used).toBe(1_000);
    expect(usdStatus?.h_limit).toBe(10_000);
  });

  it("rejects reservation exceeding the USD limit", async () => {
    seedCurrencyLimit(d1, BANK_A, "USD", 500);

    const result = await reserveH(BANK_A, "TX-USD-003", 1_000, d1, "USD");
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "H_LIMIT_EXCEEDED") {
      expect(result.h_limit).toBe(500);
      expect(result.available).toBe(500);
    }
  });

  it("releaseH credits back ParticipantCurrencyLimits.h_used for a non-JPY reservation", async () => {
    seedCurrencyLimit(d1, BANK_A, "USD", 10_000);

    const result = await reserveH(BANK_A, "TX-USD-004", 1_000, d1, "USD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const released = await releaseH(result.reservation_id, d1);
    expect(released).toBe(true);

    const usdStatus = await getHStatus(BANK_A, d1, "USD");
    expect(usdStatus?.h_used).toBe(0);
  });

  it("getHStatus returns null for a currency with no ParticipantCurrencyLimits row", async () => {
    const status = await getHStatus(BANK_A, d1, "EUR");
    expect(status).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateGtidRegister: currency allowlist
// ---------------------------------------------------------------------------

describe("validateGtidRegister — leg currency", () => {
  it("accepts JPY and USD leg currencies", () => {
    const result = validateGtidRegister(makePvpRequest("GT-VAL-001") as any);
    expect(result.ok).toBe(true);
  });

  it("rejects an unsupported leg currency", () => {
    const req = makeTwoLegRequest("GT-VAL-002", 1_000, "XYZ") as any;
    req.idempotency_key = "IDEM-VAL-002";
    const result = validateGtidRegister(req);
    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe("INVALID_CURRENCY");
  });
});

// ---------------------------------------------------------------------------
// registerGtid: leg_currency persistence
// ---------------------------------------------------------------------------

describe("registerGtid — leg_currency persistence", () => {
  it("defaults leg_currency to JPY for a legacy two-leg request", async () => {
    await registerGtid(makeTwoLegRequest("GT-CCY-001") as any, makeEnv(d1));

    const legs = await d1
      .prepare(`SELECT leg_id, leg_currency FROM GtidLegs WHERE gtid=? ORDER BY leg_id`)
      .bind("GT-CCY-001")
      .all<{ leg_id: string; leg_currency: string }>();
    expect(legs.results).toHaveLength(2);
    for (const leg of legs.results) {
      expect(leg.leg_currency).toBe("JPY");
    }
  });

  it("persists per-leg currency for a PvP (multi-currency) request", async () => {
    await registerGtid(makePvpRequest("GT-CCY-002") as any, makeEnv(d1));

    const legs = await d1
      .prepare(`SELECT leg_id, leg_currency FROM GtidLegs WHERE gtid=? ORDER BY leg_id`)
      .bind("GT-CCY-002")
      .all<{ leg_id: string; leg_currency: string }>();
    const byId = Object.fromEntries(legs.results.map((l) => [l.leg_id, l.leg_currency]));
    expect(byId["GT-CCY-002-LEG-JPY-PAYER"]).toBe("JPY");
    expect(byId["GT-CCY-002-LEG-JPY-PAYEE"]).toBe("JPY");
    expect(byId["GT-CCY-002-LEG-USD-PAYER"]).toBe("USD");
    expect(byId["GT-CCY-002-LEG-USD-PAYEE"]).toBe("USD");
  });
});

// ---------------------------------------------------------------------------
// advanceGtid: PvP (4-leg, 2-currency GTID)
// ---------------------------------------------------------------------------

describe("advanceGtid — PvP (multi-currency GTID)", () => {
  it("decides to settle with per-currency H reservations and DNS cycles", async () => {
    seedCurrencyLimit(d1, BANK_B, "USD", 10_000);

    await registerGtid(makePvpRequest("GT-PVP-001") as any, makeEnv(d1));
    await advanceGtid("GT-PVP-001", makeEnv(d1));

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-PVP-001")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_DECIDED_TO_SETTLE");

    // BANK_A reserved H in JPY (its PAYER leg)
    const jpyStatus = await getHStatus(BANK_A, d1);
    expect(jpyStatus?.h_used).toBe(100_000);

    // BANK_B reserved H in USD (its PAYER leg), JPY untouched
    const usdStatus = await getHStatus(BANK_B, d1, "USD");
    expect(usdStatus?.h_used).toBe(1_000);
    const bankBJpyStatus = await getHStatus(BANK_B, d1);
    expect(bankBJpyStatus?.h_used).toBe(0);

    // Per-currency DNS cycles
    const jpyTx = await d1
      .prepare(`SELECT dns_cycle_id, amount_currency FROM Transactions WHERE txid=?`)
      .bind("TX-GT-GT-PVP-001-LEG-JPY-PAYER")
      .first<{ dns_cycle_id: string; amount_currency: string }>();
    const usdTx = await d1
      .prepare(`SELECT dns_cycle_id, amount_currency FROM Transactions WHERE txid=?`)
      .bind("TX-GT-GT-PVP-001-LEG-USD-PAYER")
      .first<{ dns_cycle_id: string; amount_currency: string }>();

    expect(jpyTx?.amount_currency).toBe("JPY");
    expect(usdTx?.amount_currency).toBe("USD");
    expect(jpyTx?.dns_cycle_id).toMatch(/^DNS-/);
    expect(usdTx?.dns_cycle_id).toMatch(/^DNS-USD-/);
    expect(jpyTx?.dns_cycle_id).not.toBe(usdTx?.dns_cycle_id);
  });

  it("cancels when USD H limit is insufficient", async () => {
    // No ParticipantCurrencyLimits row for BANK_B/USD → H_LIMIT_EXCEEDED
    await registerGtid(makePvpRequest("GT-PVP-002") as any, makeEnv(d1));
    await advanceGtid("GT-PVP-002", makeEnv(d1));

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-PVP-002")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_CANCELLED");
  });

  it("cancels with AMOUNT_BALANCE_MISMATCH when one currency group is unbalanced", async () => {
    seedCurrencyLimit(d1, BANK_B, "USD", 10_000);

    const req = makePvpRequest("GT-PVP-003");
    // Make the USD payee leg amount differ from the USD payer leg amount
    req.legs[3]!.amount.value = 999;

    await registerGtid(req as any, makeEnv(d1));
    await advanceGtid("GT-PVP-003", makeEnv(d1));

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-PVP-003")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_CANCELLED");

    const log = await d1
      .prepare(
        `SELECT payload_json FROM FinalityLog WHERE event_type='GtidDecidedCancel' AND gtid=? ORDER BY event_seq DESC LIMIT 1`
      )
      .bind("GT-PVP-003")
      .first<{ payload_json: string }>();
    const payload = JSON.parse(log!.payload_json);
    expect(payload.reason).toBe("AMOUNT_BALANCE_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// Regression: existing single-currency GTID flow unaffected
// ---------------------------------------------------------------------------

describe("advanceGtid — single-currency regression", () => {
  it("still settles a plain JPY two-leg GTID", async () => {
    await registerGtid(makeTwoLegRequest("GT-CCY-REG-001") as any, makeEnv(d1));
    await advanceGtid("GT-CCY-REG-001", makeEnv(d1));

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-CCY-REG-001")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_DECIDED_TO_SETTLE");

    const jpyStatus = await getHStatus(BANK_A, d1);
    expect(jpyStatus?.h_used).toBe(100_000);
  });
});
