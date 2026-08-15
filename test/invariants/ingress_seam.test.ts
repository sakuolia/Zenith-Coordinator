/**
 * @file ingress_seam.test.ts — structural guards on the ZC→Bank ingress seam.
 *
 * `account-verify` shipped broken because the caller and the handler each
 * declared the command's body, under different field names, and the compiler had
 * no way to see it: both names existed somewhere in `src/`, and the only test
 * drove the caller's own assumption. The fix was structural — one declaration
 * per command in `src/types/api/bank-ingress.ts`, imported by both ends, and a
 * dispatch table typed by `BankIngressRequestMap` — and this file is what keeps
 * it structural:
 *
 *  1. **Declaration uniqueness** — no ingress command body is declared twice.
 *  2. **Dispatch completeness** — every command in the registry reaches a
 *     handler, and nothing outside the registry does.
 *
 * The per-command round trips live in `test/integration/ingress_commands.test.ts`:
 * this file checks the shape of the seam, that one checks it carries traffic.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createTestDb } from "../helpers/d1-mock";
import { BANK_INGRESS_COMMANDS } from "../../src/types";
import { handleBankIngress } from "../../src/bank/ingress";

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// 1. One declaration per command body
// ---------------------------------------------------------------------------
describe("each ingress command body is declared exactly once", () => {
  const sources = (dir: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) sources(join(dir, e.name), acc);
      else if (e.name.endsWith(".ts")) acc.push(join(dir, e.name));
    }
    return acc;
  };

  it("no interface name for an ingress body is declared in two files", () => {
    const declarations = new Map<string, string[]>();
    for (const rel of sources("src")) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      for (const m of text.matchAll(/export interface (Bank\w*(?:Request|Response))\b/g)) {
        declarations.set(m[1]!, [...(declarations.get(m[1]!) ?? []), rel]);
      }
    }
    const duplicated = [...declarations.entries()].filter(([, files]) => files.length > 1);
    expect(duplicated.map(([n, f]) => `${n}: ${f.join(", ")}`).join("\n")).toBe("");
  });

  it("the ingress handlers take their body types from the shared module", () => {
    // A handler that declares its own body type is how the two ends drifted:
    // the caller kept using the shared one and nothing compared them. This now
    // covers every ingress body, not only the `*IngressRequest` spelling —
    // `BankDebitSettledRequest` and `BankInitializeRequest` were declared beside
    // their handlers under names the old pattern did not match.
    const offenders: string[] = [];
    for (const rel of sources("src/bank/ingress")) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      for (const m of text.matchAll(/export interface (Bank\w*Request)\b/g)) {
        offenders.push(`${rel}: ${m[1]}`);
      }
    }
    expect(
      offenders.join("\n"),
      "declare ingress bodies in src/types/api/bank-ingress.ts so both ends share one type"
    ).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 2. Dispatch completeness
//
// Checked by dispatching, not by grepping the dispatcher for `case` labels: a
// guard that reads the implementation's syntax breaks when the implementation is
// refactored and proves nothing about behaviour either way.
// ---------------------------------------------------------------------------
describe("the dispatcher covers exactly the registry", () => {
  /**
   * Send a command with an empty body and report whether it was *routed*. A
   * handler that throws or rejects the body was still reached — only
   * UNKNOWN_COMMAND means the dispatcher had nowhere to send it.
   */
  async function isRouted(command: string): Promise<boolean> {
    const { d1 } = createTestDb();
    const env = { DB: d1, ZC_HMAC_SECRET: "s" } as never;
    try {
      const resp = (await handleBankIngress("001", command, {}, env)) as {
        reason_code?: string;
      } | null;
      return resp?.reason_code !== "UNKNOWN_COMMAND";
    } catch {
      return true; // reached a handler, which then objected to the empty body
    }
  }

  it("every command in the registry reaches a handler", async () => {
    const unrouted: string[] = [];
    for (const command of BANK_INGRESS_COMMANDS) {
      if (!(await isRouted(command))) unrouted.push(command);
    }
    expect(unrouted.join(", ")).toBe("");
  });

  it("a command outside the registry is refused", async () => {
    for (const command of ["reserve-funds-v2", "", "execute", "constructor", "toString"]) {
      expect(await isRouted(command), `dispatcher routed '${command}'`).toBe(false);
    }
  });

  it("the registry is the thirteen commands of 10_requirements.md §7.2.1", () => {
    expect(BANK_INGRESS_COMMANDS).toHaveLength(13);
    expect(new Set(BANK_INGRESS_COMMANDS).size).toBe(13);
  });
});
