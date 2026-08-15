/**
 * @file Integration tests for src/zc/platform/circuit_breaker.ts
 *
 * Verifies state transitions: CLOSED → OPEN → HALF_OPEN → CLOSED, plus the
 * bounded HALF_OPEN probe cap and the lifetime traffic counters introduced
 * in the schema.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  allowRequest,
  getCircuitStatus,
  recordFailure,
  recordSuccess,
} from "../../src/zc/platform/circuit_breaker";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";

const BANK_ID = "001";

let d1: MockD1Database;

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  // Participants テーブルに行を追加（circuit_breaker は bank_id 存在を前提）
  db.prepare(
    `INSERT OR IGNORE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/001', 1000000, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(BANK_ID)
    ._runSync();
});

async function tripOpen() {
  // FAILURE_THRESHOLD = 5
  for (let i = 0; i < 5; i++) {
    await recordFailure(BANK_ID, d1 as any);
  }
}

async function rewindOpenedAt(seconds: number) {
  d1.prepare(`UPDATE CircuitBreakerState SET opened_at=? WHERE bank_id=?`)
    .bind(new Date(Date.now() - seconds * 1000).toISOString(), BANK_ID)
    ._runSync();
}

describe("initial state", () => {
  it("allows requests when no record exists (defaults to CLOSED)", async () => {
    expect(await allowRequest(BANK_ID, d1 as any)).toBe(true);
  });
});

describe("CLOSED → OPEN", () => {
  it("trips OPEN after 5 consecutive failures", async () => {
    await tripOpen();
    // Immediately after tripping, OPEN_DURATION_MS has not elapsed → deny
    expect(await allowRequest(BANK_ID, d1 as any)).toBe(false);
  });

  it("does not trip before reaching threshold", async () => {
    for (let i = 0; i < 4; i++) {
      await recordFailure(BANK_ID, d1 as any);
    }
    expect(await allowRequest(BANK_ID, d1 as any)).toBe(true);
  });
});

describe("OPEN → HALF_OPEN", () => {
  it("transitions to HALF_OPEN after OPEN_DURATION_MS (time-mocked)", async () => {
    await tripOpen();
    await rewindOpenedAt(60);

    // allowRequest should transition to HALF_OPEN and return true (probe)
    expect(await allowRequest(BANK_ID, d1 as any)).toBe(true);

    const row = await d1
      .prepare(`SELECT state FROM CircuitBreakerState WHERE bank_id=?`)
      .bind(BANK_ID)
      .first<{ state: string }>();
    expect(row?.state).toBe("HALF_OPEN");
  });
});

describe("HALF_OPEN → CLOSED (probe success)", () => {
  it("closes the circuit on a successful probe", async () => {
    await tripOpen();
    await rewindOpenedAt(60);
    await allowRequest(BANK_ID, d1 as any); // transitions to HALF_OPEN

    await recordSuccess(BANK_ID, d1 as any);

    const row = await d1
      .prepare(
        `SELECT state, consecutive_failures, half_open_inflight FROM CircuitBreakerState WHERE bank_id=?`
      )
      .bind(BANK_ID)
      .first<{ state: string; consecutive_failures: number; half_open_inflight: number }>();
    expect(row?.state).toBe("CLOSED");
    expect(row?.consecutive_failures).toBe(0);
    expect(row?.half_open_inflight).toBe(0);
  });
});

describe("HALF_OPEN → OPEN (probe failure)", () => {
  it("re-opens the circuit when the probe fails", async () => {
    await tripOpen();
    await rewindOpenedAt(60);
    await allowRequest(BANK_ID, d1 as any); // transitions to HALF_OPEN

    await recordFailure(BANK_ID, d1 as any);

    const row = await d1
      .prepare(`SELECT state, half_open_inflight FROM CircuitBreakerState WHERE bank_id=?`)
      .bind(BANK_ID)
      .first<{ state: string; half_open_inflight: number }>();
    expect(row?.state).toBe("OPEN");
    expect(row?.half_open_inflight).toBe(0);
  });

  it("resets opened_at so next HALF_OPEN probe waits a full OPEN_DURATION_MS", async () => {
    await tripOpen();
    await rewindOpenedAt(60);
    await allowRequest(BANK_ID, d1 as any); // HALF_OPEN

    const before = Date.now();
    await recordFailure(BANK_ID, d1 as any); // back to OPEN with new opened_at

    const row = await d1
      .prepare(`SELECT opened_at FROM CircuitBreakerState WHERE bank_id=?`)
      .bind(BANK_ID)
      .first<{ opened_at: string }>();
    const openedAt = new Date(row!.opened_at).getTime();
    // opened_at should be at or after the start of this test (not the old 60s-ago value)
    expect(openedAt).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe("HALF_OPEN probe cap", () => {
  // MAX_HALF_OPEN_PROBES = 3 in circuit_breaker.ts. The first allowRequest
  // promotes OPEN → HALF_OPEN and claims slot 1. Slots 2 and 3 follow. The
  // fourth concurrent request must be denied to prevent thundering the
  // recovering bank.
  it("admits up to MAX_HALF_OPEN_PROBES probes and denies the rest", async () => {
    await tripOpen();
    await rewindOpenedAt(60);

    // 1st: OPEN → HALF_OPEN, claims slot 1
    expect(await allowRequest(BANK_ID, d1 as any)).toBe(true);
    // 2nd, 3rd: claim slots 2 and 3 under HALF_OPEN
    expect(await allowRequest(BANK_ID, d1 as any)).toBe(true);
    expect(await allowRequest(BANK_ID, d1 as any)).toBe(true);
    // 4th: cap reached, must be denied
    expect(await allowRequest(BANK_ID, d1 as any)).toBe(false);

    const row = await d1
      .prepare(
        `SELECT state, half_open_inflight, total_denied FROM CircuitBreakerState WHERE bank_id=?`
      )
      .bind(BANK_ID)
      .first<{ state: string; half_open_inflight: number; total_denied: number }>();
    expect(row?.state).toBe("HALF_OPEN");
    expect(row?.half_open_inflight).toBe(3);
    expect(row?.total_denied).toBeGreaterThanOrEqual(1);
  });

  it("any single probe failure re-opens immediately, even with other probes still in flight", async () => {
    await tripOpen();
    await rewindOpenedAt(60);
    await allowRequest(BANK_ID, d1 as any); // slot 1
    await allowRequest(BANK_ID, d1 as any); // slot 2

    // Slot 1 fails before slot 2 returns
    await recordFailure(BANK_ID, d1 as any);

    const row = await d1
      .prepare(`SELECT state, half_open_inflight FROM CircuitBreakerState WHERE bank_id=?`)
      .bind(BANK_ID)
      .first<{ state: string; half_open_inflight: number }>();
    expect(row?.state).toBe("OPEN");
    expect(row?.half_open_inflight).toBe(0);
  });
});

describe("lifetime traffic metrics", () => {
  it("counts allowed requests, successes, and failures while CLOSED", async () => {
    await allowRequest(BANK_ID, d1 as any);
    await recordSuccess(BANK_ID, d1 as any);
    await allowRequest(BANK_ID, d1 as any);
    await recordFailure(BANK_ID, d1 as any);
    await allowRequest(BANK_ID, d1 as any);
    await recordSuccess(BANK_ID, d1 as any);

    const status = await getCircuitStatus(BANK_ID, d1 as any);
    expect(status?.total_requests).toBe(3);
    expect(status?.total_successes).toBe(2);
    expect(status?.total_failures).toBe(1);
    expect(status?.total_denied).toBe(0);
    expect(status?.last_success_at).not.toBeNull();
  });

  it("counts denials when the circuit is OPEN", async () => {
    await tripOpen(); // CLOSED → OPEN, no allowRequest calls yet
    await allowRequest(BANK_ID, d1 as any); // denied
    await allowRequest(BANK_ID, d1 as any); // denied

    const status = await getCircuitStatus(BANK_ID, d1 as any);
    expect(status?.total_denied).toBe(2);
    expect(status?.total_requests).toBe(0);
    expect(status?.total_failures).toBe(5); // from tripOpen()
  });
});

describe("recordSuccess in CLOSED state", () => {
  it("does nothing harmful when already CLOSED", async () => {
    await recordSuccess(BANK_ID, d1 as any);
    expect(await allowRequest(BANK_ID, d1 as any)).toBe(true);
  });
});

/**
 * An open breaker is ZC declining to call the bank — not the bank refusing the
 * posting. Both used to suspend the transaction as `EXEC_DEBIT_FAILED` /
 * `EXEC_CREDIT_FAILED`, which made an outage indistinguishable from a genuine
 * execution failure and broke the CASE aggregation of
 * docs/specs/20_method_design.md §10.9.3.6: one bank going dark produced N
 * execution-failure CASEs instead of one outage CASE.
 */
describe("adapter outage is distinguishable from execution failure (§10.8.4)", () => {
  it("suspends with SUSPEND_ADAPTER_DOWN when the breaker is open", async () => {
    await tripOpen();
    expect(await allowRequest(BANK_ID, d1 as any)).toBe(false);

    d1.prepare(
      `INSERT INTO Transactions
         (txid, lane, state, payer_bank_id, payer_account_hash, payee_bank_id,
          amount_value, amount_currency, idempotency_key, owner, version, created_at, updated_at)
       VALUES ('TX-CB-1','STANDARD','DECIDED_TO_SETTLE',?, 'PAYER-HASH', '002',
               1000, 'JPY', 'IDEM-CB-1', 'ZC', 1,
               '2025-01-01T00:00:00Z','2025-01-01T00:00:00Z')`
    )
      .bind(BANK_ID)
      ._runSync();

    const { processQueueMessage } = await import("../../src/zc/orchestrator");
    await processQueueMessage(
      {
        type: "ZC_BANK_DEBIT",
        payload: {
          txid: "TX-CB-1",
          payer_bank_id: BANK_ID,
          amount: { value: 1000, currency: "JPY" },
          decision_proof_ref: "DP-1",
          lane: "STANDARD",
        },
        txid: "TX-CB-1",
        attempt: 0,
        enqueued_at: "2025-01-01T00:00:00Z",
      } as never,
      {
        DB: d1 as unknown as D1Database,
        QUEUE: { send: async () => {} },
      } as never
    );

    const row = await (d1 as unknown as D1Database)
      .prepare(`SELECT state, reason_code FROM Transactions WHERE txid='TX-CB-1'`)
      .first<{ state: string; reason_code: string | null }>();

    expect(row?.state).toBe("SUSPENDED");
    expect(
      row?.reason_code,
      "an outage must not be recorded as an execution failure — CASE aggregation depends on the distinction"
    ).toBe("SUSPEND_ADAPTER_DOWN");
  });
});
