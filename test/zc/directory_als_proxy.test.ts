/**
 * @file directory_als_proxy.test.ts — coverage for the directory layer that
 *       was previously exercised by no test: ALS alias resolution
 *       (zc/directory/als.ts) and the payment proxy directory
 *       (zc/directory/proxy.ts).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { lookupAlias } from "../../src/zc/directory/als";
import { registerProxy, resolveProxy, deactivateProxy } from "../../src/zc/directory/proxy";

let d1: MockD1Database;
let env: any;

beforeEach(() => {
  ({ d1 } = createTestDb());
  env = { DB: d1 }; // no ALS_KV → exercises the simulated-resolution branch
});

describe("lookupAlias (ALS)", () => {
  it("resolves a payid alias to its mock bank", async () => {
    const r = await lookupAlias("payid:alice@bank", env);
    expect(r).toEqual({ bank_id: "444", account_hash: "hash_for_payid:alice@bank" });
  });

  it("resolves a phone alias and carries a pspr_ref", async () => {
    const r = await lookupAlias("phone:+81-90-0000", env);
    expect(r?.bank_id).toBe("888");
    expect(r?.pspr_ref).toBe("pspr_phone:+81-90-0000");
  });

  it("treats a 10-digit numeric string as bankCode(3)+account", async () => {
    const r = await lookupAlias("0011234567", env);
    expect(r).toEqual({ bank_id: "001", account_hash: "0011234567" });
  });

  it("returns null for an unrecognized alias", async () => {
    expect(await lookupAlias("unknown-thing", env)).toBeNull();
    expect(await lookupAlias("123456789", env)).toBeNull(); // only 9 digits
  });
});

describe("proxy directory", () => {
  const base = {
    proxy_type: "PHONE" as const,
    proxy_value: "+81-90-1234-5678",
    bank_id: "001",
    account_id: "0010000001",
    account_holder_name: "タナカ タロウ",
  };

  it("registers then resolves an active proxy", async () => {
    const row = await registerProxy(d1 as any, base);
    expect(row.is_active).toBe(1);
    expect(row.account_holder_name).toBe("タナカ タロウ");

    const resolved = await resolveProxy(d1 as any, "PHONE", base.proxy_value);
    expect(resolved).toMatchObject({ bank_id: "001", account_id: "0010000001", resolved: true });
  });

  it("defaults account_holder_name to empty string when omitted (matches stored state)", async () => {
    const { account_holder_name, ...noName } = base;
    const row = await registerProxy(d1 as any, noName as any);
    expect(row.account_holder_name).toBe("");
    const resolved = await resolveProxy(d1 as any, "PHONE", base.proxy_value);
    expect(resolved?.account_holder_name).toBe("");
  });

  it("re-registering the same alias upserts in place (stable proxy_id, new target)", async () => {
    const first = await registerProxy(d1 as any, base);
    const second = await registerProxy(d1 as any, {
      ...base,
      bank_id: "002",
      account_id: "0020000009",
    });
    expect(second.proxy_id).toBe(first.proxy_id); // updated, not duplicated
    const resolved = await resolveProxy(d1 as any, "PHONE", base.proxy_value);
    expect(resolved?.bank_id).toBe("002");
    expect(resolved?.account_id).toBe("0020000009");
  });

  it("deactivated proxies stop resolving, and re-registration reactivates them", async () => {
    const row = await registerProxy(d1 as any, base);
    await deactivateProxy(d1 as any, row.proxy_id);
    expect(await resolveProxy(d1 as any, "PHONE", base.proxy_value)).toBeNull();

    await registerProxy(d1 as any, base); // same alias again
    expect(await resolveProxy(d1 as any, "PHONE", base.proxy_value)).not.toBeNull();
  });

  it("resolving an unknown alias returns null", async () => {
    expect(await resolveProxy(d1 as any, "EMAIL", "nobody@nowhere")).toBeNull();
  });
});
