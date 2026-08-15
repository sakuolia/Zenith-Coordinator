/**
 * @file metrics.test.ts — operational metrics projection (src/zc/platform/metrics.ts).
 *
 * The metrics endpoint is a read-only projection of authoritative state, so the
 * tests seed state directly and assert the derived gauges + the Prometheus
 * rendering. No instrumentation hooks to mock — that is the whole point of
 * deriving observability from the system of record.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { collectOperationalMetrics, renderPrometheus } from "../../src/zc/platform/metrics";
import { activateBcpReadOnly } from "../../src/zc/platform/system_mode";

let d1: MockD1Database;

beforeEach(() => {
  d1 = createTestDb().d1;
});

function sample(
  metrics: Awaited<ReturnType<typeof collectOperationalMetrics>>,
  name: string,
  labels: Record<string, string> = {}
) {
  return metrics.samples.find(
    (s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v)
  );
}

async function insertTx(state: string, txid: string) {
  await d1
    .prepare(
      `INSERT INTO Transactions (txid, lane, state, amount_value, payer_bank_id, payer_account_hash, payee_bank_id, idempotency_key, version, created_at, updated_at)
       VALUES (?, 'EXPRESS', ?, 1000, '001', 'h:p', '002', ?, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    )
    .bind(txid, state, `IK-${txid}`)
    .run();
}

async function insertCase(reason: string, state: string, createdAt: string) {
  await d1
    .prepare(
      `INSERT INTO Cases (case_id, related_txid, related_gtid, state, reason_code, description, opened_by, created_at, updated_at)
       VALUES (?, NULL, NULL, ?, ?, 'x', 'ZC', ?, ?)`
    )
    .bind(`CASE-${reason}-${state}-${createdAt}`, state, reason, createdAt, createdAt)
    .run();
}

describe("collectOperationalMetrics", () => {
  it("reports system mode and the read-only flag", async () => {
    const normal = await collectOperationalMetrics(d1 as any);
    expect(sample(normal, "zc_system_mode", { mode: "NORMAL" })?.value).toBe(1);
    expect(sample(normal, "zc_read_only")?.value).toBe(0);

    await activateBcpReadOnly({ DB: d1 } as any, "drill");
    const ro = await collectOperationalMetrics(d1 as any);
    expect(sample(ro, "zc_system_mode", { mode: "BCP_READONLY" })?.value).toBe(1);
    expect(sample(ro, "zc_read_only")?.value).toBe(1);
  });

  it("counts open CASEs by reason, totals, and the oldest age — excluding RESOLVED", async () => {
    await insertCase("WATCHER_EQUIVOCATION", "OPEN", "2026-06-30T00:00:00Z");
    await insertCase("TIMEOUT", "IN_PROGRESS", "2020-01-01T00:00:00Z"); // very old
    await insertCase("TIMEOUT", "RESOLVED", "2019-01-01T00:00:00Z"); // excluded

    const m = await collectOperationalMetrics(d1 as any);
    expect(sample(m, "zc_cases_open_total")?.value).toBe(2);
    expect(
      sample(m, "zc_cases_open_by_reason", { reason_code: "WATCHER_EQUIVOCATION" })?.value
    ).toBe(1);
    expect(sample(m, "zc_cases_open_by_reason", { reason_code: "TIMEOUT" })?.value).toBe(1);
    // Oldest open case is the 2020 one → age is large (years of seconds).
    expect(sample(m, "zc_cases_open_age_seconds_max")!.value).toBeGreaterThan(100_000_000);
  });

  it("groups transactions by state and counts cross-chain quorum-pending HTLCs", async () => {
    await insertTx("SETTLED", "TX-1");
    await insertTx("SUSPENDED", "TX-2");
    await insertTx("HTLC_ONCHAIN_PENDING", "TX-3");
    // An HtlcContracts row in HTLC_ONCHAIN_PENDING (FK requires the tx to exist).
    await d1
      .prepare(
        `INSERT INTO HtlcContracts (htlc_id, txid, state, hashlock, timelock, amount_value, payer_bank_id, payee_bank_id, version, created_at, updated_at)
         VALUES ('H-1', 'TX-3', 'HTLC_ONCHAIN_PENDING', 'deadbeef', '2026-12-31T00:00:00Z', 1000, '001', '002', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
      )
      .run();

    const m = await collectOperationalMetrics(d1 as any);
    expect(sample(m, "zc_transactions_by_state", { state: "SETTLED" })?.value).toBe(1);
    expect(sample(m, "zc_transactions_by_state", { state: "SUSPENDED" })?.value).toBe(1);
    expect(sample(m, "zc_htlc_onchain_quorum_pending")?.value).toBe(1);
  });

  it("exposes the FinalityLog event_seq high-water mark as a liveness gauge", async () => {
    const empty = await collectOperationalMetrics(d1 as any);
    expect(sample(empty, "zc_finality_event_seq_high_watermark")?.value).toBe(0);

    await d1
      .prepare(
        `INSERT INTO FinalityLog (log_id, txid, event_type, state_to, payload_json, event_seq, occurred_at, prev_hash, entry_hash)
         VALUES ('FL-1', 'TX-1', 'PaymentInitiated', 'RECEIVED', '{}', 42, '2026-01-01T00:00:00Z', 'GENESIS', 'h')`
      )
      .run();
    const m = await collectOperationalMetrics(d1 as any);
    expect(sample(m, "zc_finality_event_seq_high_watermark")?.value).toBe(42);
  });
});

describe("renderPrometheus", () => {
  it("emits one HELP/TYPE per metric name and escapes label values", async () => {
    await insertCase('weird"\\name', "OPEN", "2026-06-30T00:00:00Z");
    const text = renderPrometheus(await collectOperationalMetrics(d1 as any));

    // HELP/TYPE appear exactly once for a repeated metric name.
    expect((text.match(/# TYPE zc_system_mode gauge/g) ?? []).length).toBe(1);
    expect(text).toContain("# HELP zc_cases_open_total");
    // The label value's quote and backslash are escaped.
    expect(text).toContain('reason_code="weird\\"\\\\name"');
    // A no-label gauge renders without braces.
    expect(text).toMatch(/zc_cases_open_total \d+/);
  });
});
