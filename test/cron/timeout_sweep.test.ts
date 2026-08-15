/**
 * @file Tests for the per-minute timeout sweep (cron/timeout_sweep.ts).
 *
 * The sweep advances stale transactions through several timeout paths. The
 * focus here is the SUSPENDED → FAILED_EXECUTION path: FAILED_EXECUTION is a
 * *terminal* state, so the transition MUST leave a paired FinalityLog entry —
 * otherwise a transaction reaches its end state with no audit record, the exact
 * "state advanced without evidence" window the system forbids (design
 * principle #1). This previously used a raw UPDATE that skipped the log; these
 * tests guard against that regression.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { todayJST } from "../../src/types";
import { runTimeoutSweep } from "../../src/cron/timeout_sweep";
import { registerGtid } from "../../src/zc/lanes/gtid";

function makeEnv(db: MockD1Database): any {
  return {
    DB: db,
    QUEUE: { send: async () => {} },
  };
}

let d1: MockD1Database;

function seedParticipant(db: MockD1Database, bankId: string) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 1000000, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId)
    ._runSync();
}

/** Seed a SUSPENDED transaction with an explicit expires_at. */
function seedSuspendedTx(db: MockD1Database, txid: string, expiresAt: string | null) {
  db.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, reason_code, expires_at,
      created_at, updated_at, version)
     VALUES (?, 'EXPRESS', 'SUSPENDED', 5000, 'JPY', '001', 'payerAcc', '002', 'payeeAcc',
             ?, '1.0', 'SUSPEND_EXEC_TIMEOUT', ?, '2025-06-01T09:00:00Z', '2025-06-01T09:00:00Z', 0)`
  )
    .bind(txid, `IK-${txid}`, expiresAt)
    ._runSync();
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  seedParticipant(d1, "001");
  seedParticipant(d1, "002");
});

describe("runTimeoutSweep — SUSPENDED → FAILED_EXECUTION", () => {
  it("advances a SUSPENDED tx past expires_at to FAILED_EXECUTION", async () => {
    seedSuspendedTx(d1, "TX-SWEEP-1", "2000-01-01T00:00:00Z"); // long past
    await runTimeoutSweep(makeEnv(d1));

    const tx = await d1
      .prepare(`SELECT state, reason_code FROM Transactions WHERE txid = ?`)
      .bind("TX-SWEEP-1")
      .first<{ state: string; reason_code: string }>();
    expect(tx?.state).toBe("FAILED_EXECUTION");
    expect(tx?.reason_code).toBe("FAILED_EXEC_TIMEOUT");
  });

  it("writes a paired FinalityLog 'FailedExecution' entry for the transition", async () => {
    seedSuspendedTx(d1, "TX-SWEEP-2", "2000-01-01T00:00:00Z");
    await runTimeoutSweep(makeEnv(d1));

    const log = await d1
      .prepare(
        `SELECT event_type, state_from, state_to FROM FinalityLog
         WHERE txid = ? AND event_type = 'FailedExecution'`
      )
      .bind("TX-SWEEP-2")
      .first<{ event_type: string; state_from: string; state_to: string }>();
    expect(log).not.toBeNull();
    expect(log?.state_from).toBe("SUSPENDED");
    expect(log?.state_to).toBe("FAILED_EXECUTION");
  });

  it("does NOT sweep a SUSPENDED tx whose expires_at is still in the future", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    seedSuspendedTx(d1, "TX-SWEEP-3", future);
    await runTimeoutSweep(makeEnv(d1));

    const tx = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind("TX-SWEEP-3")
      .first<{ state: string }>();
    expect(tx?.state).toBe("SUSPENDED");

    const log = await d1
      .prepare(
        `SELECT COUNT(*) AS cnt FROM FinalityLog WHERE txid = ? AND event_type = 'FailedExecution'`
      )
      .bind("TX-SWEEP-3")
      .first<{ cnt: number }>();
    expect(log?.cnt).toBe(0);
  });

  it("does NOT sweep a SUSPENDED tx with no expires_at set", async () => {
    seedSuspendedTx(d1, "TX-SWEEP-4", null);
    await runTimeoutSweep(makeEnv(d1));

    const tx = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind("TX-SWEEP-4")
      .first<{ state: string }>();
    expect(tx?.state).toBe("SUSPENDED");
  });

  it("the FAILED_EXECUTION transition has exactly one FinalityLog entry (idempotent across runs)", async () => {
    seedSuspendedTx(d1, "TX-SWEEP-5", "2000-01-01T00:00:00Z");
    await runTimeoutSweep(makeEnv(d1));
    await runTimeoutSweep(makeEnv(d1)); // second run: tx already terminal, CAS no-ops

    const log = await d1
      .prepare(
        `SELECT COUNT(*) AS cnt FROM FinalityLog WHERE txid = ? AND event_type = 'FailedExecution'`
      )
      .bind("TX-SWEEP-5")
      .first<{ cnt: number }>();
    expect(log?.cnt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runTimeoutSweep — GT_PRECHECKED stuck recovery
// ---------------------------------------------------------------------------

/** A GTID register request that touches no real bank state (only used to seed GtidTransactions/GtidLegs). */
function makeTwoLegRequest(gtid: string) {
  return {
    gtid,
    expires_at: "2099-12-31T00:00:00Z",
    legs: [
      {
        leg_id: `${gtid}-LEG-PAYER`,
        role: "PAYER" as const,
        bank_id: "001",
        account_hash: "0010000001",
        amount: { value: 100_000, currency: "JPY" },
      },
      {
        leg_id: `${gtid}-LEG-PAYEE`,
        role: "PAYEE" as const,
        bank_id: "002",
        account_hash: "0020000001",
        amount: { value: 100_000, currency: "JPY" },
      },
    ],
  };
}

describe("runTimeoutSweep — GT_PRECHECKED stuck recovery", () => {
  it("cancels a GTID stuck in GT_PRECHECKED for >10 minutes (GT_PRECHECKED -> GT_CANCELLED)", async () => {
    const gtid = "GT-STUCK-001";
    await registerGtid(makeTwoLegRequest(gtid), makeEnv(d1));

    // Simulate advanceGtid having CAS'd to GT_PRECHECKED and then crashing
    // before reaching GT_DECIDED_TO_SETTLE / GT_DECIDED_CANCEL.
    const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await d1
      .prepare(`UPDATE GtidTransactions SET state='GT_PRECHECKED', updated_at=? WHERE gtid=?`)
      .bind(stale, gtid)
      .run();

    await runTimeoutSweep(makeEnv(d1));

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind(gtid)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_CANCELLED");

    const log = await d1
      .prepare(
        `SELECT event_type, state_from, state_to FROM FinalityLog
         WHERE gtid = ? AND event_type = 'GtidDecidedCancel'`
      )
      .bind(gtid)
      .first<{ event_type: string; state_from: string; state_to: string }>();
    expect(log).not.toBeNull();
    expect(log?.state_from).toBe("GT_PRECHECKED");
    expect(log?.state_to).toBe("GT_DECIDED_CANCEL");
  });

  it("does NOT touch a GT_PRECHECKED GTID updated recently", async () => {
    const gtid = "GT-STUCK-002";
    await registerGtid(makeTwoLegRequest(gtid), makeEnv(d1));

    await d1
      .prepare(`UPDATE GtidTransactions SET state='GT_PRECHECKED', updated_at=? WHERE gtid=?`)
      .bind(new Date().toISOString(), gtid)
      .run();

    await runTimeoutSweep(makeEnv(d1));

    const gt = await d1
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
      .bind(gtid)
      .first<{ state: string }>();
    expect(gt?.state).toBe("GT_PRECHECKED");
  });
});

// ---------------------------------------------------------------------------
// runTimeoutSweep — IdempotencyKeys hygiene
// ---------------------------------------------------------------------------

function seedIdempKey(db: MockD1Database, key: string, status: string, createdAt: string) {
  db.prepare(
    `INSERT INTO IdempotencyKeys (key, status, response_body, created_at)
     VALUES (?, ?, ?, ?)`
  )
    .bind(key, status, status === "DONE" ? JSON.stringify({ result: "OK" }) : null, createdAt)
    ._runSync();
}

async function idempKeyExists(db: MockD1Database, key: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT key FROM IdempotencyKeys WHERE key=?`)
    .bind(key)
    .first<{ key: string }>();
  return row !== null;
}

describe("runTimeoutSweep — IdempotencyKeys hygiene", () => {
  it("deletes a PROCESSING key orphaned for more than 15 minutes (client can re-acquire)", async () => {
    const stale = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    seedIdempKey(d1, "IK-ORPHAN-1", "PROCESSING", stale);

    await runTimeoutSweep(makeEnv(d1));

    expect(await idempKeyExists(d1, "IK-ORPHAN-1")).toBe(false);
  });

  it("keeps a PROCESSING key younger than 15 minutes (request may still be running)", async () => {
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    seedIdempKey(d1, "IK-LIVE-1", "PROCESSING", recent);

    await runTimeoutSweep(makeEnv(d1));

    expect(await idempKeyExists(d1, "IK-LIVE-1")).toBe(true);
  });

  it("deletes a DONE key older than the 24h replay-cache TTL", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    seedIdempKey(d1, "IK-DONE-OLD", "DONE", old);

    await runTimeoutSweep(makeEnv(d1));

    expect(await idempKeyExists(d1, "IK-DONE-OLD")).toBe(false);
  });

  it("keeps a DONE key within the 24h TTL (replay still served)", async () => {
    // Old enough to trip the 15-min PROCESSING rule if status were ignored —
    // proves the two sweeps use separate thresholds per status.
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    seedIdempKey(d1, "IK-DONE-FRESH", "DONE", recent);

    await runTimeoutSweep(makeEnv(d1));

    expect(await idempKeyExists(d1, "IK-DONE-FRESH")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression guards for the T2/T3 custody boundary (単一所有者則).
//
// These pin the two two-ledger divergence scenarios (docs/specs/30_internal_design.md §5.1) that used to be guarded by
// per-venue exclusion predicates and are now theorems of the `owner` column:
//   #4: a tx whose money leg is in flight at an external settlement venue
//       (HIGH_VALUE IGS/BOJ) is owned by 'VENUE:BOJ' (stamped atomically with
//       external_settlement_status='REQUESTED') and must NOT be swept by T3 —
//       the late SETTLED callback would otherwise be rejected (payer debited /
//       BOJ settled / payee never credited).
//   #7: a tx snapshotted into a DNS cycle is owned by 'CYCLE:<id>' and must
//       NOT be swept by T2 or T3 — settleDns would otherwise settle money for
//       an abandoned tx.
// Each comes with a positive control proving the sweep still fires for a normal
// stuck tx, so a future "fix" cannot just disable the sweep wholesale.
// ---------------------------------------------------------------------------

/** Seed a stale pending tx (old updated_at) for the T2/T3 sweeps to consider.
 *  `owner` is seeded exactly as the production handoffs stamp it: 'VENUE:BOJ'
 *  rides with external_settlement_status='REQUESTED', 'CYCLE:<id>' with a
 *  kicked dns_cycle_id. */
function seedPendingTx(
  db: MockD1Database,
  txid: string,
  opts: {
    state: "DECIDED_TO_SETTLE" | "PAYER_EXEC_CONFIRMED";
    lane?: string;
    externalSettlementStatus?: string | null;
    dnsCycleId?: string | null;
  }
) {
  const owner =
    opts.externalSettlementStatus === "REQUESTED"
      ? "VENUE:BOJ"
      : opts.dnsCycleId
        ? `CYCLE:${opts.dnsCycleId}`
        : "ZC";
  db.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, external_settlement_status, dns_cycle_id,
      owner, created_at, updated_at, version)
     VALUES (?, ?, ?, 40000, 'JPY', '001', '0010000001', '002', '0020000001',
             ?, '1.0', ?, ?, ?, '2025-06-01T00:00:00Z', '2025-06-01T00:00:00Z', 0)`
  )
    .bind(
      txid,
      opts.lane ?? "STANDARD",
      opts.state,
      `IK-${txid}`,
      opts.externalSettlementStatus ?? null,
      opts.dnsCycleId ?? null,
      owner
    )
    ._runSync();
}

async function stateOf(db: MockD1Database, txid: string): Promise<string | undefined> {
  const row = await db
    .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: string }>();
  return row?.state;
}

describe("runTimeoutSweep — T3 external-settlement-in-flight guard (regression #4)", () => {
  it("does NOT suspend a PAYER_EXEC_CONFIRMED tx awaiting IGS/BOJ (external_settlement_status='REQUESTED')", async () => {
    seedPendingTx(d1, "TX-T3-INFLIGHT", {
      state: "PAYER_EXEC_CONFIRMED",
      lane: "HIGH_VALUE",
      externalSettlementStatus: "REQUESTED",
    });
    await runTimeoutSweep(makeEnv(d1));
    expect(await stateOf(d1, "TX-T3-INFLIGHT")).toBe("PAYER_EXEC_CONFIRMED");
  });

  it("positive control: DOES suspend a stale PAYER_EXEC_CONFIRMED tx with no external settlement in flight", async () => {
    seedPendingTx(d1, "TX-T3-NORMAL", {
      state: "PAYER_EXEC_CONFIRMED",
      externalSettlementStatus: null,
    });
    await runTimeoutSweep(makeEnv(d1));
    expect(await stateOf(d1, "TX-T3-NORMAL")).toBe("SUSPENDED");
  });
});

describe("runTimeoutSweep — DNS-cycle commitment guard (regression #7)", () => {
  it("does NOT suspend a PAYER_EXEC_CONFIRMED tx already committed to a DNS cycle (T3)", async () => {
    seedPendingTx(d1, "TX-T3-KICKED", {
      state: "PAYER_EXEC_CONFIRMED",
      dnsCycleId: "DNS-JPY-20260613-01",
    });
    await runTimeoutSweep(makeEnv(d1));
    expect(await stateOf(d1, "TX-T3-KICKED")).toBe("PAYER_EXEC_CONFIRMED");
  });

  it("does NOT suspend a DECIDED_TO_SETTLE tx already committed to a DNS cycle (T2)", async () => {
    seedPendingTx(d1, "TX-T2-KICKED", {
      state: "DECIDED_TO_SETTLE",
      dnsCycleId: "DNS-JPY-20260613-01",
    });
    await runTimeoutSweep(makeEnv(d1));
    expect(await stateOf(d1, "TX-T2-KICKED")).toBe("DECIDED_TO_SETTLE");
  });

  it("positive control: DOES suspend a stale DECIDED_TO_SETTLE tx not yet committed to a cycle (T2)", async () => {
    seedPendingTx(d1, "TX-T2-UNCOMMITTED", {
      state: "DECIDED_TO_SETTLE",
      dnsCycleId: null,
    });
    await runTimeoutSweep(makeEnv(d1));
    expect(await stateOf(d1, "TX-T2-UNCOMMITTED")).toBe("SUSPENDED");
  });
});

// ---------------------------------------------------------------------------
// DNS_HOLD igs_mode hierarchy: RINGFENCED → RINGFENCED_PLUS promotion (step 14)
// and the Defer queue re-injection (step 15), wired into the per-minute sweep.
// ---------------------------------------------------------------------------

describe("runTimeoutSweep — RINGFENCED_PLUS promotion", () => {
  it("promotes a held RINGFENCED cycle whose recovery reserve is computable", async () => {
    // The sweep scopes by today's JST business date (businessDateJST()) —
    // see cron/timeout_sweep.ts step 14.
    const today = todayJST();
    const cycleId = `DNS-${today}`;
    // Held + ring-fenced cycle; bank 001 owes 15M against its seeded −10M BOJ
    // prefund → 5M shortfall → a reserve can be computed with full confidence.
    d1.prepare(
      `INSERT INTO DnsCycles (cycle_id, business_date, state, igs_mode, currency, intraday_seq, hold_causing_participants, created_at)
       VALUES (?, ?, 'HOLD_ACTIVE', 'RINGFENCED', 'JPY', 1, '["001"]', ?)`
    )
      .bind(cycleId, today, `${today}T09:00:00Z`)
      ._runSync();
    d1.prepare(
      `INSERT INTO DnsNetPositions (id, cycle_id, bank_id, gross_send, gross_receive, net_position, is_settled)
       VALUES (?, ?, '001', 15000000, 0, -15000000, 0)`
    )
      .bind(`DNSNET-${cycleId}-001`, cycleId)
      ._runSync();

    await runTimeoutSweep(makeEnv(d1));

    const cyc = await d1
      .prepare(`SELECT igs_mode, dns_recovery_reserve FROM DnsCycles WHERE cycle_id=?`)
      .bind(cycleId)
      .first<{ igs_mode: string; dns_recovery_reserve: number }>();
    expect(cyc?.igs_mode).toBe("RINGFENCED_PLUS");
    expect(cyc?.dns_recovery_reserve).toBe(5_500_000);
  });
});
