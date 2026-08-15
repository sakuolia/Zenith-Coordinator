/**
 * @file case_dedup.test.ts — "is a CASE already open for this?" is asked with
 *       one predicate, and that predicate includes ESCALATED.
 *
 * `20_method_design.md` §10.7.2 requires that one cause produce one CASE. Each
 * de-duplication site implements that by asking whether an unresolved CASE for
 * the same cause already exists — and each site wrote the state list by hand.
 *
 * Written by hand, the list comes out as `('OPEN','IN_PROGRESS')`, or even just
 * `'OPEN'`, because those are the states one thinks of as "open". That is not a
 * conservative approximation, it is a guaranteed duplicate: §10.7.4's sweep
 * (`escalateOverdueCases`) moves every CASE out of OPEN/IN_PROGRESS once
 * `PR-CASE-SLA` elapses, so any predicate that omits ESCALATED stops matching
 * after exactly one SLA window — and the conditions that survive an SLA window
 * are the serious ones (a broken audit chain, an ownership divergence). The
 * ninth review's §10.2.1 asks for exactly this kind of check: turn a rule stated
 * in prose into something that fails when it is violated.
 *
 * So the predicate lives in one place (`UNRESOLVED_CASE_STATES_SQL`) and this
 * test pins two things: what the shared predicate contains, and that no site
 * re-derives it inline.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { UNRESOLVED_CASE_STATES, UNRESOLVED_CASE_STATES_SQL } from "../../src/zc/cases/case";
import type { CaseState } from "../../src/types";

const SRC = resolve(__dirname, "../../src");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? tsFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("UNRESOLVED_CASE_STATES", () => {
  it("is every CaseState except RESOLVED", () => {
    const all: CaseState[] = ["OPEN", "IN_PROGRESS", "RESOLVED", "ESCALATED"];
    expect([...UNRESOLVED_CASE_STATES].sort()).toEqual(all.filter((s) => s !== "RESOLVED").sort());
  });

  it("includes ESCALATED — the state the SLA sweep parks long-lived causes in", () => {
    expect(UNRESOLVED_CASE_STATES).toContain("ESCALATED");
    expect(UNRESOLVED_CASE_STATES_SQL).toContain("ESCALATED");
  });
});

describe("no site re-derives the unresolved-CASE predicate inline", () => {
  /**
   * `escalateOverdueCases` and `autoResolveCaseForGtid` legitimately use a
   * narrower list: you cannot escalate what is already escalated, and
   * auto-closing an ESCALATED CASE would un-queue the human §10.7.4 just
   * queued. Both are in case.ts, where the distinction is documented next to
   * the shared constant.
   */
  const ALLOWED = new Set(["zc/cases/case.ts"]);

  it("only case.ts spells a CASE-state list out by hand", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      // A hand-written SQL state list over the Cases lifecycle, e.g.
      //   state IN ('OPEN','IN_PROGRESS')      state = 'OPEN'
      const inline =
        /state\s+IN\s*\(\s*'(?:OPEN|IN_PROGRESS|ESCALATED|RESOLVED)'/.test(text) ||
        /state\s*=\s*'(?:OPEN|IN_PROGRESS|ESCALATED)'/.test(text);
      if (inline && /FROM Cases|UPDATE Cases/.test(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `these files ask "is a CASE open?" with their own state list; use UNRESOLVED_CASE_STATES_SQL ` +
        `(or, if a narrower list is intended, say why next to it in zc/cases/case.ts): ${offenders.join(", ")}`
    ).toEqual([]);
  });
});
