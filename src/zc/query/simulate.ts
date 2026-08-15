/**
 * @file simulate.ts — read-only dry-run of programmability primitives.
 *
 * High-assurance condition logic should be testable *before* it is committed to
 * an HTLC or a mandate is relied upon. These helpers expose the existing pure
 * evaluators (`condition_expr`) and the non-throwing mandate check as side-effect
 * -free simulations: they never write, never move funds, and never record an
 * Attestation — they only answer "would this evaluate true, and what is missing".
 *
 * @module zc/query/simulate
 */
import {
  collectTemplateIds,
  evaluateConditionExpr,
  validateConditionExpr,
  type ConditionExpr,
} from "../platform/condition_expr";
import { checkMandate, type MandateCheck, type MandateCheckResult } from "../../shared/mandate";

export interface SimulateConditionsResult {
  valid: boolean;
  /** Set when `valid` is false: the structural validation error. */
  error?: string;
  /** Whether the expression evaluates true given `satisfied` (only when valid). */
  met?: boolean;
  /** Distinct templates the expression references, sorted. */
  required_templates?: string[];
  /** The satisfied-template set used, sorted and de-duplicated. */
  satisfied?: string[];
  /** Referenced templates not in `satisfied`, sorted. */
  missing?: string[];
}

/**
 * Validate a condition expression and (when valid) evaluate it against a
 * hypothetical satisfied-template set. Pure — no DB, no attestation recording.
 */
export function simulateConditionExpr(
  expr: unknown,
  satisfied: readonly string[] = []
): SimulateConditionsResult {
  const v = validateConditionExpr(expr);
  if (!v.ok) return { valid: false, error: v.error };
  const e = expr as ConditionExpr;
  const required = collectTemplateIds(e).sort();
  const sat = new Set(satisfied);
  return {
    valid: true,
    met: evaluateConditionExpr(e, sat),
    required_templates: required,
    satisfied: [...sat].sort(),
    missing: required.filter((t) => !sat.has(t)),
  };
}

/**
 * Dry-run a mandate against a hypothetical instruction scope. Reads the Mandate
 * delegation chain but performs no writes; returns the same typed result as the
 * acceptance-time `checkMandate`.
 */
export async function dryRunMandate(
  db: D1Database,
  mandateId: string,
  check: MandateCheck,
  now?: string
): Promise<MandateCheckResult> {
  return checkMandate(db, mandateId, check, now);
}
