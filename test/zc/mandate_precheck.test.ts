/**
 * @file Mandate precheck wiring (Theme B, Agentic Commerce).
 *
 * Covers: EXPRESS (processExpress) and STANDARD (advanceStandard) honoring
 * an optional `Transactions.mandate_id` —
 *   - a valid mandate within scope proceeds normally (no suspension)
 *   - MANDATE_BREACH (amount / purpose / lane out of scope)
 *   - MANDATE_EXPIRED / MANDATE_REVOKED / MANDATE_NOT_FOUND
 * all route to PRECHECKED_SUSPENDED + a Case carrying the mandate
 * reason_code, instead of a hard DECIDED_CANCEL rejection.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { processExpress, resumeSuspendedExpress } from "../../src/zc/lanes/express";
import { advanceStandard, resumeFromNameCheckSuspended } from "../../src/zc/lanes/standard";
import { advanceHighValue } from "../../src/zc/lanes/highvalue";
import { advanceBulk } from "../../src/zc/lanes/bulk";
import { createHtlc, lockHtlc } from "../../src/zc/lanes/htlc";
import { registerGtid, advanceGtid } from "../../src/zc/lanes/gtid";
import type { PaymentInitiatedRequest } from "../../src/types";

function makeEnv(db: MockD1Database): any {
  return {
    DB: db,
    QUEUE: { send: async () => {} },
    ZC_HMAC_SECRET: "test-secret",
  };
}

const PAYER_BANK = "001";
const PAYEE_BANK = "002";
const PAYER_ACCOUNT = "0010000001";
const PAYEE_ACCOUNT = "0020000001";
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

function insertMandate(
  db: MockD1Database,
  opts: {
    mandateId: string;
    maxAmount?: number | null;
    allowedPurposes?: string[] | null;
    allowedLanes?: string[] | null;
    validFrom?: string;
    validTo?: string;
    revokedAt?: string | null;
  }
) {
  const {
    mandateId,
    maxAmount = null,
    allowedPurposes = null,
    allowedLanes = null,
    validFrom = "2025-01-01T00:00:00.000Z",
    validTo = "2030-01-01T00:00:00.000Z",
    revokedAt = null,
  } = opts;
  db.prepare(
    `INSERT INTO Mandate
     (mandate_id, principal_participant_id, grantee_ref, parent_mandate_id, max_amount,
      allowed_purposes, allowed_lanes, valid_from, valid_to, principal_key_id, signature,
      nonce, occurred_at, revoked_at, created_at)
     VALUES (?, 'principal-001', 'agent-001', NULL, ?, ?, ?, ?, ?, 'KEY-1', 'sig', 'nonce', ?, ?, ?)`
  )
    .bind(
      mandateId,
      maxAmount,
      allowedPurposes ? JSON.stringify(allowedPurposes) : null,
      allowedLanes ? JSON.stringify(allowedLanes) : null,
      validFrom,
      validTo,
      validFrom,
      revokedAt,
      validFrom
    )
    ._runSync();
}

function insertExpressTx(db: MockD1Database, txid: string, mandateId: string | null) {
  db.prepare(
    `INSERT OR IGNORE INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      purpose, idempotency_key, schema_version, mandate_id, created_at, updated_at, version)
     VALUES (?, 'EXPRESS', 'RECEIVED', 100000, 'JPY', ?, ?, ?, ?,
             'P2P', ?, '1.0', ?, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 0)`
  )
    .bind(txid, PAYER_BANK, PAYER_ACCOUNT, PAYEE_BANK, PAYEE_ACCOUNT, `IK-${txid}`, mandateId)
    ._runSync();
}

function insertStandardTx(db: MockD1Database, txid: string, mandateId: string | null) {
  db.prepare(
    `INSERT OR IGNORE INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      purpose, idempotency_key, schema_version, mandate_id, created_at, updated_at, version)
     VALUES (?, 'STANDARD', 'RECEIVED', 100000, 'JPY', ?, ?, ?, ?,
             'P2P', ?, '1.0', ?, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 0)`
  )
    .bind(txid, PAYER_BANK, PAYER_ACCOUNT, PAYEE_BANK, PAYEE_ACCOUNT, `IK-${txid}`, mandateId)
    ._runSync();
}

function insertLaneTx(
  db: MockD1Database,
  txid: string,
  lane: string,
  mandateId: string | null,
  amount = 100_000
) {
  db.prepare(
    `INSERT OR IGNORE INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      purpose, idempotency_key, schema_version, mandate_id, created_at, updated_at, version)
     VALUES (?, ?, 'RECEIVED', ?, 'JPY', ?, ?, ?, ?,
             'P2P', ?, '1.0', ?, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 0)`
  )
    .bind(
      txid,
      lane,
      amount,
      PAYER_BANK,
      PAYER_ACCOUNT,
      PAYEE_BANK,
      PAYEE_ACCOUNT,
      `IK-${txid}`,
      mandateId
    )
    ._runSync();
}

function makeExpressReq(txid: string, mandateId?: string): PaymentInitiatedRequest {
  return {
    schema_version: "1.0",
    message_type: "EVENT",
    name: "PaymentInitiated",
    message_id: `MSG-${txid}`,
    idempotency_key: `IK-${txid}`,
    occurred_at: "2025-06-01T10:00:00Z",
    txid,
    lane: "EXPRESS",
    amount: { value: 100_000, currency: "JPY" },
    payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACCOUNT },
    payee: { bank_id: PAYEE_BANK, account_hash: PAYEE_ACCOUNT },
    purpose: "P2P",
    mandate_id: mandateId,
  };
}

async function getTx(db: MockD1Database, txid: string) {
  return db
    .prepare(`SELECT state, reason_code, case_id FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: string; reason_code: string | null; case_id: string | null }>();
}

async function getCase(db: MockD1Database, txid: string) {
  return db
    .prepare(`SELECT case_id, reason_code, state FROM Cases WHERE related_txid = ?`)
    .bind(txid)
    .first<{ case_id: string; reason_code: string; state: string }>();
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  seedParticipant(d1, PAYER_BANK);
  seedParticipant(d1, PAYEE_BANK);
  seedAccount(d1, PAYER_BANK, PAYER_ACCOUNT);
  seedAccount(d1, PAYEE_BANK, PAYEE_ACCOUNT);
});

// ---------------------------------------------------------------------------
// EXPRESS
// ---------------------------------------------------------------------------

describe("processExpress — mandate precheck", () => {
  it("no mandate_id: proceeds normally (unchanged behavior)", async () => {
    const txid = "TX-MND-EXP-NONE";
    insertExpressTx(d1, txid, null);
    const result = await processExpress(makeExpressReq(txid), makeEnv(d1));
    expect(result.result).toBe("DECISION_ACCEPTED");
    expect(result.state).toBe("DECIDED_TO_SETTLE");
  });

  it("valid mandate within scope: proceeds to DECIDED_TO_SETTLE", async () => {
    const txid = "TX-MND-EXP-OK";
    const mandateId = "MANDATE-OK-1";
    insertMandate(d1, {
      mandateId,
      maxAmount: 200_000,
      allowedPurposes: ["P2P"],
      allowedLanes: ["EXPRESS"],
    });
    insertExpressTx(d1, txid, mandateId);
    const result = await processExpress(makeExpressReq(txid, mandateId), makeEnv(d1));
    expect(result.result).toBe("DECISION_ACCEPTED");
    expect(result.state).toBe("DECIDED_TO_SETTLE");
  });

  it("MANDATE_BREACH (amount exceeds max_amount): PRECHECKED_SUSPENDED + Case", async () => {
    const txid = "TX-MND-EXP-AMT";
    const mandateId = "MANDATE-AMT-1";
    insertMandate(d1, { mandateId, maxAmount: 1_000 }); // tx amount is 100,000
    insertExpressTx(d1, txid, mandateId);
    const result = await processExpress(makeExpressReq(txid, mandateId), makeEnv(d1));

    expect(result.result).toBe("DECISION_REJECTED");
    expect(result.state).toBe("PRECHECKED_SUSPENDED");
    expect(result.reason_code).toBe("MANDATE_BREACH");

    const tx = await getTx(d1, txid);
    expect(tx?.state).toBe("PRECHECKED_SUSPENDED");
    expect(tx?.reason_code).toBe("MANDATE_BREACH");

    const c = await getCase(d1, txid);
    expect(c?.reason_code).toBe("MANDATE_BREACH");
    expect(c?.state).toBe("OPEN");
  });

  it("MANDATE_BREACH (purpose not allowed): PRECHECKED_SUSPENDED + Case", async () => {
    const txid = "TX-MND-EXP-PURPOSE";
    const mandateId = "MANDATE-PURPOSE-1";
    insertMandate(d1, { mandateId, allowedPurposes: ["BILL"] }); // tx purpose is P2P
    insertExpressTx(d1, txid, mandateId);
    const result = await processExpress(makeExpressReq(txid, mandateId), makeEnv(d1));

    expect(result.result).toBe("DECISION_REJECTED");
    expect(result.state).toBe("PRECHECKED_SUSPENDED");
    expect(result.reason_code).toBe("MANDATE_BREACH");
  });

  it("MANDATE_BREACH (lane not allowed): PRECHECKED_SUSPENDED + Case", async () => {
    const txid = "TX-MND-EXP-LANE";
    const mandateId = "MANDATE-LANE-1";
    insertMandate(d1, { mandateId, allowedLanes: ["STANDARD"] }); // tx lane is EXPRESS
    insertExpressTx(d1, txid, mandateId);
    const result = await processExpress(makeExpressReq(txid, mandateId), makeEnv(d1));

    expect(result.result).toBe("DECISION_REJECTED");
    expect(result.state).toBe("PRECHECKED_SUSPENDED");
    expect(result.reason_code).toBe("MANDATE_BREACH");
  });

  it("MANDATE_EXPIRED: PRECHECKED_SUSPENDED + Case", async () => {
    const txid = "TX-MND-EXP-EXPIRED";
    const mandateId = "MANDATE-EXPIRED-1";
    insertMandate(d1, {
      mandateId,
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2021-01-01T00:00:00.000Z",
    });
    insertExpressTx(d1, txid, mandateId);
    const result = await processExpress(makeExpressReq(txid, mandateId), makeEnv(d1));

    expect(result.result).toBe("DECISION_REJECTED");
    expect(result.state).toBe("PRECHECKED_SUSPENDED");
    expect(result.reason_code).toBe("MANDATE_EXPIRED");

    const c = await getCase(d1, txid);
    expect(c?.reason_code).toBe("MANDATE_EXPIRED");
  });

  it("MANDATE_REVOKED: PRECHECKED_SUSPENDED + Case", async () => {
    const txid = "TX-MND-EXP-REVOKED";
    const mandateId = "MANDATE-REVOKED-1";
    insertMandate(d1, { mandateId, revokedAt: "2024-01-01T00:00:00.000Z" });
    insertExpressTx(d1, txid, mandateId);
    const result = await processExpress(makeExpressReq(txid, mandateId), makeEnv(d1));

    expect(result.result).toBe("DECISION_REJECTED");
    expect(result.state).toBe("PRECHECKED_SUSPENDED");
    expect(result.reason_code).toBe("MANDATE_REVOKED");

    const c = await getCase(d1, txid);
    expect(c?.reason_code).toBe("MANDATE_REVOKED");
  });

  it("MANDATE_NOT_FOUND: PRECHECKED_SUSPENDED + Case", async () => {
    const txid = "TX-MND-EXP-NOTFOUND";
    const mandateId = "MANDATE-DOES-NOT-EXIST";
    insertExpressTx(d1, txid, mandateId);
    const result = await processExpress(makeExpressReq(txid, mandateId), makeEnv(d1));

    expect(result.result).toBe("DECISION_REJECTED");
    expect(result.state).toBe("PRECHECKED_SUSPENDED");
    expect(result.reason_code).toBe("MANDATE_NOT_FOUND");

    const c = await getCase(d1, txid);
    expect(c?.reason_code).toBe("MANDATE_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// STANDARD
// ---------------------------------------------------------------------------

describe("advanceStandard — mandate precheck", () => {
  it("no mandate_id: proceeds normally to H_RESERVED", async () => {
    const txid = "TX-MND-STD-NONE";
    insertStandardTx(d1, txid, null);
    await advanceStandard(txid, makeEnv(d1));

    const tx = await getTx(d1, txid);
    expect(tx?.state).toBe("H_RESERVED");
  });

  it("valid mandate within scope: proceeds to H_RESERVED", async () => {
    const txid = "TX-MND-STD-OK";
    const mandateId = "MANDATE-STD-OK-1";
    insertMandate(d1, {
      mandateId,
      maxAmount: 200_000,
      allowedPurposes: ["P2P"],
      allowedLanes: ["STANDARD"],
    });
    insertStandardTx(d1, txid, mandateId);
    await advanceStandard(txid, makeEnv(d1));

    const tx = await getTx(d1, txid);
    expect(tx?.state).toBe("H_RESERVED");
  });

  it("MANDATE_BREACH (amount exceeds max_amount): PRECHECKED_SUSPENDED + Case", async () => {
    const txid = "TX-MND-STD-AMT";
    const mandateId = "MANDATE-STD-AMT-1";
    insertMandate(d1, { mandateId, maxAmount: 1_000 }); // tx amount is 100,000
    insertStandardTx(d1, txid, mandateId);
    await advanceStandard(txid, makeEnv(d1));

    const tx = await getTx(d1, txid);
    expect(tx?.state).toBe("PRECHECKED_SUSPENDED");
    expect(tx?.reason_code).toBe("MANDATE_BREACH");

    const c = await getCase(d1, txid);
    expect(c?.reason_code).toBe("MANDATE_BREACH");
    expect(c?.state).toBe("OPEN");
  });

  it("MANDATE_EXPIRED: PRECHECKED_SUSPENDED + Case", async () => {
    const txid = "TX-MND-STD-EXPIRED";
    const mandateId = "MANDATE-STD-EXPIRED-1";
    insertMandate(d1, {
      mandateId,
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2021-01-01T00:00:00.000Z",
    });
    insertStandardTx(d1, txid, mandateId);
    await advanceStandard(txid, makeEnv(d1));

    const tx = await getTx(d1, txid);
    expect(tx?.state).toBe("PRECHECKED_SUSPENDED");
    expect(tx?.reason_code).toBe("MANDATE_EXPIRED");
  });

  it("MANDATE_REVOKED: PRECHECKED_SUSPENDED + Case", async () => {
    const txid = "TX-MND-STD-REVOKED";
    const mandateId = "MANDATE-STD-REVOKED-1";
    insertMandate(d1, { mandateId, revokedAt: "2024-01-01T00:00:00.000Z" });
    insertStandardTx(d1, txid, mandateId);
    await advanceStandard(txid, makeEnv(d1));

    const tx = await getTx(d1, txid);
    expect(tx?.state).toBe("PRECHECKED_SUSPENDED");
    expect(tx?.reason_code).toBe("MANDATE_REVOKED");
  });

  it("MANDATE_NOT_FOUND: PRECHECKED_SUSPENDED + Case", async () => {
    const txid = "TX-MND-STD-NOTFOUND";
    const mandateId = "MANDATE-STD-DOES-NOT-EXIST";
    insertStandardTx(d1, txid, mandateId);
    await advanceStandard(txid, makeEnv(d1));

    const tx = await getTx(d1, txid);
    expect(tx?.state).toBe("PRECHECKED_SUSPENDED");
    expect(tx?.reason_code).toBe("MANDATE_NOT_FOUND");

    const c = await getCase(d1, txid);
    expect(c?.reason_code).toBe("MANDATE_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// HIGH_VALUE — mandate was previously unenforced on this lane (over-limit
// large-value instructions settled outside their delegated authority).
// ---------------------------------------------------------------------------

describe("advanceHighValue — mandate precheck", () => {
  it("no mandate_id: proceeds normally to DECIDED_TO_SETTLE", async () => {
    const txid = "TX-MND-HV-NONE";
    insertLaneTx(d1, txid, "HIGH_VALUE", null);
    await advanceHighValue(txid, makeEnv(d1));
    expect((await getTx(d1, txid))?.state).toBe("DECIDED_TO_SETTLE");
  });

  it("valid mandate within scope: proceeds to DECIDED_TO_SETTLE", async () => {
    const txid = "TX-MND-HV-OK";
    const mandateId = "MANDATE-HV-OK-1";
    insertMandate(d1, {
      mandateId,
      maxAmount: 200_000,
      allowedPurposes: ["P2P"],
      allowedLanes: ["HIGH_VALUE"],
    });
    insertLaneTx(d1, txid, "HIGH_VALUE", mandateId);
    await advanceHighValue(txid, makeEnv(d1));
    expect((await getTx(d1, txid))?.state).toBe("DECIDED_TO_SETTLE");
  });

  it("MANDATE_BREACH (amount exceeds max_amount): PRECHECKED_SUSPENDED + Case, not settled", async () => {
    const txid = "TX-MND-HV-AMT";
    const mandateId = "MANDATE-HV-AMT-1";
    insertMandate(d1, { mandateId, maxAmount: 1_000 }); // tx amount is 100,000
    insertLaneTx(d1, txid, "HIGH_VALUE", mandateId);
    await advanceHighValue(txid, makeEnv(d1));

    const tx = await getTx(d1, txid);
    expect(tx?.state).toBe("PRECHECKED_SUSPENDED");
    expect(tx?.reason_code).toBe("MANDATE_BREACH");
    const c = await getCase(d1, txid);
    expect(c?.reason_code).toBe("MANDATE_BREACH");
    expect(c?.state).toBe("OPEN");
  });

  it("MANDATE_BREACH (lane not allowed): a mandate scoped to EXPRESS cannot settle via HIGH_VALUE", async () => {
    const txid = "TX-MND-HV-LANE";
    const mandateId = "MANDATE-HV-LANE-1";
    insertMandate(d1, { mandateId, allowedLanes: ["EXPRESS"] });
    insertLaneTx(d1, txid, "HIGH_VALUE", mandateId);
    await advanceHighValue(txid, makeEnv(d1));

    const tx = await getTx(d1, txid);
    expect(tx?.state).toBe("PRECHECKED_SUSPENDED");
    expect(tx?.reason_code).toBe("MANDATE_BREACH");
  });

  it("MANDATE_REVOKED: PRECHECKED_SUSPENDED, not settled", async () => {
    const txid = "TX-MND-HV-REVOKED";
    const mandateId = "MANDATE-HV-REVOKED-1";
    insertMandate(d1, { mandateId, revokedAt: "2024-01-01T00:00:00.000Z" });
    insertLaneTx(d1, txid, "HIGH_VALUE", mandateId);
    await advanceHighValue(txid, makeEnv(d1));
    expect((await getTx(d1, txid))?.state).toBe("PRECHECKED_SUSPENDED");
  });
});

// ---------------------------------------------------------------------------
// BULK — mandate was previously unenforced on this lane.
// ---------------------------------------------------------------------------

describe("advanceBulk — mandate precheck", () => {
  it("no mandate_id: proceeds normally to DECIDED_TO_SETTLE", async () => {
    const txid = "TX-MND-BULK-NONE";
    insertLaneTx(d1, txid, "BULK", null);
    await advanceBulk(txid, makeEnv(d1));
    expect((await getTx(d1, txid))?.state).toBe("DECIDED_TO_SETTLE");
  });

  it("valid mandate within scope: proceeds to DECIDED_TO_SETTLE", async () => {
    const txid = "TX-MND-BULK-OK";
    const mandateId = "MANDATE-BULK-OK-1";
    insertMandate(d1, {
      mandateId,
      maxAmount: 200_000,
      allowedPurposes: ["P2P"],
      allowedLanes: ["BULK"],
    });
    insertLaneTx(d1, txid, "BULK", mandateId);
    await advanceBulk(txid, makeEnv(d1));
    expect((await getTx(d1, txid))?.state).toBe("DECIDED_TO_SETTLE");
  });

  it("MANDATE_BREACH (amount exceeds max_amount): PRECHECKED_SUSPENDED + Case, not settled", async () => {
    const txid = "TX-MND-BULK-AMT";
    const mandateId = "MANDATE-BULK-AMT-1";
    insertMandate(d1, { mandateId, maxAmount: 1_000 }); // tx amount is 100,000
    insertLaneTx(d1, txid, "BULK", mandateId);
    await advanceBulk(txid, makeEnv(d1));

    const tx = await getTx(d1, txid);
    expect(tx?.state).toBe("PRECHECKED_SUSPENDED");
    expect(tx?.reason_code).toBe("MANDATE_BREACH");
    const c = await getCase(d1, txid);
    expect(c?.reason_code).toBe("MANDATE_BREACH");
    expect(c?.state).toBe("OPEN");
  });
});

// ---------------------------------------------------------------------------
// HTLC — no PRECHECKED state, so a mandate breach cancels the contract at lock
// time (before any H / bank funds are reserved) rather than suspending.
// ---------------------------------------------------------------------------

describe("lockHtlc — mandate precheck", () => {
  function makeHtlcReq(htlcId: string, mandateId?: string, amount = 100_000) {
    return {
      htlc_id: htlcId,
      hashlock: "a".repeat(64),
      timelock: "2030-01-01T00:00:00Z",
      amount: { value: amount, currency: "JPY" },
      payer_bank_id: PAYER_BANK,
      payer_account_hash: PAYER_ACCOUNT,
      payee_bank_id: PAYEE_BANK,
      payee_account_hash: PAYEE_ACCOUNT,
      idempotency_key: `IK-${htlcId}`,
      mandate_id: mandateId,
    };
  }
  async function htlcState(htlcId: string) {
    return d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ state: string }>();
  }

  it("no mandate_id: locks normally", async () => {
    const env = makeEnv(d1);
    await createHtlc(makeHtlcReq("HTLC-MND-NONE"), env);
    await lockHtlc("HTLC-MND-NONE", env);
    expect((await htlcState("HTLC-MND-NONE"))?.state).toBe("HTLC_LOCKED");
  });

  it("valid mandate within scope: locks", async () => {
    const env = makeEnv(d1);
    insertMandate(d1, { mandateId: "MANDATE-HTLC-OK", maxAmount: 200_000, allowedLanes: ["HTLC"] });
    await createHtlc(makeHtlcReq("HTLC-MND-OK", "MANDATE-HTLC-OK"), env);
    await lockHtlc("HTLC-MND-OK", env);
    expect((await htlcState("HTLC-MND-OK"))?.state).toBe("HTLC_LOCKED");
  });

  it("MANDATE_BREACH (amount): contract cancelled, not locked, no funds committed", async () => {
    const env = makeEnv(d1);
    insertMandate(d1, { mandateId: "MANDATE-HTLC-AMT", maxAmount: 1_000 }); // amount is 100,000
    await createHtlc(makeHtlcReq("HTLC-MND-AMT", "MANDATE-HTLC-AMT"), env);
    await lockHtlc("HTLC-MND-AMT", env);

    expect((await htlcState("HTLC-MND-AMT"))?.state).toBe("DECIDED_CANCEL");
    // No payer suspense was ever reserved (the breach short-circuits before reserve).
    const susp = await d1
      .prepare(`SELECT COUNT(*) AS c FROM SuspenseDetails WHERE txid = 'TX-HTLC-HTLC-MND-AMT'`)
      .first<{ c: number }>();
    expect(susp?.c).toBe(0);
  });

  it("MANDATE_BREACH (lane): a mandate scoped to EXPRESS cannot lock via HTLC", async () => {
    const env = makeEnv(d1);
    insertMandate(d1, { mandateId: "MANDATE-HTLC-LANE", allowedLanes: ["EXPRESS"] });
    await createHtlc(makeHtlcReq("HTLC-MND-LANE", "MANDATE-HTLC-LANE"), env);
    await lockHtlc("HTLC-MND-LANE", env);
    expect((await htlcState("HTLC-MND-LANE"))?.state).toBe("DECIDED_CANCEL");
  });
});

// ---------------------------------------------------------------------------
// GTID — the mandate scopes the coordinated whole. advanceGtid checks it at
// GT_PRECHECKED against the total PAYER amount / lane='GTID'; a breach cancels
// the entire GTID before any leg settles.
// ---------------------------------------------------------------------------

describe("advanceGtid — mandate precheck", () => {
  function registerReq(gtid: string, mandateId: string | undefined, amount = 100_000) {
    return {
      gtid,
      idempotency_key: `IK-${gtid}`,
      expires_at: "2099-12-31T00:00:00Z",
      mandate_id: mandateId,
      legs: [
        {
          leg_id: `${gtid}-A`,
          role: "PAYER",
          bank_id: PAYER_BANK,
          account_hash: PAYER_ACCOUNT,
          amount: { value: amount, currency: "JPY" },
        },
        {
          leg_id: `${gtid}-B`,
          role: "PAYEE",
          bank_id: PAYEE_BANK,
          account_hash: PAYEE_ACCOUNT,
          amount: { value: amount, currency: "JPY" },
        },
      ],
    } as any;
  }
  async function gtState(gtid: string) {
    return d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid = ?`)
      .bind(gtid)
      .first<{ state: string }>();
  }
  async function legTxCount(gtid: string) {
    return d1
      .prepare(`SELECT COUNT(*) AS c FROM Transactions WHERE txid LIKE ?`)
      .bind(`TX-GT-${gtid}-%`)
      .first<{ c: number }>();
  }
  async function balance(accountId: string) {
    return d1
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ?`)
      .bind(accountId)
      .first<{ b: number }>();
  }

  it("no mandate_id: proceeds to GT_DECIDED_TO_SETTLE", async () => {
    const env = makeEnv(d1);
    await registerGtid(registerReq("GT-MND-NONE", undefined), env);
    await advanceGtid("GT-MND-NONE", env);
    expect((await gtState("GT-MND-NONE"))?.state).toBe("GT_DECIDED_TO_SETTLE");
  });

  it("valid mandate within scope: proceeds to GT_DECIDED_TO_SETTLE", async () => {
    const env = makeEnv(d1);
    insertMandate(d1, { mandateId: "MANDATE-GT-OK", maxAmount: 200_000, allowedLanes: ["GTID"] });
    await registerGtid(registerReq("GT-MND-OK", "MANDATE-GT-OK"), env);
    await advanceGtid("GT-MND-OK", env);
    expect((await gtState("GT-MND-OK"))?.state).toBe("GT_DECIDED_TO_SETTLE");
  });

  it("MANDATE_BREACH (amount): GTID cancelled, no leg settles, payee untouched", async () => {
    const env = makeEnv(d1);
    insertMandate(d1, { mandateId: "MANDATE-GT-AMT", maxAmount: 1_000 }); // total is 100,000
    const payeeBefore = (await balance(PAYEE_ACCOUNT))?.b;
    await registerGtid(registerReq("GT-MND-AMT", "MANDATE-GT-AMT"), env);
    await advanceGtid("GT-MND-AMT", env);

    expect((await gtState("GT-MND-AMT"))?.state).toBe("GT_CANCELLED");
    expect((await legTxCount("GT-MND-AMT"))?.c).toBe(0);
    // The payee was never credited (no leg settled).
    expect((await balance(PAYEE_ACCOUNT))?.b).toBe(payeeBefore);
  });

  it("MANDATE_BREACH (lane scoped to EXPRESS): GTID cancelled", async () => {
    const env = makeEnv(d1);
    insertMandate(d1, { mandateId: "MANDATE-GT-LANE", allowedLanes: ["EXPRESS"] });
    await registerGtid(registerReq("GT-MND-LANE", "MANDATE-GT-LANE"), env);
    await advanceGtid("GT-MND-LANE", env);
    expect((await gtState("GT-MND-LANE"))?.state).toBe("GT_CANCELLED");
  });
});

// ---------------------------------------------------------------------------
// Resume re-verification — a tx parked in PRECHECKED_SUSPENDED (name-check /
// operating-window) can sit for an arbitrary time; the mandate may be revoked
// or expired meanwhile. The resume edge must re-verify it, not just the original
// suspension reason, so a mandate revoked DURING the window is caught.
// ---------------------------------------------------------------------------

function insertSuspendedTx(
  db: MockD1Database,
  txid: string,
  lane: string,
  mandateId: string,
  reasonCode: string,
  pendingRequestJson: string | null = null
) {
  db.prepare(
    `INSERT OR IGNORE INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      purpose, idempotency_key, schema_version, mandate_id, reason_code,
      pending_request_json, created_at, updated_at, version)
     VALUES (?, ?, 'PRECHECKED_SUSPENDED', 100000, 'JPY', ?, ?, ?, ?,
             'P2P', ?, '1.0', ?, ?, ?, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 0)`
  )
    .bind(
      txid,
      lane,
      PAYER_BANK,
      PAYER_ACCOUNT,
      PAYEE_BANK,
      PAYEE_ACCOUNT,
      `IK-${txid}`,
      mandateId,
      reasonCode,
      pendingRequestJson
    )
    ._runSync();
}

describe("resumeFromNameCheckSuspended — mandate re-verify on resume", () => {
  it("mandate still valid: resumes past PRECHECKED to H_RESERVED", async () => {
    insertMandate(d1, {
      mandateId: "MANDATE-RES-OK",
      maxAmount: 200_000,
      allowedLanes: ["STANDARD"],
    });
    insertSuspendedTx(d1, "TX-RES-OK", "STANDARD", "MANDATE-RES-OK", "SUSPEND_NAMECHECK_PENDING");
    await resumeFromNameCheckSuspended("TX-RES-OK", makeEnv(d1));
    expect((await getTx(d1, "TX-RES-OK"))?.state).toBe("H_RESERVED");
  });

  it("mandate revoked during the suspension window: re-suspends, does not settle", async () => {
    insertMandate(d1, { mandateId: "MANDATE-RES-REV", revokedAt: "2024-01-01T00:00:00.000Z" });
    insertSuspendedTx(d1, "TX-RES-REV", "STANDARD", "MANDATE-RES-REV", "SUSPEND_NAMECHECK_PENDING");
    await resumeFromNameCheckSuspended("TX-RES-REV", makeEnv(d1));

    const tx = await getTx(d1, "TX-RES-REV");
    expect(tx?.state).toBe("PRECHECKED_SUSPENDED");
    expect(tx?.reason_code).toBe("MANDATE_REVOKED");
    const c = await getCase(d1, "TX-RES-REV");
    expect(c?.reason_code).toBe("MANDATE_REVOKED");
  });
});

describe("resumeSuspendedExpress — mandate re-verify on window reopen", () => {
  it("mandate revoked during the window-closed wait: re-suspends instead of settling", async () => {
    insertMandate(d1, { mandateId: "MANDATE-EXP-RES-REV", revokedAt: "2024-01-01T00:00:00.000Z" });
    const req = makeExpressReq("TX-EXP-RES-REV", "MANDATE-EXP-RES-REV");
    insertSuspendedTx(
      d1,
      "TX-EXP-RES-REV",
      "EXPRESS",
      "MANDATE-EXP-RES-REV",
      "COUNTERPARTY_WINDOW_CLOSED",
      JSON.stringify(req)
    );

    const result = await resumeSuspendedExpress("TX-EXP-RES-REV", makeEnv(d1));
    expect(result.ok).toBe(false);
    expect(result.state).toBe("PRECHECKED_SUSPENDED");

    const tx = await getTx(d1, "TX-EXP-RES-REV");
    expect(tx?.reason_code).toBe("MANDATE_REVOKED");
    const c = await getCase(d1, "TX-EXP-RES-REV");
    expect(c?.reason_code).toBe("MANDATE_REVOKED");
  });
});
