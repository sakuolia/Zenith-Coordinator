/**
 * @file entity_state_log.ts — append-only state-transition log for entities
 *       outside the Transactions money-path state machine.
 *
 * The money path (Transactions / HtlcContracts / GtidTransactions / GtidLegs)
 * already pairs every state overwrite with an immutable FinalityLog row via
 * `transitionWithLog`, and DNS cycles are logged on the 'DNS-' FinalityLog
 * chain. A handful of operational entities used to overwrite their status
 * column with no paired fact, so their transition history was lost:
 *   - Cases.state
 *   - PsprRegistry.capability_state
 *   - BankAccounts.status
 *   - ReversalRecords.status
 *
 * EntityStateLog records one immutable fact (state_from → state_to) per change
 * while the status column stays as a current-state projection. `transitionEntity-
 * WithLog` batches the caller's UPDATE with a conditional log INSERT gated on
 * `changes() > 0`, so the fact is written iff the UPDATE actually hit a row —
 * the same CAS+log atomicity FinalityLog uses (see orchestrator/finality.ts).
 */
import { nowISO } from "../types";
import { newUUID } from "./idempotency";

/**
 * Entity families tracked by EntityStateLog.
 *
 * MANDATE / DEBIT_MANDATE / COLLECTION join for continuous collection: a
 * standing collection is only as safe as the customer's ability to stop it, so
 * "when was this authority withdrawn, and by whom" has to be a recorded fact
 * rather than a column that quietly flipped.
 */
export type EntityType =
  | "CASE"
  | "PSPR"
  | "BANK_ACCOUNT"
  | "REVERSAL"
  | "MANDATE"
  | "DEBIT_MANDATE"
  | "COLLECTION";

export interface EntityStateTransition {
  entityType: EntityType;
  /** The entity row's primary key value. */
  entityId: string;
  /** Domain event name, e.g. 'CaseOpened', 'AccountStatusChanged'. */
  eventType: string;
  /** Previous state; null when the entity is being created. */
  stateFrom: string | null;
  stateTo: string;
  reasonCode?: string | null;
  /** 'ZC' | 'OPS' | 'BANK_{bankId}' | 'SYSTEM' etc. */
  actor?: string | null;
  payload?: Record<string, unknown> | null;
}

const COLUMNS =
  "log_id, entity_type, entity_id, event_type, state_from, state_to, reason_code, actor, payload_json, occurred_at";

const INSERT_SQL = `INSERT INTO EntityStateLog (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Conditional INSERT gated on `changes() > 0` of the immediately preceding DML
 * statement in the same batch — identical machinery to FinalityLog's
 * conditional insert. This MUST be the next statement after the gated UPDATE
 * so `changes()` reflects that UPDATE's row count.
 */
const CONDITIONAL_INSERT_SQL = `INSERT INTO EntityStateLog (${COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0`;

function bindValues(t: EntityStateTransition): Array<string | null> {
  return [
    `ESL-${newUUID()}`,
    t.entityType,
    t.entityId,
    t.eventType,
    t.stateFrom,
    t.stateTo,
    t.reasonCode ?? null,
    t.actor ?? null,
    t.payload != null ? JSON.stringify(t.payload) : null,
    nowISO(),
  ];
}

/** Build an unconditional INSERT — use when pairing with an entity-creation INSERT. */
export function buildEntityStateLogInsert(
  db: D1Database,
  t: EntityStateTransition
): D1PreparedStatement {
  return db.prepare(INSERT_SQL).bind(...bindValues(t));
}

/** Build a `changes() > 0`-gated INSERT — use when pairing with a CAS UPDATE. */
export function buildEntityStateLogConditionalInsert(
  db: D1Database,
  t: EntityStateTransition
): D1PreparedStatement {
  return db.prepare(CONDITIONAL_INSERT_SQL).bind(...bindValues(t));
}

/** Append an entity-state fact unconditionally. */
export async function recordEntityTransition(
  db: D1Database,
  t: EntityStateTransition
): Promise<void> {
  await buildEntityStateLogInsert(db, t).run();
}

export interface EntityUpdateWithLog {
  /** The status-changing UPDATE. Should be CAS-guarded so a no-op leaves no log. */
  update: { sql: string; binds: Array<string | number | null> };
  transition: EntityStateTransition;
}

/**
 * Issue the caller's UPDATE and a paired EntityStateLog INSERT as a single
 * `db.batch()`. The log INSERT is gated on `changes() > 0`, so the fact is
 * recorded iff the UPDATE changed a row, and a thrown statement rolls both
 * back. Returns true when the UPDATE hit.
 */
export async function transitionEntityWithLog(
  db: D1Database,
  req: EntityUpdateWithLog
): Promise<boolean> {
  const results = await db.batch([
    db.prepare(req.update.sql).bind(...req.update.binds),
    buildEntityStateLogConditionalInsert(db, req.transition),
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}
