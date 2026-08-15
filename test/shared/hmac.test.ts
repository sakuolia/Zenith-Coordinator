/**
 * @file Unit tests for src/shared/hmac.ts
 *
 * Uses the Web Crypto API available in Node 18+ (globalThis.crypto.subtle).
 */
import { describe, it, expect } from "vitest";
import { signPayload, verifySignature, sha256hex, timingSafeEqualStr } from "../../src/shared/hmac";

const SECRET = "test-secret-key";

describe("sha256hex", () => {
  it("returns a 64-character lowercase hex string", async () => {
    const hash = await sha256hex("hello");
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it("is deterministic for the same input", async () => {
    const h1 = await sha256hex("zenith");
    const h2 = await sha256hex("zenith");
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different inputs", async () => {
    const h1 = await sha256hex("abc");
    const h2 = await sha256hex("def");
    expect(h1).not.toBe(h2);
  });

  it('matches the system SHA-256 of "abc" (cross-checked with openssl)', async () => {
    // openssl sha256 <(echo -n "abc") on this system returns:
    // ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    const hash = await sha256hex("abc");
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("signPayload", () => {
  it("returns a 64-character hex HMAC", async () => {
    const sig = await signPayload({ txid: "TX-001", amount: 1000 }, SECRET);
    expect(sig).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(sig)).toBe(true);
  });

  it("is deterministic for identical payloads", async () => {
    const payload = { txid: "TX-002", amount: 5000 };
    const s1 = await signPayload(payload, SECRET);
    const s2 = await signPayload(payload, SECRET);
    expect(s1).toBe(s2);
  });

  it("produces different signatures for different secrets", async () => {
    const payload = { txid: "TX-003" };
    const s1 = await signPayload(payload, "secret-a");
    const s2 = await signPayload(payload, "secret-b");
    expect(s1).not.toBe(s2);
  });

  it("accepts a string payload directly", async () => {
    const sig = await signPayload("raw-string-payload", SECRET);
    expect(sig).toHaveLength(64);
  });

  it("JSON-stringifies object payloads", async () => {
    const obj = { key: "value" };
    const direct = await signPayload(JSON.stringify(obj), SECRET);
    const via_obj = await signPayload(obj, SECRET);
    expect(direct).toBe(via_obj);
  });
});

describe("verifySignature", () => {
  it("returns true for a valid signature", async () => {
    const payload = { txid: "TX-010", amount: 999 };
    const sig = await signPayload(payload, SECRET);
    expect(await verifySignature(payload, sig, SECRET)).toBe(true);
  });

  it("returns false for a tampered payload", async () => {
    const payload = { txid: "TX-011", amount: 100 };
    const sig = await signPayload(payload, SECRET);
    const tampered = { txid: "TX-011", amount: 999 };
    expect(await verifySignature(tampered, sig, SECRET)).toBe(false);
  });

  it("returns false for a wrong secret", async () => {
    const payload = { txid: "TX-012" };
    const sig = await signPayload(payload, SECRET);
    expect(await verifySignature(payload, sig, "wrong-secret")).toBe(false);
  });

  it("returns false for a truncated signature (length mismatch)", async () => {
    const payload = { txid: "TX-013" };
    const sig = await signPayload(payload, SECRET);
    const truncated = sig.slice(0, 32);
    expect(await verifySignature(payload, truncated, SECRET)).toBe(false);
  });

  it("returns false for an all-zeros signature", async () => {
    const payload = { txid: "TX-014" };
    const zeroes = "0".repeat(64);
    expect(await verifySignature(payload, zeroes, SECRET)).toBe(false);
  });
});

describe("timingSafeEqualStr", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqualStr("zenith-cron-secret", "zenith-cron-secret")).toBe(true);
  });

  it("returns false for differing strings of the same length", () => {
    expect(timingSafeEqualStr("secret-aaaa", "secret-bbbb")).toBe(false);
  });

  it("returns false on a length mismatch", () => {
    expect(timingSafeEqualStr("short", "longer-secret")).toBe(false);
  });

  it("returns false when one side is empty (fail-closed for unset secrets)", () => {
    expect(timingSafeEqualStr("", "anything")).toBe(false);
    expect(timingSafeEqualStr("anything", "")).toBe(false);
  });

  it("compares every position (a trailing-byte difference is still detected)", () => {
    const a = `${"x".repeat(63)}a`;
    const b = `${"x".repeat(63)}b`;
    expect(timingSafeEqualStr(a, b)).toBe(false);
  });
});
