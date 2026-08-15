/**
 * @file Invariant tests for the system's first principle: a transaction's state
 * never advances without a paired FinalityLog entry ("explicable state sequence";
 * docs/specs/10_requirements.md design principle #1).
 *
 * The original FAILED_EXECUTION audit gap (a raw `UPDATE Transactions SET
 * state=...` in the timeout sweep that skipped the FinalityLog) was a *class* of
 * bug, not a one-off. A per-path test only guards the one path that already
 * broke. These two invariants guard the class:
 *
 *   1. STATIC GUARD — no production code outside the sanctioned state-machine
 *      core may hand-roll a state-mutating `UPDATE Transactions`. This is the
 *      executable form of the rule already written in lanes/_helpers.ts
 *      ("never hand-roll UPDATE Transactions SET state=..."). Had it existed,
 *      it would have failed on the timeout-sweep bug at the source.
 *
 *   2. RUNTIME INVARIANT — for every Transactions row, there exists a
 *      FinalityLog entry whose `state_to` equals the row's current state.
 *      This catches a missing audit entry regardless of *how* the state moved
 *      (raw UPDATE, a future helper bug, a forgotten changes()-guard), and a
 *      negative control proves the check actually has teeth.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { runTimeoutSweep } from "../../src/cron/timeout_sweep";
import { writeFinalityLog } from "../../src/zc/orchestrator";

// ---------------------------------------------------------------------------
// 1. STATIC GUARD: raw state-mutating UPDATE Transactions only in the core
// ---------------------------------------------------------------------------

/**
 * Files permitted to issue a raw `UPDATE Transactions SET state=...`. These are
 * the state-machine core: lanes/_helpers.ts pairs the CAS + FinalityLog INSERT
 * atomically in one batch; orchestrator/finality.ts pairs them manually under a
 * `changes()>0` guard. Everything else MUST route through `transitionWithLog` /
 * `cancelInFlightTx` / `insertTxWithLog`. (igs.ts left this list when the
 * single-owner rule work routed its callback paths through transitionWithLog.)
 */
const STATE_UPDATE_ALLOWLIST = new Set<string>([
  "src/zc/lanes/_helpers.ts",
  "src/zc/orchestrator/finality.ts",
]);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** True if the file text contains an `UPDATE Transactions ... state = ...` write. */
function hasStateMutatingUpdate(src: string): boolean {
  // Split on each UPDATE Transactions occurrence; inspect the SET clause that
  // follows (up to the first WHERE / statement terminator). A `state =` (word-
  // boundary, so `external_settlement_status =` does not count) means the
  // statement advances the canonical state column.
  const parts = src.split(/UPDATE\s+Transactions/i).slice(1);
  return parts.some((seg) => {
    const setClause = seg.split(/\bWHERE\b/i)[0] ?? seg;
    return /\bstate\s*=/.test(setClause);
  });
}

describe("invariant: raw state-mutating UPDATE Transactions is confined to the core", () => {
  it("no file outside the allowlist hand-rolls a Transactions state advance", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles("src")) {
      const rel = file.replace(/\\/g, "/");
      if (STATE_UPDATE_ALLOWLIST.has(rel)) continue;
      if (hasStateMutatingUpdate(readFileSync(file, "utf8"))) offenders.push(rel);
    }
    expect(
      offenders,
      `These files hand-roll 'UPDATE Transactions SET state=...', bypassing the ` +
        `ALLOWED_TRANSITIONS validator and the paired FinalityLog write. Route them ` +
        `through transitionWithLog / cancelInFlightTx instead (see lanes/_helpers.ts).`
    ).toEqual([]);
  });

  it("the allowlist itself is honest — each allowlisted file really does contain one", () => {
    // Guards against the allowlist rotting into a stale set that silently grants
    // exemptions to files that no longer need them.
    for (const rel of STATE_UPDATE_ALLOWLIST) {
      expect(
        hasStateMutatingUpdate(readFileSync(rel, "utf8")),
        `${rel} is allowlisted but has no state-mutating UPDATE`
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. RUNTIME INVARIANT: every current state is backed by a FinalityLog entry
// ---------------------------------------------------------------------------

let d1: MockD1Database;

/** Transactions whose current state has no FinalityLog entry recording it. */
async function findUnloggedStates(
  db: MockD1Database
): Promise<Array<{ txid: string; state: string }>> {
  const rows = await db
    .prepare(
      `SELECT t.txid, t.state
       FROM Transactions t
       WHERE NOT EXISTS (
         SELECT 1 FROM FinalityLog f WHERE f.txid = t.txid AND f.state_to = t.state
       )`
    )
    .all<{ txid: string; state: string }>();
  return rows.results;
}

function seedParticipant(db: MockD1Database, bankId: string) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 1000000, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId)
    ._runSync();
}

/** Seed a transaction at `state` together with a FinalityLog entry recording it. */
async function seedLoggedTx(
  db: MockD1Database,
  txid: string,
  state: string,
  expiresAt: string | null
) {
  db.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, expires_at, created_at, updated_at, version)
     VALUES (?, 'EXPRESS', ?, 5000, 'JPY', '001', 'payerAcc', '002', 'payeeAcc',
             ?, '1.0', ?, '2025-06-01T09:00:00Z', '2025-06-01T09:00:00Z', 0)`
  )
    .bind(txid, state, `IK-${txid}`, expiresAt)
    ._runSync();
  await writeFinalityLog(db as any, {
    txid,
    event_type: "Suspended",
    state_from: "DECIDED_TO_SETTLE",
    state_to: state,
    payload_json: JSON.stringify({ txid }),
    txid_or_gtid: txid,
  });
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  seedParticipant(d1, "001");
  seedParticipant(d1, "002");
});

describe("invariant: every transaction state is backed by a FinalityLog entry", () => {
  it("holds after the timeout sweep advances SUSPENDED → FAILED_EXECUTION", async () => {
    await seedLoggedTx(d1, "TX-INV-1", "SUSPENDED", "2000-01-01T00:00:00Z");
    expect(await findUnloggedStates(d1)).toEqual([]); // clean before

    await runTimeoutSweep({ DB: d1, QUEUE: { send: async () => {} } } as any);

    // FAILED_EXECUTION is terminal — its FinalityLog entry must exist.
    expect(await findUnloggedStates(d1)).toEqual([]);
  });

  it("negative control: a raw state advance with no log IS detected", async () => {
    await seedLoggedTx(d1, "TX-INV-2", "SUSPENDED", null);
    expect(await findUnloggedStates(d1)).toEqual([]);

    // Simulate the bug class: move state with a raw UPDATE, no FinalityLog write.
    await d1
      .prepare(`UPDATE Transactions SET state = 'FAILED_EXECUTION' WHERE txid = ?`)
      .bind("TX-INV-2")
      .run();

    const unlogged = await findUnloggedStates(d1);
    expect(unlogged).toEqual([{ txid: "TX-INV-2", state: "FAILED_EXECUTION" }]);
  });
});
