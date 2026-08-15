/**
 * @file reversal_gate.test.ts — layer 1 of the three-layer Reversal gate.
 *
 * docs/specs/10_requirements.md §4.3.0 makes Reversal an AND of three layers:
 *   1. cause of action  — the credit is *physically* impossible
 *   2. justification    — payee consent / court order / supervisory request
 *   3. business class   — the `reason` label (a label, never a permission)
 *
 * Layer 2 has been enforced for a while (`approval_ref`); layer 1 was documented
 * and then never wired, so `CUSTOMER_DISPUTE` alone could unwind a completed
 * settlement — exactly the "we took it back afterwards" class the rulebook bans.
 * These tests pin the gate and, just as importantly, pin what must NOT open it:
 * account-side conditions, which are absorbed as Custody by design.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { requestReversal, submitCreditFailedProof } from "../../src/zc/cases/reversal";
import type { Env } from "../../src/types";

let d1: MockD1Database;

beforeEach(() => {
  ({ d1 } = createTestDb());
});

function makeEnv(): Env {
  return {
    DB: d1 as unknown as D1Database,
    QUEUE: { send: async () => {} } as any,
    ZC_HMAC_SECRET: "",
  } as unknown as Env;
}

function seedTx(txid: string, state = "SETTLED", amount = 10_000) {
  d1.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, version, created_at, updated_at)
     VALUES (?, 'STANDARD', ?, ?, 'JPY', '001', '0010000001', '002', '0020000001',
             ?, '1.0', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
  )
    .bind(txid, state, amount, `IK-${txid}`)
    ._runSync();
}

const db = () => d1 as unknown as D1Database;

// ---------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------

describe("Reversal layer 1 — cause of action", () => {
  it("refuses a reversal with no CREDIT_FAILED_PROOF, and receives it as a CASE", async () => {
    seedTx("TX-NOCAUSE");
    const res = await requestReversal(
      {
        original_txid: "TX-NOCAUSE",
        reason: "CUSTOMER_DISPUTE",
        approval_ref: "PAYEE_CONSENT:CONS-1", // layer 2 satisfied — layer 1 is not
        requested_by: "002",
        idempotency_key: "ik-nocause",
      },
      makeEnv()
    );

    expect(res.result).toBe("REJECTED");
    expect(res.reason_code).toBe("CREDIT_FAILED_PROOF_REQUIRED");

    // §4.3.0-1: the dispute is not dropped on the floor. It is received as a
    // CASE and routed to inter-party resolution — a customer complaint is a real
    // event, it simply is not by itself grounds to unwind a settlement.
    expect(res.case_id).toMatch(/^CASE-/);
    const opened = await db()
      .prepare(`SELECT reason_code, related_txid, state FROM Cases WHERE case_id = ?`)
      .bind(res.case_id!)
      .first<{ reason_code: string; related_txid: string; state: string }>();
    expect(opened).toMatchObject({
      reason_code: "CREDIT_FAILED_PROOF_REQUIRED",
      related_txid: "TX-NOCAUSE",
      state: "OPEN",
    });

    // Nothing was minted.
    const recs = await db()
      .prepare(`SELECT COUNT(*) AS n FROM ReversalRecords WHERE original_txid = ?`)
      .bind("TX-NOCAUSE")
      .first<{ n: number }>();
    expect(recs?.n).toBe(0);
  });

  it("admits the reversal once the payee bank has proved the credit impossible", async () => {
    seedTx("TX-CAUSE");
    await submitCreditFailedProof(db(), "TX-CAUSE", {
      proof_ref: "PROOF-1",
      bank_id: "002",
      reason_code: "BENEFICIARY_RAIL_PERMANENTLY_UNREACHABLE",
    });

    const res = await requestReversal(
      {
        original_txid: "TX-CAUSE",
        reason: "DUPLICATE_PAYMENT",
        requested_by: "002",
        idempotency_key: "ik-cause",
      },
      makeEnv()
    );
    expect(res.result).toBe("REVERSAL_CREATED");
    expect(res.reversal_txid).toMatch(/^TX-REV-/);
  });

  it("still rejects a malformed amount before the gate, so bad input does not mint CASEs", async () => {
    // Ordering matters operationally: if the cause gate ran first, every typo in
    // an amount would leave a CASE behind for someone to close.
    seedTx("TX-BADAMT", "SETTLED", 1_000);
    const res = await requestReversal(
      {
        original_txid: "TX-BADAMT",
        amount: 9_999,
        reason: "DUPLICATE_PAYMENT",
        requested_by: "002",
        idempotency_key: "ik-badamt",
      },
      makeEnv()
    );
    expect(res.reason_code).toBe("INVALID_REVERSAL_AMOUNT");
    expect(res.case_id).toBeUndefined();
    const cases = await db().prepare(`SELECT COUNT(*) AS n FROM Cases`).first<{ n: number }>();
    expect(cases?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// What may be attested, and by whom
// ---------------------------------------------------------------------------

describe("submitCreditFailedProof — who may attest what", () => {
  it("rejects an account-side condition: that is Custody, not a cause of action", async () => {
    seedTx("TX-FROZEN");
    for (const reason of ["ACCOUNT_FROZEN", "ACCOUNT_CLOSED", "ACCOUNT_NOT_FOUND"]) {
      const res = await submitCreditFailedProof(db(), "TX-FROZEN", {
        proof_ref: "PROOF-X",
        bank_id: "002",
        reason_code: reason,
      });
      expect(res).toMatchObject({ ok: false, reason: "ACCOUNT_CONDITION_NOT_A_CAUSE" });
    }
    // …and the gate stays shut.
    const res = await requestReversal(
      {
        original_txid: "TX-FROZEN",
        reason: "DUPLICATE_PAYMENT",
        requested_by: "002",
        idempotency_key: "ik-frozen",
      },
      makeEnv()
    );
    expect(res.reason_code).toBe("CREDIT_FAILED_PROOF_REQUIRED");
  });

  it("rejects an attestation from anyone but the payee bank", async () => {
    seedTx("TX-WRONGISSUER");
    const res = await submitCreditFailedProof(db(), "TX-WRONGISSUER", {
      proof_ref: "PROOF-Y",
      bank_id: "001", // the payer bank
    });
    expect(res).toMatchObject({ ok: false, reason: "PROOF_ISSUER_MISMATCH" });
  });

  it("rejects a proof before b: there is nothing to reverse yet", async () => {
    seedTx("TX-PREB", "DECIDED_TO_SETTLE");
    const res = await submitCreditFailedProof(db(), "TX-PREB", {
      proof_ref: "PROOF-Z",
      bank_id: "002",
    });
    expect(res).toMatchObject({ ok: false, reason: "B_NOT_CONFIRMED" });
  });

  it("is idempotent and appends exactly one audit fact", async () => {
    seedTx("TX-IDEM");
    const first = await submitCreditFailedProof(db(), "TX-IDEM", {
      proof_ref: "PROOF-I",
      bank_id: "002",
    });
    const second = await submitCreditFailedProof(db(), "TX-IDEM", {
      proof_ref: "PROOF-I",
      bank_id: "002",
    });
    expect(first).toMatchObject({ ok: true, already: false });
    expect(second).toMatchObject({ ok: true, already: true });

    const logs = await db()
      .prepare(
        `SELECT COUNT(*) AS n FROM FinalityLog
         WHERE txid = ? AND event_type = 'CreditFailedProofSubmitted'`
      )
      .bind("TX-IDEM")
      .first<{ n: number }>();
    expect(logs?.n).toBe(1);
  });

  it("records the proof as evidence without moving the original", async () => {
    seedTx("TX-EVIDENCE");
    await submitCreditFailedProof(db(), "TX-EVIDENCE", {
      proof_ref: "PROOF-E",
      bank_id: "002",
    });
    const row = await db()
      .prepare(
        `SELECT state_from, state_to, payload_json FROM FinalityLog
         WHERE txid = ? AND event_type = 'CreditFailedProofSubmitted'`
      )
      .bind("TX-EVIDENCE")
      .first<{ state_from: string; state_to: string; payload_json: string }>();
    // The original's history is never rewritten (§4.3): the proof is a fact
    // *about* a SETTLED transaction, not a transition of it.
    expect(row?.state_from).toBe("SETTLED");
    expect(row?.state_to).toBe("SETTLED");
    expect(JSON.parse(row!.payload_json).bank_proof_ref).toMatchObject({
      issuer_bank_id: "002",
      proof_type: "CREDIT_FAILED_PROOF",
      proof_id: "PROOF-E",
    });

    const tx = await db()
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind("TX-EVIDENCE")
      .first<{ state: string }>();
    expect(tx?.state).toBe("SETTLED");
  });
});
