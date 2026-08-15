/**
 * @file query_freshness.test.ts — what `freshness_level` actually measures.
 *
 * The indicator answers one question: **is the derived view caught up with the
 * source of truth?** It used to answer a different one — "how long ago did this
 * transaction last move" — which turned every normally completed transaction RED
 * a minute after it settled. Since the counter-desk template maps RED to
 * "queries are congested" (docs/specs/30_internal_design.md §13.6), that reading made the
 * system misinform customers about perfectly healthy payments.
 *
 * The regression these tests hold shut: age must not affect freshness; lag must.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { handleGetTransaction } from "../../src/zc/query/query";
import type { Env } from "../../src/types";

let d1: MockD1Database;

beforeEach(() => {
  ({ d1 } = createTestDb());
});

const makeEnv = () => ({ DB: d1 as unknown as D1Database }) as unknown as Env;

/** A transaction whose derived row was last projected at `projectedAt`. */
function seedTx(txid: string, state: string, projectedAt: string) {
  d1.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, version, created_at, updated_at)
     VALUES (?, 'STANDARD', ?, 1000, 'JPY', '001', '0010000001', '002', '0020000001',
             ?, '1.0', 0, ?, ?)`
  )
    .bind(txid, state, `IK-${txid}`, projectedAt, projectedAt)
    ._runSync();
}

/** A committed SoT fact for `txid` at `occurredAt`, ahead of the projection. */
function seedSotFact(txid: string, occurredAt: string, seq: number) {
  d1.prepare(
    `INSERT INTO FinalityLog
     (log_id, txid, gtid, event_type, state_from, state_to, payload_json, event_seq, occurred_at)
     VALUES (?, ?, ?, 'Settled', 'PAYEE_EXEC_CONFIRMED', 'SETTLED', '{}', ?, ?)`
  )
    .bind(`FL-${txid}-${seq}`, txid, txid, seq, occurredAt)
    ._runSync();
}

async function freshnessOf(txid: string): Promise<string> {
  const res = await handleGetTransaction(txid, makeEnv());
  return ((await res.json()) as { freshness_level: string }).freshness_level;
}

describe("freshness_level — measures read-model lag, not transaction age", () => {
  it("stays GREEN for a transaction that settled long ago", async () => {
    // The regression: this used to be RED, and the counter would have been told
    // to say "queries are congested" about a payment that completed last year.
    const longAgo = "2020-01-01T00:00:00.000Z";
    seedTx("TX-OLD", "SETTLED", longAgo);
    seedSotFact("TX-OLD", longAgo, 1);
    expect(await freshnessOf("TX-OLD")).toBe("GREEN");
  });

  it("stays GREEN for a transaction with no SoT entries at all", async () => {
    seedTx("TX-BARE", "RECEIVED", "2020-01-01T00:00:00.000Z");
    expect(await freshnessOf("TX-BARE")).toBe("GREEN");
  });

  it("goes YELLOW when the projection trails the SoT by more than 10s", async () => {
    seedTx("TX-LAG-Y", "PAYER_EXEC_CONFIRMED", "2026-01-01T00:00:00.000Z");
    seedSotFact("TX-LAG-Y", "2026-01-01T00:00:30.000Z", 1); // 30s ahead
    expect(await freshnessOf("TX-LAG-Y")).toBe("YELLOW");
  });

  it("goes RED when the projection trails the SoT by a minute or more", async () => {
    seedTx("TX-LAG-R", "PAYER_EXEC_CONFIRMED", "2026-01-01T00:00:00.000Z");
    seedSotFact("TX-LAG-R", "2026-01-01T00:05:00.000Z", 1); // 5 minutes ahead
    expect(await freshnessOf("TX-LAG-R")).toBe("RED");
  });

  it("never reports negative lag when the projection is ahead of the log tip", async () => {
    // Clock skew between the projection write and the log entry must not flip the
    // indicator; a caught-up view is GREEN, not "impossibly fresh".
    seedTx("TX-SKEW", "SETTLED", "2026-01-01T00:00:10.000Z");
    seedSotFact("TX-SKEW", "2026-01-01T00:00:00.000Z", 1);
    expect(await freshnessOf("TX-SKEW")).toBe("GREEN");
  });

  it("reports the watermark alongside, so the lag claim is checkable", async () => {
    seedTx("TX-WM", "SETTLED", "2026-01-01T00:00:00.000Z");
    seedSotFact("TX-WM", "2026-01-01T00:00:00.000Z", 42);
    const res = await handleGetTransaction("TX-WM", makeEnv());
    expect((await res.json()) as { watermark: number }).toMatchObject({ watermark: 42 });
  });
});
