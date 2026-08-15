/**
 * @file ledger_predicate.ts — conditions resolved against ZC's *own* committed
 *       FinalityLog, rather than against an external attester.
 *
 * The HTLC + external-attestation model pushes all real-world judgement to the
 * edge: ZC verifies a signed Attestation but never decides whether the fact is
 * true. That model has one awkward seam — making a payment conditional on ZC's
 * *own* ledger state (e.g. "release when txid#2 has reached `b`"), which would
 * otherwise force ZC to outsource knowledge of its own state to an external
 * signer. Reading its own committed source of truth is not "judging the world";
 * it is the one thing ZC is authoritative over. A `ConditionTemplate` whose
 * `ledger_predicate_json` is set is resolved here, deterministically, against
 * committed FinalityLog entries — no attestation is accepted for it.
 *
 * Two predicate families:
 *  - `*_REACHED_STATE` read only *committed* FinalityLog rows (entries past the
 *    linearization point) and are **monotonic** — once a txid/gtid has reached a
 *    target state, the append-only entry recording it keeps the predicate true.
 *  - `TIME_*` compare the caller's single authoritative clock read against a
 *    fixed instant. `TIME_AFTER` is monotonic (false→true at `at`); `TIME_BEFORE`
 *    is **not** (true→false at `at`). Both are evaluated at claim time, and the
 *    observed `now` is recorded in `HtlcConditionsEvaluated`, so a settled result
 *    is fully reproducible from the audit trail.
 *
 * There is no recursion (a predicate reads state/clock; it does not trigger
 * another evaluation), so no evaluation-time cycle exists; a *configuration*
 * cycle (two HTLCs each waiting on the other, or a `TIME_AFTER` never reached)
 * simply never satisfies and both fall back to their timelock refund — a
 * liveness, not a safety, concern. The system timezone is JST: an offset-less
 * `at` is read as JST (see `parseSystemTime`).
 *
 * @module zc/ledger_predicate
 */
import type { TxState } from "../../types";
import { parseSystemTime } from "../../types";
import { ALLOWED_TRANSITIONS } from "../orchestrator/state_machine";
import { ALLOWED_GTID_TRANSITIONS } from "../orchestrator/gtid_state_machine";

/** Upper bound on the target-state set (abuse guard). */
export const MAX_PREDICATE_STATES = 16;

/**
 * A deterministic predicate ZC resolves itself. The discriminated `kind` keeps a
 * small, closed set of predicates that evaluate to a definite truth value from
 * either committed state (`*_REACHED_STATE`, monotonic/append-only) or the
 * system clock (`TIME_*`). Deliberately NOT a general VM: amount/rate/data
 * predicates stay at the edge (an attester signs PASS) to keep this surface
 * deterministic and replay-auditable.
 */
export type LedgerPredicate =
  | {
      kind: "TX_REACHED_STATE";
      /** The transaction whose lifecycle is observed. */
      txid: string;
      /** Holds once `txid` has a committed FinalityLog entry in any of these states. */
      states: TxState[];
    }
  | {
      kind: "GTID_REACHED_STATE";
      /** The GTID (multi-leg aggregate) whose lifecycle is observed. */
      gtid: string;
      /** Holds once `gtid` has a committed FinalityLog entry in any of these states. */
      states: string[];
    }
  | {
      kind: "TIME_AFTER";
      /** Holds once `now >= at`. RFC3339; an offset-less value is read as JST. */
      at: string;
    }
  | {
      kind: "TIME_BEFORE";
      /** Holds while `now < at`. RFC3339; an offset-less value is read as JST. */
      at: string;
    };

export type LedgerPredicateValidation = { ok: true } | { ok: false; error: string };

const KNOWN_TX_STATES = new Set(Object.keys(ALLOWED_TRANSITIONS));
const KNOWN_GTID_STATES = new Set(Object.keys(ALLOWED_GTID_TRANSITIONS));

/** Validate a non-empty, in-range set of states drawn from `known`. */
function validateStates(
  states: unknown,
  known: Set<string>,
  label: string
): LedgerPredicateValidation {
  if (!Array.isArray(states) || states.length < 1) {
    return { ok: false, error: "states must be a non-empty array" };
  }
  if (states.length > MAX_PREDICATE_STATES) {
    return { ok: false, error: `states exceeds MAX_PREDICATE_STATES=${MAX_PREDICATE_STATES}` };
  }
  for (const s of states) {
    if (!known.has(s)) return { ok: false, error: `unknown ${label}: ${String(s)}` };
  }
  return { ok: true };
}

/** Structural + value validation of a ledger predicate (used at template registration). */
export function validateLedgerPredicate(p: unknown): LedgerPredicateValidation {
  if (p === null || typeof p !== "object")
    return { ok: false, error: "predicate must be an object" };
  const pred = p as {
    kind?: unknown;
    txid?: unknown;
    gtid?: unknown;
    states?: unknown;
    at?: unknown;
  };
  switch (pred.kind) {
    case "TX_REACHED_STATE":
      if (typeof pred.txid !== "string" || pred.txid.length === 0) {
        return { ok: false, error: "txid must be a non-empty string" };
      }
      return validateStates(pred.states, KNOWN_TX_STATES, "TxState");
    case "GTID_REACHED_STATE":
      if (typeof pred.gtid !== "string" || pred.gtid.length === 0) {
        return { ok: false, error: "gtid must be a non-empty string" };
      }
      return validateStates(pred.states, KNOWN_GTID_STATES, "GtidState");
    case "TIME_AFTER":
    case "TIME_BEFORE":
      if (typeof pred.at !== "string" || Number.isNaN(parseSystemTime(pred.at))) {
        return { ok: false, error: "at must be an RFC3339 timestamp" };
      }
      return { ok: true };
    default:
      return { ok: false, error: `unknown ledger predicate kind: ${String(pred.kind)}` };
  }
}

/** Whether `chainId` (txid or gtid) has a committed FinalityLog entry in `states`. */
async function chainReachedState(
  db: D1Database,
  column: "txid" | "gtid",
  chainId: string,
  states: readonly string[]
): Promise<boolean> {
  const placeholders = states.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM FinalityLog WHERE ${column} = ? AND state_to IN (${placeholders}) LIMIT 1`
    )
    .bind(chainId, ...states)
    .first<{ hit: number }>();
  return row != null;
}

/**
 * Evaluate a deterministic predicate. `*_REACHED_STATE` reads only committed
 * FinalityLog rows (monotonic once true); `TIME_*` compares `now` (the caller's
 * single authoritative clock read) against `at`. Never writes.
 */
export async function evaluateLedgerPredicate(
  db: D1Database,
  p: LedgerPredicate,
  now: string
): Promise<boolean> {
  switch (p.kind) {
    case "TX_REACHED_STATE":
      return chainReachedState(db, "txid", p.txid, p.states);
    case "GTID_REACHED_STATE":
      return chainReachedState(db, "gtid", p.gtid, p.states);
    case "TIME_AFTER":
      return Date.parse(now) >= parseSystemTime(p.at);
    case "TIME_BEFORE":
      return Date.parse(now) < parseSystemTime(p.at);
  }
}
