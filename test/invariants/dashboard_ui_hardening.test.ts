/**
 * @file dashboard_ui_hardening.test.ts — Regression guards for three classes
 *       of adversarial UI findings against the operator dashboard
 *       (`src/dashboard/index.html`, `console.html`):
 *
 *   1. Stored/drive-by XSS: `customer_name` (free text, server only checks
 *      non-empty — see teller_api.ts) and `bank_name` (same, see admin.ts)
 *      were interpolated unescaped into `innerHTML`. Any operator viewing a
 *      payee name or bank list could have arbitrary script run in their
 *      session, including reading the sessionStorage CRON_SECRET that gates
 *      every privileged /internal/* operation.
 *   2. Double-submit race: every money-movement button generates a fresh
 *      idempotency_key per click with no disable guard, so two rapid clicks
 *      before the first request resolves are two distinct logical requests —
 *      the backend's idempotency dedup cannot help.
 *   3. Silent amount truncation: `parseInt("9999.99")` silently becomes
 *      9999 with no indication to the operator that what was submitted
 *      differs from what was typed.
 *
 * These tests load the real dashboard source as text, extract the actual
 * fix functions (`esc`, `parseAmount`, `withSubmitGuard`) with `new
 * Function(...)` and execute them directly — not just regex-matching the
 * surrounding markup — plus regex guards against the known-vulnerable raw
 * patterns reappearing at any call site.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_HTML = readFileSync(join("src", "dashboard", "index.html"), "utf8");
const CONSOLE_HTML = readFileSync(join("src", "dashboard", "console.html"), "utf8");

function extractFunction(html: string, signature: string): string {
  const re = new RegExp(`(?:async )?function ${signature}\\s*\\{[\\s\\S]*?\\n\\}`);
  const m = html.match(re);
  if (!m) throw new Error(`function ${signature} not found in source`);
  return m[0];
}

function load<T>(html: string, signature: string, fnName: string): T {
  const src = extractFunction(html, signature);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return ${fnName};`)() as T;
}

describe("invariant: customer_name / bank_name never reach innerHTML unescaped", () => {
  it("index.html defines an esc() helper that HTML-escapes its input", () => {
    const esc = load<(s: unknown) => string>(INDEX_HTML, "esc\\(s\\)", "esc");
    expect(esc(`<img src=x onerror=alert(1)>`)).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(esc(`"'&`)).toBe("&quot;&#39;&amp;");
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
  });

  it("console.html defines an esc() helper that HTML-escapes its input", () => {
    const esc = load<(s: unknown) => string>(CONSOLE_HTML, "esc\\(s\\)", "esc");
    expect(esc(`<img src=x onerror=alert(1)>`)).toBe("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("index.html's bankName() helper escapes the bank_name it returns", () => {
    const src = extractFunction(INDEX_HTML, "bankName\\(id\\)");
    expect(src).toMatch(/esc\(b\.bank_name\)/);
  });

  // Exact substrings that were the actual UI-T1/UI-T2 vulnerable lines
  // before the fix. If any of these reappear verbatim, an interpolation
  // site has regressed back to raw, unescaped customer_name/bank_name.
  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: matching literal HTML source text, not building a template string
  const knownVulnerableRawPatterns = [
    "${r.customer_name}",
    "${a.customer_name}",
    "(${r.bank_name})",
    "${b.bank_name}",
    "${bank.bank_name || bank.bank_id}",
  ];
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: matching literal HTML source text, not building a template string

  for (const pattern of knownVulnerableRawPatterns) {
    it(`index.html no longer contains the unescaped pattern ${JSON.stringify(pattern)}`, () => {
      expect(INDEX_HTML.includes(pattern)).toBe(false);
    });
  }

  it("console.html no longer contains the unescaped liquidity-gauge bank_name pattern", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching literal HTML source text, not building a template string
    expect(CONSOLE_HTML.includes("${bank.bank_name || bank.bank_id}")).toBe(false);
    expect(CONSOLE_HTML).toMatch(/\$\{esc\(bank\.bank_name \|\| bank\.bank_id\)\}/);
  });

  it("index.html's customer_name lookup spans (lookupName/htlcLookupName/GTID) are escaped", () => {
    const occurrences = INDEX_HTML.match(/\$\{esc\(r\.customer_name\)\}/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2); // doTransfer + createHtlc payee lookups
    expect(INDEX_HTML).toMatch(
      /r\.customer_name \? `<span class="text-emerald-600">\$\{esc\(r\.customer_name\)\}/
    );
  });
});

describe("invariant: every money-movement button disables itself for the duration of its handler", () => {
  const guardedHandlers = [
    "doTransfer",
    "doCash",
    "createHtlc",
    "doGtid",
    "doQrPay",
    "doCrossBorderSend",
    "createAcct",
  ];

  it("withSubmitGuard() is defined in index.html", () => {
    expect(INDEX_HTML).toMatch(/async function withSubmitGuard\(evt, fn\)/);
  });

  for (const handler of guardedHandlers) {
    it(`${handler}(...) is only ever invoked through withSubmitGuard(event, ...) from onclick`, () => {
      const bareOnclick = new RegExp(`onclick="${handler}\\(`);
      expect(INDEX_HTML).not.toMatch(bareOnclick);
      const guarded = new RegExp(`onclick="withSubmitGuard\\(event, \\(\\) => ${handler}\\(`);
      expect(INDEX_HTML).toMatch(guarded);
    });
  }

  it("withSubmitGuard actually disables the button and re-enables it only after the handler settles", async () => {
    const withSubmitGuard = load<
      (evt: { currentTarget: { disabled: boolean } }, fn: () => Promise<void>) => Promise<void>
    >(INDEX_HTML, "withSubmitGuard\\(evt, fn\\)", "withSubmitGuard");

    const btn = { disabled: false };
    let calls = 0;
    let release!: () => void;
    const slowHandler = () =>
      new Promise<void>((resolve) => {
        calls++;
        release = resolve;
      });

    const firstClick = withSubmitGuard({ currentTarget: btn }, slowHandler);
    expect(btn.disabled).toBe(true);

    // Second rapid click while the first request is still in flight (the
    // exact scenario from UI-T3) must not invoke the handler again.
    const secondClick = withSubmitGuard({ currentTarget: btn }, slowHandler);
    expect(calls).toBe(1);

    release();
    await firstClick;
    await secondClick;
    expect(btn.disabled).toBe(false);
  });

  it("withSubmitGuard re-enables the button even when the handler throws", async () => {
    const withSubmitGuard = load<
      (evt: { currentTarget: { disabled: boolean } }, fn: () => Promise<void>) => Promise<void>
    >(INDEX_HTML, "withSubmitGuard\\(evt, fn\\)", "withSubmitGuard");

    const btn = { disabled: false };
    await expect(
      withSubmitGuard({ currentTarget: btn }, () => Promise.reject(new Error("boom")))
    ).rejects.toThrow("boom");
    expect(btn.disabled).toBe(false);
  });
});

describe("invariant: real-money amount fields reject non-integer input instead of silently truncating it", () => {
  it("parseAmount() is defined in index.html and rejects decimals/garbage", () => {
    const parseAmount = load<(v: unknown) => number>(
      INDEX_HTML,
      "parseAmount\\(v\\)",
      "parseAmount"
    );
    expect(parseAmount("9999")).toBe(9999);
    expect(parseAmount("  123  ")).toBe(123);
    expect(Number.isNaN(parseAmount("9999.99"))).toBe(true); // the exact UI-T4 payload
    expect(Number.isNaN(parseAmount("abc"))).toBe(true);
    expect(Number.isNaN(parseAmount(""))).toBe(true);
    expect(Number.isNaN(parseAmount("-5"))).toBe(true);
    expect(Number.isNaN(parseAmount("1e3"))).toBe(true);
  });

  // Exact call sites that used to silently truncate via parseInt() before
  // the fix. Each must now route through parseAmount() instead.
  const fixedAmountSites = [
    { bad: "parseInt(document.getElementById('txAmount').value)", label: "doTransfer" },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching literal HTML source text, not building a template string
    { bad: "parseInt(document.getElementById(`cash-${bankId}-amt`).value)", label: "doCash" },
    { bad: "parseInt(document.getElementById('htlcAmt').value)", label: "createHtlc" },
    { bad: "parseInt(document.getElementById('fxQAmount').value, 10)", label: "doFxQuote" },
    { bad: "parseInt(document.getElementById('qrAmt')?.value)", label: "doQrGenerate" },
    { bad: "parseInt(document.getElementById('qrPayAmt')?.value)", label: "doQrPay" },
    { bad: "parseInt(document.getElementById('cbAmt').value)", label: "doCrossBorderSend" },
  ];

  for (const { bad, label } of fixedAmountSites) {
    it(`${label}'s amount field no longer parses with bare parseInt()`, () => {
      expect(INDEX_HTML.includes(bad)).toBe(false);
    });
  }

  it("GTID leg amounts are validated and summed with parseAmount(), not parseInt()", () => {
    expect(INDEX_HTML.includes("parseInt(leg.amount)")).toBe(false);
    expect(INDEX_HTML).toMatch(/parseAmount\(leg\.amount\)/);
  });
});

describe("invariant: cross-border amounts are parsed in the selected currency's minor unit, not silently mangled or rate-inflated", () => {
  function loadParseCurrencyAmount(): (v: unknown, currency: string) => number {
    const constMatch = INDEX_HTML.match(/const CURRENCY_DECIMAL_PLACES = \{[^}]*\};/);
    if (!constMatch) throw new Error("CURRENCY_DECIMAL_PLACES not found in source");
    const fnSrc = extractFunction(INDEX_HTML, "parseCurrencyAmount\\(v, currency\\)");
    // eslint-disable-next-line no-new-func
    return new Function(`${constMatch[0]}\n${fnSrc}; return parseCurrencyAmount;`)() as (
      v: unknown,
      currency: string
    ) => number;
  }

  it("parseCurrencyAmount() converts a decimal major-unit string to an integer minor-unit count", () => {
    const parseCurrencyAmount = loadParseCurrencyAmount();
    expect(parseCurrencyAmount("100.50", "USD")).toBe(10_050); // the exact $100.50 case
    expect(parseCurrencyAmount("100.5", "USD")).toBe(10_050); // single-digit fraction is zero-padded, not misread
    expect(parseCurrencyAmount("100", "USD")).toBe(10_000);
    expect(parseCurrencyAmount("200.00", "EUR")).toBe(20_000);
  });

  it("parseCurrencyAmount() rejects a decimal point for JPY, which has no minor unit", () => {
    const parseCurrencyAmount = loadParseCurrencyAmount();
    expect(parseCurrencyAmount("50000", "JPY")).toBe(50_000);
    expect(Number.isNaN(parseCurrencyAmount("500.00", "JPY"))).toBe(true);
  });

  it("parseCurrencyAmount() rejects more fractional digits than the currency supports, garbage, and negatives", () => {
    const parseCurrencyAmount = loadParseCurrencyAmount();
    expect(Number.isNaN(parseCurrencyAmount("100.999", "USD"))).toBe(true);
    expect(Number.isNaN(parseCurrencyAmount("abc", "USD"))).toBe(true);
    expect(Number.isNaN(parseCurrencyAmount("", "USD"))).toBe(true);
    expect(Number.isNaN(parseCurrencyAmount("-5", "USD"))).toBe(true);
  });

  it("doCrossBorderSend() reads the selected currency before parsing the amount, via parseCurrencyAmount() not parseAmount()", () => {
    expect(INDEX_HTML).toMatch(
      /const foreignCur = document\.getElementById\('cbCur'\)\.value;\s*\n\s*const foreignAmt = parseCurrencyAmount\(document\.getElementById\('cbAmt'\)\.value, foreignCur\);/
    );
  });
});
