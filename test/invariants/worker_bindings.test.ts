/**
 * @file worker_bindings.test.ts — every infrastructure binding the code reaches
 *       for is declared in the deployment configuration.
 *
 * `Env` types its Cloudflare resources with `?:` (`ALS_KV`, `STREAM_DO`,
 * `R2_BUCKET`). That is correct at the type level — a Worker really can boot
 * without a binding, and the code degrades deliberately when one is absent
 * (`als.ts` falls back to an uncached lookup, `richdata.ts` stores inline,
 * `/api/stream/connect` answers 500). What it must not mean is that a
 * *deployment* silently runs in the degraded mode: the optional marker made the
 * missing declaration invisible, and `ALS_KV` was in fact absent from
 * `wrangler.toml.example` entirely while `als.ts` read from it.
 *
 * So the optionality stays in the type and the completeness is enforced here,
 * against the shipped configuration: a resource-typed field on `Env` is a claim
 * that the platform provides it, and this test makes the claim checkable.
 * Adding a binding to `Env` without declaring it fails the build, which is the
 * only moment anyone is in a position to fix it.
 *
 * Scope is infrastructure bindings only (D1 / Queue / R2 / KV / Durable
 * Objects). Secrets and plain `vars` are deliberately out: `ZC_SIGNING_KEY_PKCS8`
 * belongs in a secret store and must NOT appear in a committed toml.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const primitives = readFileSync(join(ROOT, "src/types/primitives.ts"), "utf8");
const wrangler = readFileSync(join(ROOT, "wrangler.toml.example"), "utf8");

/** Cloudflare resource types — a field of one of these is a platform binding. */
const RESOURCE_TYPES = [
  "D1Database",
  "Queue",
  "R2Bucket",
  "KVNamespace",
  "DurableObjectNamespace",
  "Fetcher",
  "AnalyticsEngineDataset",
];

/** Binding names declared on the `Env` interface, with their resource type. */
function declaredBindings(): Array<{ name: string; type: string }> {
  const from = primitives.indexOf("export interface Env {");
  expect(from, "Env interface not found in src/types/primitives.ts").toBeGreaterThan(-1);
  const body = primitives.slice(from, primitives.indexOf("\n}", from));
  const out: Array<{ name: string; type: string }> = [];
  for (const m of body.matchAll(/^\s*(\w+)\??:\s*(\w+)[;<]/gm)) {
    if (RESOURCE_TYPES.includes(m[2]!)) out.push({ name: m[1]!, type: m[2]! });
  }
  return out;
}

/**
 * Binding names declared in the deployment config. D1/Queues/R2/KV name the
 * binding with `binding =`; Durable Objects use `name =`.
 */
function configuredBindings(): Set<string> {
  const names = new Set<string>();
  for (const m of wrangler.matchAll(/^\s*(?:binding|name)\s*=\s*"([^"]+)"/gm)) names.add(m[1]!);
  // `queues.producers` names its binding with `binding =` too, but the consumer
  // block repeats the queue name — harmless, it is a superset check.
  return names;
}

describe("worker bindings: Env resources are declared in wrangler.toml.example", () => {
  it("finds the resource-typed fields on Env", () => {
    const found = declaredBindings().map((b) => b.name);
    // A parse that silently matches nothing would make the check below vacuous.
    expect(found).toContain("DB");
    expect(found).toContain("ALS_KV");
    expect(found).toContain("STREAM_DO");
  });

  it("every resource-typed Env field has a binding in the deployment config", () => {
    const configured = configuredBindings();
    const missing = declaredBindings()
      .filter((b) => !configured.has(b.name))
      .map((b) => `${b.name}: ${b.type}`);
    expect(
      missing.join(", "),
      "bindings the code reads but the deployment config does not provide — " +
        "declare them in wrangler.toml.example (a deployment must not run in the " +
        "degraded no-binding mode by accident)"
    ).toBe("");
  });
});
