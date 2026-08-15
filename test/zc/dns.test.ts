/**
 * @file DNS cycle management tests.
 *
 * Covers:
 * - getOrCreateDnsCycle: idempotent creation of OPEN cycle
 * - kickDns: OPEN → KICKED with net position calculation
 * - DNS OPEN → KICKED state transition correctness
 * - Net zero-sum invariant across payer/payee banks
 * - Regression: DnsNetPositions FK must reference DnsCycles, not DnsCycles_old
 *   (a prior migration renamed DnsCycles→DnsCycles_old which caused SQLite to
 *   rewrite the FK; a later migration fixed it — these tests guard against re-introduction)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  getOrCreateDnsCycle,
  kickDns,
  getDnsStatus,
  getDnsNetPositions,
} from "../../src/zc/settlement/dns";

// ---------------------------------------------------------------------------
// Minimal Env mock (kickDns needs env.DB)
// ---------------------------------------------------------------------------
function makeEnv(db: MockD1Database): any {
  return {
    DB: db,
    QUEUE: { send: async () => {} },
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let d1: MockD1Database;
const TODAY = "2025-06-01";

function seedParticipant(db: MockD1Database, bankId: string) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 1000000, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId)
    ._runSync();
}

function insertDecidedTx(
  db: MockD1Database,
  txid: string,
  payerBank: string,
  payeeBank: string,
  amount: number,
  lane = "EXPRESS"
) {
  db.prepare(
    `INSERT OR IGNORE INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, created_at, updated_at, version)
     VALUES (?, ?, 'DECIDED_TO_SETTLE', ?, 'JPY', ?, 'payerAcc', ?, 'payeeAcc',
             ?, '1.0', '2025-06-01T09:00:00Z', '2025-06-01T09:00:00Z', 0)`
  )
    .bind(txid, lane, amount, payerBank, payeeBank, `IK-${txid}`)
    ._runSync();
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  seedParticipant(d1, "001");
  seedParticipant(d1, "002");
  seedParticipant(d1, "003");
});

// ---------------------------------------------------------------------------
// getOrCreateDnsCycle
// ---------------------------------------------------------------------------

describe("getOrCreateDnsCycle", () => {
  it("creates a new OPEN cycle when none exists", async () => {
    const cycleId = await getOrCreateDnsCycle(d1 as any, `${TODAY}T10:00:00Z`);
    expect(cycleId).toBeTruthy();
    expect(cycleId.startsWith("DNS-")).toBe(true);

    const row = await d1
      .prepare(`SELECT state FROM DnsCycles WHERE cycle_id = ?`)
      .bind(cycleId)
      .first<{ state: string }>();
    expect(row?.state).toBe("OPEN");
  });

  it("records the canonical JPY/seq-1 identity for the new cycle (docs/specs/20_method_design.md §9.4.2)", async () => {
    const cycleId = await getOrCreateDnsCycle(d1 as any, `${TODAY}T10:00:00Z`);

    const row = await d1
      .prepare(`SELECT currency, intraday_seq FROM DnsCycles WHERE cycle_id = ?`)
      .bind(cycleId)
      .first<{ currency: string; intraday_seq: number }>();
    expect(row?.currency).toBe("JPY");
    expect(row?.intraday_seq).toBe(1);
  });

  it("returns the same cycle_id on repeated calls for the same day", async () => {
    const id1 = await getOrCreateDnsCycle(d1 as any, `${TODAY}T10:00:00Z`);
    const id2 = await getOrCreateDnsCycle(d1 as any, `${TODAY}T11:00:00Z`);
    expect(id1).toBe(id2);
  });

  it("creates a new late cycle when the day cycle is already SETTLED", async () => {
    // Pre-create and mark SETTLED
    d1.prepare(
      `INSERT INTO DnsCycles (cycle_id, business_date, state, igs_mode, created_at)
       VALUES ('DNS-2025-06-01', '2025-06-01', 'SETTLED', 'NORMAL', '2025-06-01T08:00:00Z')`
    )._runSync();

    const lateId = await getOrCreateDnsCycle(d1 as any, `${TODAY}T13:00:00Z`);
    // Should create a new OPEN cycle with a different id (not 'DNS-2025-06-01')
    expect(lateId).not.toBe(`DNS-${TODAY}`);

    const row = await d1
      .prepare(`SELECT state FROM DnsCycles WHERE cycle_id = ?`)
      .bind(lateId)
      .first<{ state: string }>();
    expect(row?.state).toBe("OPEN");
  });

  it("assigns intraday_seq=2 to a late cycle created after the day's first cycle (docs/specs/20_method_design.md §9.4.2)", async () => {
    d1.prepare(
      `INSERT INTO DnsCycles (cycle_id, business_date, state, igs_mode, currency, intraday_seq, created_at)
       VALUES ('DNS-2025-06-01', '2025-06-01', 'SETTLED', 'NORMAL', 'JPY', 1, '2025-06-01T08:00:00Z')`
    )._runSync();

    const lateId = await getOrCreateDnsCycle(d1 as any, `${TODAY}T13:00:00Z`);

    const row = await d1
      .prepare(`SELECT currency, intraday_seq FROM DnsCycles WHERE cycle_id = ?`)
      .bind(lateId)
      .first<{ currency: string; intraday_seq: number }>();
    expect(row?.currency).toBe("JPY");
    expect(row?.intraday_seq).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// kickDns: OPEN → KICKED, net positions
// ---------------------------------------------------------------------------

describe("kickDns", () => {
  it("transitions the cycle from OPEN to KICKED", async () => {
    // Create an OPEN cycle
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`);
    const env = makeEnv(d1);
    const result = await kickDns(TODAY, env);

    expect(result.state).toBe("KICKED");
    expect(result.cycle_id).toContain("DNS-");

    const cycle = await getDnsStatus(TODAY, d1 as any);
    expect(cycle?.state).toBe("KICKED");
  });

  it("computes correct net positions for a single payment 001 → 002", async () => {
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`);
    insertDecidedTx(d1, "TX-DNS-A", "001", "002", 100_000);

    const env = makeEnv(d1);
    const result = await kickDns(TODAY, env);

    expect(result.net_positions["001"]).toBe(-100_000); // payer = debit
    expect(result.net_positions["002"]).toBe(100_000); // payee = credit
  });

  it("maintains zero-sum net positions (all positions sum to zero)", async () => {
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`);
    insertDecidedTx(d1, "TX-DNS-B1", "001", "002", 80_000);
    insertDecidedTx(d1, "TX-DNS-B2", "002", "003", 30_000);
    insertDecidedTx(d1, "TX-DNS-B3", "003", "001", 50_000);

    const env = makeEnv(d1);
    const result = await kickDns(TODAY, env);

    const total = Object.values(result.net_positions).reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
  });

  it("assigns pending DECIDED_TO_SETTLE transactions to the cycle", async () => {
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`);
    insertDecidedTx(d1, "TX-DNS-C1", "001", "002", 50_000);
    insertDecidedTx(d1, "TX-DNS-C2", "001", "003", 25_000);

    const env = makeEnv(d1);
    const { cycle_id } = await kickDns(TODAY, env);

    const count = await d1
      .prepare(`SELECT COUNT(*) AS cnt FROM Transactions WHERE dns_cycle_id = ?`)
      .bind(cycle_id)
      .first<{ cnt: number }>();
    expect(count?.cnt).toBe(2);
  });

  it("does not include HIGH_VALUE transactions in the cycle", async () => {
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`);
    insertDecidedTx(d1, "TX-DNS-HV", "001", "002", 200_000, "HIGH_VALUE");

    const env = makeEnv(d1);
    const { cycle_id } = await kickDns(TODAY, env);

    const count = await d1
      .prepare(`SELECT COUNT(*) AS cnt FROM Transactions WHERE dns_cycle_id = ?`)
      .bind(cycle_id)
      .first<{ cnt: number }>();
    expect(count?.cnt).toBe(0);
  });

  it("returns existing cycle state when already KICKED", async () => {
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`);
    const env = makeEnv(d1);
    const first = await kickDns(TODAY, env);
    const second = await kickDns(TODAY, env);

    // Second call should return existing cycle info (no-op)
    expect(second.cycle_id).toBe(first.cycle_id);
    expect(second.state).toBe("KICKED");
  });

  it("persists DnsNetPositions rows after kicking", async () => {
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`);
    insertDecidedTx(d1, "TX-DNS-D1", "001", "002", 60_000);

    const env = makeEnv(d1);
    await kickDns(TODAY, env);

    const positions = await getDnsNetPositions(TODAY, d1 as any);
    expect(positions.length).toBeGreaterThan(0);

    const payerPos = positions.find((p) => p.bank_id === "001");
    const payeePos = positions.find((p) => p.bank_id === "002");
    expect(payerPos?.net_position).toBe(-60_000);
    expect(payeePos?.net_position).toBe(60_000);
  });

  it("writes a DnsKicked FinalityLog entry", async () => {
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`);
    const env = makeEnv(d1);
    await kickDns(TODAY, env);

    const log = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE event_type = 'DnsKicked' LIMIT 1`)
      .first<{ event_type: string }>();
    expect(log).not.toBeNull();
    expect(log?.event_type).toBe("DnsKicked");
  });

  // Regression: a prior migration renamed DnsCycles→DnsCycles_old, which caused
  // SQLite to silently rewrite DnsNetPositions's FK to REFERENCES DnsCycles_old.
  // After 0012 dropped DnsCycles_old the FK became dangling. D1's batch executor
  // validates FK targets at prepare time, so kickDns failed with
  // "D1_ERROR: no such table: main.DnsCycles_old" whenever net positions existed.
  // A later migration fixed the FK; these tests guard against re-introduction.
  it("kickDns with BULK DECIDED_TO_SETTLE creates DnsNetPositions rows", async () => {
    await getOrCreateDnsCycle(d1 as any, `${TODAY}T09:00:00Z`);
    insertDecidedTx(d1, "TX-BULK-DNS-1", "001", "002", 100_000, "BULK");
    insertDecidedTx(d1, "TX-BULK-DNS-2", "002", "003", 50_000, "BULK");

    const env = makeEnv(d1);
    const result = await kickDns(TODAY, env);

    expect(result.state).toBe("KICKED");

    const positions = await getDnsNetPositions(TODAY, d1 as any);
    expect(positions.length).toBeGreaterThan(0);

    const total = positions.reduce((s, p) => s + p.net_position, 0);
    expect(total).toBe(0); // zero-sum invariant must hold for BULK too
  });

  it("kickDns DnsNetPositions INSERT succeeds with foreign_keys = ON", async () => {
    // This test replicates D1's FK validation behaviour (the test suite normally
    // runs with foreign_keys=OFF).  If any migration corrupts the DnsNetPositions
    // FK reference (e.g. via ALTER TABLE RENAME on a parent table), this test
    // will fail with "FOREIGN KEY constraint failed" or "no such table: <old>".
    const { sqlite, d1: fkDb } = createTestDb();
    sqlite.pragma("foreign_keys = ON");

    const fkEnv = makeEnv(fkDb);

    // Seed participants directly via the inner sqlite handle so FK checks pass
    // for Participants (referenced by other tables but not DnsNetPositions).
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO Participants
       (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
       VALUES ('001', 'Bank A', '/bank/001', 1000000, 0, 1, '2025-01-01T00:00:00Z')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO Participants
       (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
       VALUES ('002', 'Bank B', '/bank/002', 1000000, 0, 1, '2025-01-01T00:00:00Z')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO Transactions
       (txid, lane, state, amount_value, amount_currency,
        payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
        idempotency_key, schema_version, created_at, updated_at, version)
       VALUES ('TX-FK-CHK-1', 'BULK', 'DECIDED_TO_SETTLE', 75000, 'JPY',
               '001', 'payerAcc', '002', 'payeeAcc',
               'IK-TX-FK-CHK-1', '1.0',
               '2025-06-01T09:00:00Z', '2025-06-01T09:00:00Z', 0)`
      )
      .run();

    // Must not throw — if DnsNetPositions has a dangling FK this will fail
    await expect(kickDns(TODAY, fkEnv)).resolves.not.toThrow();

    const rows = sqlite.prepare(`SELECT COUNT(*) AS cnt FROM DnsNetPositions`).get() as {
      cnt: number;
    };
    expect(rows.cnt).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Schema integrity: DnsNetPositions FK must reference DnsCycles
// ---------------------------------------------------------------------------

describe("DnsNetPositions schema integrity", () => {
  // Guard against any future migration that renames DnsCycles (or another
  // ancestor table) without also recreating DnsNetPositions: SQLite silently
  // rewrites FK references on RENAME, and D1 will reject batch inserts if the
  // referenced table no longer exists.
  it("DnsNetPositions FK references DnsCycles, not a stale table name", async () => {
    const row = await d1
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'DnsNetPositions'`)
      .first<{ sql: string }>();

    expect(row).not.toBeNull();
    // FK must point to the live DnsCycles table
    expect(row!.sql).toMatch(/REFERENCES\s+DnsCycles\b/);
    // Must not reference any _old or _backup variant left by a partial migration
    expect(row!.sql).not.toMatch(/REFERENCES\s+DnsCycles_\w+/);
  });
});
