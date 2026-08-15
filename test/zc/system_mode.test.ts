/**
 * @file Unit tests for src/zc/platform/system_mode.ts (ZC-wide BCP degradation mode, テーマ H).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  getSystemMode,
  assertWritable,
  activateBcpReadOnly,
  deactivateBcpReadOnly,
} from "../../src/zc/platform/system_mode";
import { DomainError } from "../../src/shared/errors";

function makeEnv(db: MockD1Database): any {
  return { DB: db };
}

let d1: MockD1Database;

beforeEach(() => {
  d1 = createTestDb().d1;
});

describe("getSystemMode", () => {
  it("defaults to NORMAL", async () => {
    const mode = await getSystemMode(d1 as any);
    expect(mode.mode).toBe("NORMAL");
    expect(mode.reason).toBeNull();
    expect(mode.activated_at).toBeNull();
  });
});

describe("activateBcpReadOnly / deactivateBcpReadOnly", () => {
  it("activates BCP_READONLY with a reason and persists it", async () => {
    const env = makeEnv(d1);
    const mode = await activateBcpReadOnly(env, "Cloudflare regional outage");

    expect(mode.mode).toBe("BCP_READONLY");
    expect(mode.reason).toBe("Cloudflare regional outage");
    expect(mode.activated_at).toBeTruthy();

    const persisted = await getSystemMode(d1 as any);
    expect(persisted.mode).toBe("BCP_READONLY");
    expect(persisted.reason).toBe("Cloudflare regional outage");
  });

  it("writes a FinalityLog GLOBAL chain entry on activation", async () => {
    const env = makeEnv(d1);
    await activateBcpReadOnly(env, "Cloudflare regional outage");

    const row = await d1
      .prepare(
        `SELECT * FROM FinalityLog WHERE event_type = 'SystemBcpActivated' AND txid IS NULL AND gtid IS NULL`
      )
      .first<{ state_from: string; state_to: string; payload_json: string }>();
    expect(row).toBeTruthy();
    expect(row!.state_from).toBe("NORMAL");
    expect(row!.state_to).toBe("BCP_READONLY");
    expect(JSON.parse(row!.payload_json)).toEqual({
      reason: "Cloudflare regional outage",
      previous_reason: null,
    });
  });

  it("is idempotent: re-activating while already BCP_READONLY does not write a second FinalityLog entry", async () => {
    const env = makeEnv(d1);
    await activateBcpReadOnly(env, "first reason");
    await activateBcpReadOnly(env, "second reason");

    const rows = await d1
      .prepare(`SELECT * FROM FinalityLog WHERE event_type = 'SystemBcpActivated'`)
      .all();
    expect(rows.results).toHaveLength(1);

    const mode = await getSystemMode(d1 as any);
    expect(mode.reason).toBe("first reason");
  });

  it("deactivates BCP_READONLY back to NORMAL and logs the transition", async () => {
    const env = makeEnv(d1);
    await activateBcpReadOnly(env, "vendor outage");

    const mode = await deactivateBcpReadOnly(env);
    expect(mode.mode).toBe("NORMAL");
    expect(mode.reason).toBeNull();
    expect(mode.activated_at).toBeNull();

    const persisted = await getSystemMode(d1 as any);
    expect(persisted.mode).toBe("NORMAL");

    const row = await d1
      .prepare(
        `SELECT * FROM FinalityLog WHERE event_type = 'SystemBcpDeactivated' AND txid IS NULL AND gtid IS NULL`
      )
      .first<{ state_from: string; state_to: string }>();
    expect(row).toBeTruthy();
    expect(row!.state_from).toBe("BCP_READONLY");
    expect(row!.state_to).toBe("NORMAL");
  });

  it("is idempotent: deactivating while already NORMAL does not write a FinalityLog entry", async () => {
    const env = makeEnv(d1);
    await deactivateBcpReadOnly(env);

    const rows = await d1
      .prepare(`SELECT * FROM FinalityLog WHERE event_type = 'SystemBcpDeactivated'`)
      .all();
    expect(rows.results).toHaveLength(0);
  });

  it("round-trip: activate then assertWritable throws, deactivate then it does not", async () => {
    const env = makeEnv(d1);
    await activateBcpReadOnly(env, "maintenance");
    let mode = await getSystemMode(d1 as any);
    expect(() => assertWritable(mode)).toThrow(DomainError);

    await deactivateBcpReadOnly(env);
    mode = await getSystemMode(d1 as any);
    expect(() => assertWritable(mode)).not.toThrow();
  });
});
