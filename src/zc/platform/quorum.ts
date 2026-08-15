/**
 * @file quorum.ts — Consensus-quorum health and design-principle-10 degradation.
 *
 * Design principle 10: the single source of truth is held by a geographically
 * distributed consensus log; under quorum loss the system must degrade to
 * read-only to avoid committing a state that a minority partition cannot agree
 * on (a "mis-decision"). This module models that quorum and reconciles the
 * ZC-wide system mode with its health.
 *
 * Scope note (honest): this reference implementation persists the single source
 * of truth in D1 (single-node SQLite), so there is no real multi-replica
 * consensus to observe. What is implemented here is the *control half* of
 * principle 10 — quorum evaluation and the enforced read-only degradation it
 * drives — exercised by feeding observed replica reachability in. A production
 * deployment backs the log with a consensus store (Spanner / Aurora DSQL /
 * CockroachDB / YugabyteDB) and feeds *its* membership health into
 * `reconcileQuorum`; the enforcement wiring (write primitives gating on
 * `assertWritableDb`) is then exactly what holds. See docs/specs/30_internal_design.md
 * §6 (一貫性モデル) and §7 (可搬性・移植契約).
 *
 * @module zc/platform/quorum
 */
import type { Env, SystemModeRow } from "../../types";
import { degradeToQuorumLossReadOnly, getSystemMode, restoreFromQuorumLoss } from "./system_mode";

/** Default replica set used when `env.ZC_QUORUM_REPLICAS` is unset. */
const DEFAULT_REPLICAS = ["r1", "r2", "r3"];

/** Outcome of evaluating quorum over a replica set. */
export interface QuorumHealth {
  /** Total configured replicas (the membership). */
  total: number;
  /** Replicas observed reachable this evaluation. */
  reachable: number;
  /** Votes required for quorum: floor(total/2) + 1 (strict majority). */
  required: number;
  /** True when `reachable >= required`. */
  hasQuorum: boolean;
  /** The reachable replica ids, deduplicated and intersected with membership. */
  reachableIds: string[];
}

/** Resolve the configured replica membership from env, falling back to a default trio. */
export function quorumMembership(env: Env): string[] {
  const raw = env.ZC_QUORUM_REPLICAS;
  if (!raw) return [...DEFAULT_REPLICAS];
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.length > 0 ? ids : [...DEFAULT_REPLICAS];
}

/**
 * Evaluate quorum: a strict majority of the configured membership must be
 * reachable. `reachableIds` is intersected with the membership and
 * deduplicated, so reporting an unknown or duplicate id cannot manufacture
 * quorum.
 */
export function evaluateQuorum(membership: string[], reachableIds: string[]): QuorumHealth {
  const member = new Set(membership);
  const reachable = new Set(reachableIds.filter((id) => member.has(id)));
  const total = member.size;
  const required = Math.floor(total / 2) + 1;
  return {
    total,
    reachable: reachable.size,
    required,
    hasQuorum: reachable.size >= required,
    reachableIds: [...reachable],
  };
}

/** Result of reconciling system mode with observed quorum health. */
export interface QuorumReconcileResult {
  health: QuorumHealth;
  mode: SystemModeRow;
  /** What the reconciliation did this call. */
  action: "DEGRADED" | "RESTORED" | "NO_CHANGE";
}

/**
 * Reconcile the ZC-wide system mode with observed quorum health.
 *
 * - Quorum lost, not already degraded → enter QUORUM_LOSS_READONLY.
 * - Quorum regained, currently in QUORUM_LOSS_READONLY → return to NORMAL.
 * - Operator-declared BCP_READONLY is never touched: quorum reconciliation
 *   only owns the QUORUM_LOSS_READONLY ↔ NORMAL edge, so it cannot silently
 *   clear (or be confused by) a vendor-outage degradation an operator declared.
 *
 * Idempotent: calling repeatedly with the same health is a NO_CHANGE no-op.
 */
export async function reconcileQuorum(
  env: Env,
  reachableIds: string[]
): Promise<QuorumReconcileResult> {
  const health = evaluateQuorum(quorumMembership(env), reachableIds);
  const current = await getSystemMode(env.DB);

  if (!health.hasQuorum) {
    if (current.mode === "NORMAL") {
      const reason = `consensus quorum lost: ${health.reachable}/${health.total} replicas reachable (need ${health.required})`;
      const mode = await degradeToQuorumLossReadOnly(env, reason);
      return { health, mode, action: "DEGRADED" };
    }
    // Already BCP_READONLY or QUORUM_LOSS_READONLY: leave as-is.
    return { health, mode: current, action: "NO_CHANGE" };
  }

  // Quorum healthy: clear only our own degradation, never an operator BCP.
  if (current.mode === "QUORUM_LOSS_READONLY") {
    const mode = await restoreFromQuorumLoss(env);
    return { health, mode, action: "RESTORED" };
  }
  return { health, mode: current, action: "NO_CHANGE" };
}
