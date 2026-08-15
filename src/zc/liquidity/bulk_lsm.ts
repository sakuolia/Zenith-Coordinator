/**
 * @file bulk_lsm.ts — Bulk/Deferred LSM (Liquidity Saving Mechanism) optimiser.
 *
 * Implements the normative objective, audit trail, and fallback of
 * docs/specs/30_internal_design.md 第14章, closing the "Bulk LSM 流動性節約最適化" gap in
 * docs/specs/30_internal_design.md § 7. The prior bulk path advanced every queued tx in
 * arrival order (FIFO-equivalent) with no recorded rationale; this selects an
 * execution set against the live H constraints by the spec's lexicographic
 * objective and records *why* (input snapshot, constraints, execution set, trace,
 * objective metrics) on the FinalityLog and in LsmRuns.
 *
 * Lexicographic objective (§14.1, in priority order):
 *   1. due_at adherence  — never miss a deadline you can meet
 *   2. fairness          — prevent starvation (longest-waiting first)
 *   3. throughput        — settle as many as the H budget allows
 * H constraint (安全弁) is absolute: a tx is only *selected* if its payer's
 * remaining H budget covers it, and final commit is still gated by advanceBulk's
 * real H reservation. Non-selected tx are deferred (carried to the next window),
 * never rejected.
 *
 * Fallback (§14.3): if optimisation throws, processing must not stop — a FIFO /
 * PRIORITY / THROTTLE fallback runs, the degradation is recorded in
 * objective_metrics, and ops is notified (LsmRunFallback + console.error).
 *
 * @module zc/lanes/bulk_lsm
 */
import type { Env } from "../../types";
import { nowISO, businessDateJST } from "../../types";
import { newUUID } from "../../shared/idempotency";
import { sha256hex } from "../../shared/hmac";
import { writeFinalityLog } from "../orchestrator";
import { advanceBulk } from "../lanes/bulk";
import { LSM_FAIRNESS_BUCKET_SEC } from "../../shared/constants";

/** A window-cutoff candidate (one queued BULK tx awaiting an execution decision). */
interface LsmCandidate {
  txid: string;
  payer_bank_id: string;
  amount_value: number;
  /** Deadline (Transactions.expires_at). null = no explicit deadline. */
  due_at: string | null;
  created_at: string;
}

type LsmMode = "OPTIMIZED" | "FIFO" | "PRIORITY" | "THROTTLE";

export interface LsmRunResult {
  run_id: string;
  mode: LsmMode;
  is_fallback: boolean;
  selected: string[];
  deferred: string[];
  committed: string[];
  objective_metrics: Record<string, unknown>;
}

const FAR_FUTURE = "9999-12-31T23:59:59.999Z";

/**
 * Greedy selection under a per-payer H budget, walking candidates in the order
 * the chosen objective dictates. A tx whose payer cannot currently cover it is
 * deferred and the walk continues (so a smaller later tx can still fit — the
 * throughput dimension). Pure: no DB writes, returns the decision + trace.
 */
function greedySelect(
  candidates: LsmCandidate[],
  budgets: Map<string, number>,
  order: (a: LsmCandidate, b: LsmCandidate) => number
): {
  selected: LsmCandidate[];
  deferred: LsmCandidate[];
  trace: Array<{ txid: string; decision: "SELECT" | "DEFER"; reason: string }>;
} {
  const sorted = [...candidates].sort(order);
  const remaining = new Map(budgets);
  const selected: LsmCandidate[] = [];
  const deferred: LsmCandidate[] = [];
  const trace: Array<{ txid: string; decision: "SELECT" | "DEFER"; reason: string }> = [];

  for (const c of sorted) {
    const avail = remaining.get(c.payer_bank_id) ?? 0;
    if (c.amount_value <= avail) {
      selected.push(c);
      remaining.set(c.payer_bank_id, avail - c.amount_value);
      trace.push({ txid: c.txid, decision: "SELECT", reason: "H_BUDGET_OK" });
    } else {
      deferred.push(c);
      trace.push({ txid: c.txid, decision: "DEFER", reason: "H_BUDGET_INSUFFICIENT" });
    }
  }
  return { selected, deferred, trace };
}

/** Lexicographic objective comparator: due_at asc, then longest-wait, then amount asc. */
function lexicographicOrder(now: number) {
  return (a: LsmCandidate, b: LsmCandidate): number => {
    // 1. due_at adherence — earliest deadline first.
    const da = a.due_at ?? FAR_FUTURE;
    const db = b.due_at ?? FAR_FUTURE;
    if (da !== db) return da < db ? -1 : 1;
    // 2. fairness — longest-waiting first, bucketed so tiny timing jitter does
    //    not outweigh throughput. Larger wait bucket ⇒ earlier.
    const wa = Math.floor((now - Date.parse(a.created_at)) / 1000 / LSM_FAIRNESS_BUCKET_SEC);
    const wb = Math.floor((now - Date.parse(b.created_at)) / 1000 / LSM_FAIRNESS_BUCKET_SEC);
    if (wa !== wb) return wb - wa;
    // 3. throughput — smaller amounts first fit more tx under the same budget.
    if (a.amount_value !== b.amount_value) return a.amount_value - b.amount_value;
    return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0;
  };
}

/** FIFO fallback: arrival order. */
function fifoOrder(a: LsmCandidate, b: LsmCandidate): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0;
}

/** PRIORITY fallback: deadline order only. */
function priorityOrder(a: LsmCandidate, b: LsmCandidate): number {
  const da = a.due_at ?? FAR_FUTURE;
  const db = b.due_at ?? FAR_FUTURE;
  if (da !== db) return da < db ? -1 : 1;
  return fifoOrder(a, b);
}

/**
 * THROTTLE fallback: FIFO, but each payer is capped at half its available H this
 * window so no single participant drains the rail (間引き). Deliberately the most
 * degraded mode — recorded as such in objective_metrics.
 */
function throttleSelect(candidates: LsmCandidate[], budgets: Map<string, number>) {
  const capped = new Map<string, number>();
  for (const [bank, b] of budgets) capped.set(bank, Math.floor(b / 2));
  return greedySelect(candidates, capped, fifoOrder);
}

/**
 * Run one Bulk LSM window: snapshot the candidate set, select an execution set
 * under the H constraints by the lexicographic objective (or a fallback), commit
 * the selected via advanceBulk, and record the decision for audit.
 *
 * `opts.forceFallback` runs a specific fallback mode directly (used to simulate
 * an optimiser failure / for tests). Any thrown error in the OPTIMIZED path also
 * degrades to the FIFO fallback rather than aborting the window.
 */
export async function runBulkLsm(
  env: Env,
  opts: {
    businessDate?: string;
    windowId?: string;
    forceFallback?: "FIFO" | "PRIORITY" | "THROTTLE";
  } = {}
): Promise<LsmRunResult> {
  const db = env.DB;
  const now = nowISO();
  const businessDate = opts.businessDate ?? businessDateJST(now);
  const windowId = opts.windowId ?? `WIN-${businessDate}-${now.slice(11, 19).replace(/:/g, "")}`;

  // 1. Snapshot the candidate set (window-cutoff queue): BULK awaiting decision.
  //    JPY only — advanceBulk reserves H against the JPY budget; mixing a foreign
  //    currency would price its amount against the wrong budget.
  const candRows = await db
    .prepare(
      `SELECT txid, payer_bank_id, amount_value, expires_at AS due_at, created_at
       FROM Transactions
       WHERE lane='BULK' AND state='RECEIVED' AND amount_currency='JPY'
       ORDER BY created_at ASC`
    )
    .all<LsmCandidate>();
  const candidates = candRows.results ?? [];

  // 2. Constraints: each payer bank's remaining H budget (h_limit − h_used).
  const budgets = new Map<string, number>();
  if (candidates.length > 0) {
    const bankIds = [...new Set(candidates.map((c) => c.payer_bank_id))];
    const placeholders = bankIds.map(() => "?").join(",");
    const partRows = await db
      .prepare(
        `SELECT bank_id, h_limit, h_used FROM Participants WHERE bank_id IN (${placeholders})`
      )
      .bind(...bankIds)
      .all<{ bank_id: string; h_limit: number; h_used: number }>();
    for (const p of partRows.results ?? []) {
      budgets.set(p.bank_id, Math.max(0, (p.h_limit ?? 0) - (p.h_used ?? 0)));
    }
  }

  // 3. Select. OPTIMIZED unless a fallback was forced; on a thrown optimiser
  //    error, degrade to FIFO (§14.3: 処理を停止させない).
  let mode: LsmMode = "OPTIMIZED";
  let isFallback = false;
  let fallbackReason: string | undefined;
  let result: ReturnType<typeof greedySelect>;
  const nowMs = Date.parse(now);

  if (opts.forceFallback) {
    mode = opts.forceFallback;
    isFallback = true;
    fallbackReason = "FORCED";
    result =
      mode === "THROTTLE"
        ? throttleSelect(candidates, budgets)
        : greedySelect(candidates, budgets, mode === "PRIORITY" ? priorityOrder : fifoOrder);
  } else {
    try {
      result = greedySelect(candidates, budgets, lexicographicOrder(nowMs));
    } catch (err) {
      mode = "FIFO";
      isFallback = true;
      fallbackReason = err instanceof Error ? err.message : String(err);
      console.error("[LSM] optimiser failed, falling back to FIFO:", err);
      result = greedySelect(candidates, budgets, fifoOrder);
    }
  }

  const { selected, deferred, trace } = result;

  // 4. Audit digests (§14.2): reproducible "why this set".
  const snapshot = candidates.map((c) => ({
    txid: c.txid,
    payer: c.payer_bank_id,
    amount: c.amount_value,
    due_at: c.due_at,
    created_at: c.created_at,
  }));
  const inputSnapshotId = `LSMSNAP-${(await sha256hex(JSON.stringify(snapshot))).slice(0, 16)}`;
  const constraintsDigest = await sha256hex(
    JSON.stringify({
      mode,
      budgets: [...budgets.entries()].sort(),
      objective: ["due_at", "fairness", "throughput"],
      stop_condition: "H_BUDGET_EXHAUSTED",
    })
  );
  const executionSetHash = await sha256hex(JSON.stringify([...selected.map((c) => c.txid)].sort()));
  const traceDigest = await sha256hex(JSON.stringify(trace));

  // 5. Commit the selected set (advanceBulk's H reservation is the safety valve;
  //    a tx that loses the reservation race cancels itself and is reported below).
  const committed: string[] = [];
  for (const c of selected) {
    await advanceBulk(c.txid, env);
    const after = await db
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind(c.txid)
      .first<{ state: string }>();
    if (after?.state === "DECIDED_TO_SETTLE") committed.push(c.txid);
  }

  // 6. Objective metrics (§14.1 達成度 + フォールバック時の劣化).
  const overdueSelected = selected.filter((c) => c.due_at !== null && c.due_at < now).length;
  const maxWaitSec =
    candidates.length > 0
      ? Math.max(...candidates.map((c) => Math.floor((nowMs - Date.parse(c.created_at)) / 1000)))
      : 0;
  const objectiveMetrics: Record<string, unknown> = {
    candidates: candidates.length,
    selected: selected.length,
    deferred: deferred.length,
    committed: committed.length,
    on_time_selected: selected.length - overdueSelected,
    overdue_selected: overdueSelected,
    max_wait_seconds: maxWaitSec,
    throughput: committed.length,
    degraded: isFallback,
    ...(isFallback ? { fallback_mode: mode, fallback_reason: fallbackReason } : {}),
  };

  // 7. Persist the run + FinalityLog event.
  const runId = `LSM-${newUUID()}`;
  await db
    .prepare(
      `INSERT INTO LsmRuns
         (run_id, business_date, window_id, mode, is_fallback, input_snapshot_id,
          constraints_digest, execution_set_hash, trace_digest, candidate_count,
          selected_count, deferred_count, objective_metrics, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      runId,
      businessDate,
      windowId,
      mode,
      isFallback ? 1 : 0,
      inputSnapshotId,
      constraintsDigest,
      executionSetHash,
      traceDigest,
      candidates.length,
      selected.length,
      deferred.length,
      JSON.stringify(objectiveMetrics),
      now
    )
    .run();

  await writeFinalityLog(db, {
    txid: null,
    event_type: isFallback ? "LsmRunFallback" : "LsmRunCommitted",
    state_from: null,
    state_to: mode,
    payload_json: JSON.stringify({
      run_id: runId,
      window_id: windowId,
      mode,
      input_snapshot_id: inputSnapshotId,
      constraints_digest: constraintsDigest,
      execution_set_hash: executionSetHash,
      trace_digest: traceDigest,
      objective_metrics: objectiveMetrics,
    }),
    txid_or_gtid: runId,
  });

  if (isFallback) {
    console.error(
      `[LSM] window ${windowId} ran in fallback mode=${mode} (${fallbackReason}); ` +
        `${committed.length}/${candidates.length} committed, ${deferred.length} deferred`
    );
  }

  return {
    run_id: runId,
    mode,
    is_fallback: isFallback,
    selected: selected.map((c) => c.txid),
    deferred: deferred.map((c) => c.txid),
    committed,
    objective_metrics: objectiveMetrics,
  };
}
