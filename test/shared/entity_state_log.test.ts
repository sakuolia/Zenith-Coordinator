/**
 * @file Tests for EntityStateLog — the append-only state-transition history for
 * entities outside the Transactions money-path state machine.
 *
 * Verifies that status changes which previously overwrote a column with no
 * paired fact (Cases, PSPR capabilities, bank account status, reversals) now
 * append an immutable EntityStateLog row recording state_from → state_to, and
 * that a no-op change (same state) appends nothing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { transitionEntityWithLog, recordEntityTransition } from "../../src/shared/entity_state_log";
import { openCase, updateCase } from "../../src/zc/cases/case";
import { registerPspr, revokePspr } from "../../src/zc/directory/pspr";
import {
  requestReversal,
  completeReversal,
  submitCreditFailedProof,
} from "../../src/zc/cases/reversal";
import { handleUpdateAccountStatus } from "../../src/bank/teller_api";
import type { Env, EntityStateLogRow } from "../../src/types";

let d1: MockD1Database;

function makeEnv(): Env {
  return {
    DB: d1 as unknown as D1Database,
    QUEUE: { send: async () => {} } as any,
    R2: {} as any,
    ZC_HMAC_SECRET: "",
    VAULT_URL: "",
    VAULT_TOKEN: "",
  } as unknown as Env;
}

async function logsFor(entityType: string, entityId: string): Promise<EntityStateLogRow[]> {
  const { results } = await d1
    .prepare(
      // rowid reflects insertion order; the log is INSERT-only so it is a stable
      // tiebreaker when several facts share the same occurred_at timestamp.
      `SELECT * FROM EntityStateLog WHERE entity_type=? AND entity_id=? ORDER BY rowid ASC`
    )
    .bind(entityType, entityId)
    .all<EntityStateLogRow>();
  return results ?? [];
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
});

// ---------------------------------------------------------------------------
// Helper mechanics
// ---------------------------------------------------------------------------

describe("transitionEntityWithLog", () => {
  it("appends a log row only when the UPDATE changes a row", async () => {
    d1.prepare(
      `INSERT INTO Cases (case_id, state, reason_code, opened_by, created_at, updated_at)
       VALUES ('CASE-X', 'OPEN', 'R', 'OPS', 't', 't')`
    )._runSync();

    // Matching CAS → row changes → log written.
    const hit = await transitionEntityWithLog(d1 as unknown as D1Database, {
      update: {
        sql: `UPDATE Cases SET state='RESOLVED', updated_at='t2' WHERE case_id=? AND state='OPEN'`,
        binds: ["CASE-X"],
      },
      transition: {
        entityType: "CASE",
        entityId: "CASE-X",
        eventType: "CaseStateChanged",
        stateFrom: "OPEN",
        stateTo: "RESOLVED",
      },
    });
    expect(hit).toBe(true);

    // Non-matching CAS → no row changes → no log written.
    const miss = await transitionEntityWithLog(d1 as unknown as D1Database, {
      update: {
        sql: `UPDATE Cases SET state='ESCALATED', updated_at='t3' WHERE case_id=? AND state='OPEN'`,
        binds: ["CASE-X"],
      },
      transition: {
        entityType: "CASE",
        entityId: "CASE-X",
        eventType: "CaseStateChanged",
        stateFrom: "OPEN",
        stateTo: "ESCALATED",
      },
    });
    expect(miss).toBe(false);

    const logs = await logsFor("CASE", "CASE-X");
    expect(logs).toHaveLength(1);
    expect(logs[0].state_from).toBe("OPEN");
    expect(logs[0].state_to).toBe("RESOLVED");
  });

  it("recordEntityTransition appends unconditionally", async () => {
    await recordEntityTransition(d1 as unknown as D1Database, {
      entityType: "BANK_ACCOUNT",
      entityId: "ACC-1",
      eventType: "AccountStatusChanged",
      stateFrom: "NORMAL",
      stateTo: "FROZEN",
      reasonCode: "SUSPECTED_FRAUD",
      actor: "BANK_001",
      payload: { ticket: "T-9" },
    });
    const logs = await logsFor("BANK_ACCOUNT", "ACC-1");
    expect(logs).toHaveLength(1);
    expect(logs[0].reason_code).toBe("SUSPECTED_FRAUD");
    expect(JSON.parse(logs[0].payload_json!)).toEqual({ ticket: "T-9" });
  });
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("Cases history", () => {
  it("records the full open → in-progress → resolved lifecycle", async () => {
    const db = d1 as unknown as D1Database;
    const caseId = await openCase(db, { reason_code: "TIMEOUT", opened_by: "ZC" });
    await updateCase(db, caseId, "IN_PROGRESS");
    await updateCase(db, caseId, "RESOLVED", "2026-05-27T00:00:00Z");

    const logs = await logsFor("CASE", caseId);
    expect(logs.map((l) => `${l.state_from}->${l.state_to}`)).toEqual([
      "null->OPEN",
      "OPEN->IN_PROGRESS",
      "IN_PROGRESS->RESOLVED",
    ]);
  });

  it("does not log a no-op transition to the same state", async () => {
    const db = d1 as unknown as D1Database;
    const caseId = await openCase(db, { reason_code: "TIMEOUT", opened_by: "ZC" });
    await updateCase(db, caseId, "OPEN");
    const logs = await logsFor("CASE", caseId);
    expect(logs).toHaveLength(1); // only the CaseOpened creation fact
  });
});

// ---------------------------------------------------------------------------
// PSPR
// ---------------------------------------------------------------------------

describe("PSPR history", () => {
  it("logs registration once and revocation once", async () => {
    const db = d1 as unknown as D1Database;
    await registerPspr(db, "PSPR-1", "002", "0020000001", "2999-01-01T00:00:00Z");
    // Duplicate register is an idempotent no-op → no second creation fact.
    await registerPspr(db, "PSPR-1", "002", "0020000001", "2999-01-01T00:00:00Z");
    await revokePspr(db, "PSPR-1");
    // Second revoke is a no-op → no spurious fact.
    await revokePspr(db, "PSPR-1");

    const logs = await logsFor("PSPR", "PSPR-1");
    expect(logs.map((l) => `${l.state_from}->${l.state_to}`)).toEqual([
      "null->ACTIVE",
      "ACTIVE->REVOKED",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Bank account status
// ---------------------------------------------------------------------------

describe("BankAccounts status history", () => {
  function seedAccount() {
    d1.prepare(
      `INSERT INTO BankAccounts
       (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES ('ACC-001', '001', 'CUST-1', 'Test', 'SAVINGS', 'NORMAL', 't')`
    )._runSync();
  }

  function patchReq(status: string, reason?: string): Request {
    return new Request("https://x/bank/001/v1/teller/accounts/ACC-001", {
      method: "PATCH",
      headers: { "X-Bank-Id": "001", "X-Teller-Id": "T-1", "Content-Type": "application/json" },
      body: JSON.stringify({ status, reason }),
    });
  }

  it("records freeze → close transitions with reason", async () => {
    seedAccount();
    const env = makeEnv();
    await handleUpdateAccountStatus(patchReq("FROZEN", "AML_HIT"), "001", "ACC-001", env);
    await handleUpdateAccountStatus(patchReq("CLOSED", "CUSTOMER_REQUEST"), "001", "ACC-001", env);

    const logs = await logsFor("BANK_ACCOUNT", "ACC-001");
    expect(logs.map((l) => `${l.state_from}->${l.state_to}`)).toEqual([
      "NORMAL->FROZEN",
      "FROZEN->CLOSED",
    ]);
    expect(logs[0].reason_code).toBe("AML_HIT");
  });

  it("does not log when re-applying the current status", async () => {
    seedAccount();
    const env = makeEnv();
    await handleUpdateAccountStatus(patchReq("NORMAL"), "001", "ACC-001", env);
    const logs = await logsFor("BANK_ACCOUNT", "ACC-001");
    expect(logs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reversals
// ---------------------------------------------------------------------------

describe("Reversal record history", () => {
  /** SETTLED tx + the payee-bank CREDIT_FAILED_PROOF that opens the Reversal
   *  gate (docs/specs/10_requirements.md §4.3.0 第1層) — fixture, not the subject here. */
  async function seedSettledTx(txid: string, amount = 500000) {
    d1.prepare(
      `INSERT INTO Transactions
       (txid, lane, state, amount_value, amount_currency,
        payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
        idempotency_key, schema_version, version, created_at, updated_at)
       VALUES (?, 'STANDARD', 'SETTLED', ?, 'JPY',
               '001', '0010000001', '002', '0020000001',
               ?, '1.0', 0, 't', 't')`
    )
      .bind(txid, amount, `IK-${txid}`)
      ._runSync();
    await submitCreditFailedProof(d1 as unknown as D1Database, txid, {
      proof_ref: `PROOF-${txid}`,
      bank_id: "002",
    });
  }

  it("records requested → tx_created → completed", async () => {
    await seedSettledTx("TX-ORIG-1");
    const env = makeEnv();
    const res = await requestReversal(
      {
        original_txid: "TX-ORIG-1",
        reason: "DUPLICATE_PAYMENT",
        requested_by: "001",
        idempotency_key: "ik-rev-1",
      },
      env
    );
    expect(res.result).toBe("REVERSAL_CREATED");

    await completeReversal(res.reversal_txid!, d1 as unknown as D1Database);

    const logs = await logsFor("REVERSAL", res.reversal_id);
    expect(logs.map((l) => `${l.state_from}->${l.state_to}`)).toEqual([
      "null->REQUESTED",
      "REQUESTED->TX_CREATED",
      "TX_CREATED->COMPLETED",
    ]);
  });
});
