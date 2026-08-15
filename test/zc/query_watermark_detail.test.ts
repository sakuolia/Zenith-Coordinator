/**
 * @file query_watermark_detail.test.ts — the query response locates every log
 *       position it was read at, not just the transaction's own.
 *
 * The gap this closes (docs/specs/30_internal_design.md §13.6): a single
 * `MAX(event_seq)` over the transaction's chain cannot make a GTID answer
 * reproducible, because the decision that moved the leg was recorded on the GT
 * chain — a different hash chain with its own sequence. An auditor handed only
 * the leg's number has no way to re-derive what the response said.
 *
 * So the assertions here are about *coverage of chains*, not about magnitudes:
 * every chain carrying facts about the transaction appears as a key, and the
 * collapsed `watermark` never claims to be more current than the breakdown.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { handleGetTransaction } from "../../src/zc/query/query";
import type { Env } from "../../src/types";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";

let d1: MockD1Database;

beforeEach(() => {
  ({ d1 } = createTestDb());
});

const makeEnv = () => ({ DB: d1 as unknown as D1Database }) as unknown as Env;

function seedTx(txid: string, opts: { dnsCycleId?: string } = {}) {
  const at = "2026-01-01T00:00:00.000Z";
  d1.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, version, dns_cycle_id, created_at, updated_at)
     VALUES (?, 'STANDARD', 'SETTLED', 1000, 'JPY', '001', '0010000001', '002', '0020000001',
             ?, '1.0', 0, ?, ?, ?)`
  )
    .bind(txid, `IK-${txid}`, opts.dnsCycleId ?? null, at, at)
    ._runSync();
}

/** An entry on the transaction's own chain. */
function seedTxEntry(txid: string, seq: number) {
  d1.prepare(
    `INSERT INTO FinalityLog
     (log_id, txid, gtid, event_type, state_from, state_to, payload_json, event_seq, occurred_at)
     VALUES (?, ?, NULL, 'Settled', 'PAYEE_EXEC_CONFIRMED', 'SETTLED', '{}', ?, ?)`
  )
    .bind(`FL-${txid}-${seq}`, txid, seq, "2026-01-01T00:00:00.000Z")
    ._runSync();
}

/** An entry on a non-transaction chain (GT / DNS cycle): gtid set, txid NULL. */
function seedAggregateEntry(chainId: string, seq: number) {
  d1.prepare(
    `INSERT INTO FinalityLog
     (log_id, txid, gtid, event_type, state_from, state_to, payload_json, event_seq, occurred_at)
     VALUES (?, NULL, ?, 'GtidSettled', 'GT_DECIDED_TO_SETTLE', 'GT_SETTLED', '{}', ?, ?)`
  )
    .bind(`FL-${chainId}-${seq}`, chainId, seq, "2026-01-01T00:00:00.000Z")
    ._runSync();
}

function seedLeg(gtid: string, txid: string) {
  const at = "2026-01-01T00:00:00.000Z";
  d1.prepare(
    `INSERT INTO GtidTransactions
     (gtid, state, initiator_bank_id, total_amount, leg_count, version, created_at, updated_at)
     VALUES (?, 'GT_SETTLED', '001', 1000, 1, 0, ?, ?)`
  )
    .bind(gtid, at, at)
    ._runSync();
  d1.prepare(
    `INSERT INTO GtidLegs
     (leg_id, gtid, txid, role, bank_id, account_hash, amount_value, state, version, created_at, updated_at)
     VALUES (?, ?, ?, 'PAYER', '001', '0010000001', 1000, 'LEG_SETTLED', 0, ?, ?)`
  )
    .bind(`LEG-${txid}`, gtid, txid, at, at)
    ._runSync();
}

async function detailOf(txid: string) {
  const res = await handleGetTransaction(txid, makeEnv());
  return (await res.json()) as {
    watermark: number;
    watermark_detail: { shards: Record<string, number> };
  };
}

describe("watermark_detail — one key per chain the answer was read from", () => {
  it("reports the transaction's own chain for a plain transfer", async () => {
    seedTx("TX-PLAIN");
    seedTxEntry("TX-PLAIN", 7);
    const body = await detailOf("TX-PLAIN");
    expect(body.watermark_detail.shards).toEqual({ "TX:TX-PLAIN": 7 });
    expect(body.watermark).toBe(7);
  });

  it("adds the GT chain for a GTID leg — the chain its decision actually lives on", async () => {
    // The reproducibility gap in one case: the leg's own chain is at 7, but the
    // decision that settled it is entry 99 on the GT chain. A response carrying
    // only 7 cannot be re-derived.
    seedTx("TX-LEG");
    seedTxEntry("TX-LEG", 7);
    seedLeg("GTID-1", "TX-LEG");
    seedAggregateEntry("GTID-1", 99);

    const body = await detailOf("TX-LEG");
    expect(body.watermark_detail.shards).toEqual({ "TX:TX-LEG": 7, "GT:GTID-1": 99 });
    // The collapsed number must not understate the breakdown it summarises.
    expect(body.watermark).toBe(99);
  });

  it("adds the DNS cycle chain for a transfer snapshotted into a net cycle", async () => {
    seedTx("TX-DNS", { dnsCycleId: "DNS-20260101-01" });
    seedTxEntry("TX-DNS", 3);
    seedAggregateEntry("DNS-20260101-01", 55);

    const body = await detailOf("TX-DNS");
    expect(body.watermark_detail.shards).toEqual({
      "TX:TX-DNS": 3,
      "DNS:DNS-20260101-01": 55,
    });
  });

  it("reports a participating chain with no entries as 0 rather than omitting it", async () => {
    // "This chain exists and has nothing for you yet" is a different statement
    // from "there is no such chain", and only the first is true here.
    seedTx("TX-EMPTY", { dnsCycleId: "DNS-20260101-02" });
    seedTxEntry("TX-EMPTY", 4);

    const body = await detailOf("TX-EMPTY");
    expect(body.watermark_detail.shards).toEqual({
      "TX:TX-EMPTY": 4,
      "DNS:DNS-20260101-02": 0,
    });
  });

  it("keeps a leg's own chain separate from its GT chain", async () => {
    // A leg row written with both txid and gtid set belongs to the tx chain
    // (finality_chain.ts): it must not inflate the GT chain's watermark.
    seedTx("TX-BOTH");
    seedLeg("GTID-2", "TX-BOTH");
    d1.prepare(
      `INSERT INTO FinalityLog
       (log_id, txid, gtid, event_type, state_from, state_to, payload_json, event_seq, occurred_at)
       VALUES ('FL-BOTH', 'TX-BOTH', 'GTID-2', 'Settled', 'PAYEE_EXEC_CONFIRMED', 'SETTLED', '{}', 12, '2026-01-01T00:00:00.000Z')`
    )._runSync();

    const body = await detailOf("TX-BOTH");
    expect(body.watermark_detail.shards).toEqual({ "TX:TX-BOTH": 12, "GT:GTID-2": 0 });
  });

  it("is present even for a transaction with no log entries at all", async () => {
    seedTx("TX-NONE");
    const body = await detailOf("TX-NONE");
    expect(body.watermark_detail.shards).toEqual({ "TX:TX-NONE": 0 });
    expect(body.watermark).toBe(0);
  });
});
