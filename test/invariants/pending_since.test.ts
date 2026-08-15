/**
 * @file pending_since.test.ts — static guards keeping the timeout clocks off
 *       columns an unrelated writer can move (docs/specs/20_method_design.md §3.3.1).
 *
 * The rule these guards enforce is not "use `pending_since` everywhere". It is:
 *
 *   **no timer may measure from a column that a write unrelated to progress
 *   can move.**
 *
 * `Transactions.updated_at` broke that rule. Two writers move it without
 * touching `state` and without a state guard — `case_id` when a CASE is opened
 * (src/zc/cases/case.ts) and `edi_ref` when remittance data is linked
 * (src/zc/richdata/edi.ts) — so opening a CASE about a stalled transfer
 * postponed that transfer's own deadline, and repeating it postponed the
 * deadline without bound. `Transactions.pending_since` exists to be
 * unreachable by those writers. `test/cron/pending_since.test.ts` pins the
 * behaviour; the guards here pin the shape of the code, so a new timer copying
 * the old idiom fails the suite instead of shipping.
 *
 * `GtidTransactions.updated_at` satisfies the rule a different way: every
 * `UPDATE GtidTransactions` in the tree also assigns `state`, so the column IS
 * the state-entry time and no incidental writer exists to reset it. That is a
 * property of the current call sites rather than of the schema, so guard 3
 * checks it directly — the day someone adds a non-state writer to that table,
 * the GTID timers acquire the Transactions defect, and this test says so.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SWEEP_PATH = join("src", "cron", "timeout_sweep.ts");
const SWEEP = readFileSync(SWEEP_PATH, "utf8");

/**
 * Files permitted to write `Transactions.pending_since`: the row-creating
 * paths (which start the first wait) and the Authority Check marker (which
 * starts a wait inside a state the row is already in).
 */
const PENDING_SINCE_WRITERS = [
  join("src", "zc", "lanes", "_helpers.ts"),
  join("src", "zc", "lanes", "_authority_check.ts"),
  join("src", "zc", "cases", "reversal.ts"),
  join("src", "zc", "ingress", "transfers.ts"),
  join("src", "zc", "richdata", "cross_border.ts"),
];

function allSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) allSourceFiles(full, acc);
    else if (full.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

/**
 * Every backtick-delimited template literal in a source file, comments removed
 * first. Prose in this codebase quotes SQL and column names with backticks, so
 * scanning raw text would treat `` `pending_since` `` in a JSDoc block as SQL.
 */
function templateLiterals(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return code.match(/`[^`]*`/g) ?? [];
}

describe("invariant: no timeout measures from a resettable column", () => {
  it("no Transactions deadline comparison in the sweep reads a bare updated_at", () => {
    const offending = templateLiterals(SWEEP)
      .filter((sql) => /\bFROM\s+Transactions\b/i.test(sql))
      .filter((sql) => /\bupdated_at\s*[<>]/.test(sql))
      .filter((sql) => !/COALESCE\(\s*pending_since\s*,\s*updated_at\s*\)\s*[<>]/.test(sql));

    expect(
      offending,
      `A timeout in ${SWEEP_PATH} compares Transactions.updated_at against a deadline. ` +
        "That column moves on any write to the row (case_id, edi_ref), so an unrelated " +
        "writer can postpone the deadline without bound. Use " +
        "`COALESCE(pending_since, updated_at)` — see the header comment in that file and " +
        "docs/disclosure/CORE_DISCLOSURE.md【0124】4."
    ).toEqual([]);
  });

  it("all four Transactions timers are present in the corrected form", () => {
    // Positive counterpart to the guard above: T_precheck, T_auth, T2_exec and
    // T3_payee_proof must each still be there, so deleting a timer fails here
    // rather than silently reducing coverage.
    const uses = SWEEP.match(/COALESCE\(\s*pending_since\s*,\s*updated_at\s*\)\s*[<>]/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(4);
  });

  it("GtidTransactions.updated_at is only ever written together with state", () => {
    // The GTID timers (GT_DECIDED_TO_SETTLE / GT_PRECHECKED recovery) measure
    // from `updated_at`, which is sound only while every writer of that column
    // is a state transition. Adding a non-state writer to this table without a
    // dedicated clock column would reproduce the Transactions defect.
    const offending: Array<{ file: string; sql: string }> = [];
    for (const file of allSourceFiles("src")) {
      for (const sql of templateLiterals(readFileSync(file, "utf8"))) {
        if (!/\bUPDATE\s+GtidTransactions\b/i.test(sql)) continue;
        if (!/\bupdated_at\s*=/.test(sql)) continue;
        if (!/\bstate\s*=/.test(sql)) offending.push({ file, sql: sql.slice(0, 120) });
      }
    }

    expect(
      offending,
      "These statements write GtidTransactions.updated_at without changing `state`. " +
        "The GTID timeouts measure from `updated_at` on the assumption that it marks " +
        "state entry; an incidental writer breaks that assumption and makes the deadline " +
        "resettable. Either fold the write into a state transition, or give the table its " +
        "own `pending_since` as Transactions has."
    ).toEqual([]);
  });
});

describe("invariant: every row is created with its clock already running", () => {
  it("every INSERT INTO Transactions sets pending_since", () => {
    // The COALESCE fallback in the sweep exists for rows written before the
    // column did. A NEW row-creating path that omits the column would silently
    // opt itself back into measuring from `updated_at` — the whole defect,
    // reintroduced one lane at a time and invisible in behaviour until a CASE
    // is opened against one of those rows. (This guard was written because the
    // first pass at the fix missed exactly two such paths: the main ingress
    // INSERT and the cross-border one, both spelled `INSERT OR IGNORE`.)
    const offending: Array<{ file: string; sql: string }> = [];
    for (const file of allSourceFiles("src")) {
      for (const sql of templateLiterals(readFileSync(file, "utf8"))) {
        if (!/\bINSERT\b[\s\S]*?\bINTO\s+Transactions\b/i.test(sql)) continue;
        if (!/\bpending_since\b/.test(sql)) offending.push({ file, sql: sql.slice(0, 140) });
      }
    }

    expect(
      offending,
      "These statements create a Transactions row without `pending_since`. The row's " +
        "timeout clock would fall back to `updated_at`, which any unrelated write moves. " +
        "Stamp the column at creation — see src/cron/timeout_sweep.ts."
    ).toEqual([]);
  });
});

describe("invariant: pending_since is written only by the wait-starting call sites", () => {
  it("no other source file assigns Transactions.pending_since", () => {
    // Only SQL counts (prose mentions the column freely), and only writes:
    // reading it via the sweep's COALESCE form is the intended use, so that
    // form is stripped before looking for what remains — an assignment or an
    // INSERT column list.
    const writers = allSourceFiles("src")
      .filter((f) => !PENDING_SINCE_WRITERS.includes(f))
      .filter((f) =>
        templateLiterals(readFileSync(f, "utf8"))
          .map((sql) => sql.replace(/COALESCE\(\s*pending_since\s*,\s*updated_at\s*\)/g, ""))
          .some((sql) => /\bpending_since\b/.test(sql))
      );

    expect(
      writers,
      "These files reference `Transactions.pending_since`. Only the lane helpers, the " +
        "Authority Check marker, and the reversal INSERT may write it: the column is the " +
        "timeout clock, and a writer touching it for an unrelated reason recreates the " +
        "resettable-deadline defect `updated_at` had."
    ).toEqual([]);
  });
});
