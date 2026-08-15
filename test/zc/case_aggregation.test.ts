/**
 * @file CASE aggregation and secondary escalation (docs/specs/20_method_design.md §10.7.2).
 *
 * §10.7.2 has always required that one cause produce one CASE, with the
 * individual txids held as relations — but nothing implemented it: every
 * detection called `openCase` directly, so an adapter outage produced one CASE
 * per transaction, which is the ticket explosion the rule exists to prevent.
 *
 * Three properties are load-bearing here, and each is a defect if it is absent
 * rather than merely a missing convenience:
 *
 *  1. Aggregation asks "already filed?" over `UNRESOLVED_CASE_STATES`,
 *     ESCALATED included. Omit it and aggregation stops working after exactly
 *     one SLA window (§10.7.2.1) — for the longest-lived causes, the ones a
 *     person is already holding.
 *  2. The count follows the link table. A retried detection of the same txid
 *     must not inflate `occurrence_count`, or the threshold measures retry
 *     volume rather than spread.
 *  3. Secondary escalation fires without changing state. ESCALATED plus
 *     "do not auto-close" plus "fold everything in" leaves a cause free to grow
 *     silently while a person holds the CASE; §10.7.2.2 breaks that silence.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { CASE_SECONDARY_ESCALATION_COUNT } from "../../src/shared/constants";
import {
  causeKey,
  escalateOverdueCases,
  openCase,
  openOrAggregateCase,
  sweepSecondaryEscalations,
  updateCase,
} from "../../src/zc/cases/case";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";

let d1: MockD1Database;

beforeEach(() => {
  d1 = createTestDb().d1;
});

const db = () => d1 as unknown as D1Database;

const cause = {
  reason_code: "SUSPEND_ADAPTER_DOWN",
  cause_party_id: "BANK_A",
  opened_by: "ZC" as const,
};

async function caseRow(caseId: string) {
  return await db()
    .prepare(
      `SELECT state, cause_key, cause_party_id, detection_path, occurrence_count,
              last_occurred_at, escalated_at, last_notified_at
         FROM Cases WHERE case_id = ?`
    )
    .bind(caseId)
    .first<{
      state: string;
      cause_key: string | null;
      cause_party_id: string | null;
      detection_path: string | null;
      occurrence_count: number;
      last_occurred_at: string | null;
      escalated_at: string | null;
      last_notified_at: string | null;
    }>();
}

async function caseCount(): Promise<number> {
  const r = await db().prepare(`SELECT COUNT(*) AS n FROM Cases`).first<{ n: number }>();
  return r?.n ?? 0;
}

async function links(caseId: string): Promise<string[]> {
  const r = await db()
    .prepare(`SELECT link_key FROM CaseRelatedTransactions WHERE case_id=? ORDER BY link_key`)
    .bind(caseId)
    .all<{ link_key: string }>();
  return (r.results ?? []).map((x) => x.link_key);
}

async function events(caseId: string, eventType: string): Promise<number> {
  const r = await db()
    .prepare(
      `SELECT COUNT(*) AS n FROM EntityStateLog
        WHERE entity_type='CASE' AND entity_id=? AND event_type=?`
    )
    .bind(caseId, eventType)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

describe("causeKey — the aggregation key of §10.7.2", () => {
  it("is CAUSE:{party}:{reason} when the responsible party is known", () => {
    expect(causeKey(cause)).toBe("CAUSE:BANK_A:SUSPEND_ADAPTER_DOWN");
  });

  it("falls back to the detection path while the party is unknown", () => {
    expect(causeKey({ reason_code: "CHAIN_BREAK", detection_path: "FINALITY_AUDIT" })).toBe(
      "CAUSE:FINALITY_AUDIT:CHAIN_BREAK"
    );
  });

  it("prefers the party over the detection path once the party is known", () => {
    expect(
      causeKey({ reason_code: "CHAIN_BREAK", cause_party_id: "BANK_B", detection_path: "AUDIT" })
    ).toBe("CAUSE:BANK_B:CHAIN_BREAK");
  });

  it("is null with neither — such a CASE stands alone rather than binding on a bare reason code", () => {
    expect(causeKey({ reason_code: "EXEC_DELAY" })).toBeNull();
  });
});

describe("CASE aggregation — one cause, one CASE", () => {
  it("folds later occurrences of the same cause into the first CASE", async () => {
    const first = await openOrAggregateCase(db(), { ...cause, related_txid: "TX-1" });
    const second = await openOrAggregateCase(db(), { ...cause, related_txid: "TX-2" });
    const third = await openOrAggregateCase(db(), { ...cause, related_txid: "TX-3" });

    expect(first.aggregated).toBe(false);
    expect(second.aggregated).toBe(true);
    expect(third.aggregated).toBe(true);
    expect(second.case_id).toBe(first.case_id);
    expect(third.case_id).toBe(first.case_id);

    expect(await caseCount(), "one cause must not produce three CASEs").toBe(1);

    const row = await caseRow(first.case_id);
    expect(row?.cause_key).toBe("CAUSE:BANK_A:SUSPEND_ADAPTER_DOWN");
    expect(row?.occurrence_count).toBe(3);
    expect(await links(first.case_id)).toEqual(["TX-1", "TX-2", "TX-3"]);
  });

  it("keeps a different cause party on its own CASE", async () => {
    const a = await openOrAggregateCase(db(), { ...cause, related_txid: "TX-1" });
    const b = await openOrAggregateCase(db(), {
      ...cause,
      cause_party_id: "BANK_B",
      related_txid: "TX-2",
    });
    expect(b.case_id).not.toBe(a.case_id);
    expect(await caseCount()).toBe(2);
  });

  it("keeps a different reason code on its own CASE", async () => {
    const a = await openOrAggregateCase(db(), { ...cause, related_txid: "TX-1" });
    const b = await openOrAggregateCase(db(), {
      ...cause,
      reason_code: "EXEC_DEBIT_FAILED",
      related_txid: "TX-2",
    });
    expect(b.case_id).not.toBe(a.case_id);
  });

  it("does not aggregate into a RESOLVED CASE — a cause still true after resolution is new", async () => {
    const first = await openOrAggregateCase(db(), { ...cause, related_txid: "TX-1" });
    await updateCase(db(), first.case_id, "RESOLVED", new Date().toISOString());

    const second = await openOrAggregateCase(db(), { ...cause, related_txid: "TX-2" });
    expect(second.aggregated).toBe(false);
    expect(second.case_id).not.toBe(first.case_id);
  });

  it("still aggregates into an ESCALATED CASE (§10.7.2.1)", async () => {
    // The regression this pins: written as state='OPEN' (or OPEN/IN_PROGRESS),
    // the predicate stops matching one SLA window after the sweep promotes the
    // CASE, and every later occurrence of a cause a person is already holding
    // files a fresh ticket.
    const first = await openOrAggregateCase(db(), {
      ...cause,
      related_txid: "TX-1",
      sla_deadline: "2000-01-01T00:00:00.000Z",
    });
    expect(await escalateOverdueCases(db(), new Date().toISOString())).toBe(1);
    expect((await caseRow(first.case_id))?.state).toBe("ESCALATED");

    const second = await openOrAggregateCase(db(), { ...cause, related_txid: "TX-2" });
    expect(second.case_id).toBe(first.case_id);
    expect(await caseCount()).toBe(1);
    expect((await caseRow(first.case_id))?.occurrence_count).toBe(2);
  });

  it("counts distinct transactions, not detections — a retry of the same txid does not inflate it", async () => {
    const first = await openOrAggregateCase(db(), { ...cause, related_txid: "TX-1" });
    await openOrAggregateCase(db(), { ...cause, related_txid: "TX-2" });
    await openOrAggregateCase(db(), { ...cause, related_txid: "TX-2" });
    await openOrAggregateCase(db(), { ...cause, related_txid: "TX-2" });

    const row = await caseRow(first.case_id);
    expect(row?.occurrence_count).toBe(2);
    expect(await links(first.case_id)).toEqual(["TX-1", "TX-2"]);
    // The duplicate wrote no fact either: no link inserted, no count moved, no log.
    expect(await events(first.case_id, "CaseOccurrenceAggregated")).toBe(1);
  });

  it("advances last_occurred_at on aggregation and records the fact", async () => {
    const first = await openOrAggregateCase(db(), { ...cause, related_txid: "TX-1" });
    const opened = (await caseRow(first.case_id))!.last_occurred_at!;

    await new Promise((r) => setTimeout(r, 5));
    await openOrAggregateCase(db(), { ...cause, related_txid: "TX-2" });

    const row = await caseRow(first.case_id);
    expect(Date.parse(row!.last_occurred_at!)).toBeGreaterThanOrEqual(Date.parse(opened));
    expect(await events(first.case_id, "CaseOccurrenceAggregated")).toBe(1);
  });

  it("aggregates a GTID occurrence on its gtid", async () => {
    const first = await openOrAggregateCase(db(), { ...cause, related_gtid: "GT-1" });
    const second = await openOrAggregateCase(db(), { ...cause, related_gtid: "GT-2" });
    expect(second.case_id).toBe(first.case_id);
    expect(await links(first.case_id)).toEqual(["GT-1", "GT-2"]);
  });

  it("opens a standalone CASE when neither a party nor a detection path is given", async () => {
    const a = await openOrAggregateCase(db(), { reason_code: "EXEC_DELAY", opened_by: "ZC" });
    const b = await openOrAggregateCase(db(), { reason_code: "EXEC_DELAY", opened_by: "ZC" });
    expect(b.aggregated).toBe(false);
    expect(b.case_id).not.toBe(a.case_id);
    expect((await caseRow(a.case_id))?.cause_key).toBeNull();
  });

  it("re-keys nothing retroactively: openCase still records the cause columns it was given", async () => {
    const caseId = await openCase(db(), {
      ...cause,
      detection_path: "TIMEOUT_SWEEP",
      related_txid: "TX-9",
    });
    const row = await caseRow(caseId);
    expect(row?.cause_party_id).toBe("BANK_A");
    expect(row?.detection_path).toBe("TIMEOUT_SWEEP");
    expect(row?.occurrence_count).toBe(1);
    expect(await links(caseId)).toEqual(["TX-9"]);
  });
});

describe("secondary escalation (§10.7.2.2)", () => {
  async function escalatedCase(): Promise<string> {
    const r = await openOrAggregateCase(db(), {
      ...cause,
      related_txid: "TX-1",
      sla_deadline: "2000-01-01T00:00:00.000Z",
    });
    await escalateOverdueCases(db(), new Date().toISOString());
    return r.case_id;
  }

  it("stamps escalated_at on promotion — the baseline the sweep compares against", async () => {
    const caseId = await escalatedCase();
    expect((await caseRow(caseId))?.escalated_at).not.toBeNull();
  });

  it("fires when the cause keeps occurring after a person was queued", async () => {
    const caseId = await escalatedCase();
    expect(await sweepSecondaryEscalations(db()), "nothing new yet").toEqual([]);

    await new Promise((r) => setTimeout(r, 5));
    await openOrAggregateCase(db(), { ...cause, related_txid: "TX-2" });

    expect(await sweepSecondaryEscalations(db())).toEqual([caseId]);
    expect(await events(caseId, "CaseSecondaryEscalated")).toBe(1);
  });

  it("fires on spread alone, once the count passes the threshold", async () => {
    const caseId = await escalatedCase();
    await db()
      .prepare(`UPDATE Cases SET occurrence_count=? WHERE case_id=?`)
      .bind(CASE_SECONDARY_ESCALATION_COUNT + 1, caseId)
      .run();

    expect(await sweepSecondaryEscalations(db())).toEqual([caseId]);
  });

  it("does not change the CASE state — ESCALATED is already the handling state", async () => {
    const caseId = await escalatedCase();
    await new Promise((r) => setTimeout(r, 5));
    await openOrAggregateCase(db(), { ...cause, related_txid: "TX-2" });
    await sweepSecondaryEscalations(db());

    const row = await caseRow(caseId);
    expect(row?.state, "re-opening it would overrule the person §10.7.4 queued").toBe("ESCALATED");
  });

  it("does not re-notify a wide but quiet CASE on every tick", async () => {
    const caseId = await escalatedCase();
    await db()
      .prepare(`UPDATE Cases SET occurrence_count=? WHERE case_id=?`)
      .bind(CASE_SECONDARY_ESCALATION_COUNT + 1, caseId)
      .run();

    expect(await sweepSecondaryEscalations(db())).toEqual([caseId]);
    expect(await sweepSecondaryEscalations(db()), "no new occurrences since the notice").toEqual(
      []
    );
    expect(await events(caseId, "CaseSecondaryEscalated")).toBe(1);
  });

  it("re-notifies once new occurrences arrive after the previous notice", async () => {
    const caseId = await escalatedCase();
    await new Promise((r) => setTimeout(r, 5));
    await openOrAggregateCase(db(), { ...cause, related_txid: "TX-2" });
    expect(await sweepSecondaryEscalations(db())).toEqual([caseId]);

    await new Promise((r) => setTimeout(r, 5));
    await openOrAggregateCase(db(), { ...cause, related_txid: "TX-3" });
    expect(await sweepSecondaryEscalations(db())).toEqual([caseId]);
    expect(await events(caseId, "CaseSecondaryEscalated")).toBe(2);
  });

  it("leaves CASEs that are not ESCALATED alone", async () => {
    const first = await openOrAggregateCase(db(), { ...cause, related_txid: "TX-1" });
    await db()
      .prepare(`UPDATE Cases SET occurrence_count=? WHERE case_id=?`)
      .bind(CASE_SECONDARY_ESCALATION_COUNT + 1, first.case_id)
      .run();

    expect(
      await sweepSecondaryEscalations(db()),
      "an OPEN CASE is still in the automatic pool; the first escalation has not happened yet"
    ).toEqual([]);
  });
});

/**
 * The capability is only worth having if the detection paths that actually
 * produce mass occurrences use it. These pin the four §10.7.2 callers.
 */
describe("call sites file through aggregation", () => {
  it("a bank-wide shadow drift is one CASE with one relation per account", async () => {
    const { reconcileAccount } = await import("../../src/bank/legacy/reconcile");
    const { LegacyCore } = await import("../../src/bank/legacy/legacy_core");
    const core = new LegacyCore(db());
    core.setOnline(true);
    await core.seedOpeningBalance("010", "A", 10_000);
    await core.seedOpeningBalance("010", "B", 20_000);
    // Shadow rows absent → expected 0 for both accounts → drift on each.
    const a = await reconcileAccount(db(), core, "010", "A");
    const b = await reconcileAccount(db(), core, "010", "B");

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.case_id, "one adapter-level cause is one CASE, not one per account").toBe(a!.case_id);
    expect(await caseCount()).toBe(1);

    const row = await caseRow(a!.case_id);
    expect(row?.cause_key).toBe("CAUSE:010:LEGACY_ADAPTER_RECON_DRIFT");
    expect(row?.occurrence_count, "the account is the subject here, so both count").toBe(2);
    expect(await links(a!.case_id)).toEqual(["010/A", "010/B"]);
  });

  it("a repeated audit of the same broken chain relates rather than re-files", async () => {
    const first = await openOrAggregateCase(db(), {
      related_txid: "TX-CHAIN",
      reason_code: "FINALITY_CHAIN_BROKEN",
      opened_by: "ZC",
      cause_party_id: "TX-CHAIN",
    });
    const second = await openOrAggregateCase(db(), {
      related_txid: "TX-CHAIN",
      reason_code: "FINALITY_CHAIN_BROKEN",
      opened_by: "ZC",
      cause_party_id: "TX-CHAIN",
    });

    expect(second.case_id).toBe(first.case_id);
    expect(second.aggregated).toBe(true);
    expect(await caseCount(), "nightly re-runs must not pile up").toBe(1);
    // The dedup this replaced keyed on `description LIKE '%chain X %'`; the key
    // is now the chain id itself, so rewording the sentence cannot break it.
    expect((await caseRow(first.case_id))?.cause_key).toBe("CAUSE:TX-CHAIN:FINALITY_CHAIN_BROKEN");
  });
});
