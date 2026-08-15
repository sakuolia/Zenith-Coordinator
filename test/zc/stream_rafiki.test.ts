/**
 * @file Tests for the Rafiki / Interledger STREAM micro-payment Durable Object.
 *
 * Drives the DO through its hibernation WebSocket handlers (bypassing the real
 * WebSocketPair) with a fake socket, and verifies:
 * - the ILP condition/fulfillment handshake (correct → fulfill, forged → F05)
 * - amount validation (positive, within per-packet max)
 * - replay protection (a stale sequence is never double-counted)
 * - batch flush integrity: the alarm commits to the Finality Log, only resets
 *   what it flushed, and never drops funds when the flush throws.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { StreamDO } from "../../src/zc/events/stream_rafiki";

// ---------------------------------------------------------------------------
// Minimal DurableObjectState + WebSocket mocks
// ---------------------------------------------------------------------------

function makeState() {
  const storage = new Map<string, unknown>();
  let alarm: number | null = null;
  const sockets: unknown[] = [];
  return {
    sockets,
    storage: {
      get: async <T>(k: string) => storage.get(k) as T | undefined,
      put: async (k: string, v: unknown) => void storage.set(k, v),
      getAlarm: async () => alarm,
      setAlarm: async (t: number) => void (alarm = t),
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    acceptWebSocket: (ws: unknown) => void sockets.push(ws),
    getWebSockets: () => sockets,
  };
}

function makeSocket() {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    send: (s: string) => void sent.push(JSON.parse(s)),
    close: () => {},
    last: () => sent[sent.length - 1],
  };
}

// Sender-side mirror of the receiver's derivation, used to forge a *valid*
// condition for a packet given the connection's shared secret.
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function conditionFor(sharedSecret: string, sequence: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    fromB64url(sharedSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const fulfillment = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(sequence)))
  );
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", fulfillment)));
}

let d1: MockD1Database;
beforeEach(() => {
  d1 = createTestDb().d1;
});

async function countFlushes() {
  const rows = (await d1
    .prepare("SELECT payload_json FROM FinalityLog WHERE event_type = 'StreamingBatchFlush'")
    .all()) as unknown as { results: { payload_json: string }[] };
  return rows.results.map((r) => JSON.parse(r.payload_json));
}

describe("StreamDO — ILP STREAM handshake & integrity", () => {
  it("fulfills a correctly-conditioned packet and accumulates the amount", async () => {
    const state = makeState();
    const env = { DB: d1 } as never;
    const doInstance = new StreamDO(state as never, env);
    const ws = makeSocket();

    await doInstance.webSocketMessage(ws as never, JSON.stringify({ type: "connect" }));
    const ack = ws.last() as { type: string; sharedSecret: string };
    expect(ack.type).toBe("connection_ack");
    expect(ack.sharedSecret).toBeTruthy();

    const cond = await conditionFor(ack.sharedSecret, 0);
    await doInstance.webSocketMessage(
      ws as never,
      JSON.stringify({ type: "prepare", sequence: 0, amount: "150", executionCondition: cond })
    );
    expect(ws.last()).toMatchObject({ type: "fulfill", sequence: 0 });

    // Flush and confirm the balance landed in the Finality Log.
    await doInstance.alarm();
    const flushes = await countFlushes();
    expect(flushes).toHaveLength(1);
    expect(flushes[0].flushed_minor).toBe("150");
    expect(flushes[0].packets).toBe(1);
  });

  it("rejects a forged condition (F05) and never counts it", async () => {
    const state = makeState();
    const doInstance = new StreamDO(state as never, { DB: d1 } as never);
    const ws = makeSocket();
    await doInstance.webSocketMessage(ws as never, JSON.stringify({ type: "connect" }));

    await doInstance.webSocketMessage(
      ws as never,
      JSON.stringify({
        type: "prepare",
        sequence: 0,
        amount: "999",
        executionCondition: b64url(new Uint8Array(32)),
      })
    );
    expect(ws.last()).toMatchObject({ type: "reject", code: "F05" });

    await doInstance.alarm();
    expect(await countFlushes()).toHaveLength(0);
  });

  it("rejects replayed/stale sequences (F99) without double-counting", async () => {
    const state = makeState();
    const doInstance = new StreamDO(state as never, { DB: d1 } as never);
    const ws = makeSocket();
    await doInstance.webSocketMessage(ws as never, JSON.stringify({ type: "connect" }));
    const ack = ws.last() as { sharedSecret: string };

    const c1 = await conditionFor(ack.sharedSecret, 1);
    await doInstance.webSocketMessage(
      ws as never,
      JSON.stringify({ type: "prepare", sequence: 1, amount: "100", executionCondition: c1 })
    );
    expect(ws.last()).toMatchObject({ type: "fulfill" });

    // Replay sequence 1 — even with a valid condition it must be refused.
    await doInstance.webSocketMessage(
      ws as never,
      JSON.stringify({ type: "prepare", sequence: 1, amount: "100", executionCondition: c1 })
    );
    expect(ws.last()).toMatchObject({ type: "reject", code: "F99" });

    await doInstance.alarm();
    expect((await countFlushes())[0].flushed_minor).toBe("100");
  });

  it("rejects oversized and non-positive amounts", async () => {
    const state = makeState();
    const doInstance = new StreamDO(state as never, { DB: d1 } as never);
    const ws = makeSocket();
    await doInstance.webSocketMessage(ws as never, JSON.stringify({ type: "connect" }));
    const ack = ws.last() as { sharedSecret: string };

    const big = await conditionFor(ack.sharedSecret, 0);
    await doInstance.webSocketMessage(
      ws as never,
      JSON.stringify({
        type: "prepare",
        sequence: 0,
        amount: "9999999999",
        executionCondition: big,
      })
    );
    expect(ws.last()).toMatchObject({ type: "reject", code: "F08" });

    const neg = await conditionFor(ack.sharedSecret, 1);
    await doInstance.webSocketMessage(
      ws as never,
      JSON.stringify({ type: "prepare", sequence: 1, amount: "-5", executionCondition: neg })
    );
    expect(ws.last()).toMatchObject({ type: "reject", code: "F00" });
  });

  it("does not drop funds when the flush fails, and retries on the next alarm", async () => {
    const state = makeState();
    // A DB whose first flush throws (simulated outage); we later swap in the
    // working DB to prove the preserved balance still commits.
    const throwingDb = {
      prepare: () => {
        throw new Error("simulated D1 outage");
      },
    };

    const doInstance = new StreamDO(state as never, { DB: throwingDb } as never);
    const ws = makeSocket();
    await doInstance.webSocketMessage(ws as never, JSON.stringify({ type: "connect" }));
    const ack = ws.last() as { sharedSecret: string };
    const cond = await conditionFor(ack.sharedSecret, 0);
    await doInstance.webSocketMessage(
      ws as never,
      JSON.stringify({ type: "prepare", sequence: 0, amount: "250", executionCondition: cond })
    );

    // First flush throws — balance must be preserved, nothing committed.
    await doInstance.alarm();
    expect(await countFlushes()).toHaveLength(0);

    // Swap in the working DB and flush again: the 250 is still there.
    (doInstance as never as { env: { DB: unknown } }).env.DB = d1;
    await doInstance.alarm();
    const flushes = await countFlushes();
    expect(flushes).toHaveLength(1);
    expect(flushes[0].flushed_minor).toBe("250");
  });
});
