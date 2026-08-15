/**
 * @file operator_quorum.ts — table-agnostic n-of-m quorum & equivocation policy.
 *
 * ZC verifies several independent kinds of signed observation/attestation and,
 * in each case, applies the *same* trust-minimization policy:
 *
 *   1. Count **distinct operators**, not distinct keys. The unit of independence
 *      is the operator (`KeyRegistry.owner_ref`), so one operator holding several
 *      keys cannot manufacture a quorum on its own.
 *   2. A quorum is only meaningful if the distinct operators **agree about the
 *      same fact**. Two operators asserting contradictory things (a Watcher
 *      reporting a different `venue/proof_type`; an attester signing FAIL where
 *      another signed PASS) is *equivocation* — disagreement must never be
 *      counted as agreement.
 *
 * This module is the single source of that policy as **pure functions**, shared
 * by the Watcher path (`shared/watcher.ts`, settlement-proof quorum) and the
 * ConditionTemplate Attestation path (`shared/attestation_quorum.ts`, condition
 * programmability). The table-specific projection (which SQL produces the
 * `(owner_ref, claim)` rows) lives in those callers; the *decision* lives here
 * and is unit-tested once (`test/shared/operator_quorum.test.ts`).
 *
 * @module shared/operator_quorum
 */

/** One operator's claim about an event/condition (e.g. PASS/FAIL, venue/proof). */
export interface OperatorClaim {
  /** `KeyRegistry.owner_ref` — the operator identity the vote counts under. */
  owner_ref: string;
  /** Canonical string describing *what* the operator asserted. */
  claim: string;
}

/** Number of distinct operators (owner_ref) across the given claims. */
export function distinctOperatorCount(rows: ReadonlyArray<{ owner_ref: string }>): number {
  return new Set(rows.map((r) => r.owner_ref)).size;
}

/**
 * Whether `distinctOperators` meets the required quorum. `required` is clamped
 * to a minimum of 1 — a quorum of 0 is never meaningful, and a configured value
 * below 1 must not let an unobserved event count as final.
 */
export function meetsQuorum(distinctOperators: number, required: number): boolean {
  return distinctOperators >= Math.max(1, required);
}

export interface EquivocationResult {
  /** True when ≥2 distinct `claim` values appear across the rows. */
  conflict: boolean;
  /** The distinct claim values observed, sorted. */
  distinctClaims: string[];
  /** Operators (owner_ref) grouped by the claim they asserted, for evidence. */
  operatorsByClaim: Record<string, string[]>;
}

/**
 * Detect equivocation over a set of operator claims about the *same* subject.
 *
 * Conflict ⇔ more than one distinct `claim` value is present across the rows.
 * This captures both inter-operator disagreement (operator X says PASS, operator
 * Y says FAIL) and a single operator asserting contradictory claims. Callers
 * treat a conflict as fail-closed (the fact is *not* established) and converge
 * it into a CASE for audit rather than silently picking a side.
 */
export function detectEquivocation(rows: ReadonlyArray<OperatorClaim>): EquivocationResult {
  const operatorsByClaim: Record<string, Set<string>> = {};
  for (const r of rows) {
    const set = operatorsByClaim[r.claim] ?? new Set<string>();
    set.add(r.owner_ref);
    operatorsByClaim[r.claim] = set;
  }
  const distinctClaims = Object.keys(operatorsByClaim).sort();
  return {
    conflict: distinctClaims.length > 1,
    distinctClaims,
    operatorsByClaim: Object.fromEntries(
      distinctClaims.map((c) => [c, [...operatorsByClaim[c]!].sort()])
    ),
  };
}
