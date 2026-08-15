/**
 * @file CASE SLA deadline and the Auto-Progress → Manual-Only promotion.
 *
 * docs/specs/20_method_design.md §10.7.4 has always required that a CASE which stops
 * progressing be escalated out of the automatic pool. Nothing could evaluate it:
 * `Cases` had no deadline column, so every CASE waited indefinitely and the rule
 * lived only in the document. These tests fix the behaviour that closes that gap.
 *
 * The load-bearing property is not "a column exists" but "a stalled CASE reaches
 * a person": an escalation that never fires is indistinguishable from the bug.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { CASE_SLA_SEC } from "../../src/shared/constants";
import { escalateOverdueCases, openCase, updateCase } from "../../src/zc/cases/case";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";

let d1: MockD1Database;

beforeEach(() => {
  d1 = createTestDb().d1;
});

const db = () => d1 as unknown as D1Database;

async function caseRow(caseId: string) {
  return await db()
    .prepare(`SELECT state, sla_deadline, evidence_refs FROM Cases WHERE case_id = ?`)
    .bind(caseId)
    .first<{ state: string; sla_deadline: string | null; evidence_refs: string | null }>();
}

describe("CASE SLA — every case carries a deadline", () => {
  it("openCase fills sla_deadline from the default when the caller gives none", async () => {
    const before = Date.now();
    const caseId = await openCase(db(), { reason_code: "EXEC_DELAY", opened_by: "ZC" });

    const row = await caseRow(caseId);
    expect(row?.sla_deadline, "a CASE without a deadline can never be escalated").not.toBeNull();

    const deadline = Date.parse(row!.sla_deadline!);
    expect(deadline).toBeGreaterThanOrEqual(before + CASE_SLA_SEC * 1000 - 5_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + CASE_SLA_SEC * 1000 + 5_000);
  });

  it("an explicit deadline and evidence_refs round-trip", async () => {
    const caseId = await openCase(db(), {
      reason_code: "PROOF_MISMATCH",
      opened_by: "OPS",
      sla_deadline: "2026-01-01T00:00:00.000Z",
      evidence_refs: ["EV-1", "EV-2"],
    });

    const row = await caseRow(caseId);
    expect(row?.sla_deadline).toBe("2026-01-01T00:00:00.000Z");
    expect(JSON.parse(row!.evidence_refs!)).toEqual(["EV-1", "EV-2"]);
  });
});

describe("CASE SLA — Auto-Progress → Manual-Only promotion (§10.7.4)", () => {
  it("escalates an overdue OPEN case", async () => {
    const caseId = await openCase(db(), {
      reason_code: "EXEC_DELAY",
      opened_by: "ZC",
      sla_deadline: "2020-01-01T00:00:00.000Z", // long past
    });

    const escalated = await escalateOverdueCases(db(), new Date().toISOString());

    expect(escalated).toBe(1);
    expect((await caseRow(caseId))?.state).toBe("ESCALATED");
  });

  it("escalates IN_PROGRESS too — being worked on is not the same as progressing", async () => {
    const caseId = await openCase(db(), {
      reason_code: "AUTHORITY_WAIT",
      opened_by: "OPS",
      sla_deadline: "2020-01-01T00:00:00.000Z",
    });
    await updateCase(db(), caseId, "IN_PROGRESS");

    await escalateOverdueCases(db(), new Date().toISOString());

    expect((await caseRow(caseId))?.state).toBe("ESCALATED");
  });

  it("leaves a case whose deadline has not passed alone", async () => {
    const caseId = await openCase(db(), { reason_code: "EXEC_DELAY", opened_by: "ZC" });

    const escalated = await escalateOverdueCases(db(), new Date().toISOString());

    expect(escalated).toBe(0);
    expect((await caseRow(caseId))?.state).toBe("OPEN");
  });

  it("does not reopen a RESOLVED case that happens to be past its deadline", async () => {
    // Resolution wins over the clock: escalating a closed case would manufacture
    // work out of an already-converged exception.
    const caseId = await openCase(db(), {
      reason_code: "EXEC_DELAY",
      opened_by: "ZC",
      sla_deadline: "2020-01-01T00:00:00.000Z",
    });
    await updateCase(db(), caseId, "RESOLVED", new Date().toISOString());

    const escalated = await escalateOverdueCases(db(), new Date().toISOString());

    expect(escalated).toBe(0);
    expect((await caseRow(caseId))?.state).toBe("RESOLVED");
  });

  it("is idempotent — a second sweep does not re-escalate", async () => {
    await openCase(db(), {
      reason_code: "EXEC_DELAY",
      opened_by: "ZC",
      sla_deadline: "2020-01-01T00:00:00.000Z",
    });

    expect(await escalateOverdueCases(db(), new Date().toISOString())).toBe(1);
    expect(await escalateOverdueCases(db(), new Date().toISOString())).toBe(0);
  });

  it("records the promotion in EntityStateLog so the escalation is auditable", async () => {
    const caseId = await openCase(db(), {
      reason_code: "EXEC_DELAY",
      opened_by: "ZC",
      sla_deadline: "2020-01-01T00:00:00.000Z",
    });
    await escalateOverdueCases(db(), new Date().toISOString());

    const log = await db()
      .prepare(
        `SELECT state_from, state_to FROM EntityStateLog
          WHERE entity_type='CASE' AND entity_id=? AND state_to='ESCALATED'`
      )
      .bind(caseId)
      .first<{ state_from: string; state_to: string }>();

    expect(log?.state_from).toBe("OPEN");
    expect(log?.state_to).toBe("ESCALATED");
  });
});
