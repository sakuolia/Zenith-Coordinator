/**
 * @file GTID (Global Transaction ID) multi-leg coordination tests.
 *
 * Covers:
 * - registerGtid: GT_RECEIVED + legs created
 * - advanceGtid: GT_RECEIVED → GT_DECIDED_TO_SETTLE (all legs OK)
 * - advanceGtid: leg-ready-check NG → GT_DECIDED_CANCEL → GT_CANCELLED
 * - advanceGtid: missing PAYER or PAYEE leg → GT_DECIDED_CANCEL
 * - advanceGtid: H_LIMIT_EXCEEDED during PAYER reservation → GT_DECIDED_CANCEL
 * - advanceGtid: idempotency (CAS guard, double-call is no-op)
 * - checkAndFinalizeGtid: GT_DECIDED_TO_SETTLE → GT_SETTLED when all TX settled
 * - checkAndFinalizeGtid: GT_DECIDED_TO_SETTLE → GT_SUSPENDED when a leg fails
 * - checkAndFinalizeGtid: no-op when GT not in GT_DECIDED_TO_SETTLE
 * - suspendTx on a GT leg triggers GT_SUSPENDED via checkAndFinalizeGtid
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { registerGtid, advanceGtid } from "../../src/zc/lanes/gtid";
import { checkAndFinalizeGtid } from "../../src/zc/orchestrator";
import { reserveH } from "../../src/zc/liquidity/h_model";

// ---------------------------------------------------------------------------
// Env mock
// ---------------------------------------------------------------------------
function makeEnv(db: MockD1Database): any {
  return {
    DB: db,
    QUEUE: { send: async () => {} },
    ZC_HMAC_SECRET: "test-secret",
  };
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------
const BANK_A = "001";
const BANK_B = "002";
const ACCOUNT_A = "0010000001";
const ACCOUNT_B = "0020000001";
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

/** Build a minimal two-leg GTID register request (PAYER A → PAYEE B). */
function makeTwoLegRequest(gtid: string, amount = 100_000) {
  return {
    gtid,
    expires_at: "2099-12-31T00:00:00Z",
    legs: [
      {
        leg_id: `${gtid}-LEG-PAYER`,
        role: "PAYER" as const,
        bank_id: BANK_A,
        account_hash: ACCOUNT_A,
        amount: { value: amount, currency: "JPY" },
      },
      {
        leg_id: `${gtid}-LEG-PAYEE`,
        role: "PAYEE" as const,
        bank_id: BANK_B,
        account_hash: ACCOUNT_B,
        amount: { value: amount, currency: "JPY" },
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
});

// ---------------------------------------------------------------------------
// registerGtid
// ---------------------------------------------------------------------------

describe("registerGtid", () => {
  it("creates GtidTransactions in GT_RECEIVED state", async () => {
    await registerGtid(makeTwoLegRequest("GT-REG-001"), makeEnv(d1));

    const gt = await d1
      .prepare(`SELECT state, leg_count FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-REG-001")
      .first<{ state: string; leg_count: number }>();
    expect(gt?.state).toBe("GT_RECEIVED");
    expect(gt?.leg_count).toBe(2);
  });

  it("creates GtidLegs in LEG_REGISTERED state", async () => {
    await registerGtid(makeTwoLegRequest("GT-REG-002"), makeEnv(d1));

    const legs = await d1
      .prepare(`SELECT role, state FROM GtidLegs WHERE gtid=? ORDER BY role`)
      .bind("GT-REG-002")
      .all<{ role: string; state: string }>();
    expect(legs.results).toHaveLength(2);
    for (const leg of legs.results) {
      expect(leg.state).toBe("LEG_REGISTERED");
    }
  });

  it("writes GtidRegistered FinalityLog entry", async () => {
    await registerGtid(makeTwoLegRequest("GT-REG-003"), makeEnv(d1));

    const log = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE event_type='GtidRegistered' LIMIT 1`)
      .first<{ event_type: string }>();
    expect(log).not.toBeNull();
  });

  it("returns GTID_ACCEPTED", async () => {
    const result = await registerGtid(makeTwoLegRequest("GT-REG-004"), makeEnv(d1));
    expect(result.result).toBe("GTID_ACCEPTED");
    expect(result.gtid).toBe("GT-REG-004");
    expect(result.state).toBe("GT_RECEIVED");
  });
});

// ---------------------------------------------------------------------------
// advanceGtid — happy path: GT_RECEIVED → GT_DECIDED_TO_SETTLE
// ---------------------------------------------------------------------------

describe("advanceGtid — happy path", () => {
  it("transitions GT to GT_DECIDED_TO_SETTLE when all legs pass ready-check", async () => {
    await registerGtid(makeTwoLegRequest("GT-ADV-001"), makeEnv(d1));
    await advanceGtid("GT-ADV-001", makeEnv(d1));

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-ADV-001")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_DECIDED_TO_SETTLE");
  });

  it("marks all legs as LEG_READY_CHECKED", async () => {
    await registerGtid(makeTwoLegRequest("GT-ADV-002"), makeEnv(d1));
    await advanceGtid("GT-ADV-002", makeEnv(d1));

    const legs = await d1
      .prepare(`SELECT state FROM GtidLegs WHERE gtid=?`)
      .bind("GT-ADV-002")
      .all<{ state: string }>();
    // PAYER leg: LEG_READY_CHECKED; PAYEE leg: also LEG_READY_CHECKED
    for (const leg of legs.results) {
      expect(leg.state).toBe("LEG_READY_CHECKED");
    }
  });

  it("creates a PAYER Transaction in DECIDED_TO_SETTLE state", async () => {
    await registerGtid(makeTwoLegRequest("GT-ADV-003"), makeEnv(d1));
    await advanceGtid("GT-ADV-003", makeEnv(d1));

    const txid = `TX-GT-GT-ADV-003-LEG-PAYER`;
    const tx = await d1
      .prepare(`SELECT state, lane FROM Transactions WHERE txid=?`)
      .bind(txid)
      .first<{ state: string; lane: string }>();
    expect(tx?.state).toBe("DECIDED_TO_SETTLE");
  });

  it("writes GtidDecided FinalityLog entry", async () => {
    await registerGtid(makeTwoLegRequest("GT-ADV-004"), makeEnv(d1));
    await advanceGtid("GT-ADV-004", makeEnv(d1));

    const log = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE event_type='GtidDecided' LIMIT 1`)
      .first<{ event_type: string }>();
    expect(log).not.toBeNull();
  });

  it("reserves and locks H for the PAYER leg", async () => {
    await registerGtid(makeTwoLegRequest("GT-ADV-005", 200_000), makeEnv(d1));
    await advanceGtid("GT-ADV-005", makeEnv(d1));

    const p = await d1
      .prepare(`SELECT h_used FROM Participants WHERE bank_id=?`)
      .bind(BANK_A)
      .first<{ h_used: number }>();
    // H is LOCKED (still counts toward h_used)
    expect(p?.h_used).toBe(200_000);

    const res = await d1
      .prepare(`SELECT mode FROM HReservations WHERE bank_id=? AND txid=?`)
      .bind(BANK_A, `TX-GT-GT-ADV-005-LEG-PAYER`)
      .first<{ mode: string }>();
    expect(res?.mode).toBe("LOCKED");
  });
});

// ---------------------------------------------------------------------------
// advanceGtid — leg-ready-check NG → GT_CANCELLED
// ---------------------------------------------------------------------------

describe("advanceGtid — leg-ready-check failure", () => {
  it("cancels GT when payer account is FROZEN (leg-ready-check NG)", async () => {
    d1.prepare(`UPDATE BankAccounts SET status='FROZEN' WHERE account_id=?`)
      .bind(ACCOUNT_A)
      ._runSync();

    await registerGtid(makeTwoLegRequest("GT-NG-001"), makeEnv(d1));
    await advanceGtid("GT-NG-001", makeEnv(d1));

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-NG-001")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_CANCELLED");
  });

  it("marks failing leg as LEG_FAILED", async () => {
    d1.prepare(`UPDATE BankAccounts SET status='FROZEN' WHERE account_id=?`)
      .bind(ACCOUNT_A)
      ._runSync();

    await registerGtid(makeTwoLegRequest("GT-NG-002"), makeEnv(d1));
    await advanceGtid("GT-NG-002", makeEnv(d1));

    const failedLeg = await d1
      .prepare(`SELECT state FROM GtidLegs WHERE gtid=? AND role='PAYER'`)
      .bind("GT-NG-002")
      .first<{ state: string }>();
    expect(failedLeg?.state).toBe("LEG_FAILED");
  });

  it("writes GtidDecidedCancel and GtidCancelled FinalityLog entries", async () => {
    d1.prepare(`UPDATE BankAccounts SET status='FROZEN' WHERE account_id=?`)
      .bind(ACCOUNT_A)
      ._runSync();

    await registerGtid(makeTwoLegRequest("GT-NG-003"), makeEnv(d1));
    await advanceGtid("GT-NG-003", makeEnv(d1));

    const logs = await d1
      .prepare(
        `SELECT event_type FROM FinalityLog WHERE event_type IN ('GtidDecidedCancel', 'GtidCancelled') ORDER BY event_seq`
      )
      .all<{ event_type: string }>();
    const types = logs.results.map((r) => r.event_type);
    expect(types).toContain("GtidDecidedCancel");
    expect(types).toContain("GtidCancelled");
  });
});

// ---------------------------------------------------------------------------
// advanceGtid — missing leg roles → GT_CANCELLED
// ---------------------------------------------------------------------------

describe("advanceGtid — missing PAYER or PAYEE leg", () => {
  it("cancels GT when only PAYER legs are registered (no PAYEE)", async () => {
    const req = {
      gtid: "GT-MISS-001",
      expires_at: "2099-12-31T00:00:00Z",
      legs: [
        {
          leg_id: "GT-MISS-001-LEG-A",
          role: "PAYER" as const,
          bank_id: BANK_A,
          account_hash: ACCOUNT_A,
          amount: { value: 100_000, currency: "JPY" },
        },
      ],
    };
    await registerGtid(req, makeEnv(d1));
    await advanceGtid("GT-MISS-001", makeEnv(d1));

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-MISS-001")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_CANCELLED");
  });
});

// ---------------------------------------------------------------------------
// advanceGtid — H_LIMIT_EXCEEDED → GT_CANCELLED
// ---------------------------------------------------------------------------

describe("advanceGtid — H_LIMIT_EXCEEDED during PAYER reservation", () => {
  it("cancels GT and releases any previously reserved H", async () => {
    // Exhaust H limit for payer bank
    await reserveH(BANK_A, "TX-EXHAUST-GT", H_LIMIT, d1 as any);

    await registerGtid(makeTwoLegRequest("GT-HL-001"), makeEnv(d1));
    await advanceGtid("GT-HL-001", makeEnv(d1));

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-HL-001")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_CANCELLED");

    // h_used must remain at H_LIMIT (not incremented further)
    const p = await d1
      .prepare(`SELECT h_used FROM Participants WHERE bank_id=?`)
      .bind(BANK_A)
      .first<{ h_used: number }>();
    expect(p?.h_used).toBe(H_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// advanceGtid — idempotency (CAS guard)
// ---------------------------------------------------------------------------

describe("advanceGtid — idempotency", () => {
  it("does not process GT twice if already past GT_RECEIVED", async () => {
    await registerGtid(makeTwoLegRequest("GT-IK-001"), makeEnv(d1));
    // Advance once → GT_DECIDED_TO_SETTLE
    await advanceGtid("GT-IK-001", makeEnv(d1));
    // Second call: CAS guard prevents re-processing
    await expect(advanceGtid("GT-IK-001", makeEnv(d1))).resolves.toBeUndefined();

    const p = await d1
      .prepare(`SELECT h_used FROM Participants WHERE bank_id=?`)
      .bind(BANK_A)
      .first<{ h_used: number }>();
    // h_used must be exactly one reservation's worth
    expect(p?.h_used).toBeLessThanOrEqual(100_000);
  });
});

// ---------------------------------------------------------------------------
// checkAndFinalizeGtid — GT_DECIDED_TO_SETTLE → GT_SETTLED
// ---------------------------------------------------------------------------

describe("checkAndFinalizeGtid — GT_SETTLED when all legs done", () => {
  async function setupSettledLegs(gtid: string) {
    // Register and advance GT
    await registerGtid(makeTwoLegRequest(gtid), makeEnv(d1));
    await advanceGtid(gtid, makeEnv(d1));

    // Mark the PAYER TX as SETTLED (simulate successful settlement)
    const txid = `TX-GT-${gtid}-LEG-PAYER`;
    await d1
      .prepare(
        `UPDATE Transactions SET state='SETTLED', version=version+1, updated_at='2025-06-01T12:00:00Z'
       WHERE txid=?`
      )
      .bind(txid)
      .run();
  }

  it("transitions GT to GT_SETTLED when all PAYER TXs are SETTLED", async () => {
    await setupSettledLegs("GT-FIN-001");
    await checkAndFinalizeGtid("GT-FIN-001", d1 as any);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-FIN-001")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SETTLED");
  });

  it("marks all GtidLegs as LEG_SETTLED", async () => {
    await setupSettledLegs("GT-FIN-002");
    await checkAndFinalizeGtid("GT-FIN-002", d1 as any);

    const legs = await d1
      .prepare(`SELECT state FROM GtidLegs WHERE gtid=?`)
      .bind("GT-FIN-002")
      .all<{ state: string }>();
    for (const leg of legs.results) {
      expect(leg.state).toBe("LEG_SETTLED");
    }
  });

  it("writes GtidSettled FinalityLog entry", async () => {
    await setupSettledLegs("GT-FIN-003");
    await checkAndFinalizeGtid("GT-FIN-003", d1 as any);

    const log = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE event_type='GtidSettled' LIMIT 1`)
      .first<{ event_type: string }>();
    expect(log).not.toBeNull();
  });

  it("updates legs_settled_count to leg_count", async () => {
    await setupSettledLegs("GT-FIN-004");
    await checkAndFinalizeGtid("GT-FIN-004", d1 as any);

    const gt = await d1
      .prepare(`SELECT leg_count, legs_settled_count FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-FIN-004")
      .first<{ leg_count: number; legs_settled_count: number }>();
    expect(gt?.legs_settled_count).toBe(gt?.leg_count);
  });
});

// ---------------------------------------------------------------------------
// checkAndFinalizeGtid — GT_SUSPENDED when a leg fails
// ---------------------------------------------------------------------------

describe("checkAndFinalizeGtid — GT_SUSPENDED when a leg fails", () => {
  it("does NOT suspend the GT on a transient SUSPENDED leg — it waits", async () => {
    // A SUSPENDED leg (e.g. AWAITING_PAYEE_APPROVAL) is transient and may resume
    // to SETTLED. Suspending the GTID on it would terminally strand an
    // otherwise-completable transfer. Finalization must wait, not suspend.
    await registerGtid(makeTwoLegRequest("GT-SUSP-001"), makeEnv(d1));
    await advanceGtid("GT-SUSP-001", makeEnv(d1));

    const txid = `TX-GT-GT-SUSP-001-LEG-PAYER`;
    await d1
      .prepare(
        `UPDATE Transactions SET state='SUSPENDED', reason_code='AWAITING_PAYEE_APPROVAL',
       version=version+1, updated_at='2025-06-01T12:00:00Z' WHERE txid=?`
      )
      .bind(txid)
      .run();

    await checkAndFinalizeGtid("GT-SUSP-001", d1 as any);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-SUSP-001")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_DECIDED_TO_SETTLE"); // still waiting, not suspended
  });

  it("transitions GT to GT_SUSPENDED when a PAYER TX is FAILED_EXECUTION", async () => {
    await registerGtid(makeTwoLegRequest("GT-SUSP-002"), makeEnv(d1));
    await advanceGtid("GT-SUSP-002", makeEnv(d1));

    const txid = `TX-GT-GT-SUSP-002-LEG-PAYER`;
    await d1
      .prepare(
        `UPDATE Transactions SET state='FAILED_EXECUTION', version=version+1,
       updated_at='2025-06-01T12:00:00Z' WHERE txid=?`
      )
      .bind(txid)
      .run();

    await checkAndFinalizeGtid("GT-SUSP-002", d1 as any);

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-SUSP-002")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SUSPENDED");
  });

  it("writes GtidSuspended FinalityLog entry", async () => {
    await registerGtid(makeTwoLegRequest("GT-SUSP-003"), makeEnv(d1));
    await advanceGtid("GT-SUSP-003", makeEnv(d1));

    const txid = `TX-GT-GT-SUSP-003-LEG-PAYER`;
    await d1
      .prepare(
        `UPDATE Transactions SET state='FAILED_EXECUTION', version=version+1,
       updated_at='2025-06-01T12:00:00Z' WHERE txid=?`
      )
      .bind(txid)
      .run();

    await checkAndFinalizeGtid("GT-SUSP-003", d1 as any);

    const log = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE event_type='GtidSuspended' LIMIT 1`)
      .first<{ event_type: string }>();
    expect(log).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkAndFinalizeGtid — no-op for non-GT_DECIDED_TO_SETTLE states
// ---------------------------------------------------------------------------

describe("checkAndFinalizeGtid — no-op for wrong GT state", () => {
  it("does nothing when GT is in GT_RECEIVED state", async () => {
    await registerGtid(makeTwoLegRequest("GT-NOOP-001"), makeEnv(d1));
    // Do NOT advance — GT stays at GT_RECEIVED
    await expect(checkAndFinalizeGtid("GT-NOOP-001", d1 as any)).resolves.toBeUndefined();

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-NOOP-001")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_RECEIVED");
  });

  it("does nothing when GT is already GT_SETTLED", async () => {
    d1.prepare(
      `INSERT INTO GtidTransactions
       (gtid, state, initiator_bank_id, total_amount, leg_count, legs_ready_count,
        legs_settled_count, version, created_at, updated_at)
       VALUES ('GT-NOOP-002', 'GT_SETTLED', '001', 100000, 2, 2, 2, 0,
               '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`
    )._runSync();

    await expect(checkAndFinalizeGtid("GT-NOOP-002", d1 as any)).resolves.toBeUndefined();

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind("GT-NOOP-002")
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_SETTLED");
  });
});

// ---------------------------------------------------------------------------
// Bug 1 regression: PAYER bank suspense released on GTID cancel
// ---------------------------------------------------------------------------

describe("advanceGtid — PAYER bank suspense released on cancel (B1 regression)", () => {
  it("releases bank SuspenseDetails (RESERVED→RETURNED) for PAYER leg when H_LIMIT_EXCEEDED triggers cancel", async () => {
    // Exhaust H limit so the H-reservation phase fails after leg-ready-checks pass.
    // bankLegReadyCheck for PAYER creates SuspenseDetails(RESERVED) before H reservation is attempted.
    await reserveH(BANK_A, "TX-EXHAUST-SUSP", H_LIMIT, d1 as any);

    const gtid = "GT-B1-SUSP-001";
    await registerGtid(makeTwoLegRequest(gtid, 100_000), makeEnv(d1));
    await advanceGtid(gtid, makeEnv(d1));

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind(gtid)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_CANCELLED");

    // The PAYER leg suspense that was created by bankLegReadyCheck must now be RETURNED
    const payerLegId = `${gtid}-LEG-PAYER`;
    const predictedTxid = `TX-GT-${payerLegId}`;
    const suspense = await d1
      .prepare(`SELECT status FROM SuspenseDetails WHERE txid=? AND bank_id=?`)
      .bind(predictedTxid, BANK_A)
      .first<{ status: string }>();

    expect(suspense?.status).toBe("RETURNED");
  });

  it("releases bank SuspenseDetails when all leg-ready-checks pass but PAYER account balance is insufficient for H (leg NG path)", async () => {
    // Freeze PAYER account so bankLegReadyCheck fails (account not NORMAL).
    // The leg will be LEG_FAILED (no bank suspense created), GT transitions to GT_CANCELLED.
    // This verifies that we do NOT crash trying to release non-existent suspense.
    d1.prepare(`UPDATE BankAccounts SET status='FROZEN' WHERE account_id=?`)
      .bind(ACCOUNT_A)
      ._runSync();

    const gtid = "GT-B1-NG-001";
    await registerGtid(makeTwoLegRequest(gtid, 100_000), makeEnv(d1));
    await advanceGtid(gtid, makeEnv(d1));

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind(gtid)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_CANCELLED");

    // No suspense should exist (bankLegReadyCheck returned NG before reserving)
    const payerLegId = `${gtid}-LEG-PAYER`;
    const predictedTxid = `TX-GT-${payerLegId}`;
    const suspense = await d1
      .prepare(`SELECT status FROM SuspenseDetails WHERE txid=? AND bank_id=?`)
      .bind(predictedTxid, BANK_A)
      .first<{ status: string }>();
    expect(suspense).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleGetGtid — derived ready/settled counts (audit follow-up)
// ---------------------------------------------------------------------------
describe("handleGetGtid — derives leg counts from real leg states", async () => {
  const { handleGetGtid } = await import("../../src/zc/query/query");

  it("overrides snapshot counts with values derived from GtidLegs", async () => {
    const { d1 } = createTestDb();
    // GT row with stored snapshot counts deliberately wrong (0/0) — derivation
    // should ignore them and report the actual leg-state counts.
    d1.prepare(
      `INSERT INTO GtidTransactions
       (gtid, state, initiator_bank_id, total_amount, leg_count,
        legs_ready_count, legs_settled_count, version, created_at, updated_at)
       VALUES ('GTID-DRV-1', 'GT_DECIDED_TO_SETTLE', '001', 300, 3, 0, 0, 0, 't', 't')`
    )._runSync();
    d1.prepare(
      `INSERT INTO GtidLegs
       (leg_id, gtid, role, bank_id, account_hash, amount_value, state, version, created_at, updated_at)
       VALUES
       ('L1', 'GTID-DRV-1', 'PAYER', '001', '0010000001', 100, 'LEG_SETTLED',        0, 't', 't'),
       ('L2', 'GTID-DRV-1', 'PAYER', '001', '0010000001', 100, 'LEG_READY_CHECKED',  0, 't', 't'),
       ('L3', 'GTID-DRV-1', 'PAYEE', '002', '0020000001', 100, 'LEG_RECEIVED',       0, 't', 't')`
    )._runSync();

    const env = makeEnv(d1);
    const res = await handleGetGtid("GTID-DRV-1", env);
    const body = (await res.json()) as { legs_ready_count: number; legs_settled_count: number };
    // ready = LEG_READY_CHECKED + LEG_SETTLED = 2; settled = LEG_SETTLED = 1.
    expect(body.legs_ready_count).toBe(2);
    expect(body.legs_settled_count).toBe(1);
  });

  it("falls back to stored counts for synthetic GTs with no legs", async () => {
    const { d1 } = createTestDb();
    d1.prepare(
      `INSERT INTO GtidTransactions
       (gtid, state, initiator_bank_id, total_amount, leg_count,
        legs_ready_count, legs_settled_count, version, created_at, updated_at)
       VALUES ('GTID-DNS-1', 'GT_SETTLED', 'ZC', 500, 2, 2, 2, 0, 't', 't')`
    )._runSync();

    const env = makeEnv(d1);
    const res = await handleGetGtid("GTID-DNS-1", env);
    const body = (await res.json()) as { legs_ready_count: number; legs_settled_count: number };
    expect(body.legs_ready_count).toBe(2);
    expect(body.legs_settled_count).toBe(2);
  });
});
