/**
 * @file Tests for the scheduled FinalityLog chain audit (zc/finality_audit.ts).
 *
 * Covers:
 * - clean chains pass with no CASE opened
 * - tampering (mutating a stored payload_json) is detected and converges to a CASE
 * - the audit records its own verdict as a GLOBAL-chain FinalityLog event
 * - repeated runs do not pile up duplicate CASEs for the same broken chain
 * - a broken gtid chain routes the CASE to related_gtid rather than related_txid
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { writeFinalityLog } from "../../src/zc/orchestrator";
import { runFinalityChainAudit, FINALITY_CHAIN_BROKEN } from "../../src/zc/finality/finality_audit";
import { escalateOverdueCases } from "../../src/zc/cases/case";

function makeEnv(db: MockD1Database): any {
  return { DB: db, QUEUE: { send: async () => {} } };
}

let d1: MockD1Database;

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
});

/** Append a valid (correctly hash-chained) FinalityLog entry for a txid chain. */
async function appendTxEntry(txid: string, eventType: string, stateFrom: string, stateTo: string) {
  await writeFinalityLog(d1 as any, {
    txid,
    event_type: eventType,
    state_from: stateFrom,
    state_to: stateTo,
    payload_json: JSON.stringify({ txid, note: `${stateFrom}->${stateTo}` }),
    txid_or_gtid: txid,
  });
}

/** Append a valid FinalityLog entry on a gtid chain (txid null). */
async function appendGtidEntry(gtid: string, eventType: string, stateTo: string) {
  await writeFinalityLog(d1 as any, {
    txid: null,
    event_type: eventType,
    state_from: null,
    state_to: stateTo,
    payload_json: JSON.stringify({ gtid }),
    txid_or_gtid: gtid,
  });
}

describe("runFinalityChainAudit — clean chains", () => {
  it("passes when every chain is intact and opens no CASE", async () => {
    await appendTxEntry("TX-A", "PaymentInitiated", "", "RECEIVED");
    await appendTxEntry("TX-A", "PreCheckPassed", "RECEIVED", "PRECHECKED");
    await appendTxEntry("TX-B", "PaymentInitiated", "", "RECEIVED");

    const result = await runFinalityChainAudit(makeEnv(d1));

    expect(result.broken_chains.length).toBe(0);
    expect(result.cases_opened).toBe(0);
    expect(result.chains_checked).toBeGreaterThanOrEqual(2);
    expect(result.entries_checked).toBeGreaterThanOrEqual(3);

    const cases = await d1
      .prepare(`SELECT COUNT(*) AS cnt FROM Cases WHERE reason_code = ?`)
      .bind(FINALITY_CHAIN_BROKEN)
      .first<{ cnt: number }>();
    expect(cases?.cnt).toBe(0);
  });
});

describe("runFinalityChainAudit — tamper detection", () => {
  it("detects a mutated entry and opens a CASE linked to the txid", async () => {
    await appendTxEntry("TX-TAMPER", "PaymentInitiated", "", "RECEIVED");
    await appendTxEntry("TX-TAMPER", "PreCheckPassed", "RECEIVED", "PRECHECKED");

    // Silently rewrite history: mutate a stored payload without re-hashing.
    await d1
      .prepare(`UPDATE FinalityLog SET payload_json = ? WHERE txid = ? AND state_to = 'RECEIVED'`)
      .bind(JSON.stringify({ txid: "TX-TAMPER", note: "TAMPERED" }), "TX-TAMPER")
      .run();

    const result = await runFinalityChainAudit(makeEnv(d1));

    expect(result.broken_chains.length).toBe(1);
    expect(result.broken_chains[0]!.chain_id).toBe("TX-TAMPER");
    expect(result.broken_chains[0]!.break_reason).toBe("ENTRY_HASH_MISMATCH");
    expect(result.cases_opened).toBe(1);

    const caseRow = await d1
      .prepare(`SELECT related_txid, related_gtid, state FROM Cases WHERE reason_code = ? LIMIT 1`)
      .bind(FINALITY_CHAIN_BROKEN)
      .first<{ related_txid: string | null; related_gtid: string | null; state: string }>();
    expect(caseRow?.related_txid).toBe("TX-TAMPER");
    expect(caseRow?.related_gtid).toBeNull();
    expect(caseRow?.state).toBe("OPEN");
  });

  it("records its verdict as a GLOBAL-chain FinalityChainAuditFailed event", async () => {
    await appendTxEntry("TX-TAMPER2", "PaymentInitiated", "", "RECEIVED");
    await d1
      .prepare(`UPDATE FinalityLog SET state_to = 'PRECHECKED' WHERE txid = ?`)
      .bind("TX-TAMPER2")
      .run();

    await runFinalityChainAudit(makeEnv(d1));

    const verdict = await d1
      .prepare(
        `SELECT txid, gtid, state_to FROM FinalityLog WHERE event_type = 'FinalityChainAuditFailed'`
      )
      .first<{ txid: string | null; gtid: string | null; state_to: string }>();
    expect(verdict).not.toBeNull();
    expect(verdict?.txid).toBeNull();
    expect(verdict?.gtid).toBeNull();
    expect(verdict?.state_to).toBe("AUDIT_FAILED");
  });

  it("does not open a duplicate CASE on a second run for the same broken chain", async () => {
    await appendTxEntry("TX-DUP", "PaymentInitiated", "", "RECEIVED");
    await d1
      .prepare(`UPDATE FinalityLog SET payload_json = '{"x":1}' WHERE txid = ?`)
      .bind("TX-DUP")
      .run();

    const first = await runFinalityChainAudit(makeEnv(d1));
    expect(first.cases_opened).toBe(1);

    const second = await runFinalityChainAudit(makeEnv(d1));
    // Still reported as broken, but no new CASE.
    expect(second.broken_chains.length).toBe(1);
    expect(second.cases_opened).toBe(0);

    const cases = await d1
      .prepare(`SELECT COUNT(*) AS cnt FROM Cases WHERE reason_code = ?`)
      .bind(FINALITY_CHAIN_BROKEN)
      .first<{ cnt: number }>();
    expect(cases?.cnt).toBe(1);
  });

  it("does not open a duplicate CASE after the SLA sweep escalated the first one", async () => {
    // The break outlives PR-CASE-SLA — chain corruption is the longest-lived
    // alarm the system has — so §10.7.4's sweep promotes the CASE to ESCALATED
    // while the chain is still broken. De-duplication keyed on state='OPEN'
    // would stop matching here and file a fresh CASE on every subsequent run.
    await appendTxEntry("TX-ESC", "PaymentInitiated", "", "RECEIVED");
    await d1
      .prepare(`UPDATE FinalityLog SET payload_json = '{"x":1}' WHERE txid = ?`)
      .bind("TX-ESC")
      .run();

    expect((await runFinalityChainAudit(makeEnv(d1))).cases_opened).toBe(1);

    const past = new Date(Date.now() - 3600_000).toISOString();
    await d1
      .prepare(`UPDATE Cases SET sla_deadline = ? WHERE reason_code = ?`)
      .bind(past, FINALITY_CHAIN_BROKEN)
      .run();
    expect(await escalateOverdueCases(d1 as any, new Date().toISOString())).toBe(1);

    const after = await runFinalityChainAudit(makeEnv(d1));
    expect(after.broken_chains.length).toBe(1);
    expect(after.cases_opened).toBe(0);

    const cases = await d1
      .prepare(`SELECT COUNT(*) AS cnt FROM Cases WHERE reason_code = ?`)
      .bind(FINALITY_CHAIN_BROKEN)
      .first<{ cnt: number }>();
    expect(cases?.cnt).toBe(1);
  });

  it("routes a broken LSM run chain to related_gtid, not related_txid", async () => {
    // `LSM-*` (a Bulk LSM optimiser run) is stored in the gtid column like
    // GT-/GTID-/DNS-. Classifying it as a transaction id would write a
    // related_txid that points at no transaction.
    await appendGtidEntry("LSM-1", "LsmRunCommitted", "OPTIMAL");
    await appendGtidEntry("LSM-1", "LsmRunCommitted", "OPTIMAL");
    await d1
      .prepare(
        `UPDATE FinalityLog SET payload_json = '{"hacked":true}' WHERE gtid = ? AND event_seq = 1`
      )
      .bind("LSM-1")
      .run();

    const result = await runFinalityChainAudit(makeEnv(d1));
    expect(result.cases_opened).toBe(1);

    const caseRow = await d1
      .prepare(`SELECT related_txid, related_gtid FROM Cases WHERE reason_code = ? LIMIT 1`)
      .bind(FINALITY_CHAIN_BROKEN)
      .first<{ related_txid: string | null; related_gtid: string | null }>();
    expect(caseRow?.related_gtid).toBe("LSM-1");
    expect(caseRow?.related_txid).toBeNull();
  });

  it("routes a broken gtid chain to related_gtid", async () => {
    await appendGtidEntry("GTID-X", "GtidRegistered", "GT_RECEIVED");
    await appendGtidEntry("GTID-X", "GtidDecided", "GT_DECIDED_TO_SETTLE");
    await d1
      .prepare(
        `UPDATE FinalityLog SET payload_json = '{"hacked":true}' WHERE gtid = ? AND state_to = 'GT_RECEIVED'`
      )
      .bind("GTID-X")
      .run();

    const result = await runFinalityChainAudit(makeEnv(d1));
    expect(result.cases_opened).toBe(1);

    const caseRow = await d1
      .prepare(`SELECT related_txid, related_gtid FROM Cases WHERE reason_code = ? LIMIT 1`)
      .bind(FINALITY_CHAIN_BROKEN)
      .first<{ related_txid: string | null; related_gtid: string | null }>();
    expect(caseRow?.related_gtid).toBe("GTID-X");
    expect(caseRow?.related_txid).toBeNull();
  });
});
