/**
 * @file gtid_state_machine.test.ts — guards for the GTID-level state machine.
 *
 * Two kinds of guard, symmetric to how `state_machine.ts` (TxState) is protected
 * by `lane_invariants.test.ts`:
 *
 *   A. Unit tests of `ALLOWED_GTID_TRANSITIONS` / `isValidGtidTransition` /
 *      `assertValidGtidTransition` — exhaustiveness, terminality, rejection.
 *   B. Static analysis: scan every GTID source file for raw
 *      `UPDATE GtidTransactions SET state='GT_Y' ... WHERE ... state='GT_X'`
 *      transitions and `INSERT ... INTO GtidTransactions ... VALUES (?, 'GT_X')`
 *      entry states, and assert each one is declared in the state machine. This
 *      is what stops a future edit from sneaking an un-validated GTID transition
 *      (e.g. GT_RECEIVED → GT_SETTLED, skipping the decision) past review.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ALLOWED_GTID_TRANSITIONS,
  ALLOWED_GTID_ENTRY_STATES,
  isValidGtidTransition,
  assertValidGtidTransition,
} from "../../src/zc/orchestrator/gtid_state_machine";
import type { GtidState } from "../../src/types";

const REPO_ROOT = join(__dirname, "..", "..");

/** The authoritative GtidState union, parsed from the type definition. */
function parseGtidStates(): Set<string> {
  const src = readFileSync(join(REPO_ROOT, "src", "types", "states.ts"), "utf8");
  const m = src.match(/export\s+type\s+GtidState\s*=\s*([\s\S]*?);/);
  if (!m) throw new Error("Could not locate GtidState union in src/types/states.ts");
  const names = new Set<string>();
  const RE = /"(GT_[A-Z_]+)"/g;
  let mm: RegExpExecArray | null;
  while ((mm = RE.exec(m[1]!)) !== null) names.add(mm[1]!);
  return names;
}

/** Strip line and block comments so SQL inside docs/comments isn't scanned. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** GTID source files that mutate GtidTransactions.state. */
function gtidSourceFiles(): string[] {
  const out: string[] = [];
  const gtidLaneDir = join(REPO_ROOT, "src", "zc", "lanes", "gtid");
  for (const ent of readdirSync(gtidLaneDir)) {
    if (ent.endsWith(".ts")) out.push(join(gtidLaneDir, ent));
  }
  out.push(join(REPO_ROOT, "src", "zc", "orchestrator", "gtid.ts"));
  out.push(join(REPO_ROOT, "src", "zc", "settlement", "dns", "settle.ts"));
  return out.filter((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// A. Unit tests of the declared graph
// ---------------------------------------------------------------------------

describe("GTID state machine — declared graph", () => {
  it("ALLOWED_GTID_TRANSITIONS is exhaustive over GtidState", () => {
    const declaredKeys = new Set(Object.keys(ALLOWED_GTID_TRANSITIONS));
    const unionStates = parseGtidStates();
    // Every GtidState union member must be a key (no state without a row).
    expect([...unionStates].filter((s) => !declaredKeys.has(s))).toEqual([]);
    // And no extra keys that aren't real states (drift the other way).
    expect([...declaredKeys].filter((s) => !unionStates.has(s))).toEqual([]);
  });

  it("every transition target is itself a declared state", () => {
    const keys = new Set(Object.keys(ALLOWED_GTID_TRANSITIONS));
    for (const [from, tos] of Object.entries(ALLOWED_GTID_TRANSITIONS)) {
      for (const to of tos) {
        expect(keys.has(to), `${from} → ${to}: ${to} is not a declared state`).toBe(true);
      }
    }
  });

  it("terminal states have no outgoing transitions", () => {
    for (const terminal of ["GT_SETTLED", "GT_CANCELLED", "GT_FAILED"] as GtidState[]) {
      expect(ALLOWED_GTID_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it("isValidGtidTransition accepts the happy path and rejects illegal jumps", () => {
    expect(isValidGtidTransition("GT_RECEIVED", "GT_PRECHECKED")).toBe(true);
    expect(isValidGtidTransition("GT_PRECHECKED", "GT_DECIDED_TO_SETTLE")).toBe(true);
    expect(isValidGtidTransition("GT_DECIDED_TO_SETTLE", "GT_SETTLED")).toBe(true);
    // Illegal: skipping the decision, or advancing out of a terminal state.
    expect(isValidGtidTransition("GT_RECEIVED", "GT_SETTLED")).toBe(false);
    expect(isValidGtidTransition("GT_PRECHECKED", "GT_SETTLED")).toBe(false);
    expect(isValidGtidTransition("GT_SETTLED", "GT_DECIDED_TO_SETTLE")).toBe(false);
    expect(isValidGtidTransition("GT_CANCELLED", "GT_RECEIVED")).toBe(false);
  });

  it("assertValidGtidTransition throws INVARIANT_VIOLATION on an illegal transition", () => {
    expect(() => assertValidGtidTransition("GT_DECIDED_TO_SETTLE", "GT_SETTLED")).not.toThrow();
    expect(() => assertValidGtidTransition("GT_RECEIVED", "GT_SETTLED")).toThrow(
      /INVARIANT_VIOLATION|Disallowed GTID/
    );
  });
});

// ---------------------------------------------------------------------------
// B. Static analysis: source transitions ⊆ declared graph
// ---------------------------------------------------------------------------

describe("GTID state machine — source transitions are declared", () => {
  it("every raw `UPDATE GtidTransactions SET state` transition is in ALLOWED_GTID_TRANSITIONS", () => {
    // Capture (target, source): SET state='GT_Y' ... WHERE ... state='GT_X'.
    const RE =
      /UPDATE\s+GtidTransactions\s+SET\s+state\s*=\s*'(GT_[A-Z_]+)'[\s\S]*?WHERE[\s\S]*?state\s*=\s*'(GT_[A-Z_]+)'/gi;
    const offenders: string[] = [];
    let found = 0;
    for (const file of gtidSourceFiles()) {
      const src = stripComments(readFileSync(file, "utf8"));
      let m: RegExpExecArray | null;
      while ((m = RE.exec(src)) !== null) {
        found++;
        const to = m[1]!;
        const from = m[2]!;
        if (!isValidGtidTransition(from as GtidState, to as GtidState)) {
          offenders.push(`${relative(REPO_ROOT, file)}: ${from} → ${to}`);
        }
      }
    }
    // Sanity: the scanner must actually have matched the known transitions, else
    // a regex regression would make this test vacuously pass.
    expect(found, "static scanner matched no GTID transitions — regex regression?").toBeGreaterThan(
      5
    );
    expect(
      offenders,
      `These raw GTID transitions are not declared in ALLOWED_GTID_TRANSITIONS:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });

  it("every `INSERT INTO GtidTransactions` entry state is in ALLOWED_GTID_ENTRY_STATES", () => {
    // The state literal is the first 'GT_...' inside the VALUES list.
    const RE = /INSERT[\s\S]*?INTO\s+GtidTransactions[\s\S]*?VALUES\s*\([\s\S]*?'(GT_[A-Z_]+)'/gi;
    const offenders: string[] = [];
    let found = 0;
    for (const file of gtidSourceFiles()) {
      const src = stripComments(readFileSync(file, "utf8"));
      let m: RegExpExecArray | null;
      while ((m = RE.exec(src)) !== null) {
        found++;
        const entry = m[1]!;
        if (!ALLOWED_GTID_ENTRY_STATES.has(entry as GtidState)) {
          offenders.push(`${relative(REPO_ROOT, file)}: enters at ${entry}`);
        }
      }
    }
    expect(found, "static scanner matched no GTID inserts — regex regression?").toBeGreaterThan(0);
    expect(
      offenders,
      `These GTID INSERT entry states are not in ALLOWED_GTID_ENTRY_STATES:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });
});
