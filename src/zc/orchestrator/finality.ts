/**
 * @file finality.ts — FinalityLog persistence, cancellation, and suspension.
 *
 * All state-change audit trail writes and the two core terminal-state helpers
 * (finalizeCancelledTx, suspendTx) live here so they can be imported without
 * pulling in the full queue dispatcher or bank call hub.
 *
 * Event-seq allocation: a single-row `FinalitySeq` counter table is
 * incremented atomically per write via `UPDATE ... RETURNING`. This
 * replaces the previous wall-clock + random scheme that relied on UNIQUE-retry
 * as its only ordering guarantee.
 *
 * Atomicity: the canonical CAS + FinalityLog INSERT is issued as a single
 * `db.batch()` using a conditional INSERT...SELECT WHERE EXISTS pattern. The
 * INSERT only takes effect if the prior UPDATE moved the row to the expected
 * post-state, so a thrown log write rolls back both statements together.
 * Callers wanting this pattern should use `transitionWithLog` in
 * `lanes/_helpers.ts`; the same machinery powers `finalizeCancelledTx` and
 * `suspendTx` below.
 */
import type { TxState, FinalityEventType } from "../../types";
import { nowISO } from "../../types";
import { newUUID } from "../../shared/idempotency";
import { openCase, autoResolveCaseForTx } from "../cases/case";
import { assertWritableDb } from "../platform/system_mode";
import { isValidTransition } from "./state_machine";
import {
  chainIdOf,
  computeEntryHash,
  getChainTipHash,
  NON_TX_CHAIN_PREFIXES,
} from "../finality/finality_chain";

// ---------------------------------------------------------------------------
// FinalityLog persistence
// ---------------------------------------------------------------------------

/** Shape of a FinalityLog row to be written. */
export interface FinalityLogEntry {
  txid: string | null;
  event_type: FinalityEventType | string;
  state_from: string | null;
  state_to: string;
  payload_json: string;
  txid_or_gtid: string | null;
}

/** Prefixes recognized as non-TX chain identifiers stored in FinalityLog.gtid.
 *  Canonical list lives in finality_chain.ts (NON_TX_CHAIN_PREFIXES) so the
 *  chain-write side and the verify/scope side cannot drift apart. */
const CHAIN_ID_PREFIXES = NON_TX_CHAIN_PREFIXES;

/**
 * Atomically allocate the next monotonic event_seq from the FinalitySeq table.
 * `UPDATE ... RETURNING` is a single SQLite/D1 statement and runs under the
 * implicit per-statement transaction, so concurrent isolates each receive a
 * distinct seq value. The UNIQUE index `idx_fl_event_seq_unique`
 * is therefore a belt-and-braces guard rather than the primary mechanism.
 */
async function allocateEventSeq(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`UPDATE FinalitySeq SET next_seq = next_seq + 1 WHERE id = 1 RETURNING next_seq`)
    .first<{ next_seq: number }>();
  if (row && typeof row.next_seq === "number") return row.next_seq;
  // Defensive bootstrap: if the seed row is missing (migration not applied or
  // test fixture forgot to create it), fall back to MAX(event_seq)+1.
  const fallback = await db
    .prepare(`SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM FinalityLog`)
    .first<{ next_seq: number }>();
  return fallback?.next_seq ?? 1;
}

/** Chain ID resolution for a FinalityLog entry. */
export function resolveChainContext(entry: FinalityLogEntry): {
  gtid: string | null;
  chainId: string;
} {
  const txidOrGtid = entry.txid_or_gtid;
  const gtid =
    txidOrGtid && CHAIN_ID_PREFIXES.some((p) => txidOrGtid.startsWith(p)) ? txidOrGtid : null;
  const chainId = chainIdOf({ txid: entry.txid, gtid });
  return { gtid, chainId };
}

/** Pre-computed FinalityLog row, ready to bind into an INSERT statement. */
export interface PreparedFinalityLogRow {
  log_id: string;
  txid: string | null;
  gtid: string | null;
  event_type: string;
  state_from: string | null;
  state_to: string;
  payload_json: string;
  event_seq: number;
  occurred_at: string;
  prev_hash: string;
  entry_hash: string;
}

/**
 * Compute the full set of FinalityLog row values for a given entry, including
 * the allocated event_seq and the SHA-256 chain hashes. Exposed for callers
 * that need to include the INSERT in their own `db.batch()` to obtain CAS+log
 * atomicity (see `lanes/_helpers.ts#transitionWithLog`).
 */
export async function prepareFinalityLogRow(
  db: D1Database,
  entry: FinalityLogEntry
): Promise<PreparedFinalityLogRow> {
  const { gtid, chainId } = resolveChainContext(entry);
  const log_id = `FL-${newUUID()}`;
  const event_seq = await allocateEventSeq(db);
  const occurred_at = nowISO();
  const prev_hash = await getChainTipHash(db, chainId);
  const entry_hash = await computeEntryHash(
    {
      log_id,
      txid: entry.txid,
      gtid,
      event_type: entry.event_type,
      state_from: entry.state_from,
      state_to: entry.state_to,
      payload_json: entry.payload_json,
      event_seq,
      occurred_at,
    },
    prev_hash
  );
  return {
    log_id,
    txid: entry.txid,
    gtid,
    event_type: String(entry.event_type),
    state_from: entry.state_from,
    state_to: entry.state_to,
    payload_json: entry.payload_json,
    event_seq,
    occurred_at,
    prev_hash,
    entry_hash,
  };
}

const FINALITY_LOG_COLUMNS = `log_id, txid, gtid, event_type, state_from, state_to,
  payload_json, event_seq, occurred_at, prev_hash, entry_hash`;

const FINALITY_LOG_INSERT_SQL = `
  INSERT INTO FinalityLog (${FINALITY_LOG_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Conditional INSERT that fires only when the immediately preceding DML
 * statement in the same connection changed >0 rows. Use this when batching
 * with a CAS UPDATE so the log row appears iff the state transition actually
 * committed (`changes()` reports the most recent UPDATE's row count, and a
 * losing CAS produces `changes() = 0`).
 *
 * Important: this MUST be the next statement after the gated UPDATE in the
 * batch. Inserting anything between them would shift `changes()` to that
 * intermediate statement and break the guard.
 */
const FINALITY_LOG_CONDITIONAL_INSERT_SQL = `
  INSERT INTO FinalityLog (${FINALITY_LOG_COLUMNS})
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE changes() > 0
`;

/** Build an unconditional INSERT for a pre-computed FinalityLog row. */
export function buildFinalityLogInsert(
  db: D1Database,
  row: PreparedFinalityLogRow
): D1PreparedStatement {
  return db
    .prepare(FINALITY_LOG_INSERT_SQL)
    .bind(
      row.log_id,
      row.txid,
      row.gtid,
      row.event_type,
      row.state_from,
      row.state_to,
      row.payload_json,
      row.event_seq,
      row.occurred_at,
      row.prev_hash,
      row.entry_hash
    );
}

/**
 * Build a conditional INSERT for a pre-computed FinalityLog row, gated on
 * `changes() > 0` so the log entry is only persisted when the immediately
 * preceding statement in the batch actually modified a row.
 *
 * Place this statement directly after the gated CAS UPDATE inside the same
 * `db.batch()`. Do not interleave other DML statements between them — the
 * `changes()` function reports the most recent DML statement's row count,
 * so a different intervening UPDATE would shift the guard.
 */
export function buildFinalityLogConditionalInsert(
  db: D1Database,
  row: PreparedFinalityLogRow
): D1PreparedStatement {
  return db
    .prepare(FINALITY_LOG_CONDITIONAL_INSERT_SQL)
    .bind(
      row.log_id,
      row.txid,
      row.gtid,
      row.event_type,
      row.state_from,
      row.state_to,
      row.payload_json,
      row.event_seq,
      row.occurred_at,
      row.prev_hash,
      row.entry_hash
    );
}

/**
 * Persist a FinalityLog entry for audit trail.
 *
 * Retries up to MAX_RETRIES times on UNIQUE constraint violations. These can
 * still occur on the prev_hash partial UNIQUE indexes (B5/B9) when two
 * concurrent isolates read the same chain tip and try to extend it
 * simultaneously — the loser is rejected, re-reads the tip, and retries.
 *
 * event_seq collisions are no longer expected (the monotonic counter rules
 * them out) but we keep them in the retry predicate for defense-in-depth.
 */
export async function writeFinalityLog(db: D1Database, entry: FinalityLogEntry): Promise<void> {
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const row = await prepareFinalityLogRow(db, entry);
    try {
      await buildFinalityLogInsert(db, row).run();
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("UNIQUE") && !msg.includes("unique")) throw err;
      if (attempt === MAX_RETRIES - 1) {
        throw new Error(
          `writeFinalityLog: failed after ${MAX_RETRIES} attempts due to concurrent writes — ${msg}`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Terminal-state helpers
// ---------------------------------------------------------------------------

/**
 * Finalize a cancelled transaction by transitioning DECIDED_CANCEL → CANCELLED.
 * DECIDED_CANCEL is a transient state that must be resolved immediately.
 *
 * The UPDATE and the paired FinalityLog INSERT are issued as a single
 * `db.batch()` so the state advance and the audit record commit or roll back
 * together — closing the window where the row could move to CANCELLED without
 * a 'Cancelled' event being recorded.
 */
export async function finalizeCancelledTx(txid: string, db: D1Database): Promise<void> {
  const now = nowISO();
  const cur = await db
    .prepare(`SELECT version FROM Transactions WHERE txid = ? AND state = 'DECIDED_CANCEL'`)
    .bind(txid)
    .first<{ version: number }>();
  if (!cur) return;

  const logRow = await prepareFinalityLogRow(db, {
    txid,
    event_type: "Cancelled",
    state_from: "DECIDED_CANCEL",
    state_to: "CANCELLED",
    payload_json: JSON.stringify({ txid }),
    txid_or_gtid: txid,
  });

  const results = await db.batch([
    db
      .prepare(
        `UPDATE Transactions SET state='CANCELLED', updated_at=?, version=version+1
       WHERE txid=? AND state='DECIDED_CANCEL' AND version=?`
      )
      .bind(now, txid, cur.version),
    buildFinalityLogConditionalInsert(db, logRow),
  ]);

  if ((results[0]?.meta.changes ?? 0) > 0) {
    await autoResolveCaseForTx(db, txid);
  }
}

/**
 * Suspend a transaction due to timeout, execution failure, or filter rejection.
 * Uses CAS (version guard) to prevent TOCTOU conflicts. Automatically opens
 * a Case for manual investigation and checks GTID leg status if applicable.
 *
 * As with finalizeCancelledTx, the state CAS and the FinalityLog INSERT are
 * batched together so a thrown log write would roll back the state change.
 *
 * GTID legs are identified via the GtidLegs side-table (not the legacy
 * `txid.startsWith('TX-GT-')` prefix discriminator) so future txid format
 * changes do not silently disable the cascade to checkAndFinalizeGtid.
 */
export async function suspendTx(
  txid: string,
  reasonCode: string,
  db: D1Database,
  details?: Record<string, unknown>
): Promise<void> {
  // Principle 10: suspending a tx is a committed decision — refuse while
  // read-only. The queue/cron caller retries once the system returns to NORMAL.
  await assertWritableDb(db);

  const now = nowISO();
  const tx = await db
    .prepare(`SELECT state, version, owner FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: TxState; version: number; owner: string }>();
  if (!tx) return;

  // 単一所有者則: suspendTx is always ZC-issued (timeouts, bank NG paths), so a
  // non-ZC owner means another party (DNS cycle / settlement venue / chain
  // watcher set) currently governs the row's fate and ZC must not abandon it.
  // A skip — not a throw — because the caller is the cron/queue and losing the
  // row to a legitimate concurrent handoff (e.g. kickDns snapshotting between
  // the sweep's SELECT and this call) is a benign race, not a bug.
  if (tx.owner !== "ZC") {
    console.error(
      `[orchestrator] suspendTx skipped for ${txid}: row is owned by '${tx.owner}', not ZC`
    );
    return;
  }

  if (!isValidTransition(tx.state, "SUSPENDED")) return;

  const logRow = await prepareFinalityLogRow(db, {
    txid,
    event_type: "Suspended",
    state_from: tx.state,
    state_to: "SUSPENDED",
    payload_json: JSON.stringify({ reason_code: reasonCode, ...details }),
    txid_or_gtid: txid,
  });

  // `AND owner='ZC'`: re-assert ownership at commit time — DNS bulk snapshot
  // stamps do not bump `version`, so the version guard alone cannot see a
  // handoff landing between the SELECT above and this UPDATE.
  const results = await db.batch([
    db
      .prepare(
        `UPDATE Transactions SET state='SUSPENDED', reason_code=?, updated_at=?, version=version+1
       WHERE txid=? AND state=? AND version=? AND owner='ZC'`
      )
      .bind(reasonCode, now, txid, tx.state, tx.version),
    buildFinalityLogConditionalInsert(db, logRow),
  ]);

  if ((results[0]?.meta.changes ?? 0) === 0) {
    console.error(
      `[orchestrator] suspendTx CAS failed for ${txid}: state=${tx.state} may have advanced`
    );
    return;
  }

  await openCase(db, {
    related_txid: txid,
    reason_code: reasonCode,
    opened_by: "ZC",
    description: `Auto-suspended: ${reasonCode}`,
  });

  // GTID dispatch: query GtidLegs by txid instead of inferring from a txid prefix.
  const leg = await db
    .prepare(`SELECT gtid FROM GtidLegs WHERE txid = ?`)
    .bind(txid)
    .first<{ gtid: string }>();
  if (leg) {
    const { checkAndFinalizeGtid } = await import("./gtid");
    await checkAndFinalizeGtid(leg.gtid, db);
  }
}
