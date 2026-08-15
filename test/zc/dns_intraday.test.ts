/**
 * @file dns_intraday.test.ts — multiple intraday DNS cutoffs (24/365稼働,
 *       30_internal_design.md § 7). Each cutoff settles the current OPEN window and
 *       opens the next canonical `DNS-{CCY}-YYYYMMDD-NN` cycle.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { getOrCreateDnsCycle, runIntradayDnsCutoff } from "../../src/zc/settlement/dns";

const TODAY = "2025-06-18";
const NOW = `${TODAY}T01:00:00Z`;

let d1: MockD1Database;
function makeEnv(db: MockD1Database): any {
  return { DB: db, QUEUE: { send: async () => {} } };
}

/** Insert a settled-ready tx that kickDns will sweep into the OPEN cycle. */
function insertTx(db: MockD1Database, txid: string, amount = 1000) {
  db.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash,
      payee_bank_id, payee_account_hash, idempotency_key, schema_version, dns_cycle_id,
      created_at, updated_at, version)
     VALUES (?, 'EXPRESS', 'DECIDED_TO_SETTLE', ?, 'JPY', '001', '0010000001', '002', '0020000001',
             ?, '1.0', NULL, ?, ?, 0)`
  )
    .bind(txid, amount, `IK-${txid}`, NOW, NOW)
    ._runSync();
}

beforeEach(() => {
  ({ d1 } = createTestDb()); // seeds 001/002 with BOJ prefund + accounts
});

describe("runIntradayDnsCutoff", () => {
  it("settles the current OPEN window and opens the next intraday cycle", async () => {
    const first = await getOrCreateDnsCycle(d1 as any, NOW, "JPY");
    expect(first).toBe(`DNS-${TODAY}`);
    insertTx(d1, "TX-IC-1");

    const r1 = await runIntradayDnsCutoff(TODAY, makeEnv(d1), "JPY");
    expect(r1.cutoff).toBe(true);
    expect(r1.settled_cycle).toBe(`DNS-${TODAY}`);
    expect(r1.settled_state).toBe("SETTLED");
    expect(r1.opened_cycle).toBe("DNS-JPY-20250618-02");
    expect(r1.intraday_seq).toBe(2);

    // The closed cycle is SETTLED; the new one is OPEN.
    const closed = await d1
      .prepare(`SELECT state FROM DnsCycles WHERE cycle_id=?`)
      .bind(`DNS-${TODAY}`)
      .first<{ state: string }>();
    expect(closed?.state).toBe("SETTLED");
    const opened = await d1
      .prepare(`SELECT state, intraday_seq FROM DnsCycles WHERE cycle_id='DNS-JPY-20250618-02'`)
      .first<{ state: string; intraday_seq: number }>();
    expect(opened?.state).toBe("OPEN");
    expect(opened?.intraday_seq).toBe(2);

    // The cutoff is on the audit chain.
    const ev = await d1
      .prepare(
        `SELECT payload_json FROM FinalityLog WHERE event_type='DnsIntradayCutoff' AND gtid='DNS-JPY-20250618-02'`
      )
      .first<{ payload_json: string }>();
    expect(ev?.payload_json).toContain('"intraday_seq":2');
  });

  it("routes new transactions into the freshly opened window and can cut again", async () => {
    await getOrCreateDnsCycle(d1 as any, NOW, "JPY");
    insertTx(d1, "TX-IC-A");
    const r1 = await runIntradayDnsCutoff(TODAY, makeEnv(d1), "JPY");
    expect(r1.opened_cycle).toBe("DNS-JPY-20250618-02");

    // A new tx after the cutoff is assigned to the new OPEN cycle by getOrCreateDnsCycle.
    const cur = await getOrCreateDnsCycle(d1 as any, NOW, "JPY");
    expect(cur).toBe("DNS-JPY-20250618-02");
    insertTx(d1, "TX-IC-B", 2000);

    // Second cutoff settles -02 and opens -03.
    const r2 = await runIntradayDnsCutoff(TODAY, makeEnv(d1), "JPY");
    expect(r2.settled_cycle).toBe("DNS-JPY-20250618-02");
    expect(r2.opened_cycle).toBe("DNS-JPY-20250618-03");
    expect(r2.intraday_seq).toBe(3);

    const settled2 = await d1
      .prepare(`SELECT state FROM DnsCycles WHERE cycle_id='DNS-JPY-20250618-02'`)
      .first<{ state: string }>();
    expect(settled2?.state).toBe("SETTLED");
  });

  it("is a no-op when there is no OPEN cycle to close", async () => {
    const r = await runIntradayDnsCutoff(TODAY, makeEnv(d1), "JPY");
    expect(r.cutoff).toBe(false);
  });
});
