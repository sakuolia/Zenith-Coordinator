/**
 * @file CASE management — dispute/exception case creation and state updates.
 *       Tracks OPEN -> IN_PROGRESS -> RESOLVED/ESCALATED lifecycle.
 * @module zc/case
 */
import type { CaseState } from "../../types";
import { nowISO } from "../../types";
import { newUUID } from "../../shared/idempotency";
import { CASE_SLA_SEC, CASE_SECONDARY_ESCALATION_COUNT } from "../../shared/constants";
import {
  buildEntityStateLogConditionalInsert,
  buildEntityStateLogInsert,
  transitionEntityWithLog,
} from "../../shared/entity_state_log";

/**
 * States a CASE may be *moved to* through `POST /api/cases/:case_id/update`.
 *
 * `OPEN` is deliberately excluded even though it is a valid `CaseState`: it is
 * the state a CASE is born in, and moving back to it would make "いつ開いたか"
 * ambiguous on a ledger whose whole purpose is to be explainable. A case that
 * needs to be worked again after resolution is a *new* CASE linked to the same
 * txid — the same reasoning that makes a post-b remedy a new transaction rather
 * than a rewind (`10_requirements.md` §4.3).
 */
export const CASE_UPDATE_STATES = ["IN_PROGRESS", "RESOLVED", "ESCALATED"] as const;

export type CaseUpdateState = (typeof CASE_UPDATE_STATES)[number];

/**
 * The states in which a CASE is **still unresolved** — i.e. the condition that
 * opened it may still be true, so opening a second CASE for the same condition
 * would be a duplicate (docs/specs/20_method_design.md §10.7.2).
 *
 * `ESCALATED` belongs here. It is the one non-obvious member, and leaving it out
 * is not a conservative choice but a guaranteed defect: §10.7.4's sweep
 * (`escalateOverdueCases`) moves *every* CASE out of OPEN/IN_PROGRESS once
 * `PR-CASE-SLA` elapses. A de-duplication predicate written as `state='OPEN'`
 * (or even `IN_PROGRESS`) therefore stops matching after one SLA window and the
 * next sweep files a fresh CASE for a condition a human is already looking at —
 * exactly the ticket explosion §10.7.2 exists to prevent, aimed at the alarms
 * that stay true the longest (a broken audit chain, an ownership divergence).
 *
 * `RESOLVED` is the only state that means "this condition has been dealt with";
 * a condition that is still true after resolution legitimately opens a new CASE.
 *
 * Every "is one already open?" query must use this set. `zc/platform/metrics.ts`
 * counts the same set for the open-CASE gauge, so the dashboard and the
 * de-duplication agree on what "open" means.
 */
export const UNRESOLVED_CASE_STATES = ["OPEN", "IN_PROGRESS", "ESCALATED"] as const;

/** SQL fragment: `state IN ('OPEN','IN_PROGRESS','ESCALATED')`. */
export const UNRESOLVED_CASE_STATES_SQL = `state IN (${UNRESOLVED_CASE_STATES.map((s) => `'${s}'`).join(",")})`;

export function isCaseUpdateState(v: unknown): v is CaseUpdateState {
  return typeof v === "string" && (CASE_UPDATE_STATES as readonly string[]).includes(v);
}

export interface OpenCaseInput {
  related_txid?: string;
  related_gtid?: string;
  reason_code: string;
  description?: string;
  opened_by: "ZC" | "BANK" | "OPS";
  /**
   * When this CASE must have progressed by (RFC3339). Defaults to
   * `CASE_SLA_SEC` from now. Past this point the sweep escalates the CASE to
   * ESCALATED — the Auto-Progress → Manual-Only promotion of
   * docs/specs/20_method_design.md §10.7.4.
   */
  sla_deadline?: string;
  /** Evidence reference ids backing the CASE (§10.10.2). */
  evidence_refs?: string[];
  /**
   * The participant (or other entity) this cause is attributed to, when it is
   * known at detection time. Together with `reason_code` it forms the
   * aggregation key of §10.7.2.
   */
  cause_party_id?: string;
  /**
   * Identifier of the detection path, used in the aggregation key *in place of*
   * `cause_party_id` while the responsible party is unknown. §10.7.2's key is
   * "cause × reason"; a detection that cannot yet name the cause still has to
   * aggregate on something, and the alternative — leaving the key null — files
   * one CASE per occurrence for exactly the failures that produce the most of
   * them (an adapter down, a chain break), which is the ticket explosion the
   * rule exists to prevent.
   */
  detection_path?: string;
  /**
   * What this occurrence counts as, when the subject is not a transaction.
   *
   * `occurrence_count` is meant to say how far a cause has spread, and it
   * counts distinct relations. For most detections the subject is a txid or a
   * gtid and this is derived from them. Some causes spread over other subjects
   * — accounts under one adapter, chains under one audit — and without a key of
   * their own every occurrence would look like a repeat of the first, leaving
   * the count pinned at 1 for exactly the failures that spread widest.
   */
  link_key?: string;
}

/**
 * The aggregation key of §10.7.2: `CAUSE:{cause_party_id | detection_path}:{reason_code}`.
 *
 * Returns null when the caller named neither a cause party nor a detection
 * path. Such a CASE stands alone: it is not aggregated into, and nothing is
 * aggregated into it. That is deliberate — a key of `CAUSE::REASON` would bind
 * together every unattributed CASE that happens to share a reason code, which
 * is not "one cause, one CASE" but "one word, one CASE".
 */
export function causeKey(input: {
  reason_code: string;
  cause_party_id?: string;
  detection_path?: string;
}): string | null {
  const cause = input.cause_party_id ?? input.detection_path;
  return cause ? `CAUSE:${cause}:${input.reason_code}` : null;
}

/**
 * Open a case
 */
export async function openCase(db: D1Database, input: OpenCaseInput): Promise<string> {
  const caseId = `CASE-${newUUID()}`;
  const now = nowISO();
  // Every CASE carries a deadline. A CASE without one can never be promoted out
  // of Auto-Progress, which is precisely the "waiting forever, unnoticed" state
  // §10.7.4 exists to prevent — so the default is applied here rather than left
  // to each caller to remember.
  const slaDeadline =
    input.sla_deadline ?? new Date(Date.parse(now) + CASE_SLA_SEC * 1000).toISOString();

  const key = causeKey(input);
  const link = input.link_key ?? input.related_txid ?? input.related_gtid ?? null;

  await db.batch([
    db
      .prepare(
        `INSERT INTO Cases
     (case_id, related_txid, related_gtid, state, reason_code, description, opened_by, sla_deadline, evidence_refs,
      cause_key, cause_party_id, detection_path, occurrence_count, last_occurred_at, created_at, updated_at)
     VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
      .bind(
        caseId,
        input.related_txid ?? null,
        input.related_gtid ?? null,
        input.reason_code,
        input.description ?? null,
        input.opened_by,
        slaDeadline,
        input.evidence_refs ? JSON.stringify(input.evidence_refs) : null,
        key,
        input.cause_party_id ?? null,
        input.detection_path ?? null,
        now,
        now,
        now
      ),
    buildEntityStateLogInsert(db, {
      entityType: "CASE",
      entityId: caseId,
      eventType: "CaseOpened",
      stateFrom: null,
      stateTo: "OPEN",
      reasonCode: input.reason_code,
      actor: input.opened_by,
      payload: {
        related_txid: input.related_txid ?? null,
        related_gtid: input.related_gtid ?? null,
        sla_deadline: slaDeadline,
        cause_key: key,
      },
    }),
    ...(link
      ? [
          db
            .prepare(
              `INSERT INTO CaseRelatedTransactions (case_id, link_key, related_txid, related_gtid, linked_at)
               VALUES (?, ?, ?, ?, ?)`
            )
            .bind(caseId, link, input.related_txid ?? null, input.related_gtid ?? null, now),
        ]
      : []),
  ]);

  // Associate case_id with Transactions
  if (input.related_txid) {
    await db
      .prepare(`UPDATE Transactions SET case_id=?, updated_at=? WHERE txid=?`)
      .bind(caseId, now, input.related_txid)
      .run();
  }

  return caseId;
}

/** Outcome of `openOrAggregateCase`. */
export interface AggregateCaseResult {
  case_id: string;
  /** True when the occurrence was folded into a CASE that already existed. */
  aggregated: boolean;
}

/**
 * File an occurrence under §10.7.2's aggregation rule: one cause, one CASE.
 *
 * Where an unresolved CASE already carries this occurrence's cause key, the
 * occurrence is *related* to it — `occurrence_count` is incremented and
 * `last_occurred_at` advanced — instead of opening a second CASE. Otherwise a
 * CASE is opened as usual.
 *
 * Two properties are load-bearing:
 *
 *  - **"Already filed?" is asked with `UNRESOLVED_CASE_STATES`**, ESCALATED
 *    included. Omitting it makes aggregation stop working after exactly one SLA
 *    window, precisely for the long-lived causes a person is already handling
 *    (see the constant's own comment, and §10.7.2.1).
 *  - **The count follows the link table, not the call.** The relation insert is
 *    `INSERT OR IGNORE` on `(case_id, link_key)` and the increment is gated on
 *    it having inserted a row, so a retried detection of the *same* transaction
 *    does not inflate the count. `occurrence_count` therefore means "distinct
 *    transactions bound to this cause", which is what makes the §10.7.2 count
 *    threshold a statement about spread rather than about retry volume.
 *
 * An occurrence with no cause party and no detection path has no key
 * (`causeKey` returns null) and is opened as a standalone CASE.
 */
export async function openOrAggregateCase(
  db: D1Database,
  input: OpenCaseInput
): Promise<AggregateCaseResult> {
  const key = causeKey(input);
  const link = input.link_key ?? input.related_txid ?? input.related_gtid ?? null;
  if (!key) return { case_id: await openCase(db, input), aggregated: false };

  const existing = await db
    .prepare(
      `SELECT case_id, state FROM Cases
        WHERE cause_key = ? AND ${UNRESOLVED_CASE_STATES_SQL}
        ORDER BY created_at ASC LIMIT 1`
    )
    .bind(key)
    .first<{ case_id: string; state: string }>();

  if (!existing) return { case_id: await openCase(db, input), aggregated: false };

  const now = nowISO();
  if (!link) {
    // Nothing to relate, but the cause did occur again: advance the recency
    // marker so the secondary escalation of §10.7.2 can still see that this
    // cause is still live. The count tracks distinct transactions, so it does
    // not move here.
    await db
      .prepare(`UPDATE Cases SET last_occurred_at=?, updated_at=? WHERE case_id=?`)
      .bind(now, now, existing.case_id)
      .run();
    return { case_id: existing.case_id, aggregated: true };
  }

  // INSERT OR IGNORE → gated UPDATE → gated log, in one batch. Each statement
  // after the first is conditioned on `changes() > 0` of the one before it, so
  // a duplicate link writes nothing at all: no double count, no phantom fact.
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO CaseRelatedTransactions (case_id, link_key, related_txid, related_gtid, linked_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(existing.case_id, link, input.related_txid ?? null, input.related_gtid ?? null, now),
    db
      .prepare(
        `UPDATE Cases SET occurrence_count = occurrence_count + 1, last_occurred_at = ?, updated_at = ?
          WHERE case_id = ? AND changes() > 0`
      )
      .bind(now, now, existing.case_id),
    buildEntityStateLogConditionalInsert(db, {
      entityType: "CASE",
      entityId: existing.case_id,
      eventType: "CaseOccurrenceAggregated",
      stateFrom: existing.state,
      stateTo: existing.state,
      reasonCode: input.reason_code,
      actor: input.opened_by,
      payload: {
        cause_key: key,
        related_txid: input.related_txid ?? null,
        related_gtid: input.related_gtid ?? null,
      },
    }),
  ]);

  if (input.related_txid) {
    await db
      .prepare(`UPDATE Transactions SET case_id=?, updated_at=? WHERE txid=? AND case_id IS NULL`)
      .bind(existing.case_id, now, input.related_txid)
      .run();
  }

  return { case_id: existing.case_id, aggregated: true };
}

/**
 * Update CASE state
 */
export async function updateCase(
  db: D1Database,
  caseId: string,
  newState: CaseState,
  resolvedAt?: string
): Promise<void> {
  const now = nowISO();
  const cur = await db
    .prepare(`SELECT state FROM Cases WHERE case_id = ?`)
    .bind(caseId)
    .first<{ state: string }>();
  if (!cur || cur.state === newState) return;

  await transitionEntityWithLog(db, {
    update: {
      // `escalated_at` is stamped on the promotion to ESCALATED and never
      // moved afterwards: the secondary escalation of §10.7.2 asks whether the
      // cause has kept occurring *since a person was queued*, so its baseline
      // has to be the moment of queueing, not the latest touch of the row.
      sql: `UPDATE Cases SET state=?, resolved_at=COALESCE(?, resolved_at),
              escalated_at=CASE WHEN ?='ESCALATED' AND escalated_at IS NULL THEN ? ELSE escalated_at END,
              updated_at=? WHERE case_id=? AND state=?`,
      binds: [newState, resolvedAt ?? null, newState, now, now, caseId, cur.state],
    },
    transition: {
      entityType: "CASE",
      entityId: caseId,
      eventType: "CaseStateChanged",
      stateFrom: cur.state,
      stateTo: newState,
    },
  });
}

/**
 * Automatically transition the CASE to a resolved state (automatic convergence driven by state progression)
 */
export async function autoResolveCaseForTx(db: D1Database, txid: string): Promise<void> {
  const row = await db
    .prepare(`SELECT case_id FROM Transactions WHERE txid=? AND case_id IS NOT NULL`)
    .bind(txid)
    .first<{ case_id: string }>();
  if (row?.case_id) {
    const c = await db
      .prepare(`SELECT state FROM Cases WHERE case_id=?`)
      .bind(row.case_id)
      .first<{ state: string }>();
    if (c && (c.state === "OPEN" || c.state === "IN_PROGRESS")) {
      await updateCase(db, row.case_id, "RESOLVED", nowISO());
    }
  }
}

/**
 * Auto-Progress → Manual-Only promotion (docs/specs/20_method_design.md §10.7.4).
 *
 * A CASE that has sat in OPEN / IN_PROGRESS past its `sla_deadline` has stopped
 * progressing on its own; leaving it there is the failure mode §10.7.4 names
 * ("`next_action_hint=WAIT` のみで一定期間推移しない場合… 昇格する"). Escalating
 * it moves it out of the automatic pool and into the human queue.
 *
 * Deliberately *not* resolution: ESCALATED means "a person must look", not
 * "finished". Nothing here touches the related transaction — the CASE lifecycle
 * and the payment lifecycle stay separate (§3.6).
 *
 * @returns number of CASEs escalated.
 */
export async function escalateOverdueCases(db: D1Database, nowIso: string): Promise<number> {
  const overdue = await db
    .prepare(
      `SELECT case_id FROM Cases
        WHERE state IN ('OPEN','IN_PROGRESS')
          AND sla_deadline IS NOT NULL
          AND sla_deadline < ?`
    )
    .bind(nowIso)
    .all<{ case_id: string }>();

  let escalated = 0;
  for (const c of overdue.results ?? []) {
    await updateCase(db, c.case_id, "ESCALATED");
    escalated++;
  }
  return escalated;
}

/**
 * Auto-close the CASEs a GTID opened, once the GTID itself has converged.
 *
 * Deliberately narrower than `UNRESOLVED_CASE_STATES`: an `ESCALATED` CASE means
 * "a person must look" (§10.7.4), and closing it from a machine path would
 * un-queue that person without anyone deciding to. Auto-Resolvable ends at the
 * boundary where the CASE was promoted to Manual-Only.
 */
export async function autoResolveCaseForGtid(db: D1Database, gtid: string): Promise<void> {
  const cases = await db
    .prepare(`SELECT case_id FROM Cases WHERE related_gtid=? AND state IN ('OPEN', 'IN_PROGRESS')`)
    .bind(gtid)
    .all<{ case_id: string }>();
  for (const c of cases?.results ?? []) {
    await updateCase(db, c.case_id, "RESOLVED", nowISO());
  }
}

/**
 * Secondary escalation for a CASE a person already holds
 * (docs/specs/20_method_design.md §10.7.2.2).
 *
 * §10.7.2.1 folds every further occurrence of a cause into the existing CASE,
 * ESCALATED included, and §10.7.4 forbids auto-closing an ESCALATED CASE. Both
 * rules are right and their intersection is a blind spot: while a CASE waits in
 * the human queue, the cause can keep spreading without moving the CASE count
 * or the CASE state. Nothing in the system says so. This sweep says so.
 *
 * Fires on either signal from `openOrAggregateCase`'s bookkeeping:
 *  - `occurrence_count` past `CASE_SECONDARY_ESCALATION_COUNT` — the cause is wide; or
 *  - `last_occurred_at` after `escalated_at` — the cause is *still occurring*
 *    after a person was queued, however few transactions it has touched.
 *
 * **The state is not changed.** ESCALATED is already the terminal handling
 * state; promoting it further would mean nothing, and re-opening it would
 * overrule the person §10.7.4 just queued. What this emits is a fact
 * (`CaseSecondaryEscalated` on `EntityStateLog`, `state_from = state_to`) for
 * whatever notification path consumes that log.
 *
 * `last_notified_at` bounds the noise: a CASE is re-notified only once new
 * occurrences arrive after the previous notice, so a wide-but-quiet CASE is
 * announced once rather than on every sweep tick.
 *
 * @returns the case_ids notified on this pass.
 */
export async function sweepSecondaryEscalations(
  db: D1Database,
  nowIso: string = nowISO()
): Promise<string[]> {
  const due = await db
    .prepare(
      `SELECT case_id, reason_code, cause_key, occurrence_count, last_occurred_at
         FROM Cases
        WHERE state = 'ESCALATED'
          AND ( occurrence_count > ?
                OR (last_occurred_at IS NOT NULL AND escalated_at IS NOT NULL
                    AND last_occurred_at > escalated_at) )
          AND ( last_notified_at IS NULL
                OR (last_occurred_at IS NOT NULL AND last_occurred_at > last_notified_at) )`
    )
    .bind(CASE_SECONDARY_ESCALATION_COUNT)
    .all<{
      case_id: string;
      reason_code: string;
      cause_key: string | null;
      occurrence_count: number;
      last_occurred_at: string | null;
    }>();

  const notified: string[] = [];
  for (const c of due.results ?? []) {
    await db.batch([
      db
        .prepare(`UPDATE Cases SET last_notified_at=?, updated_at=? WHERE case_id=?`)
        .bind(nowIso, nowIso, c.case_id),
      buildEntityStateLogConditionalInsert(db, {
        entityType: "CASE",
        entityId: c.case_id,
        eventType: "CaseSecondaryEscalated",
        stateFrom: "ESCALATED",
        stateTo: "ESCALATED",
        reasonCode: c.reason_code,
        actor: "ZC",
        payload: {
          cause_key: c.cause_key,
          occurrence_count: c.occurrence_count,
          last_occurred_at: c.last_occurred_at,
          threshold: CASE_SECONDARY_ESCALATION_COUNT,
        },
      }),
    ]);
    notified.push(c.case_id);
  }
  return notified;
}
