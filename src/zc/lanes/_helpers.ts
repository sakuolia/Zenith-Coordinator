/**
 * @file _helpers.ts — Shared building blocks for lane state machines.
 *
 * Four primitives every lane uses to mutate or create Transactions rows:
 *   - transitionWithLog — CAS-advance a row's state and write the paired
 *     FinalityLog entry in one atomic db.batch() (optional `sideUpdates`
 *     for parallel rows like HtlcContracts ride in the same batch).
 *   - cancelInFlightTx  — cancel an in-flight tx in TOCTOU-safe order:
 *     state guard → release H → log → finalize as CANCELLED.
 *   - insertTxWithLog   — INSERT a row at an `ALLOWED_ENTRY_STATES`-whitelisted
 *     entry state with a paired FinalityLog (GTID leg creation).
 *   - transferOwnership — CAS-move `Transactions.owner` (state unchanged) with
 *     a paired FinalityLog handoff event, mirroring transitionWithLog.
 *
 * Hard rule: never hand-roll `UPDATE Transactions SET state=...` or
 * `INSERT INTO Transactions (..., state, ...)`. That bypasses the
 * ALLOWED_TRANSITIONS / ALLOWED_ENTRY_STATES validator and the atomic
 * FinalityLog write, leaving a state advance with no audit record — a hard
 * bug in an "explicable state sequence" system. `test/zc/lane_invariants.test.ts`
 * enforces this statically.
 *
 * 単一所有者則 (single-owner rule, docs/specs/30_internal_design.md §5):
 * every Transactions row has exactly one `owner` allowed to move it —
 * 'ZC' | 'CYCLE:<id>' | 'VENUE:<id>' | 'CHAIN:<set>'. transitionWithLog and
 * cancelInFlightTx verify `issuer === owner` unconditionally (an
 * OWNERSHIP_VIOLATION is an invariant breach, never downgraded by
 * `strict:false`), and their CAS re-asserts the owner at commit time. `owner`
 * may only be written here (transferOwnership / setColumns) and by the
 * whitelisted DNS bulk snapshot/return sites; `test/invariants/ownership.test.ts`
 * enforces this statically.
 *
 * Rationale, full API, invariants, and the new-lane checklist live in
 * docs/specs/30_internal_design.md § 4 (レーン共通プリミティブ) — kept there so the
 * design prose has one home that cannot drift from this file.
 */
import { nowISO } from "../../types";
import type { FinalityEventType, TxState } from "../../types";
import {
  finalizeCancelledTx,
  prepareFinalityLogRow,
  buildFinalityLogConditionalInsert,
} from "../orchestrator/finality";
import { isValidTransition, ALLOWED_TRANSITIONS } from "../orchestrator/state_machine";
import { releaseH } from "../liquidity/h_model";
import { assertWritableDb } from "../platform/system_mode";
import { DomainError } from "../../shared/errors";

// ---------------------------------------------------------------------------
// Owner identifiers (単一所有者則)
// ---------------------------------------------------------------------------

/** Default owner/issuer: the coordinator itself. */
export const OWNER_ZC = "ZC";
/** External settlement venue owner for the IGS/BOJ money leg. */
export const OWNER_VENUE_BOJ = "VENUE:BOJ";
/**
 * Cross-chain Watcher-set owner. A single watcher set exists today; if a
 * per-rail set is introduced, derive it from `HtlcContracts.cross_chain_source`
 * (§5.4 uses 'CHAIN:default' as the backfill value for HTLC_ONCHAIN_PENDING).
 */
export const OWNER_CHAIN_DEFAULT = "CHAIN:default";
/** DNS cycle owner for rows snapshotted into a net position by kickDns. */
export function cycleOwner(cycleId: string): string {
  return `CYCLE:${cycleId}`;
}

// ---------------------------------------------------------------------------
// transitionWithLog
// ---------------------------------------------------------------------------

export interface TransitionRequest {
  txid: string;
  /** Allowed source state(s). The CAS UPDATE only fires if the current row matches. */
  fromState: string | string[];
  toState: string;
  eventType: FinalityEventType | string;
  /** Arbitrary fields to record in the FinalityLog payload. */
  payload?: Record<string, unknown>;
  /** Optional column updates applied alongside `state` (state, updated_at, version are managed). */
  setColumns?: Record<string, string | number | null>;
  /**
   * Who is issuing this transition (単一所有者則). Defaults to 'ZC'. Must equal
   * the row's current `owner` or the call throws OWNERSHIP_VIOLATION —
   * unconditionally, regardless of `strict`. A handoff exit sets
   * `setColumns: { owner: 'ZC' }` so ownership returns in the same batch.
   */
  issuer?: string;
  /** When true, raises DomainError('CONCURRENCY_CONFLICT') instead of returning {applied:false}. */
  strict?: boolean;
  /**
   * Optional secondary-table UPDATEs run atomically in the same D1 batch
   * as the canonical Transactions CAS UPDATE. Symmetric to
   * `cancelInFlightTx.sideUpdates`. Each entry's individual `changes` count
   * is informational only — the canonical UPDATE alone gates the FinalityLog
   * INSERT (which sits between the canonical UPDATE and the side updates so
   * `changes() > 0` reflects the canonical CAS). Used by lanes that maintain
   * a parallel state row (e.g. HtlcContracts) which must commit-or-rollback
   * together with the Transactions advance.
   */
  sideUpdates?: Array<{ sql: string; binds: Array<string | number | null> }>;
}

export interface TransitionResult {
  applied: boolean;
  /** Snapshot of the row's state before the UPDATE; null if the row did not exist. */
  previousState: string | null;
}

/**
 * CAS-update a Transactions row and write a paired FinalityLog entry — atomically.
 *
 * Atomicity contract:
 *   - The UPDATE and the FinalityLog INSERT are issued as a single `db.batch()`.
 *   - The INSERT uses a conditional `INSERT...SELECT ... WHERE EXISTS(...)` form
 *     gated on the post-UPDATE row state and version, so it fires iff the CAS
 *     hit. A thrown INSERT (e.g. prev_hash UNIQUE collision) rolls back the
 *     UPDATE because both run inside the batch's implicit transaction.
 *
 * State machine validation:
 *   - Each (currentState, toState) pair is checked against `ALLOWED_TRANSITIONS`
 *     before the CAS UPDATE. Illegal transitions raise `INVARIANT_VIOLATION`
 *     (strict) or return `{applied:false}` (non-strict), and never touch the DB.
 *
 * Idempotency:
 *   - If no row matches `txid AND state IN (fromState)` the call is a no-op
 *     (returns `{applied:false}`). When `strict: true` the same condition
 *     raises `CONCURRENCY_CONFLICT` so callers can surface a 409 to the client.
 */
export async function transitionWithLog(
  db: D1Database,
  req: TransitionRequest
): Promise<TransitionResult> {
  // Principle 10: refuse to commit new state while the system is read-only
  // (quorum loss or operator BCP). Throws SYSTEM_*_READ_ONLY (DOWNSTREAM →
  // queue retries until NORMAL). This is the same choke point as CAS+log
  // atomicity, so a state advance is structurally impossible while read-only.
  await assertWritableDb(db);

  const fromStates = Array.isArray(req.fromState) ? req.fromState : [req.fromState];
  const placeholders = fromStates.map(() => "?").join(",");
  const issuer = req.issuer ?? OWNER_ZC;

  const cur = await db
    .prepare(`SELECT state, version, owner FROM Transactions WHERE txid = ?`)
    .bind(req.txid)
    .first<{ state: string; version: number; owner: string }>();
  if (!cur) {
    if (req.strict) {
      throw new DomainError("TX_NOT_FOUND", `transaction ${req.txid} not found`, {
        txid: req.txid,
      });
    }
    return { applied: false, previousState: null };
  }
  // 単一所有者則: only the current owner may move the row. This throws even
  // when `strict:false` — same severity as INVARIANT_VIOLATION: an issuer
  // acting on a row it does not own is a bug (or the exact two-ledger
  // divergence the owner column exists to make structurally impossible),
  // not a benign lost race.
  if (issuer !== cur.owner) {
    throw new DomainError(
      "OWNERSHIP_VIOLATION",
      `transition on ${req.txid} issued by '${issuer}' but the row is owned by '${cur.owner}'`,
      { txid: req.txid, owner: cur.owner, issuer, to: req.toState }
    );
  }
  if (!fromStates.includes(cur.state)) {
    if (req.strict) {
      throw new DomainError(
        "CONCURRENCY_CONFLICT",
        `transaction ${req.txid} state=${cur.state}, expected one of [${fromStates.join(",")}]`,
        { txid: req.txid, current_state: cur.state, expected: fromStates }
      );
    }
    return { applied: false, previousState: cur.state };
  }

  // State-machine validation: each candidate source must permit transitioning
  // to `toState`. This is unconditional — there is no bypass — so a future
  // refactor adding a new lane cannot silently sneak through a transition not
  // listed in ALLOWED_TRANSITIONS. Bookkeeping events (e.g. PreCheckSuspended,
  // NameCheckOverridden) target real states that ARE in ALLOWED_TRANSITIONS and
  // pass this check like any other transition.
  if (!isValidTransition(cur.state as TxState, req.toState as TxState)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      `Disallowed state transition ${cur.state} → ${req.toState} for ${req.txid}. ` +
        `Allowed from ${cur.state}: [${(ALLOWED_TRANSITIONS[cur.state as TxState] ?? []).join(",") || "<none>"}]`,
      { txid: req.txid, from: cur.state, to: req.toState }
    );
  }

  // V8 perf: single-pass build of the SET clause + bind values. The previous
  // form enumerated `sets` three times (Object.keys + 2× .map) which both
  // allocates intermediate arrays and forces V8 to walk the property table
  // repeatedly. One `for...in` builds both arrays inline.
  const sets = req.setColumns ?? {};
  let setSql = "";
  const setValues: Array<string | number | null> = [];
  for (const k in sets) {
    setSql += setSql ? `, ${k} = ?` : `${k} = ?`;
    setValues.push(sets[k]!);
  }
  const now = nowISO();

  // The CAS re-asserts `owner = issuer` at commit time: DNS bulk snapshot
  // stamps (kickDns) deliberately do not bump `version`, so the version guard
  // alone cannot see a handoff that lands between our SELECT and this UPDATE.
  // `pending_since` restarts on every transition: entering a state begins the
  // wait that state's timer measures. It is deliberately separate from
  // `updated_at`, which any write to the row moves (see the column comment in
  // migrations/0001_consolidated_schema.sql). Helper-owned — callers must not
  // pass it through `setColumns`; `test/invariants/pending_since.test.ts`
  // enforces that the timeout sweep reads this column and not `updated_at`.
  const updateSql = `
    UPDATE Transactions
       SET state = ?
           ${setSql ? `, ${setSql}` : ""}
           , updated_at = ?
           , pending_since = ?
           , version = version + 1
     WHERE txid = ?
       AND state IN (${placeholders})
       AND version = ?
       AND owner = ?
  `;

  // Pre-compute the FinalityLog row (event_seq, prev_hash, entry_hash) so the
  // INSERT can be batched with the UPDATE without a second round-trip.
  const logRow = await prepareFinalityLogRow(db, {
    txid: req.txid,
    event_type: req.eventType,
    state_from: cur.state,
    state_to: req.toState,
    payload_json: JSON.stringify(req.payload ?? { txid: req.txid }),
    txid_or_gtid: req.txid,
  });

  // Atomic batch: either all statements commit, or all roll back.
  // The conditional INSERT is gated on `changes() > 0` for the immediately
  // preceding UPDATE, so a losing CAS skips the log INSERT and the row is
  // not corrupted by an orphan audit entry. Side updates run after the
  // FinalityLog INSERT — their changes() do not gate anything, but they
  // commit-or-rollback as a unit with the canonical CAS.
  const results = await db.batch([
    db
      .prepare(updateSql)
      .bind(req.toState, ...setValues, now, now, req.txid, ...fromStates, cur.version, issuer),
    buildFinalityLogConditionalInsert(db, logRow),
    ...(req.sideUpdates ?? []).map((u) => db.prepare(u.sql).bind(...u.binds)),
  ]);

  const updateChanges = results[0]?.meta.changes ?? 0;
  if (updateChanges === 0) {
    if (req.strict) {
      throw new DomainError(
        "CONCURRENCY_CONFLICT",
        `CAS lost on ${req.txid}: another writer advanced the row`,
        { txid: req.txid, expected_version: cur.version }
      );
    }
    return { applied: false, previousState: cur.state };
  }

  return { applied: true, previousState: cur.state };
}

// ---------------------------------------------------------------------------
// insertTxWithLog
// ---------------------------------------------------------------------------

/**
 * Whitelist of states a Transactions row is allowed to *enter* on INSERT.
 * Most lanes start at RECEIVED and walk the ALLOWED_TRANSITIONS graph; GTID
 * is the exception — after the GT-level decision commits, leg-level rows are
 * created already at DECIDED_TO_SETTLE because no per-leg pre-decision state
 * exists. Restricting the helper to a known set prevents future callers from
 * silently bypassing the state machine by INSERTing arbitrary states.
 */
const ALLOWED_ENTRY_STATES: ReadonlySet<TxState> = new Set<TxState>([
  "RECEIVED",
  "HTLC_LOCKED",
  "DECIDED_TO_SETTLE",
]);

export interface InsertTxRequest {
  txid: string;
  lane: string;
  /** Initial state of the row. Must be in ALLOWED_ENTRY_STATES. */
  initialState: TxState;
  amount: { value: number; currency: string };
  payerBankId: string;
  payerAccountHash: string;
  payeeBankId: string;
  payeeAccountHash: string;
  idempotencyKey: string;
  decisionProofRef?: string | null;
  finalityLogRef?: string | null;
  hReservationId?: string | null;
  dnsCycleId?: string | null;
  /**
   * Escape hatch for one-off Transactions columns the helper does not expose
   * as first-class fields (e.g. `purpose`). Keep this list small — if a column
   * is being set by more than one lane, promote it to a named field instead.
   */
  extraColumns?: Record<string, string | number | null>;
  /** FinalityLog event_type recording the row entry (e.g. 'GtidLegDecidedToSettle'). */
  eventType: FinalityEventType | string;
  /** Arbitrary fields to record in the FinalityLog payload. */
  payload?: Record<string, unknown>;
  /**
   * Optional secondary-table UPDATEs run atomically in the same D1 batch
   * as the canonical Transactions INSERT (e.g. GtidLegs.txid backref). Their
   * `changes` count is informational only; commit-or-rollback is gated on
   * the whole batch.
   */
  sideUpdates?: Array<{ sql: string; binds: Array<string | number | null> }>;
}

export interface InsertTxResult {
  /** True when this call inserted a new row; false when the row already existed (idempotent no-op). */
  inserted: boolean;
}

/**
 * Atomically INSERT a Transactions row at a known entry state and write a
 * paired FinalityLog entry recording how the row arrived. Symmetric to
 * `transitionWithLog`, but for the row-creation case where there is no
 * previous Transactions state.
 *
 * Atomicity contract:
 *   - INSERT, FinalityLog INSERT, and any `sideUpdates` are issued as a
 *     single `db.batch()`. A thrown statement (e.g. UNIQUE collision) rolls
 *     the others back, so a Transactions row never exists without its
 *     paired audit entry.
 *
 * Idempotency:
 *   - Uses `INSERT OR IGNORE`. Returns `{inserted:false}` if the row already
 *     exists; the FinalityLog INSERT is gated on `changes() > 0` so a duplicate
 *     call leaves the audit trail untouched.
 *
 * Entry-state validation:
 *   - `initialState` must be in `ALLOWED_ENTRY_STATES`. Attempts to INSERT at
 *     arbitrary states raise `INVARIANT_VIOLATION` before any DB I/O.
 */
export async function insertTxWithLog(
  db: D1Database,
  req: InsertTxRequest
): Promise<InsertTxResult> {
  // Principle 10: refuse to create new committed state while read-only.
  await assertWritableDb(db);

  if (!ALLOWED_ENTRY_STATES.has(req.initialState)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      `Disallowed entry state ${req.initialState} for ${req.txid}. ` +
        `Allowed entry states: [${Array.from(ALLOWED_ENTRY_STATES).join(",")}]`,
      { txid: req.txid, initial_state: req.initialState }
    );
  }

  const now = nowISO();
  const logRow = await prepareFinalityLogRow(db, {
    txid: req.txid,
    event_type: req.eventType,
    state_from: null,
    state_to: req.initialState,
    payload_json: JSON.stringify(req.payload ?? { txid: req.txid }),
    txid_or_gtid: req.txid,
  });

  // Compose the column list and bind vector. The fixed columns come first;
  // `extraColumns` (escape hatch for one-off fields like `purpose`) extends
  // both arrays in lockstep so the INSERT remains parameterized.
  const extra = req.extraColumns ?? {};
  let extraCols = "";
  let extraPlaceholders = "";
  const extraValues: Array<string | number | null> = [];
  for (const k in extra) {
    extraCols += `, ${k}`;
    extraPlaceholders += ", ?";
    extraValues.push(extra[k]!);
  }

  const insertSql = `
    INSERT OR IGNORE INTO Transactions
      (txid, lane, state, amount_value, amount_currency,
       payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
       idempotency_key, schema_version, decision_proof_ref, finality_log_ref,
       h_reservation_id, dns_cycle_id, version, created_at, updated_at,
       pending_since${extraCols})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1.0', ?, ?, ?, ?, 0, ?, ?, ?${extraPlaceholders})
  `;

  const results = await db.batch([
    db
      .prepare(insertSql)
      .bind(
        req.txid,
        req.lane,
        req.initialState,
        req.amount.value,
        req.amount.currency,
        req.payerBankId,
        req.payerAccountHash,
        req.payeeBankId,
        req.payeeAccountHash,
        req.idempotencyKey,
        req.decisionProofRef ?? null,
        req.finalityLogRef ?? null,
        req.hReservationId ?? null,
        req.dnsCycleId ?? null,
        now,
        now,
        now,
        ...extraValues
      ),
    buildFinalityLogConditionalInsert(db, logRow),
    ...(req.sideUpdates ?? []).map((u) => db.prepare(u.sql).bind(...u.binds)),
  ]);

  const insertChanges = results[0]?.meta.changes ?? 0;
  return { inserted: insertChanges > 0 };
}

// ---------------------------------------------------------------------------
// cancelInFlightTx
// ---------------------------------------------------------------------------

export interface CancelRequest {
  txid: string;
  reasonCode: string;
  /** States from which a cancel is permitted. Defaults to pre-decision states. */
  fromStates?: string[];
  /** Skip the H release step (used for lanes that never reserve H). */
  skipReleaseH?: boolean;
  /**
   * Optional secondary-table CAS UPDATEs run atomically in the same D1 batch
   * as the canonical Transactions UPDATE. Each entry's individual `changes`
   * count is informational only — H release, FinalityLog, and finalize gate
   * ONLY on the canonical Transactions UPDATE succeeding. This guarantees
   * that side-table state (e.g. HtlcContracts.state) cannot lead H to be
   * released when the canonical decision has already committed to settle.
   */
  sideUpdates?: Array<{ sql: string; binds: Array<string | number | null> }>;
  /**
   * Custom FinalityLog event_type. Defaults to 'DecidedCancel'.
   * Useful when a lane wants a more specific name (e.g. 'HtlcCancelled').
   */
  eventType?: string;
  /** Additional fields merged into the FinalityLog payload. */
  payloadExtra?: Record<string, unknown>;
  /**
   * Who is issuing the cancel (単一所有者則). Defaults to 'ZC'. Must equal the
   * row's `owner` or the call throws OWNERSHIP_VIOLATION. The canonical cancel
   * UPDATE always returns `owner` to 'ZC' — a cancelled row is terminal and
   * back under coordinator custody.
   */
  issuer?: string;
}

/**
 * Cancel an in-flight transaction: CAS to DECIDED_CANCEL → release H (if any)
 * → log → finalize as CANCELLED.
 *
 * The order is important: we transition state FIRST so a parallel decision
 * path cannot win the CAS. Only after the row is owned do we release H,
 * which prevents the bug where a LOCKED reservation gets released even
 * though the decision path won.
 *
 * The canonical CAS UPDATE and the paired DecidedCancel FinalityLog INSERT
 * are issued in a single batch (atomic). Side-updates (e.g. HtlcContracts)
 * are appended to that batch so they commit-or-rollback together with the
 * canonical update.
 *
 * Returns true when the canonical cancel took effect; false when the row
 * was already past the cancel window (idempotent no-op).
 */
export async function cancelInFlightTx(db: D1Database, req: CancelRequest): Promise<boolean> {
  // Principle 10: a cancel is also a committed decision — refuse while read-only.
  await assertWritableDb(db);

  const now = nowISO();
  const fromStates = req.fromStates ?? [
    "RECEIVED",
    "PRECHECKED",
    "PRECHECKED_SUSPENDED",
    "H_RESERVED",
  ];
  const placeholders = fromStates.map(() => "?").join(",");
  const issuer = req.issuer ?? OWNER_ZC;

  const txRow = await db
    .prepare(`SELECT state, version, owner FROM Transactions WHERE txid = ?`)
    .bind(req.txid)
    .first<{ state: string; version: number; owner: string }>();
  if (!txRow) return false;
  // 単一所有者則: same unconditional guard as transitionWithLog — a cancel is a
  // state-moving decision and may only be issued by the row's current owner.
  if (issuer !== txRow.owner) {
    throw new DomainError(
      "OWNERSHIP_VIOLATION",
      `cancel on ${req.txid} issued by '${issuer}' but the row is owned by '${txRow.owner}'`,
      { txid: req.txid, owner: txRow.owner, issuer, reason_code: req.reasonCode }
    );
  }
  if (!fromStates.includes(txRow.state)) return false;

  // Pre-compute the DecidedCancel log row so it can be batched with the CAS.
  const logRow = await prepareFinalityLogRow(db, {
    txid: req.txid,
    event_type: req.eventType ?? "DecidedCancel",
    state_from: txRow.state,
    state_to: "DECIDED_CANCEL",
    payload_json: JSON.stringify({ reason_code: req.reasonCode, ...(req.payloadExtra ?? {}) }),
    txid_or_gtid: req.txid,
  });

  // Statement order matters: the FinalityLog INSERT must come directly after
  // the CAS UPDATE so its `changes() > 0` guard reflects the UPDATE's row
  // count. Side-updates run last; their changes() do not gate anything.
  // `owner = 'ZC'` in SET: a cancelled row returns to coordinator custody in
  // the same atomic batch. `AND owner = ?` in WHERE: re-assert ownership at
  // commit time (bulk snapshot stamps do not bump version — see transitionWithLog).
  const stmts = [
    db
      .prepare(
        `UPDATE Transactions
          SET state = 'DECIDED_CANCEL', reason_code = ?, owner = 'ZC', updated_at = ?, version = version + 1
        WHERE txid = ? AND state IN (${placeholders}) AND version = ? AND owner = ?`
      )
      .bind(req.reasonCode, now, req.txid, ...fromStates, txRow.version, issuer),
    buildFinalityLogConditionalInsert(db, logRow),
    ...(req.sideUpdates ?? []).map((u) => db.prepare(u.sql).bind(...u.binds)),
  ];

  const results = await db.batch(stmts);
  const canonicalChanges = results[0]?.meta.changes ?? 0;
  if (canonicalChanges === 0) return false;

  if (!req.skipReleaseH) {
    const txForH = await db
      .prepare(`SELECT h_reservation_id FROM Transactions WHERE txid = ?`)
      .bind(req.txid)
      .first<{ h_reservation_id: string | null }>();
    if (txForH?.h_reservation_id) {
      await releaseH(txForH.h_reservation_id, db);
    }
  }

  await finalizeCancelledTx(req.txid, db);
  return true;
}

// ---------------------------------------------------------------------------
// transferOwnership
// ---------------------------------------------------------------------------

export interface TransferOwnershipRequest {
  txid: string;
  /** Expected current owner — the CAS predicate. */
  fromOwner: string;
  toOwner: string;
  /** FinalityLog event_type. Defaults to 'OwnershipTransferred'; the sweep's
   *  lease-expiry reclaim uses 'OwnershipReclaimed'. */
  eventType?: FinalityEventType | string;
  /** Arbitrary fields merged into the FinalityLog payload. */
  payload?: Record<string, unknown>;
  /**
   * Optional column updates applied alongside `owner` (owner, updated_at,
   * version are managed). Used when the handoff and its trigger fact must
   * commit together (e.g. `external_settlement_status='REQUESTED'` with
   * `owner='VENUE:BOJ'` on IGS submission).
   */
  setColumns?: Record<string, string | number | null>;
}

export interface TransferOwnershipResult {
  applied: boolean;
  /** Owner observed before the CAS; null if the row did not exist. */
  previousOwner: string | null;
}

/**
 * CAS-move a row's `owner` and write the paired FinalityLog handoff event —
 * atomically. The mirror of `transitionWithLog` for the moments where
 * ownership moves while `state` does not (e.g. a BULK tx stays
 * DECIDED_TO_SETTLE when kickDns snapshots it; an IGS submission stays
 * PAYER_EXEC_CONFIRMED while the money leg is at the venue). Recording the
 * handoff makes "who holds this tx right now" part of explainability —
 * principle 4 extended, per docs/specs/30_internal_design.md §5.4 Phase 2.
 *
 * Atomicity contract: identical to transitionWithLog — the owner CAS UPDATE
 * and the conditional FinalityLog INSERT (gated on `changes() > 0`) are one
 * `db.batch()`. A losing CAS (wrong fromOwner or concurrent version bump)
 * returns `{applied:false}` and writes nothing.
 */
export async function transferOwnership(
  db: D1Database,
  req: TransferOwnershipRequest
): Promise<TransferOwnershipResult> {
  // Principle 10: an ownership handoff is committed coordination state —
  // refuse while read-only, exactly like a state transition.
  await assertWritableDb(db);

  const cur = await db
    .prepare(`SELECT state, version, owner FROM Transactions WHERE txid = ?`)
    .bind(req.txid)
    .first<{ state: string; version: number; owner: string }>();
  if (!cur) return { applied: false, previousOwner: null };
  if (cur.owner !== req.fromOwner) return { applied: false, previousOwner: cur.owner };

  const sets = req.setColumns ?? {};
  let setSql = "";
  const setValues: Array<string | number | null> = [];
  for (const k in sets) {
    setSql += `, ${k} = ?`;
    setValues.push(sets[k]!);
  }
  const now = nowISO();

  // state_from = state_to = current state: the handoff moves custody, not the
  // state machine.
  const logRow = await prepareFinalityLogRow(db, {
    txid: req.txid,
    event_type: req.eventType ?? "OwnershipTransferred",
    state_from: cur.state,
    state_to: cur.state,
    payload_json: JSON.stringify({
      txid: req.txid,
      from_owner: req.fromOwner,
      to_owner: req.toOwner,
      ...(req.payload ?? {}),
    }),
    txid_or_gtid: req.txid,
  });

  const results = await db.batch([
    db
      .prepare(
        `UPDATE Transactions
            SET owner = ?${setSql}, updated_at = ?, version = version + 1
          WHERE txid = ? AND owner = ? AND version = ?`
      )
      .bind(req.toOwner, ...setValues, now, req.txid, req.fromOwner, cur.version),
    buildFinalityLogConditionalInsert(db, logRow),
  ]);

  const applied = (results[0]?.meta.changes ?? 0) > 0;
  return { applied, previousOwner: cur.owner };
}
