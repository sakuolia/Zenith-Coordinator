/**
 * @file explain.test.ts — explainTransaction state-summary contract.
 *
 * The core "explicability" promise (基本コンセプト：状態変化の理由を説明可能に)
 * requires that the operator-facing `/explain` summary render a human-readable
 * sentence for EVERY transaction state — not the raw `状態: XXX` fallback.
 *
 * Regression guard: a prior version keyed the terminal failure summary as
 * "FAILED", but the real state is "FAILED_EXECUTION" (state machine has no
 * "FAILED"), so a failed transaction silently fell back to `状態: FAILED_EXECUTION`.
 * The exhaustiveness test below pins every ALLOWED_TRANSITIONS state to a real
 * summary so this cannot regress when a new state is introduced.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { explainTransaction } from "../../src/zc/query/explain";
import { ALLOWED_TRANSITIONS } from "../../src/zc/orchestrator/state_machine";

let d1: MockD1Database;

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
});

function insertTx(txid: string, state: string) {
  d1.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, created_at, updated_at, version)
     VALUES (?, 'EXPRESS', ?, 100000, 'JPY', '001', '001ACC', '002', '002ACC',
             ?, '1.0', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 0)`
  )
    .bind(txid, state, `IK-${txid}`)
    ._runSync();
}

describe("explainTransaction — state summary", () => {
  it("renders the human-readable failure summary for FAILED_EXECUTION (not a raw fallback)", async () => {
    insertTx("TX-EXPLAIN-FAIL", "FAILED_EXECUTION");
    const r = await explainTransaction(d1 as any, "TX-EXPLAIN-FAIL");
    expect(r).not.toBeNull();
    expect(r!.current_state).toBe("FAILED_EXECUTION");
    expect(r!.summary).toBe("実行エラーにより失敗しました");
    // Must not be the raw fallback label.
    expect(r!.summary).not.toContain("状態:");
  });

  it("has a non-fallback summary for EVERY transaction state", async () => {
    const allStates = Object.keys(ALLOWED_TRANSITIONS);
    expect(allStates.length).toBeGreaterThan(10);
    for (const state of allStates) {
      const txid = `TX-SUMMARY-${state}`;
      insertTx(txid, state);
      const r = await explainTransaction(d1 as any, txid);
      expect(r, `explain returned null for state ${state}`).not.toBeNull();
      expect(
        r!.summary.startsWith("状態:"),
        `state ${state} fell back to the raw "状態:" label instead of a human summary`
      ).toBe(false);
      expect(r!.summary.length).toBeGreaterThan(0);
    }
  });
});
