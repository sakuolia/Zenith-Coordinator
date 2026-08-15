/**
 * @file condition_expr.ts — Boolean composition of HTLC ConditionTemplates.
 *
 * Generalizes the single-template programmability (Theme C) to an AND/OR
 * expression tree over several whitelisted ConditionTemplates (30_internal_design.md
 * § 7 "プログラマビリティの汎用化"). An HTLC carrying a `condition_expr_json` is
 * fulfilled when the expression evaluates true given the set of templates for
 * which a fresh, in-scope, signature-verified PASS Attestation was presented.
 *
 * Grammar (recursive):
 *   leaf  := { "template_id": string }
 *   node  := { "op": "AND" | "OR", "operands": Expr[] }            (1..MAX_OPERANDS)
 *   thr   := { "op": "THRESHOLD", "k": int, "operands": Expr[] }   (1..MAX_OPERANDS, 1<=k<=#operands)
 *
 * A single leaf is exactly the prior single-template behaviour, so this is a
 * strict generalization. AND/OR are the degenerate thresholds (AND = THRESHOLD
 * k=#operands, OR = THRESHOLD k=1); THRESHOLD makes "at least k of these n"
 * (k-of-n) expressible directly instead of via combinatorial AND/OR expansion.
 * ZC never judges whether the underlying real-world condition held — only that
 * each leaf's Attestation is valid (recordAttestation) and PASS; this module is
 * the pure boolean combinator over that result set.
 *
 * @module zc/condition_expr
 */

/** A whitelisted-template leaf, an AND/OR, or a k-of-n THRESHOLD over sub-expressions. */
export type ConditionExpr =
  | { template_id: string }
  | { op: "AND" | "OR"; operands: ConditionExpr[] }
  | { op: "THRESHOLD"; k: number; operands: ConditionExpr[] };

/** Structural limits (abuse / unbounded-recursion guards). */
export const MAX_EXPR_DEPTH = 6;
export const MAX_OPERANDS = 16;
export const MAX_TEMPLATES = 32;

export type ConditionExprValidation = { ok: true } | { ok: false; error: string };

/** AND/OR/THRESHOLD nodes all carry an `operands` array. */
type OpNode =
  | { op: "AND" | "OR"; operands: ConditionExpr[] }
  | { op: "THRESHOLD"; k: number; operands: ConditionExpr[] };

function isLeaf(e: ConditionExpr): e is { template_id: string } {
  return typeof (e as { template_id?: unknown }).template_id === "string";
}

function isThreshold(
  e: ConditionExpr
): e is { op: "THRESHOLD"; k: number; operands: ConditionExpr[] } {
  const n = e as { op?: unknown; operands?: unknown };
  return n.op === "THRESHOLD" && Array.isArray(n.operands);
}

function isNode(e: ConditionExpr): e is OpNode {
  const n = e as { op?: unknown; operands?: unknown };
  return (n.op === "AND" || n.op === "OR" || n.op === "THRESHOLD") && Array.isArray(n.operands);
}

/** Recursive structural check (depth / operand-count / node shape). */
function validateStructure(expr: unknown, depth: number): ConditionExprValidation {
  if (expr === null || typeof expr !== "object") {
    return { ok: false, error: "expression must be an object" };
  }
  if (depth > MAX_EXPR_DEPTH) {
    return { ok: false, error: `expression deeper than MAX_EXPR_DEPTH=${MAX_EXPR_DEPTH}` };
  }
  const e = expr as ConditionExpr;
  if (isLeaf(e)) {
    if (!e.template_id) return { ok: false, error: "leaf template_id must be non-empty" };
    return { ok: true };
  }
  if (isNode(e)) {
    if (e.operands.length < 1 || e.operands.length > MAX_OPERANDS) {
      return { ok: false, error: `op operands must be 1..${MAX_OPERANDS}` };
    }
    if (isThreshold(e)) {
      if (!Number.isInteger(e.k) || e.k < 1 || e.k > e.operands.length) {
        return { ok: false, error: `THRESHOLD k must be an integer in 1..${e.operands.length}` };
      }
    }
    for (const operand of e.operands) {
      const r = validateStructure(operand, depth + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  return { ok: false, error: "node must be a {template_id} leaf or an {op,operands} node" };
}

/**
 * Validate the structure of a condition expression: every node is a leaf with a
 * non-empty `template_id` or an AND/OR with 1..MAX_OPERANDS operands, the tree is
 * no deeper than MAX_EXPR_DEPTH, and references no more than MAX_TEMPLATES
 * distinct templates. Returns a typed error rather than throwing so callers can
 * surface it.
 *
 * The MAX_TEMPLATES bound matters because MAX_EXPR_DEPTH/MAX_OPERANDS alone admit
 * an enormous tree (up to MAX_OPERANDS^MAX_EXPR_DEPTH leaves); without this check
 * a single expression could reference an unbounded number of distinct templates,
 * forcing the claimant to present (and ZC to verify) one attestation per leaf.
 */
export function validateConditionExpr(expr: unknown): ConditionExprValidation {
  const structural = validateStructure(expr, 1);
  if (!structural.ok) return structural;
  // Structure is valid here, so the cast is safe for the distinct-template count.
  const distinct = collectTemplateIds(expr as ConditionExpr).length;
  if (distinct > MAX_TEMPLATES) {
    return {
      ok: false,
      error: `expression references ${distinct} distinct templates > MAX_TEMPLATES=${MAX_TEMPLATES}`,
    };
  }
  return { ok: true };
}

/** Collect the distinct template_ids referenced anywhere in the expression. */
export function collectTemplateIds(expr: ConditionExpr): string[] {
  const out = new Set<string>();
  const walk = (e: ConditionExpr) => {
    if (isLeaf(e)) out.add(e.template_id);
    else if (isNode(e)) e.operands.forEach(walk);
  };
  walk(expr);
  return [...out];
}

/**
 * Evaluate the expression against the set of `satisfied` template_ids (those with
 * a verified PASS attestation). AND ⇒ every operand true; OR ⇒ any operand true;
 * leaf ⇒ its template is in the satisfied set.
 */
export function evaluateConditionExpr(expr: ConditionExpr, satisfied: Set<string>): boolean {
  if (isLeaf(expr)) return satisfied.has(expr.template_id);
  if (isThreshold(expr)) {
    let met = 0;
    for (const o of expr.operands) {
      if (evaluateConditionExpr(o, satisfied)) met++;
      if (met >= expr.k) return true; // short-circuit once the threshold is reached
    }
    return false;
  }
  if (isNode(expr)) {
    return expr.op === "AND"
      ? expr.operands.every((o) => evaluateConditionExpr(o, satisfied))
      : expr.operands.some((o) => evaluateConditionExpr(o, satisfied));
  }
  return false;
}
