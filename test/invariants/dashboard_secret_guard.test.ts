/**
 * @file dashboard_secret_guard.test.ts — Static guard against secrets baked
 *       into client-served dashboard HTML.
 *
 * Background: the operator dashboards (`src/dashboard/*.html`) call the
 * privileged `/internal/*` API (seed, DNS kick/settle, BCP read-only, quorum
 * report), all gated server-side by the `X-Cron-Secret` header. Those files
 * used to hardcode `const CRON_SECRET = 'zenith-cron-secret'` in client-side
 * JavaScript — i.e. the shared admin secret shipped to every browser that
 * loaded the page (view-source recoverable), turning the server's fail-closed
 * gate into a trivially bypassable one and additionally pinning a weak default.
 *
 * The fix sources the secret at runtime (operator prompt → sessionStorage) so
 * it is never part of the served artifact. This test guards the *class* of bug:
 * no dashboard HTML may assign a non-empty string literal to a *_SECRET
 * identifier, and the known leaked default must not reappear anywhere.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DASHBOARD_DIR = join("src", "dashboard");
const HTML_FILES = readdirSync(DASHBOARD_DIR).filter((f) => f.endsWith(".html"));

/** `const|let|var SOMETHING_SECRET = '<non-empty>'` (or "..."/`...`). */
const HARDCODED_SECRET = /(?:const|let|var)\s+\w*SECRET\w*\s*=\s*(['"`])(?!\1)[^'"`]+\1/i;

describe("invariant: dashboards never bake a secret into the served artifact", () => {
  it("found dashboard HTML files to scan", () => {
    expect(HTML_FILES.length).toBeGreaterThan(0);
  });

  for (const file of HTML_FILES) {
    const html = readFileSync(join(DASHBOARD_DIR, file), "utf8");

    it(`${file} does not assign a hardcoded *_SECRET literal`, () => {
      const m = html.match(HARDCODED_SECRET);
      expect(m, m ? `hardcoded secret in ${file}: ${m[0]}` : undefined).toBeNull();
    });

    it(`${file} does not contain the known leaked default 'zenith-cron-secret'`, () => {
      expect(html.includes("zenith-cron-secret")).toBe(false);
    });

    if (html.includes("X-Cron-Secret")) {
      it(`${file} sources the cron secret at runtime (sessionStorage), not from a constant`, () => {
        expect(html.includes("sessionStorage")).toBe(true);
      });
    }
  }
});
