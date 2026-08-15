/**
 * @file Tests for H_locked recovery paths (zc/h_unlock.ts), docs/specs/20_method_design.md § 8.4.1.
 *
 * Covers:
 * - NoDebitRecordedProofSubmitted releases H_locked and returns capacity to the pool
 * - HUnlockAuthorized requires two distinct approvers + evidence, then releases
 * - the money-safety gate: H is NEVER released once a (PAYER_EXEC_CONFIRMED) or
 *   b occurred, detected via current state OR FinalityLog history
 * - idempotency: a second release is a typed no-op
 * - T25 (chaos probe): combined-violation precedence when multiple guards in
 *   submitNoDebitProof / authorizeHUnlock fire on the same call at once — pins
 *   the exact check order (field gates before the loadReleasableH state gate)
 *   against 32_api_contracts.md ~lines 459-470.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { submitNoDebitProof, authorizeHUnlock } from "../../src/zc/liquidity/h_unlock";
import { writeFinalityLog } from "../../src/zc/orchestrator";

let d1: MockD1Database;
const BANK = "001";
const AMOUNT = 5000;

/** Seed a post-decision transaction that still holds a LOCKED, unreleased H. */
function seedStuckTx(db: MockD1Database, txid: string, state = "FAILED_EXECUTION") {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${BANK}', 1000000, ?, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(BANK, AMOUNT)
    ._runSync();

  const reservationId = `H-${txid}`;
  db.prepare(
    `INSERT INTO HReservations
     (reservation_id, txid, bank_id, amount, mode, is_released, created_at)
     VALUES (?, ?, ?, ?, 'LOCKED', 0, '2025-06-01T09:00:00Z')`
  )
    .bind(reservationId, txid, BANK, AMOUNT)
    ._runSync();

  db.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, h_reservation_id,
      created_at, updated_at, version)
     VALUES (?, 'EXPRESS', ?, ?, 'JPY', ?, 'payerAcc', '002', 'payeeAcc',
             ?, '1.0', ?, '2025-06-01T09:00:00Z', '2025-06-01T09:00:00Z', 0)`
  )
    .bind(txid, state, AMOUNT, BANK, `IK-${txid}`, reservationId)
    ._runSync();
  return reservationId;
}

async function hUsed(db: MockD1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT h_used FROM Participants WHERE bank_id = ?`)
    .bind(BANK)
    .first<{ h_used: number }>();
  return row?.h_used ?? -1;
}

async function isReleased(db: MockD1Database, reservationId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT is_released FROM HReservations WHERE reservation_id = ?`)
    .bind(reservationId)
    .first<{ is_released: number }>();
  return row?.is_released ?? -1;
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
});

describe("submitNoDebitProof — machine-decidable release", () => {
  it("releases H_locked and returns capacity to the pool", async () => {
    const resId = seedStuckTx(d1, "TX-NODEBIT-1");
    expect(await hUsed(d1)).toBe(AMOUNT);

    const result = await submitNoDebitProof(d1 as any, "TX-NODEBIT-1", {
      proof_ref: "PROOF-NODEBIT-1",
      bank_id: BANK,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event).toBe("NoDebitRecordedProofSubmitted");
    expect(await hUsed(d1)).toBe(0);
    expect(await isReleased(d1, resId)).toBe(1);

    const log = await d1
      .prepare(
        `SELECT COUNT(*) AS cnt FROM FinalityLog WHERE txid = ? AND event_type = 'NoDebitRecordedProofSubmitted'`
      )
      .bind("TX-NODEBIT-1")
      .first<{ cnt: number }>();
    expect(log?.cnt).toBe(1);
  });

  it("requires a proof_ref", async () => {
    seedStuckTx(d1, "TX-NODEBIT-2");
    const result = await submitNoDebitProof(d1 as any, "TX-NODEBIT-2", {
      proof_ref: "",
      bank_id: BANK,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("PROOF_REF_REQUIRED");
  });

  it("is a typed no-op on a second release (idempotent)", async () => {
    seedStuckTx(d1, "TX-NODEBIT-3");
    await submitNoDebitProof(d1 as any, "TX-NODEBIT-3", { proof_ref: "P1", bank_id: BANK });
    const second = await submitNoDebitProof(d1 as any, "TX-NODEBIT-3", {
      proof_ref: "P2",
      bank_id: BANK,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("ALREADY_RELEASED");
    expect(await hUsed(d1)).toBe(0); // released exactly once, not twice
  });
});

describe("money-safety gate — never release after a/b", () => {
  it("rejects release when the current state is PAYER_EXEC_CONFIRMED", async () => {
    const resId = seedStuckTx(d1, "TX-AB-1", "PAYER_EXEC_CONFIRMED");
    const result = await submitNoDebitProof(d1 as any, "TX-AB-1", {
      proof_ref: "P",
      bank_id: BANK,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("A_OR_B_CONFIRMED");
    expect(await isReleased(d1, resId)).toBe(0); // H untouched
    expect(await hUsed(d1)).toBe(AMOUNT);
  });

  it("rejects release when a/b appears in FinalityLog history even if state is SUSPENDED", async () => {
    const resId = seedStuckTx(d1, "TX-AB-2", "SUSPENDED");
    // The row passed through a before being suspended.
    await writeFinalityLog(d1 as any, {
      txid: "TX-AB-2",
      event_type: "PayerExecConfirmed",
      state_from: "DECIDED_TO_SETTLE",
      state_to: "PAYER_EXEC_CONFIRMED",
      payload_json: "{}",
      txid_or_gtid: "TX-AB-2",
    });

    const result = await authorizeHUnlock(d1 as any, "TX-AB-2", {
      approver_1: "ops.alice",
      approver_2: "ops.bob",
      evidence_type: "LEDGER_HASH",
      evidence_ref: "HASH-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("A_OR_B_CONFIRMED");
    expect(await isReleased(d1, resId)).toBe(0);
  });
});

describe("authorizeHUnlock — two-person operational control", () => {
  it("rejects a single approver (four-eyes required)", async () => {
    seedStuckTx(d1, "TX-4EYES-1");
    const result = await authorizeHUnlock(d1 as any, "TX-4EYES-1", {
      approver_1: "ops.alice",
      approver_2: "ops.alice",
      evidence_type: "LEDGER_HASH",
      evidence_ref: "HASH-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("FOUR_EYES_REQUIRED");
  });

  it("requires an evidence reference", async () => {
    seedStuckTx(d1, "TX-4EYES-2");
    const result = await authorizeHUnlock(d1 as any, "TX-4EYES-2", {
      approver_1: "ops.alice",
      approver_2: "ops.bob",
      evidence_type: "LEDGER_HASH",
      evidence_ref: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("EVIDENCE_REQUIRED");
  });

  it("releases with two distinct approvers + evidence and logs HUnlockAuthorized", async () => {
    const resId = seedStuckTx(d1, "TX-4EYES-3");
    const result = await authorizeHUnlock(d1 as any, "TX-4EYES-3", {
      approver_1: "ops.alice",
      approver_2: "ops.bob",
      evidence_type: "AUTHORITY_CHECK",
      evidence_ref: "AC-2026-001",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event).toBe("HUnlockAuthorized");
    expect(await isReleased(d1, resId)).toBe(1);
    expect(await hUsed(d1)).toBe(0);

    const log = await d1
      .prepare(
        `SELECT payload_json FROM FinalityLog WHERE txid = ? AND event_type = 'HUnlockAuthorized'`
      )
      .bind("TX-4EYES-3")
      .first<{ payload_json: string }>();
    expect(log).not.toBeNull();
    const payload = JSON.parse(log!.payload_json);
    expect(payload.approver_1).toBe("ops.alice");
    expect(payload.approver_2).toBe("ops.bob");
    expect(payload.evidence_ref).toBe("AC-2026-001");
  });
});

describe("T25 (chaos probe): combined-violation precedence", () => {
  it("submitNoDebitProof: missing proof_ref AND an already-settled tx → PROOF_REF_REQUIRED wins (the field gate runs before loadReleasableH is ever called)", async () => {
    const resId = seedStuckTx(d1, "TX-T25-1", "PAYER_EXEC_CONFIRMED");
    const result = await submitNoDebitProof(d1 as any, "TX-T25-1", {
      proof_ref: "",
      bank_id: BANK,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("PROOF_REF_REQUIRED");
      expect(result.reason).not.toBe("A_OR_B_CONFIRMED");
    }
    expect(await isReleased(d1, resId)).toBe(0);
    expect(await hUsed(d1)).toBe(AMOUNT);
  });

  it("authorizeHUnlock: a triple violation (same approver twice, no evidence, already settled) still resolves to FOUR_EYES_REQUIRED — the first guard checked wins", async () => {
    const resId = seedStuckTx(d1, "TX-T25-2", "SETTLED");
    const result = await authorizeHUnlock(d1 as any, "TX-T25-2", {
      approver_1: "ops.alice",
      approver_2: "ops.alice", // four-eyes violation
      evidence_type: "",
      evidence_ref: "", // evidence violation too
      // and the tx is already SETTLED — an a/b violation as well
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("FOUR_EYES_REQUIRED");
      expect(result.reason).not.toBe("EVIDENCE_REQUIRED");
      expect(result.reason).not.toBe("A_OR_B_CONFIRMED");
    }
    expect(await isReleased(d1, resId)).toBe(0);
    expect(await hUsed(d1)).toBe(AMOUNT);
  });

  it("authorizeHUnlock: distinct approvers but no evidence, on an already-settled tx → EVIDENCE_REQUIRED wins over A_OR_B_CONFIRMED (the second field gate still runs before the state gate)", async () => {
    const resId = seedStuckTx(d1, "TX-T25-3", "PAYEE_EXEC_CONFIRMED");
    const result = await authorizeHUnlock(d1 as any, "TX-T25-3", {
      approver_1: "ops.alice",
      approver_2: "ops.bob",
      evidence_type: "LEDGER_HASH",
      evidence_ref: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("EVIDENCE_REQUIRED");
      expect(result.reason).not.toBe("A_OR_B_CONFIRMED");
    }
    expect(await isReleased(d1, resId)).toBe(0);
    expect(await hUsed(d1)).toBe(AMOUNT);
  });

  it("authorizeHUnlock: all four-eyes/evidence fields well-formed, but the tx is already settled → A_OR_B_CONFIRMED is reached and wins (no remaining field gate to shadow it)", async () => {
    const resId = seedStuckTx(d1, "TX-T25-4", "SETTLED");
    const result = await authorizeHUnlock(d1 as any, "TX-T25-4", {
      approver_1: "ops.alice",
      approver_2: "ops.bob",
      evidence_type: "LEDGER_HASH",
      evidence_ref: "HASH-OK",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("A_OR_B_CONFIRMED");
    expect(await isReleased(d1, resId)).toBe(0);
    expect(await hUsed(d1)).toBe(AMOUNT);
  });
});
