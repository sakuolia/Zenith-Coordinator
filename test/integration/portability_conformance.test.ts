/**
 * @file portability_conformance.test.ts — executable form of the storage-backend
 *       porting contract (docs/specs/30_internal_design.md §7 可搬性: dialect table + acceptance criteria).
 *
 * docs/specs/30_internal_design.md prescribes, in prose, the SQLite/D1 dialect idioms a real
 * distributed-SQL backend must reproduce when it replaces D1. This suite turns
 * the most load-bearing of those idioms into assertions so a porting engineer
 * has a concrete first gate: swap the adapter behind createTestDb, run this file,
 * and a green result means the four behaviors the payment core relies on hold.
 *
 * SCOPE / HONESTY: these run against the in-process better-sqlite3 adapter, so
 * they CODIFY the contract — they are not a substitute for running the full
 * chaos suite against a real multi-region cluster (30_internal_design.md §7 可搬性) or for
 * validating linearizability / split-brain safety (§3.3–3.4), which need the
 * actual backend. They pin the *semantics each idiom must preserve* so a port
 * that quietly changes one (e.g. a conditional INSERT that fires on a losing
 * CAS, or a non-atomic batch) fails loudly here rather than in production.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  prepareFinalityLogRow,
  buildFinalityLogConditionalInsert,
  writeFinalityLog,
} from "../../src/zc/orchestrator/finality";

let d1: MockD1Database;

async function seedTx(txid: string, state = "RECEIVED") {
  await d1
    .prepare(
      `INSERT INTO Transactions (txid, lane, state, amount_value, payer_bank_id, payer_account_hash, payee_bank_id, idempotency_key, version, created_at, updated_at)
       VALUES (?, 'EXPRESS', ?, 1000, '001', 'h:p', '002', ?, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    )
    .bind(txid, state, `IK-${txid}`)
    .run();
}

beforeEach(() => {
  ({ d1 } = createTestDb());
});

describe("portability contract: changes()-gated conditional FinalityLog INSERT", () => {
  it("does NOT write the log row when the preceding CAS UPDATE loses (changes()=0)", async () => {
    await seedTx("TX-CAS-1");
    const row = await prepareFinalityLogRow(d1 as any, {
      txid: "TX-CAS-1",
      event_type: "PreChecked",
      state_from: "RECEIVED",
      state_to: "PRECHECKED",
      payload_json: "{}",
      txid_or_gtid: "TX-CAS-1",
    });
    // Losing CAS: version guard does not match → UPDATE changes 0 rows.
    const res = await d1.batch([
      d1
        .prepare(
          `UPDATE Transactions SET state='PRECHECKED', version=version+1 WHERE txid=? AND version=999`
        )
        .bind("TX-CAS-1"),
      buildFinalityLogConditionalInsert(d1 as any, row),
    ]);
    expect(res[0]!.meta.changes).toBe(0);
    const got = await d1
      .prepare(`SELECT COUNT(*) AS n FROM FinalityLog WHERE log_id=?`)
      .bind(row.log_id)
      .first<{ n: number }>();
    expect(got?.n).toBe(0); // no orphan audit row on a losing CAS
  });

  it("DOES write the log row when the preceding CAS UPDATE wins (changes()>0)", async () => {
    await seedTx("TX-CAS-2");
    const row = await prepareFinalityLogRow(d1 as any, {
      txid: "TX-CAS-2",
      event_type: "PreChecked",
      state_from: "RECEIVED",
      state_to: "PRECHECKED",
      payload_json: "{}",
      txid_or_gtid: "TX-CAS-2",
    });
    const res = await d1.batch([
      d1
        .prepare(
          `UPDATE Transactions SET state='PRECHECKED', version=version+1 WHERE txid=? AND version=0`
        )
        .bind("TX-CAS-2"),
      buildFinalityLogConditionalInsert(d1 as any, row),
    ]);
    expect(res[0]!.meta.changes).toBe(1);
    const got = await d1
      .prepare(`SELECT COUNT(*) AS n FROM FinalityLog WHERE log_id=?`)
      .bind(row.log_id)
      .first<{ n: number }>();
    expect(got?.n).toBe(1);
  });
});

describe("portability contract: db.batch() is atomic (all-or-nothing)", () => {
  it("rolls back an earlier statement when a later one in the same batch throws", async () => {
    // Two inserts with the same PRIMARY KEY: the second violates UNIQUE and must
    // roll back the first (the batch is one implicit transaction).
    const ins = (suffix: string) =>
      d1
        .prepare(
          `INSERT INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
           VALUES ('999', ?, '/bank/999', 0, 0, 1, '2026-01-01T00:00:00Z')`
        )
        .bind(`Dup-${suffix}`);
    await expect(d1.batch([ins("a"), ins("b")])).rejects.toThrow();
    const got = await d1
      .prepare(`SELECT COUNT(*) AS n FROM Participants WHERE bank_id='999'`)
      .first<{ n: number }>();
    expect(got?.n).toBe(0); // first insert rolled back with the batch
  });
});

describe("portability contract: INSERT OR IGNORE is idempotent (not an error)", () => {
  it("a duplicate-PK INSERT OR IGNORE is a no-op", async () => {
    const sql = `INSERT OR IGNORE INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
                 VALUES ('888', 'X', '/bank/888', 0, 0, 1, '2026-01-01T00:00:00Z')`;
    const first = await d1.prepare(sql).run();
    const second = await d1.prepare(sql).run();
    expect(first.meta.changes).toBe(1);
    expect(second.meta.changes).toBe(0); // ignored, no throw
    const got = await d1
      .prepare(`SELECT COUNT(*) AS n FROM Participants WHERE bank_id='888'`)
      .first<{ n: number }>();
    expect(got?.n).toBe(1);
  });
});

describe("portability contract: event_seq allocation is strictly monotonic + unique", () => {
  it("sequential FinalityLog writes receive strictly increasing, unique event_seq", async () => {
    await seedTx("TX-SEQ-1");
    for (let i = 0; i < 5; i++) {
      await writeFinalityLog(d1 as any, {
        txid: "TX-SEQ-1",
        event_type: "Note",
        state_from: null,
        state_to: "RECEIVED",
        payload_json: JSON.stringify({ i }),
        txid_or_gtid: "TX-SEQ-1",
      });
    }
    const rows = await d1
      .prepare(`SELECT event_seq FROM FinalityLog ORDER BY event_seq ASC`)
      .all<{ event_seq: number }>();
    const seqs = (rows.results ?? []).map((r) => r.event_seq);
    expect(seqs.length).toBe(5);
    expect(new Set(seqs).size).toBe(5); // unique
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!); // strictly increasing
  });
});
