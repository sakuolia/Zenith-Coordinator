/**
 * @file Circuit Breaker — participant bank health monitoring and request throttling.
 *
 * Implements the spec's Circuit Breaker requirement:
 *   "Detect that a participant bank is unreachable → halt execution requests to that bank → gradual resumption (preventing retry storms)"
 *
 * States (per participant bank):
 *   CLOSED    — normal operation; all requests pass through
 *   OPEN      — bank unreachable; all requests fast-fail without calling the bank
 *   HALF_OPEN — tentative recovery; up to MAX_HALF_OPEN_PROBES probes pass through
 *
 * The circuit trips OPEN after `FAILURE_THRESHOLD` consecutive failures.
 * After `OPEN_DURATION_MS` it transitions to HALF_OPEN and admits a small
 * bounded number of probe requests (MAX_HALF_OPEN_PROBES). Any failure during
 * HALF_OPEN re-opens the circuit; any success closes it. The probe cap is the
 * key thunder-herd guard: without it, every queued request would stampede the
 * recovering bank the moment OPEN_DURATION_MS elapsed.
 *
 * The table also tracks lifetime traffic counters (total_requests / successes
 * / failures / denied), giving operators per-bank reliability visibility
 * without needing an external metrics pipeline.
 *
 * State is persisted in the CircuitBreakerState table so that it survives
 * Worker isolate restarts and is visible across concurrent isolates.
 *
 * @module zc/circuit_breaker
 */
import { nowISO } from "../../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of consecutive failures before the circuit trips OPEN. */
const FAILURE_THRESHOLD = 5;

/** How long (ms) to stay OPEN before allowing HALF_OPEN probes. */
const OPEN_DURATION_MS = 30_000; // 30 seconds

/**
 * Maximum number of in-flight probes admitted while state=HALF_OPEN. Keeps a
 * recovering bank from being stampeded by the queued backlog the moment the
 * OPEN_DURATION_MS timer expires. A single failure still re-opens immediately.
 */
const MAX_HALF_OPEN_PROBES = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerStatus {
  bank_id: string;
  state: CircuitState;
  consecutive_failures: number;
  last_failure_at: string | null;
  opened_at: string | null;
  half_open_at: string | null;
  updated_at: string;
  // Metrics
  total_requests: number;
  total_successes: number;
  total_failures: number;
  total_denied: number;
  half_open_inflight: number;
  last_success_at: string | null;
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Check whether a request to the given bank should be allowed.
 *
 * - CLOSED → allow, increment total_requests
 * - HALF_OPEN → allow only if a probe slot is free (atomic CAS on
 *   half_open_inflight < MAX_HALF_OPEN_PROBES); otherwise fast-fail
 * - OPEN → if OPEN_DURATION_MS elapsed, transition to HALF_OPEN and admit
 *   the first probe atomically; otherwise fast-fail (increments total_denied)
 *
 * @returns `true` if the request may proceed, `false` if fast-failed
 */
export async function allowRequest(bankId: string, db: D1Database): Promise<boolean> {
  const row = await getOrInit(bankId, db);
  const now = nowISO();

  if (row.state === "CLOSED") {
    await db
      .prepare(
        `UPDATE CircuitBreakerState
       SET total_requests = total_requests + 1, updated_at = ?
       WHERE bank_id = ? AND state = 'CLOSED'`
      )
      .bind(now, bankId)
      .run();
    return true;
  }

  if (row.state === "HALF_OPEN") {
    return claimHalfOpenProbe(bankId, db, now);
  }

  // OPEN: check elapsed time
  if (row.opened_at) {
    const elapsed = Date.now() - new Date(row.opened_at).getTime();
    if (elapsed >= OPEN_DURATION_MS) {
      // Transition OPEN → HALF_OPEN atomically and claim the first probe slot.
      // Doing both in one statement avoids a race where two concurrent callers
      // each promote the row and double-count probes.
      const upd = await db
        .prepare(
          `UPDATE CircuitBreakerState
         SET state = 'HALF_OPEN', half_open_at = ?,
             half_open_inflight = 1, total_requests = total_requests + 1,
             updated_at = ?
         WHERE bank_id = ? AND state = 'OPEN'`
        )
        .bind(now, now, bankId)
        .run();
      if ((upd.meta.changes ?? 0) > 0) return true;
      // Lost the CAS race: another caller already promoted the row. Try to
      // claim a probe slot under the new HALF_OPEN state.
      return claimHalfOpenProbe(bankId, db, now);
    }
  }

  // OPEN and not yet eligible to probe: fast-fail.
  await db
    .prepare(
      `UPDATE CircuitBreakerState
     SET total_denied = total_denied + 1, updated_at = ?
     WHERE bank_id = ?`
    )
    .bind(now, bankId)
    .run();
  return false;
}

/**
 * Record a successful bank call. From HALF_OPEN this closes the circuit and
 * resets the probe counter; from CLOSED it just bumps the success metric.
 */
export async function recordSuccess(bankId: string, db: D1Database): Promise<void> {
  const now = nowISO();
  // Close the circuit and reset all transient counters; runs unconditionally
  // (success in any state should restore CLOSED). half_open_inflight resets so
  // the next OPEN→HALF_OPEN cycle starts clean.
  await db
    .prepare(
      `UPDATE CircuitBreakerState
     SET state = 'CLOSED', consecutive_failures = 0,
         last_failure_at = NULL, opened_at = NULL, half_open_at = NULL,
         half_open_inflight = 0,
         total_successes = total_successes + 1,
         last_success_at = ?,
         updated_at = ?
     WHERE bank_id = ?`
    )
    .bind(now, now, bankId)
    .run();
}

/**
 * Record a failed bank call. Increments the failure counter and may trip
 * the circuit OPEN if the threshold is reached. A failure during HALF_OPEN
 * re-opens immediately regardless of how many probes are still in flight.
 */
export async function recordFailure(bankId: string, db: D1Database): Promise<void> {
  const now = nowISO();
  const row = await getOrInit(bankId, db);

  const newCount = row.consecutive_failures + 1;

  if (row.state === "HALF_OPEN") {
    // Probe failed → back to OPEN. Reset half_open_inflight so the next probe
    // window starts from zero; remaining concurrent probes that arrive after
    // this point will be fast-failed by the OPEN-state check.
    await db
      .prepare(
        `UPDATE CircuitBreakerState
       SET state = 'OPEN', consecutive_failures = ?, last_failure_at = ?,
           opened_at = ?, half_open_at = NULL, half_open_inflight = 0,
           total_failures = total_failures + 1,
           updated_at = ?
       WHERE bank_id = ?`
      )
      .bind(newCount, now, now, now, bankId)
      .run();
    return;
  }

  if (newCount >= FAILURE_THRESHOLD && row.state === "CLOSED") {
    // Trip OPEN
    await db
      .prepare(
        `UPDATE CircuitBreakerState
       SET state = 'OPEN', consecutive_failures = ?, last_failure_at = ?,
           opened_at = ?,
           total_failures = total_failures + 1,
           updated_at = ?
       WHERE bank_id = ?`
      )
      .bind(newCount, now, now, now, bankId)
      .run();
    return;
  }

  // Still CLOSED, just bump counters
  await db
    .prepare(
      `UPDATE CircuitBreakerState
     SET consecutive_failures = ?, last_failure_at = ?,
         total_failures = total_failures + 1,
         updated_at = ?
     WHERE bank_id = ?`
    )
    .bind(newCount, now, now, bankId)
    .run();
}

/**
 * Get the current circuit breaker status for a bank. Returns null if the
 * bank is not registered in the circuit breaker table.
 */
export async function getCircuitStatus(
  bankId: string,
  db: D1Database
): Promise<CircuitBreakerStatus | null> {
  return db
    .prepare(`SELECT * FROM CircuitBreakerState WHERE bank_id = ?`)
    .bind(bankId)
    .first<CircuitBreakerStatus>();
}

/**
 * List all circuit breaker states (dashboard / monitoring).
 */
export async function listCircuitStates(db: D1Database): Promise<CircuitBreakerStatus[]> {
  const { results } = await db
    .prepare(`SELECT * FROM CircuitBreakerState ORDER BY bank_id`)
    .all<CircuitBreakerStatus>();
  return results ?? [];
}

/**
 * Manually reset a circuit to CLOSED (ops override). Preserves lifetime
 * counters so reliability history isn't lost on a manual reset.
 */
export async function resetCircuit(bankId: string, db: D1Database): Promise<void> {
  const now = nowISO();
  await db
    .prepare(
      `UPDATE CircuitBreakerState
     SET state = 'CLOSED', consecutive_failures = 0,
         last_failure_at = NULL, opened_at = NULL, half_open_at = NULL,
         half_open_inflight = 0,
         updated_at = ?
     WHERE bank_id = ?`
    )
    .bind(now, bankId)
    .run();
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Atomically claim one HALF_OPEN probe slot. Returns true if a slot was
 * granted, false if the probe cap is full (caller should fast-fail).
 *
 * The single UPDATE statement is the synchronization primitive: SQLite/D1
 * serialize writes, so the `half_open_inflight < MAX` predicate cannot race.
 */
async function claimHalfOpenProbe(bankId: string, db: D1Database, now: string): Promise<boolean> {
  const upd = await db
    .prepare(
      `UPDATE CircuitBreakerState
     SET half_open_inflight = half_open_inflight + 1,
         total_requests = total_requests + 1,
         updated_at = ?
     WHERE bank_id = ?
       AND state = 'HALF_OPEN'
       AND half_open_inflight < ?`
    )
    .bind(now, bankId, MAX_HALF_OPEN_PROBES)
    .run();
  if ((upd.meta.changes ?? 0) > 0) return true;

  // Probe cap full: fast-fail and count the denial for visibility.
  await db
    .prepare(
      `UPDATE CircuitBreakerState
     SET total_denied = total_denied + 1, updated_at = ?
     WHERE bank_id = ?`
    )
    .bind(now, bankId)
    .run();
  return false;
}

async function getOrInit(bankId: string, db: D1Database): Promise<CircuitBreakerStatus> {
  const existing = await db
    .prepare(`SELECT * FROM CircuitBreakerState WHERE bank_id = ?`)
    .bind(bankId)
    .first<CircuitBreakerStatus>();

  if (existing) return existing;

  const now = nowISO();
  await db
    .prepare(
      `INSERT OR IGNORE INTO CircuitBreakerState
     (bank_id, state, consecutive_failures, last_failure_at, opened_at, half_open_at, updated_at,
      total_requests, total_successes, total_failures, total_denied, half_open_inflight, last_success_at)
     VALUES (?, 'CLOSED', 0, NULL, NULL, NULL, ?, 0, 0, 0, 0, 0, NULL)`
    )
    .bind(bankId, now)
    .run();

  return {
    bank_id: bankId,
    state: "CLOSED",
    consecutive_failures: 0,
    last_failure_at: null,
    opened_at: null,
    half_open_at: null,
    updated_at: now,
    total_requests: 0,
    total_successes: 0,
    total_failures: 0,
    total_denied: 0,
    half_open_inflight: 0,
    last_success_at: null,
  };
}
