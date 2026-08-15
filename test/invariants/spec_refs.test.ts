/**
 * @file spec_refs.test.ts — Drift guards for docs/specs/.
 *
 * The 2026-07 specs review found that every axis with a mechanical check was
 * healthy (31_schema.md vs the consolidated migration, file_structure.md vs the
 * tree, markdown anchors) while every axis without one had rotted: §X.Y
 * references pointing at sections that no longer existed — or never existed —
 * stale line-number references, and value domains (lane, TxState) that
 * disagreed across three documents and the code.
 *
 * These tests close that gap. They are deliberately structural, not stylistic:
 * each one fails only when a reader would actually be misled.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const SPECS = join(ROOT, "docs/specs");
const SPEC_FILES = readdirSync(SPECS).filter((f) => f.endsWith(".md"));

/**
 * Documents whose §-references and links are checked.
 *
 * The README is included even though it lives outside `docs/specs/`. It makes the
 * same kind of claim — "see §X.Y of that document" — and the drift guard used to
 * stop at the directory boundary, which is not where the claims stop: an earlier
 * pass found two dead pointers in it (`§8.1 の精密化`, actually §6.1; `§3.4 の
 * KeyRegistry 統制`, actually §3.3.4). A guard scoped by directory rather than by
 * the kind of claim it protects will keep having this blind spot.
 */
const CHECKED_FILES = [...SPEC_FILES, "../../README.md"];

const read = (f: string) => readFileSync(join(SPECS, f), "utf8");

/** Section numbers declared by headings, e.g. "### 12.3.1 識別子" -> "12.3.1". */
function declaredSections(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const h = /^#{2,6}\s+(.*)$/.exec(line);
    if (!h) continue;
    // 第N章 ... -> also register "N" so that "§N" (chapter-level) resolves.
    const chapter = /^第(\d+)章/.exec(h[1]);
    if (chapter) out.add(chapter[1]);
    const num = /^(\d+(?:\.\d+)*)\s/.exec(h[1]);
    if (num) {
      out.add(num[1]);
      // A section implies its ancestors are addressable (e.g. 12.3 from 12.3.1).
      const parts = num[1].split(".");
      for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("."));
    }
  }
  return out;
}

const SECTIONS = new Map<string, Set<string>>(
  SPEC_FILES.map((f) => [f, declaredSections(read(f))])
);

/** Which spec file a "…`20_method_design.md` §3.4…" reference targets. */
function targetOf(prefix: string, self: string): string {
  const named = SPEC_FILES.filter((f) => prefix.includes(f));
  // The nearest filename mentioned before the § wins; otherwise it is a self-reference.
  if (named.length === 0) return self;
  let best = named[0];
  let bestAt = -1;
  for (const f of named) {
    const at = prefix.lastIndexOf(f);
    if (at > bestAt) {
      bestAt = at;
      best = f;
    }
  }
  return best;
}

describe("specs: §X.Y references resolve to a real section", () => {
  it.each(CHECKED_FILES)("%s", (file) => {
    const text = read(file);
    const lines = text.split("\n");
    const broken: string[] = [];

    lines.forEach((line, i) => {
      // Skip fenced-code and table-of-contents style lines is unnecessary:
      // a § reference is a claim wherever it appears.
      for (const m of line.matchAll(/§\s*(\d+(?:\.\d+)*)/g)) {
        const sec = m[1];
        const prefix = line.slice(Math.max(0, m.index! - 120), m.index!);
        // 「本書§17.5」/「本節」 is explicitly a self-reference even when another
        // document is named earlier in the same sentence.
        const target = /(?:本書|本節|本章)\s*$/.test(prefix) ? file : targetOf(prefix, file);
        const known = SECTIONS.get(target);
        if (!known || known.has(sec)) continue;
        broken.push(
          `  L${i + 1}: §${sec} -> ${target} (no such section)\n      ${line.trim().slice(0, 140)}`
        );
      }
    });

    expect(broken.join("\n"), `broken § references in docs/specs/${file}`).toBe("");
  });
});

describe("specs: no legacy or unmaintainable reference notations", () => {
  // Line-number references (§914-920) and old appendix symbols (§A.3, §G.5)
  // both survived a document reorganisation and pointed nowhere afterwards.
  const FORBIDDEN: Array<[RegExp, string]> = [
    [/§\s*\d{3,}/, "line-number reference (§914-920 style) — use a section number"],
    [
      /§\s*[A-HK](?:\.\d+)+/,
      "old appendix symbol (§A.3 / §G.5 style) — renumbered to chapter-based sections",
    ],
    [/§\s*1\.5\s+[A-Z]\b/, "old single-file section symbol (§1.5 X style)"],
    [/付録\s*[A-I]\b/, "old appendix label — 30_internal_design.md 第12〜16章 に再編済み"],
  ];

  it.each(CHECKED_FILES)("%s", (file) => {
    const lines = read(file).split("\n");
    const hits: string[] = [];
    lines.forEach((line, i) => {
      // The renumbering note in 30 legitimately names the old symbols; it is a
      // blockquote table whose whole purpose is to map them to the new numbers.
      if (line.startsWith(">")) return;
      if (line.includes("旧記号") || line.includes("旧付録")) return;
      for (const [re, why] of FORBIDDEN) {
        if (re.test(line)) hits.push(`  L${i + 1}: ${why}\n      ${line.trim().slice(0, 140)}`);
      }
    });
    expect(hits.join("\n"), `legacy reference notation in docs/specs/${file}`).toBe("");
  });
});

describe("specs: markdown links resolve", () => {
  const slug = (h: string) =>
    h
      .replace(/<a id="[^"]*"><\/a>/g, "")
      .replace(/[^\w\s\-぀-ヿ一-鿿ｦ-ﾟ]/g, "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-");

  const anchors = new Map<string, Set<string>>();
  for (const f of SPEC_FILES) {
    const t = read(f);
    const a = new Set<string>();
    for (const m of t.matchAll(/<a id="([^"]+)"/g)) a.add(m[1]);
    for (const m of t.matchAll(/^#{1,6}\s+(.+)$/gm)) a.add(slug(m[1]));
    anchors.set(f, a);
  }

  it.each(SPEC_FILES)("%s", (file) => {
    const text = read(file);
    const bad: string[] = [];
    for (const m of text.matchAll(/\]\(([^)\s#]*)#([^)\s]+)\)/g)) {
      const target = m[1] === "" ? file : basename(m[1]);
      const known = anchors.get(target);
      if (!known) continue; // link into a non-spec file: out of scope here
      if (!known.has(m[2])) bad.push(`  ${m[1]}#${m[2]}`);
    }
    expect(bad.join("\n"), `unresolved anchor links in docs/specs/${file}`).toBe("");
  });
});

describe("specs: documented value domains match the implementation", () => {
  const states = readFileSync(join(ROOT, "src/types/states.ts"), "utf8");

  /** Resolves a string-literal union, expanding referenced aliases one level. */
  const unionOf = (name: string, seen = new Set<string>()): string[] => {
    if (seen.has(name)) return [];
    seen.add(name);
    const m = new RegExp(`export type ${name} =([^;]+);`).exec(states);
    if (!m) throw new Error(`${name} not found in src/types/states.ts`);
    const literals = [...m[1].matchAll(/"([A-Z][A-Z_0-9]*)"/g)].map((x) => x[1]);
    // Referenced aliases are the bare identifiers left once literals are removed.
    const bare = m[1].replace(/"[^"]*"/g, "");
    const refs = [...bare.matchAll(/\b([A-Z][A-Za-z]+)\b/g)].map((x) => x[1]);
    return [...new Set([...literals, ...refs.flatMap((r) => unionOf(r, seen))])];
  };

  it("Transactions.lane column domain (31_schema.md) == TxLane", () => {
    const doc = /lane\s+TEXT\s+NOT NULL,\s*--\s*([A-Z_|]+)/.exec(read("31_schema.md"));
    expect(doc, "lane column comment not found in 31_schema.md").not.toBeNull();
    expect(doc![1].split("|").sort()).toEqual(unionOf("TxLane").sort());
  });

  it("POST /api/transfers lane request domain (32_api_contracts.md) == LaneType", () => {
    const doc = /"lane":\s*"([A-Z_|]+)"/.exec(read("32_api_contracts.md"));
    expect(doc, "lane request enum not found in 32_api_contracts.md").not.toBeNull();
    expect(doc![1].split("|").sort()).toEqual(unionOf("LaneType").sort());
  });

  it("QueryResponse state enum (30_internal_design.md §13.6) == TxState", () => {
    const doc = /"state":\s*"((?:[A-Z][A-Z_0-9]*\|){5,}[A-Z][A-Z_0-9]*)"/.exec(
      read("30_internal_design.md")
    );
    expect(doc, "state enum not found in 30_internal_design.md").not.toBeNull();
    expect(doc![1].split("|").sort()).toEqual(unionOf("TxState").sort());
  });

  it("GTID is produced internally, never accepted as a request lane", () => {
    expect(unionOf("LaneType")).not.toContain("GTID");
    expect(unionOf("TxLane")).toContain("GTID");
    // HTLC_AUTH is a flow on the HTLC lane, not a lane value.
    expect(unionOf("TxLane")).not.toContain("HTLC_AUTH");
  });
});

/**
 * The 2026-07 fourth-pass review found the same failure mode as the third: the
 * axes with a mechanical check stayed healthy, the ones without rotted. Four
 * value domains had drifted apart from the code (`RichDataType`, `DnsState`
 * plus a phantom `RECALC_EXCLUDING_BANK` state, `next_action_hint` — which had
 * four different domains across four documents — and `proof_type`, which listed
 * a *type name* as one of its values). The checks below make the declaration
 * itself machine-comparable so the next drift fails in CI instead of in a
 * reader's head.
 *
 * The convention: a spec declares a domain as
 *     実装の正: `src/<path>.ts#<TypeName>`: `A` | `B` | `C`
 * or, in a DDL comment,
 *     -- <TypeName>: A|B|C
 * and this file resolves `<TypeName>` against the source of truth.
 */
describe("specs: declared value domains resolve against the implementation", () => {
  /**
   * The declaration carries its own path — `src/zc/cases/reversal.ts#ReversalReason` —
   * so resolve against that file rather than a parallel allow-list here. The list
   * used to be hardcoded, which silently limited the convention to three files:
   * a spec could declare a domain that lived anywhere else and the check would
   * throw instead of comparing.
   *
   * **Value tokens may contain digits.** Every regex in this file matches a value
   * as `[A-Z][A-Z_0-9]*`, not `[A-Z_]+`. The narrower class silently dropped
   * `P2P` from `PurposeType` on both sides of the comparison, so the check
   * compared four values against four and passed while being blind to the fifth:
   * the value could have been deleted from the union without the check noticing.
   * A comparison that discards part of both inputs still goes green — which is
   * the worst failure mode a drift guard can have.
   */
  const domainOf = (path: string, name: string): string[] => {
    const full = join(ROOT, path);
    if (!existsSync(full)) throw new Error(`declared source ${path} does not exist`);
    const m = new RegExp(`export type ${name} =([^;]+);`).exec(readFileSync(full, "utf8"));
    if (!m) throw new Error(`type ${name} not found in ${path}`);
    return [...m[1].matchAll(/"([A-Z][A-Z_0-9]*)"/g)].map((x) => x[1]).sort();
  };

  /**
   * The DDL-comment form (`-- DnsState: OPEN|KICKED|…`) carries no path, so it is
   * resolved by name across all of src/ rather than against a hardcoded list.
   */
  const srcFiles = (function walk(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (p.endsWith(".ts")) acc.push(p);
    }
    return acc;
  })(join(ROOT, "src"));

  const domainByName = (name: string): string[] => {
    for (const f of srcFiles) {
      const m = new RegExp(`export type ${name} =([^;]+);`).exec(readFileSync(f, "utf8"));
      if (m) return [...m[1].matchAll(/"([A-Z][A-Z_0-9]*)"/g)].map((x) => x[1]).sort();
    }
    throw new Error(`type ${name} not found anywhere under src/`);
  };

  it("every `…#TypeName`: `A` | `B` declaration in docs/specs/ matches the union", () => {
    // Inline prose form: 実装の正: `src/types/states.ts#DnsState`: `OPEN` | `KICKED` | …
    const decl = /`(src\/[^`#]*)#(\w+)`:\s*(`[A-Z][A-Z_0-9]*`(?:\s*\|\s*`[A-Z][A-Z_0-9]*`)*)/g;
    const mismatches: string[] = [];
    let checked = 0;
    for (const file of SPEC_FILES) {
      for (const m of read(file).matchAll(decl)) {
        checked++;
        const declared = [...m[3].matchAll(/`([A-Z][A-Z_0-9]*)`/g)].map((x) => x[1]).sort();
        const actual = domainOf(m[1], m[2]);
        if (declared.join("|") !== actual.join("|")) {
          mismatches.push(`${file}: ${m[2]} declared [${declared}] but code has [${actual}]`);
        }
      }
    }
    expect(
      checked,
      "no `#TypeName`: declarations found — has the convention been dropped?"
    ).toBeGreaterThan(0);
    expect(mismatches.join("\n")).toBe("");
  });

  it("every `-- TypeName: A|B|C` DDL comment in 31_schema.md matches the union", () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const m of read("31_schema.md").matchAll(
      /--\s*([A-Z][A-Za-z]+):\s*([A-Z][A-Z_0-9]*(?:\|[A-Z][A-Z_0-9]*)+)/g
    )) {
      checked++;
      const declared = m[2].split("|").sort();
      const actual = domainByName(m[1]);
      if (declared.join("|") !== actual.join("|")) {
        mismatches.push(`31_schema.md: ${m[1]} declared [${declared}] but code has [${actual}]`);
      }
    }
    expect(checked, "no `-- TypeName:` DDL comments found").toBeGreaterThan(0);
    expect(mismatches.join("\n")).toBe("");
  });

  it("next_action_hint is a closed set — no per-event hint values", () => {
    const iface = readFileSync(join(ROOT, "src/types/api/transfers.ts"), "utf8");
    const field = /next_action_hint:\s*((?:"[A-Z][A-Z_0-9]*"\s*\|?\s*)+);/.exec(iface);
    expect(field, "next_action_hint field not found in src/types/api/transfers.ts").not.toBeNull();
    const actual = [...field![1].matchAll(/"([A-Z][A-Z_0-9]*)"/g)].map((x) => x[1]).sort();

    const offenders: string[] = [];
    for (const file of SPEC_FILES) {
      // Declared enums: "next_action_hint": "WAIT|RETRY_LATER|…"
      for (const m of read(file).matchAll(/"next_action_hint":\s*"([A-Z_|]+)"/g)) {
        const declared = m[1].split("|").sort();
        if (declared.join("|") !== actual.join("|")) {
          offenders.push(`${file}: enum [${declared}] != [${actual}]`);
        }
      }
      // Prose usages: next_action_hint: WAIT / next_action_hint=WAIT
      for (const m of read(file).matchAll(/next_action_hint\s*[:=]\s*`?([A-Z][A-Z_]+)`?/g)) {
        if (!actual.includes(m[1])) offenders.push(`${file}: uses out-of-domain value ${m[1]}`);
      }
    }
    expect(offenders.join("\n")).toBe("");
  });
});

/**
 * Field-level counterpart to the endpoint guard.
 *
 * `public_message_id` was referenced as a response field by five normative
 * passages and existed nowhere in the codebase; the same pass also found
 * `auth_timeout_seconds`, `originator_name`, and `actual_name` documented as
 * request/response fields the implementation has never accepted or returned. A
 * reader following the contract would have built against fields that silently do
 * not exist — the failure mode a contract document is supposed to prevent.
 */
describe("specs: every field named in 32_api_contracts.md exists in the code", () => {
  const sourceText = (() => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (entry.endsWith(".ts")) out.push(readFileSync(p, "utf8"));
      }
    };
    walk(join(ROOT, "src"));
    return out.join("\n");
  })();

  it("no JSON field in the contract is absent from src/", () => {
    const doc = read("32_api_contracts.md");
    // snake_case JSON keys, i.e. `"field_name":` — narrow enough to skip prose
    // and wide enough to cover every request/response example in the file.
    const fields = new Set([...doc.matchAll(/"([a-z][a-z0-9_]{2,})"\s*:/g)].map((m) => m[1]));
    const missing = [...fields].filter((f) => !sourceText.includes(f)).sort();
    expect(fields.size, "no JSON fields parsed from the contract").toBeGreaterThan(100);
    expect(
      missing.join(", "),
      "fields documented in 32_api_contracts.md but absent from src/"
    ).toBe("");
  });
});

/**
 * Asymmetric disclosure, enforced (docs/specs/30_internal_design.md §10.0).
 *
 * A spec states norms in the present tense and says nothing about meeting them;
 * only gaps are annotated. The fifth-pass review stripped 17 "As-Built /
 * implementation status" blocks and 31 occurrences of 実装済み that had built up
 * by closing each earlier finding with a note in the body — notes that rot on
 * every commit, and rot in one direction only ("says implemented, isn't").
 *
 * Silence is the load-bearing convention here: it has to mean "as specified",
 * which it cannot if confirmations drift back in one at a time. Chapter 10 of
 * 30_internal_design.md is exempt — it is the ledger, and §10.0 is the rule
 * itself, which necessarily quotes the words it bans.
 */
describe("specs: no implementation-status claims in the body", () => {
  const BANNED = ["実装済み", "As-Built"];

  it.each(SPEC_FILES)("%s", (file) => {
    const lines = read(file).split("\n");
    const hits: string[] = [];
    let inRoadmapChapter = false;

    lines.forEach((line, i) => {
      // 30_internal_design.md 第10章 (the Roadmap ledger, §10.0 included) is the
      // one place these words belong.
      if (file === "30_internal_design.md") {
        if (/^## 第10章/.test(line)) inRoadmapChapter = true;
        else if (/^## 第\d+章/.test(line)) inRoadmapChapter = false;
      }
      if (inRoadmapChapter) return;

      for (const word of BANNED) {
        if (line.includes(word)) {
          hits.push(
            `  L${i + 1}: "${word}" — state the norm; annotate only gaps (§10.0)\n      ${line.trim().slice(0, 120)}`
          );
        }
      }
    });

    expect(hits.join("\n"), `implementation-status claim in docs/specs/${file}`).toBe("");
  });
});

/**
 * The other half of §10.0: a disclosed gap must be tracked somewhere.
 *
 * A `**未充足**` note that names no owner is how a gap becomes folklore — true
 * when written, unfindable six months later. Requiring a pointer to the chapter
 * 10 ledger keeps the ledger the single place to ask "what is left?".
 *
 * Matches the bold marker rather than the bare word: 未充足 also appears in prose
 * that is not a disclosure ("条件が未充足の場合は fail-closed", "第1層未充足" as a
 * rejection reason), and flagging those would train readers to ignore the check.
 */
describe("specs: every disclosed gap points at the Roadmap ledger", () => {
  const DISCLOSURE = /\*\*未充足(（[^）]*）)?\*\*/;
  const POINTERS = ["第10章", "Roadmap", "s10-roadmap"];

  it.each(SPEC_FILES)("%s", (file) => {
    const lines = read(file).split("\n");
    const orphans: string[] = [];
    let inRoadmapChapter = false;

    lines.forEach((line, i) => {
      if (file === "30_internal_design.md") {
        if (/^## 第10章/.test(line)) inRoadmapChapter = true;
        else if (/^## 第\d+章/.test(line)) inRoadmapChapter = false;
      }
      if (inRoadmapChapter) return; // entries there are the ledger
      if (!DISCLOSURE.test(line)) return;

      // The pointer may trail the marker by a few lines in a multi-line note.
      const window = lines.slice(i, i + 8).join("\n");
      if (!POINTERS.some((p) => window.includes(p))) {
        orphans.push(
          `  L${i + 1}: gap disclosed but not tracked — add a 第10章 Roadmap pointer\n      ${line.trim().slice(0, 120)}`
        );
      }
    });

    expect(orphans.join("\n"), `untracked 未充足 note in docs/specs/${file}`).toBe("");
  });
});

/**
 * Third namespace, third instance of the same failure.
 *
 * `reason_code` names three distinct value spaces (10_requirements.md 序章
 * § reason_code の 3 つの値空間): error codes returned on 4xx/5xx, *state* codes
 * stored on `Transactions.reason_code`, and CASE codes on `Cases.reason_code`.
 * Only the first was catalogued and checked. The 2026-07 sixth-pass review found
 * that 8 of the 14 state codes the specs fix normatively did not exist anywhere in
 * the implementation — including the one the counter-desk runbook keys its crisis
 * wording to (`SUSPEND_IGS_HOLD`) and the one used to build a CASE aggregation key
 * (`SUSPEND_ADAPTER_DOWN`). A norm written over a value that cannot occur is not a
 * norm; it reads as one.
 *
 * The convention mirrors the endpoint guard: a state reason_code that exists is
 * written plainly, one that is specified ahead of the implementation carries 【未実装】.
 */
describe("specs: state reason_code values named normatively exist in the code", () => {
  const sourceText = (() => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (entry.endsWith(".ts")) out.push(readFileSync(p, "utf8"));
      }
    };
    walk(join(ROOT, "src"));
    return out.join("\n");
  })();

  // Scope, decided by measurement rather than taste (sixth-pass review §H-1).
  // Extending this to bare backticked values in any table whose header mentions
  // reason_code was tried against the corpus: 56 tokens matched, 4 flagged, and
  // only 1 was a real defect — the other 3 were `MAX_AMOUNT_VALUE`,
  // `ALLOWED_TRANSITIONS` and a prose cross-reference, i.e. constants and symbol
  // names that merely look like codes. A 75% false-positive rate teaches readers
  // to ignore the check, which costs more than the one defect it catches, so the
  // guard stays on the unambiguous `reason_code=`/`reason_code:` forms. (The one
  // real defect it surfaced — a stale value enumeration in 10 §4.3.0 — was fixed
  // by deleting the duplicate and pointing at the single source in §4.3.1.)
  it("every `reason_code=X` / `reason_code: X` in docs/specs/ exists in src or is marked 【未実装】", () => {
    // `reason_code=SUSPEND_ADAPTER_DOWN`【未実装】 / - `reason_code: IGS_FAILED`（…）
    const decl = /reason_code\s*[=:]\s*`?([A-Z][A-Z_0-9]{3,})`?\s*(?:`)?\s*(【未実装】)?/g;
    const problems: string[] = [];
    let checked = 0;
    for (const file of SPEC_FILES) {
      for (const m of read(file).matchAll(decl)) {
        checked++;
        const [, code, unimplemented] = m;
        const exists = sourceText.includes(`"${code}"`);
        if (!exists && !unimplemented) {
          problems.push(
            `${file}: ${code} — absent from src/; use the real value or mark 【未実装】`
          );
        } else if (exists && unimplemented) {
          problems.push(`${file}: ${code} — marked 【未実装】 but src/ does write it`);
        }
      }
    }
    expect(checked, "no `reason_code=` assertions parsed from docs/specs/").toBeGreaterThan(5);
    expect(problems.join("\n")).toBe("");
  });
});

describe("specs: every endpoint documented in 32_api_contracts.md is routed", () => {
  const ROUTER_SOURCES = [
    "src/router/zc.ts",
    "src/router/bank.ts",
    "src/router/internal.ts",
    "src/index.ts",
    "src/bank/ingress.ts",
    "src/bank/customer_api.ts",
    "src/bank/teller_api.ts",
    "src/zc/fx/api.ts",
  ]
    .map((f) => readFileSync(join(ROOT, f), "utf8"))
    .join("\n");

  it("routed endpoints are unmarked, unrouted endpoints carry 【未実装】", () => {
    const doc = read("32_api_contracts.md");
    const heading =
      /^#{3,5}\s+((?:GET|POST|PUT|DELETE|PATCH)(?:\/(?:GET|POST|PUT|DELETE|PATCH))*)\s+(\/[^\s`?]+)(.*)$/gm;
    const problems: string[] = [];
    let checked = 0;
    for (const m of doc.matchAll(heading)) {
      checked++;
      const [, method, path, rest] = m;
      const markedUnimplemented = rest.includes("【未実装】");
      // Static path segments must all appear somewhere in the routing layer.
      const tokens = path
        .split("/")
        .filter(Boolean)
        .filter((s) => !s.startsWith(":") && !s.startsWith("{"));
      const routed = tokens.every((t) => ROUTER_SOURCES.includes(t));
      if (routed && markedUnimplemented) {
        problems.push(`${method} ${path} — marked 【未実装】 but the router mentions it`);
      } else if (!routed && !markedUnimplemented) {
        problems.push(`${method} ${path} — not routed; document it as 【未実装】 or implement it`);
      }
    }
    expect(checked, "no endpoint headings parsed from 32_api_contracts.md").toBeGreaterThan(50);
    expect(problems.join("\n")).toBe("");
  });
});

describe("specs: PR-* parameters are all registered in the ledger", () => {
  it("every PR-* used in prose appears in 30_internal_design.md §12.9", () => {
    const ledger = read("30_internal_design.md");
    const registered = new Set(
      [...ledger.matchAll(/\|\s*`(PR-[A-Z0-9_-]+)`\s*\|/g)].map((m) => m[1])
    );
    const used = new Map<string, string[]>();
    for (const f of SPEC_FILES) {
      const text = read(f);
      for (const m of text.matchAll(/PR-[A-Z0-9_-]*[A-Z0-9_]/g)) {
        // `PR-SLO-*` is a glob over a family, not a parameter name.
        if (/^-?\*/.test(text.slice(m.index! + m[0].length))) continue;
        if (!used.has(m[0])) used.set(m[0], []);
        used.get(m[0])!.push(f);
      }
    }
    const missing = [...used.entries()]
      .filter(([name]) => !registered.has(name))
      .map(([name, files]) => `  ${name} (used in ${[...new Set(files)].join(", ")})`);
    expect(missing.join("\n"), "PR-* parameters missing from the §12.9 ledger").toBe("");
  });
});

describe("specs: file_structure.md matches the repository tree", () => {
  const IGNORED = new Set([".git", "node_modules", ".wrangler", "dist", "coverage"]);

  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      if (IGNORED.has(e)) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, acc);
      else acc.push(p);
    }
    return acc;
  };

  it("every src/**/*.ts is mentioned", () => {
    const doc = read("file_structure.md");
    const missing = walk(join(ROOT, "src"))
      .filter((p) => p.endsWith(".ts"))
      .map((p) => basename(p))
      .filter((n) => !doc.includes(n));
    expect(missing.join(", "), "source files absent from file_structure.md").toBe("");
  });

  // The tree used to be checked for src/ only, which left a self-referential
  // hole: this very file was absent from file_structure.md and no guard could
  // notice. The drift guards are part of the documented structure too.
  it("every test/**/*.ts is mentioned", () => {
    const doc = read("file_structure.md");
    const missing = walk(join(ROOT, "test"))
      .filter((p) => p.endsWith(".ts"))
      .map((p) => basename(p))
      .filter((n) => !doc.includes(n));
    expect(missing.join(", "), "test files absent from file_structure.md").toBe("");
  });

  it("every documented .ts file exists", () => {
    const onDisk = new Set(walk(ROOT).map((p) => basename(p)));
    const documented = [...read("file_structure.md").matchAll(/^[│├└─\s]*([\w.-]+\.ts)\s/gm)].map(
      (m) => m[1]
    );
    const phantom = [...new Set(documented)].filter((n) => !onDisk.has(n));
    expect(phantom.join(", "), "file_structure.md documents files that do not exist").toBe("");
  });
});

describe("specs: reason_code catalog vs REASON_CODE_CATEGORY", () => {
  const errorsTs = readFileSync(join(ROOT, "src/shared/errors.ts"), "utf8");

  /** Codes registered in REASON_CODE_CATEGORY, with their category. */
  const registered = (): Map<string, string> => {
    const from = errorsTs.indexOf("REASON_CODE_CATEGORY");
    expect(from, "REASON_CODE_CATEGORY not found in src/shared/errors.ts").toBeGreaterThan(-1);
    const body = errorsTs.slice(from, errorsTs.indexOf("\n};", from));
    return new Map(
      [...body.matchAll(/^\s{2}([A-Z_0-9]+):\s*"([A-Z][A-Z_0-9]*)"/gm)].map((m) => [m[1], m[2]])
    );
  };

  /** Codes listed in the 32_api_contracts.md error catalog table. */
  const catalogued = (): Map<string, string> => {
    const doc = read("32_api_contracts.md");
    const from = doc.indexOf("### 主要 reason_code 一覧");
    expect(from, "reason_code catalog heading not found").toBeGreaterThan(-1);
    // Stop before the sub-section listing codes that bypass DomainError: those
    // are deliberately NOT required to be in REASON_CODE_CATEGORY.
    const to = doc.indexOf("#### `DomainError` を経由しない reason_code", from);
    const body = doc.slice(from, to === -1 ? undefined : to);
    return new Map(
      [...body.matchAll(/^\|\s*([A-Z_0-9]+)\s*\|\s*([A-Z][A-Z_0-9]*)\s*\|/gm)].map((m) => [
        m[1],
        m[2],
      ])
    );
  };

  it("every registered reason_code appears in the 32_api_contracts.md catalog", () => {
    const missing = [...registered().keys()].filter((c) => !catalogued().has(c)).sort();
    expect(
      missing.join(", "),
      "registered in REASON_CODE_CATEGORY but absent from the § エラーカタログ table"
    ).toBe("");
  });

  it("every catalogued reason_code is registered in REASON_CODE_CATEGORY", () => {
    const reg = registered();
    const phantom = [...catalogued().keys()].filter((c) => !reg.has(c)).sort();
    expect(phantom.join(", "), "documented in the catalog but not registered in code").toBe("");
  });

  it("the documented category matches the registered category", () => {
    const reg = registered();
    const mismatched = [...catalogued().entries()]
      .filter(([code, cat]) => reg.has(code) && reg.get(code) !== cat)
      .map(([code, cat]) => `${code}: doc=${cat} code=${reg.get(code)}`);
    expect(mismatched.join("\n"), "category disagreement between doc and code").toBe("");
  });

  it("every DomainError reason_code is registered (unregistered ones become INTERNAL/500)", () => {
    const reg = registered();
    const srcFiles = (function walk(dir: string, acc: string[] = []): string[] {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p, acc);
        else if (p.endsWith(".ts")) acc.push(p);
      }
      return acc;
    })(join(ROOT, "src"));

    const unregistered = new Set<string>();
    for (const f of srcFiles) {
      for (const m of readFileSync(f, "utf8").matchAll(/new DomainError\(\s*"([A-Z_0-9]+)"/g)) {
        if (!reg.has(m[1])) unregistered.add(`${m[1]} (${f.slice(ROOT.length + 1)})`);
      }
    }
    expect(
      [...unregistered].sort().join("\n"),
      "DomainError thrown with a reason_code that has no category — it would surface as 500"
    ).toBe("");
  });
});

describe("specs: cmd/event vocabulary vs FinalityLog audit vocabulary", () => {
  const spec = read("30_internal_design.md");
  const messaging = readFileSync(join(ROOT, "src/types/api/messaging.ts"), "utf8");

  /** Names in the §12.1.1–12.1.4 contract tables. */
  const contractNames = (): string[] => {
    const from = spec.indexOf("### 12.1 cmd/event一覧");
    const to = spec.indexOf("#### 12.1.5");
    return [
      ...spec.slice(from, to).matchAll(/^\|\s*([A-Z][A-Za-z]+)\s*\|\s*(?:COMMAND|EVENT)\s*\|/gm),
    ].map((m) => m[1]);
  };

  /** The FinalityEventType union in the implementation. */
  const auditNames = (): Set<string> => {
    const m = /FinalityEventType\s*=([^;]+);/.exec(messaging);
    if (!m) throw new Error("FinalityEventType not found");
    return new Set([...m[1].matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1]));
  };

  /** The overlap set that §12.1.6 claims, read back out of the prose. */
  const claimedOverlap = (): Set<string> => {
    const from = spec.indexOf("**1. 同名で FinalityLog にも記録されるもの");
    const to = spec.indexOf("**2. I/F 語彙のみ");
    expect(from, "§12.1.6 overlap list not found").toBeGreaterThan(-1);
    return new Set([...spec.slice(from, to).matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]));
  };

  it("§12.1.6 overlap list == (§12.1 names ∩ FinalityEventType)", () => {
    const audit = auditNames();
    const actual = [...new Set(contractNames().filter((n) => audit.has(n)))].sort();
    expect([...claimedOverlap()].sort()).toEqual(actual);
  });

  it("every §12.1 name is unique (no duplicate contract entries)", () => {
    const names = contractNames();
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect([...new Set(dupes)].join(", "), "duplicate cmd/event entries in §12.1").toBe("");
  });
});
