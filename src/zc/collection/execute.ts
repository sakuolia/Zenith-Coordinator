/**
 * @file execute.ts — firing collections on their due date, recording attempts,
 *       and confirming the outcome.
 *
 * Three things here are load-bearing and easy to undo by accident:
 *
 *  1. **Allocation order is decided by ZC, not by the core.** ZC does not know
 *     the customer's balance, but it does not need to: handing the core an
 *     ordered set and letting it reject what does not fit *is* the greedy fill.
 *     That keeps the optimisation auditable (we can say why A was collected and
 *     B was not) while asking the core for no new capability at all.
 *
 *  2. **Success and failure become final at different times.** Success is final
 *     when b lands — money moved, nothing more can change it. Failure is final
 *     only once no further attempt can happen, which for a SCHEDULED collection
 *     is 24:00 of the due date, because the core may retry through the day and
 *     a customer who pays in at noon should be collected that evening.
 *
 *  3. **Expected insufficient funds is not a CASE.** Nothing was reserved ahead
 *     of the due date, so the adapter's "the shadow authorised it but the core
 *     refused" divergence test simply does not apply here. Filing millions of
 *     ordinary failures as CASEs would drown the mechanism that exists for real
 *     divergence.
 *
 * docs/specs/20_method_design.md §2.2.7.4-5, docs/specs/10_requirements.md §3.2.8.6/§3.2.8.9.
 *
 * @module zc/collection/execute
 */
import type { DebitMandateRow, Env, ScheduledCollectionRow } from "../../types";
import { nowISO } from "../../types";
import { newUUID } from "../../shared/idempotency";
import { openOrAggregateCase } from "../cases/case";
import { writeFinalityLog } from "../orchestrator";
import { insertTxWithLog, transferOwnership, transitionWithLog } from "../lanes/_helpers";
import { releaseBudget } from "./budget";

/** A collection competing for one customer's balance on one due date. */
export interface OrderableCollection {
  collection_id: string;
  /** Customer's own priority declaration, when the contract carries one. */
  priority_hint: number | null;
  /** Due date of the ladder's FIRST rung — how old the underlying claim is. */
  original_due_date: string;
  amount_total: number;
}

/**
 * Lexicographic allocation order, deliberately the same shape as the Bulk LSM
 * comparator (`src/zc/liquidity/bulk_lsm.ts`).
 *
 * Ascending amount is what maximises the number of collections that succeed
 * under a fixed balance — that is the LSM's `throughput` term, and it is the
 * right primary economic objective. On its own, though, it is regressive once
 * ladders exist: a collection that has already failed carries a late fee, so it
 * is *larger*, so pure amount ordering pushes the oldest debt furthest back
 * exactly when it most needs to succeed. The age term ahead of it cancels that,
 * the same way the LSM puts `due_at` ahead of `throughput`.
 *
 * The final term must be deterministic — ordering by arrival or ROWID is how
 * you end up crediting the wrong party (the same reasoning as GTID's `leg_id`
 * ordering rule).
 */
export function allocationOrder(a: OrderableCollection, b: OrderableCollection): number {
  // 1. The customer's own ranking, when they have expressed one. Nothing in the
  //    existing rails offers this: it is the customer deciding which of their
  //    own obligations survives a shortfall.
  const pa = a.priority_hint ?? Number.MAX_SAFE_INTEGER;
  const pb = b.priority_hint ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  // 2. Age of the underlying claim.
  if (a.original_due_date !== b.original_due_date) {
    return a.original_due_date < b.original_due_date ? -1 : 1;
  }
  // 3. Throughput.
  if (a.amount_total !== b.amount_total) return a.amount_total - b.amount_total;
  // 4. Deterministic tie-break.
  return a.collection_id < b.collection_id ? -1 : a.collection_id > b.collection_id ? 1 : 0;
}

/**
 * Collections eligible to fire on `businessDate`.
 *
 * A later rung waits for two conditions, not one: its own date, *and* the
 * previous rung having confirmed as failed. Driving on the date alone would
 * double-collect whenever the core's window ran late, because the earlier rung
 * would still be open.
 */
export async function selectDueCollections(
  db: D1Database,
  businessDate: string
): Promise<ScheduledCollectionRow[]> {
  const rows = await db
    .prepare(
      `SELECT c.* FROM ScheduledCollection c
         JOIN DebitMandate m USING (dd_mandate_id)
        WHERE c.due_date <= ?
          AND c.state IN ('SCHEDULED', 'FROZEN')
          AND c.result IS NULL
          AND m.state = 'ACTIVE'`
    )
    .bind(businessDate)
    .all<ScheduledCollectionRow>();

  const eligible: ScheduledCollectionRow[] = [];
  for (const row of rows.results) {
    if (row.ladder_seq === 1) {
      eligible.push(row);
      continue;
    }
    const prior = await db
      .prepare(
        `SELECT result, state FROM ScheduledCollection
          WHERE dd_mandate_id = ? AND charge_ref = ? AND ladder_seq < ?
          ORDER BY ladder_seq DESC LIMIT 1`
      )
      .bind(row.dd_mandate_id, row.charge_ref, row.ladder_seq)
      .first<{ result: string | null; state: string }>();
    // Only a *confirmed* failure opens the next rung. An earlier rung still
    // inside its window is not a failure yet.
    if (prior?.result === "CONFIRMED_NG") eligible.push(row);
  }
  return eligible;
}

/** Attach ordering keys, resolving each ladder's original due date. */
export async function toOrderable(
  db: D1Database,
  rows: ScheduledCollectionRow[]
): Promise<OrderableCollection[]> {
  const out: OrderableCollection[] = [];
  for (const row of rows) {
    const first = await db
      .prepare(
        `SELECT due_date FROM ScheduledCollection
          WHERE dd_mandate_id = ? AND charge_ref = ? ORDER BY ladder_seq ASC LIMIT 1`
      )
      .bind(row.dd_mandate_id, row.charge_ref)
      .first<{ due_date: string }>();
    out.push({
      collection_id: row.collection_id,
      priority_hint: row.priority_hint,
      original_due_date: first?.due_date ?? row.due_date,
      amount_total: row.amount_value + row.latefee_value,
    });
  }
  return out;
}

export interface FireResult {
  fired: string[];
  order: string[];
  skipped: Array<{ collection_id: string; reason_code: string }>;
}

/**
 * Fire the day's collections in allocation order.
 *
 * The order and the reason for it go to the FinalityLog before anything moves,
 * the same way the Bulk LSM records its adoption rationale. Without that record
 * "why was A collected and B not" has no answer, and the fairness rule would be
 * a claim rather than a fact.
 */
export async function fireDueCollections(
  env: Env,
  businessDate: string,
  now: string = nowISO()
): Promise<FireResult> {
  const db = env.DB;
  const due = await selectDueCollections(db, businessDate);
  const orderable = await toOrderable(db, due);
  orderable.sort(allocationOrder);

  const byId = new Map(due.map((r) => [r.collection_id, r]));
  const order = orderable.map((o) => o.collection_id);

  await writeFinalityLog(db, {
    txid: null,
    event_type: "CollectionAllocationOrdered",
    state_from: null,
    state_to: "ORDERED",
    payload_json: JSON.stringify({
      business_date: businessDate,
      objective: ["customer_priority", "claim_age", "amount_asc", "collection_id"],
      order,
    }),
    txid_or_gtid: `COLORD-${businessDate}`,
  });

  const fired: string[] = [];
  const skipped: FireResult["skipped"] = [];
  for (const id of order) {
    const row = byId.get(id)!;
    const outcome = await fireCollection(env, row, now);
    if (outcome.ok) fired.push(id);
    else skipped.push({ collection_id: id, reason_code: outcome.reason_code });
  }
  return { fired, order, skipped };
}

/**
 * Materialise one collection as a Transaction and hand it to the core.
 *
 * Ownership moves to `CORE:<bank>:<date>` for modes that have a settlement
 * window, so the timeout sweep leaves the row alone while the core is still
 * retrying — the same single-owner discipline HIGH_VALUE uses for an external
 * venue. REALTIME has no window and keeps `owner='ZC'`.
 */
async function fireCollection(
  env: Env,
  row: ScheduledCollectionRow,
  now: string
): Promise<{ ok: true; txid: string } | { ok: false; reason_code: string }> {
  const db = env.DB;
  const contract = await db
    .prepare(`SELECT * FROM DebitMandate WHERE dd_mandate_id = ?`)
    .bind(row.dd_mandate_id)
    .first<DebitMandateRow>();
  if (!contract) return { ok: false, reason_code: "DD_MANDATE_NOT_FOUND" };

  const txid = `TX-DD-${row.collection_id}`;
  const total = row.amount_value + row.latefee_value;
  const owner = row.mode === "REALTIME" ? "ZC" : `CORE:${contract.payer_bank_id}:${row.due_date}`;

  await insertTxWithLog(db, {
    txid,
    lane: "DIRECT_DEBIT",
    initialState: "RECEIVED",
    amount: { value: total, currency: row.amount_currency },
    payerBankId: contract.payer_bank_id,
    payerAccountHash: contract.payer_account_alias,
    payeeBankId: contract.payee_bank_id,
    payeeAccountHash: contract.payee_account_hash,
    idempotencyKey: `DD-${row.collection_id}`,
    extraColumns: {
      purpose: "BILL",
      mandate_id: contract.mandate_id,
      edi_ref: row.edi_ref,
      owner,
    },
    eventType: "PaymentInitiated",
    payload: {
      txid,
      lane: "DIRECT_DEBIT",
      collection_id: row.collection_id,
      charge_ref: row.charge_ref,
      ladder_seq: row.ladder_seq,
      mode: row.mode,
      owner,
    },
    sideUpdates: [
      {
        sql: `UPDATE ScheduledCollection
                 SET state = 'FIRED', txid = ?, fired_at = ?, updated_at = ?, version = version + 1
               WHERE collection_id = ? AND state IN ('SCHEDULED','FROZEN')`,
        binds: [txid, now, now, row.collection_id],
      },
    ],
  });

  await env.QUEUE.send({
    type: "ZC_STATE_ADVANCE",
    payload: { txid, action: "ADVANCE_STANDARD" },
    txid,
    attempt: 0,
    enqueued_at: now,
  });

  return { ok: true, txid };
}

export interface RecordAttemptParams {
  collectionId: string;
  result: "OK" | "NG";
  reasonCode?: string | null;
  bankProofRef?: string | null;
  observedAt?: string;
}

/**
 * Reason codes that today's money cannot fix. A payee chasing these would be
 * spending on a reminder that cannot work.
 */
const NOT_RETRIABLE_TODAY = new Set([
  "ACCOUNT_NOT_FOUND",
  "ACCOUNT_CLOSED",
  "ACCOUNT_FROZEN",
  "MANDATE_REVOKED",
  "MANDATE_EXPIRED",
  "MANDATE_BREACH",
]);

/**
 * Record one observation from the core.
 *
 * A successful attempt confirms the collection immediately. A failed one does
 * not: it is appended and the collection stays open, because within a
 * SCHEDULED window another pass may still succeed. That intermediate state is
 * not a verdict, but it is precisely what lets a payee act while acting is
 * still useful.
 */
export async function recordAttempt(
  db: D1Database,
  params: RecordAttemptParams
): Promise<
  | { result: "RECORDED"; attempt_no: number; confirmed: boolean }
  | { result: "ERROR"; reason_code: string }
> {
  const observedAt = params.observedAt ?? nowISO();
  const row = await db
    .prepare(`SELECT * FROM ScheduledCollection WHERE collection_id = ?`)
    .bind(params.collectionId)
    .first<ScheduledCollectionRow>();
  if (!row) return { result: "ERROR", reason_code: "COLLECTION_NOT_FOUND" };
  if (row.result !== null) return { result: "ERROR", reason_code: "STATE_GUARD" };

  const prior = await db
    .prepare(`SELECT MAX(attempt_no) AS n FROM CollectionAttempt WHERE collection_id = ?`)
    .bind(params.collectionId)
    .first<{ n: number | null }>();
  const attemptNo = (prior?.n ?? 0) + 1;
  const retriable =
    params.result === "NG" && !NOT_RETRIABLE_TODAY.has(params.reasonCode ?? "") ? 1 : 0;

  await db
    .prepare(
      `INSERT INTO CollectionAttempt
         (attempt_id, collection_id, attempt_no, observed_at, result, reason_code,
          retriable_today, bank_proof_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      `CATT-${newUUID()}`,
      params.collectionId,
      attemptNo,
      observedAt,
      params.result,
      params.reasonCode ?? null,
      retriable,
      params.bankProofRef ?? null,
      observedAt
    )
    .run();

  await db
    .prepare(
      `UPDATE ScheduledCollection SET retriable_today = ?, updated_at = ?, version = version + 1
        WHERE collection_id = ?`
    )
    .bind(retriable, observedAt, params.collectionId)
    .run();

  if (params.result === "OK") {
    await confirmCollection(db, params.collectionId, "CONFIRMED_OK", null, observedAt);
    return { result: "RECORDED", attempt_no: attemptNo, confirmed: true };
  }
  return { result: "RECORDED", attempt_no: attemptNo, confirmed: false };
}

/**
 * Write the terminal verdict and settle the budget accordingly.
 *
 * CONFIRMED_OK also supersedes the ladder's remaining rungs. They are moved to
 * SUPERSEDED rather than deleted so the customer can still be told that the
 * 13 May retry was cancelled because 27 April succeeded.
 */
export async function confirmCollection(
  db: D1Database,
  collectionId: string,
  result: "CONFIRMED_OK" | "CONFIRMED_NG",
  reasonCode: string | null,
  at: string = nowISO()
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT * FROM ScheduledCollection WHERE collection_id = ?`)
    .bind(collectionId)
    .first<ScheduledCollectionRow>();
  if (!row || row.result !== null) return false;

  const applied = await db
    .prepare(
      `UPDATE ScheduledCollection
          SET result = ?, reason_code = ?, confirmed_at = ?, updated_at = ?, version = version + 1
        WHERE collection_id = ? AND result IS NULL`
    )
    .bind(result, reasonCode, at, at, collectionId)
    .run();
  if ((applied.meta.changes ?? 0) === 0) return false;

  await releaseBudget(
    db,
    row.dd_mandate_id,
    row.amount_value,
    row.latefee_value,
    result === "CONFIRMED_OK" ? "SETTLED" : "FAILED",
    at
  );

  if (result === "CONFIRMED_OK") {
    await db
      .prepare(
        `UPDATE ScheduledCollection
            SET state = 'SUPERSEDED', reason_code = 'SUPERSEDED_BY_EARLIER_RUNG',
                updated_at = ?, version = version + 1
          WHERE dd_mandate_id = ? AND charge_ref = ? AND collection_id != ?
            AND result IS NULL AND state IN ('SCHEDULED','FROZEN','AWAITING_ADDITIONAL_AUTH')`
      )
      .bind(at, row.dd_mandate_id, row.charge_ref, collectionId)
      .run();
  }

  await writeFinalityLog(db, {
    txid: row.txid,
    event_type: result === "CONFIRMED_OK" ? "CollectionConfirmed" : "CollectionFailed",
    state_from: row.state,
    state_to: result,
    payload_json: JSON.stringify({
      collection_id: collectionId,
      charge_ref: row.charge_ref,
      ladder_seq: row.ladder_seq,
      reason_code: reasonCode,
    }),
    txid_or_gtid: collectionId,
  });
  return true;
}

/**
 * Close out collections whose deadline has passed with no success.
 *
 * One predicate covers every mode because the deadline is data rather than a
 * constant baked into this function — `SCHEDULED` carries 24:00 of the due
 * date, `REALTIME` carries the Decision instant. A mode with some other
 * finality point would need no change here.
 *
 * An ordinary shortfall ends as CONFIRMED_NG and nothing else. It is the
 * expected terminal state of a collection, not an anomaly, and only genuine
 * divergence earns a CASE.
 */
export async function sweepConfirmDeadlines(
  db: D1Database,
  now: string = nowISO()
): Promise<{ confirmed_ng: number; cases_opened: number }> {
  const rows = await db
    .prepare(
      `SELECT * FROM ScheduledCollection
        WHERE result IS NULL AND confirm_deadline_at <= ? AND state = 'FIRED'`
    )
    .bind(now)
    .all<ScheduledCollectionRow>();

  let casesOpened = 0;
  for (const row of rows.results) {
    const last = await db
      .prepare(
        `SELECT reason_code FROM CollectionAttempt
          WHERE collection_id = ? ORDER BY attempt_no DESC LIMIT 1`
      )
      .bind(row.collection_id)
      .first<{ reason_code: string | null }>();
    const reason = last?.reason_code ?? "INSUFFICIENT_FUNDS";
    await confirmCollection(db, row.collection_id, "CONFIRMED_NG", reason, now);

    // Return ownership: the core's window is over either way. Routed through
    // `transferOwnership` rather than an UPDATE so the handoff lands in the
    // FinalityLog — "when did custody come back from the core" is exactly the
    // question the single-owner rule exists to answer.
    if (row.txid) {
      const tx = await db
        .prepare(`SELECT owner FROM Transactions WHERE txid = ?`)
        .bind(row.txid)
        .first<{ owner: string }>();
      if (tx?.owner?.startsWith("CORE:")) {
        await transferOwnership(db, {
          txid: row.txid,
          fromOwner: tx.owner,
          toOwner: "ZC",
          eventType: "OwnershipTransferred",
          payload: {
            reason: "collection confirm deadline reached",
            collection_id: row.collection_id,
          },
        });
      }
    }

    // A collection that never even reported an attempt is not an ordinary
    // shortfall — the core said nothing at all, which is exactly the kind of
    // unexplained state that has to converge into a CASE.
    const attempts = await db
      .prepare(`SELECT COUNT(*) AS n FROM CollectionAttempt WHERE collection_id = ?`)
      .bind(row.collection_id)
      .first<{ n: number }>();
    if ((attempts?.n ?? 0) === 0) {
      await openOrAggregateCase(db, {
        related_txid: row.txid ?? undefined,
        reason_code: "COLLECTION_NO_ATTEMPT_REPORTED",
        opened_by: "ZC",
        link_key: row.collection_id,
        description:
          `Collection ${row.collection_id} passed its confirm deadline with no attempt ` +
          `reported by the core. Not an ordinary shortfall — the outcome is unknown.`,
      });
      casesOpened++;
    }
  }

  return { confirmed_ng: rows.results.length, cases_opened: casesOpened };
}

/**
 * Advance a fired collection's transaction once the core confirms the debit.
 * Kept separate from `recordAttempt` so the observation and the state advance
 * remain distinguishable in the log.
 */
export async function markPayerConfirmed(
  db: D1Database,
  txid: string,
  now: string = nowISO()
): Promise<boolean> {
  const t = await transitionWithLog(db, {
    txid,
    fromState: "DECIDED_TO_SETTLE",
    toState: "PAYER_EXEC_CONFIRMED",
    eventType: "PayerExecConfirmed",
    payload: { txid, lane: "DIRECT_DEBIT" },
    setColumns: { owner: "ZC" },
  });
  void now;
  return t.applied;
}
