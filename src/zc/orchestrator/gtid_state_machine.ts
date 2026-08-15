/**
 * @file gtid_state_machine.ts — GTID (multi-leg coordinated transaction) state
 *       transition validator.
 *
 * The single source of truth for the GTID-level state graph, symmetric to
 * `state_machine.ts` for `TxState`. Before this module existed, the legal GTID
 * graph was implicit — encoded only in the `WHERE state='GT_X'` guards of the
 * raw `UPDATE GtidTransactions` statements scattered across `lanes/gtid/` and
 * `orchestrator/gtid.ts`. That left the coordinated-settlement aggregate (which
 * moves money across multiple banks atomically) without the central, validated,
 * statically-enforced transition table that every per-tx `TxState` change has.
 *
 * Two layers of protection build on this declaration:
 *   1. Runtime: `assertValidGtidTransition` guards the finalization transitions
 *      whose source state is read from the DB (not a literal), so a corrupt or
 *      unexpected row state cannot be advanced to a terminal money-moving state.
 *   2. Static: `test/zc/gtid_state_machine.test.ts` scans the GTID source for
 *      `UPDATE GtidTransactions SET state='GT_Y' ... WHERE ... state='GT_X'`
 *      pairs and asserts each one is in `ALLOWED_GTID_TRANSITIONS` — the GTID
 *      analogue of the `lane_invariants` ban on hand-rolled `TxState` UPDATEs.
 *
 * Normative reference: docs/specs/20_method_design.md §5.5 (GTID 状態規則) and
 * docs/specs/30_internal_design.md §4 (GTID 状態機械).
 */
import type { GtidState } from "../../types";
import { DomainError } from "../../shared/errors";

/**
 * Exhaustive map of allowed GTID-level state transitions.
 *
 * Lifecycle (happy path):
 *   GT_RECEIVED → GT_PRECHECKED → GT_DECIDED_TO_SETTLE → GT_SETTLED
 *
 * A GTID is one coordinated Decision over all its legs, so cancellation and
 * suspension are aggregate-level: a single failed ready-check, balance mismatch,
 * unsupported shape, mandate breach, or H-limit breach cancels the *whole* GTID
 * (GT_PRECHECKED → GT_DECIDED_CANCEL → GT_CANCELLED), and a terminal leg
 * execution failure suspends the whole GTID (GT_DECIDED_TO_SETTLE → GT_SUSPENDED).
 */
export const ALLOWED_GTID_TRANSITIONS: Record<GtidState, GtidState[]> = {
  GT_RECEIVED: ["GT_PRECHECKED"],
  GT_PRECHECKED: ["GT_DECIDED_TO_SETTLE", "GT_DECIDED_CANCEL"],
  GT_DECIDED_TO_SETTLE: ["GT_SETTLED", "GT_SUSPENDED"],
  GT_DECIDED_CANCEL: ["GT_CANCELLED"],
  // A SUSPENDED GTID resolves the same way a SUSPENDED TxState does: either it
  // resumes (the suspending leg recovers and all legs settle, re-reaching
  // GT_DECIDED_TO_SETTLE) or the timeout sweep promotes it to the terminal
  // GT_FAILED. Both edges are spec-normative (§5.5); the resume edge is the one
  // a future recovery path would use and is declared here so it cannot be added
  // later as an un-validated raw UPDATE.
  GT_SUSPENDED: ["GT_DECIDED_TO_SETTLE", "GT_FAILED"],
  // Terminal states — no outgoing transitions.
  GT_SETTLED: [],
  GT_CANCELLED: [],
  GT_FAILED: [],
};

/**
 * States a GtidTransactions row may be *created* at on INSERT, analogous to
 * `_helpers.ts#ALLOWED_ENTRY_STATES` for Transactions.
 *
 *   - GT_RECEIVED: normal registration (`registerGtid`).
 *   - GT_SETTLED:  the DNS net-settlement GTID, minted already-settled by
 *     `settleDns` to record the central-bank net leg set (it never walks the
 *     state machine — the netting cycle is the aggregate, not the GTID).
 */
export const ALLOWED_GTID_ENTRY_STATES: ReadonlySet<GtidState> = new Set<GtidState>([
  "GT_RECEIVED",
  "GT_SETTLED",
]);

/**
 * Check whether a GTID state transition is permitted by the state machine.
 *
 * @param from - Current GTID state
 * @param to   - Target GTID state
 * @returns true if the transition is allowed
 */
export function isValidGtidTransition(from: GtidState, to: GtidState): boolean {
  return ALLOWED_GTID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Throw `INVARIANT_VIOLATION` if a GTID transition is not permitted.
 *
 * Used as a defense-in-depth guard at transition sites whose source state is
 * read from the database rather than a compile-time literal — so a corrupt row
 * or a loosened upstream guard cannot silently drive an illegal advance.
 */
export function assertValidGtidTransition(from: string, to: string): void {
  if (!isValidGtidTransition(from as GtidState, to as GtidState)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      `Disallowed GTID state transition ${from} → ${to}. ` +
        `Allowed from ${from}: [${(ALLOWED_GTID_TRANSITIONS[from as GtidState] ?? []).join(",") || "<none>"}]`,
      { from, to }
    );
  }
}
