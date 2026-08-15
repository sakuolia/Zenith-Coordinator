/**
 * @file stream_rafiki.ts — Rafiki / Interledger STREAM-style micro-payment Durable Object.
 *
 * Models an Interledger (ILP) STREAM receiver over a *hibernatable* WebSocket.
 * High-frequency `prepare` packets — each carrying an integer amount in the
 * asset's minor units plus a SHA-256 execution *condition* — are validated,
 * fulfilled (the receiver returns the matching *fulfillment* preimage), and
 * accumulated inside the Durable Object. A self-rescheduling alarm
 * batch-commits the running total to the D1 Finality Log, amortising D1 writes
 * across thousands of packets and bypassing per-request execution limits.
 *
 * Wire protocol (JSON frames over one WebSocket, mirroring ILP/STREAM):
 *   client → connect  { assetCode?, assetScale?, gtid? }
 *   server → connection_ack { connectionId, gtid, assetCode, assetScale,
 *                             maxPacketAmount, sharedSecret }
 *   client → prepare  { sequence, amount, executionCondition }
 *   server → fulfill  { sequence, fulfillment }      // condition satisfied
 *          | reject   { sequence, code, message }     // ILP error code (Fxx/Txx)
 *
 * The condition/fulfillment pair is authentic ILP: the fulfillment is
 * HMAC-SHA256(sharedSecret, sequence) and the condition is SHA-256(fulfillment).
 * Only a peer holding the STREAM `sharedSecret` can compute a condition the
 * receiver will fulfill, so forged or replayed packets are rejected (F05/F99)
 * and never counted.
 */
import type { Env } from "../../types";
import { newUUID } from "../../shared/idempotency";
import { writeFinalityLog } from "../orchestrator";

/** How often the alarm flushes the accumulated balance to the Finality Log. */
const FLUSH_INTERVAL_MS = 10_000;

/** Per-packet ceiling, in minor units (uint64 carried as a decimal string). */
const MAX_PACKET_AMOUNT = "1000000000";

/** ILP reject codes used by this receiver (subset of the Fxx/Txx registry). */
const REJECT = {
  /** Sender error: malformed/invalid request that should not be retried. */
  BAD_REQUEST: "F00",
  /** The ILP packet itself could not be parsed. */
  INVALID_PACKET: "F01",
  /** The provided condition does not match what the receiver expects. */
  WRONG_CONDITION: "F05",
  /** Amount exceeds the negotiated per-packet maximum. */
  AMOUNT_TOO_LARGE: "F08",
  /** Generic application error (used here for replay / stale sequence). */
  APPLICATION_ERROR: "F99",
  /** Transient receiver-side failure; the sender may retry. */
  INTERNAL_ERROR: "T00",
} as const;

/** Durable, hibernation-surviving snapshot of the STREAM connection. */
interface StreamState {
  gtid: string | null;
  connectionId: string | null;
  assetCode: string;
  assetScale: number;
  sharedSecretB64: string | null;
  /** Balance pending flush, in minor units (decimal string of a bigint). */
  accumulatedMinor: string;
  /** Highest fulfilled packet sequence — guards against replay/double-count. */
  lastSequence: number;
  /** Packets fulfilled since the last successful flush (for the audit payload). */
  packetsSinceFlush: number;
}

export class StreamDO {
  private state: DurableObjectState;
  private env: Env;

  private gtid: string | null = null;
  private connectionId: string | null = null;
  private assetCode = "JPY";
  private assetScale = 0;
  private sharedSecretB64: string | null = null;
  private accumulatedMinor = "0";
  private lastSequence = -1;
  private packetsSinceFlush = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<StreamState>("stream_state");
      if (stored) {
        this.gtid = stored.gtid;
        this.connectionId = stored.connectionId;
        this.assetCode = stored.assetCode;
        this.assetScale = stored.assetScale;
        this.sharedSecretB64 = stored.sharedSecretB64;
        this.accumulatedMinor = stored.accumulatedMinor;
        this.lastSequence = stored.lastSequence;
        this.packetsSinceFlush = stored.packetsSinceFlush;
      }
    });
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();

    // Hibernation API: the runtime persists the socket and re-delivers messages
    // to webSocketMessage() even after the DO is evicted from memory.
    this.state.acceptWebSocket(server);

    // Arm the flush alarm if it isn't already pending.
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------
  // Hibernation WebSocket handlers
  // -------------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      frame = JSON.parse(text);
    } catch {
      this.send(ws, { type: "reject", code: REJECT.INVALID_PACKET, message: "malformed frame" });
      return;
    }

    try {
      switch (frame.type) {
        case "connect":
          await this.handleConnect(ws, frame);
          return;
        case "prepare":
          await this.handlePrepare(ws, frame);
          return;
        default:
          this.send(ws, {
            type: "reject",
            code: REJECT.BAD_REQUEST,
            message: `unknown frame type: ${String(frame.type)}`,
          });
      }
    } catch (e) {
      console.error("[StreamDO] handler error", e);
      this.send(ws, {
        type: "reject",
        sequence: typeof frame.sequence === "number" ? frame.sequence : undefined,
        code: REJECT.INTERNAL_ERROR,
        message: "internal error",
      });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Acknowledge the close; any pending balance is still flushed by the alarm.
    try {
      ws.close(code, reason);
    } catch {
      // socket may already be closed — nothing to do
    }
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error("[StreamDO] websocket error", error);
  }

  // -------------------------------------------------------------------------
  // Frame handlers
  // -------------------------------------------------------------------------

  /** Establish (or resume) a STREAM connection and hand back the shared secret. */
  private async handleConnect(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
    if (!this.gtid) {
      const requested = typeof frame.gtid === "string" && frame.gtid ? frame.gtid : null;
      this.gtid = requested ?? `STREAM-${newUUID()}`;
    }
    if (!this.connectionId) this.connectionId = newUUID();
    if (!this.sharedSecretB64) {
      this.sharedSecretB64 = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
    }
    if (typeof frame.assetCode === "string" && frame.assetCode) this.assetCode = frame.assetCode;
    if (Number.isInteger(frame.assetScale)) this.assetScale = frame.assetScale as number;

    await this.persist();

    this.send(ws, {
      type: "connection_ack",
      connectionId: this.connectionId,
      gtid: this.gtid,
      assetCode: this.assetCode,
      assetScale: this.assetScale,
      maxPacketAmount: MAX_PACKET_AMOUNT,
      sharedSecret: this.sharedSecretB64,
    });
  }

  /** Validate and fulfill (or reject) a single STREAM prepare packet. */
  private async handlePrepare(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const sequence = frame.sequence;
    const reject = (code: string, message: string) =>
      this.send(ws, {
        type: "reject",
        sequence: typeof sequence === "number" ? sequence : undefined,
        code,
        message,
      });

    if (!this.gtid || !this.sharedSecretB64) {
      return reject(REJECT.BAD_REQUEST, "no STREAM connection; send connect first");
    }
    if (!Number.isInteger(sequence) || (sequence as number) < 0) {
      return reject(REJECT.INVALID_PACKET, "invalid sequence");
    }
    const seq = sequence as number;
    // Strictly-increasing sequence: replays and stale packets are never counted.
    if (seq <= this.lastSequence) {
      return reject(REJECT.APPLICATION_ERROR, "duplicate or stale sequence");
    }

    // Amounts are uint64 minor units carried as a decimal string.
    let amount: bigint;
    try {
      amount = BigInt(String(frame.amount));
    } catch {
      return reject(REJECT.BAD_REQUEST, "amount must be an integer");
    }
    if (amount <= 0n) return reject(REJECT.BAD_REQUEST, "amount must be positive");
    if (amount > BigInt(MAX_PACKET_AMOUNT))
      return reject(REJECT.AMOUNT_TOO_LARGE, "amount too large");

    // Authentic ILP condition check: the receiver derives the fulfillment from
    // the shared secret and the packet sequence, then verifies SHA-256(fulfillment)
    // equals the sender-supplied condition. Only a holder of the secret matches.
    const secret = base64urlToBytes(this.sharedSecretB64);
    const fulfillment = await streamFulfillment(secret, seq);
    const expectedCondition = await sha256(fulfillment);

    let providedCondition: Uint8Array;
    try {
      providedCondition = base64urlToBytes(String(frame.executionCondition ?? ""));
    } catch {
      return reject(REJECT.WRONG_CONDITION, "wrong condition");
    }
    if (!constantTimeEqual(providedCondition, expectedCondition)) {
      return reject(REJECT.WRONG_CONDITION, "wrong condition");
    }

    // Condition satisfied. Commit the money durably *before* fulfilling so a
    // fulfilled (acknowledged) packet is always reflected in the balance.
    this.accumulatedMinor = (BigInt(this.accumulatedMinor) + amount).toString();
    this.lastSequence = seq;
    this.packetsSinceFlush += 1;
    await this.persist();

    this.send(ws, {
      type: "fulfill",
      sequence: seq,
      fulfillment: bytesToBase64url(fulfillment),
    });
  }

  // -------------------------------------------------------------------------
  // Batch flush
  // -------------------------------------------------------------------------

  async alarm(): Promise<void> {
    const pending = BigInt(this.accumulatedMinor);
    const packets = this.packetsSinceFlush;

    if (pending > 0n && this.gtid && this.env.DB) {
      console.log(`[StreamDO] flushing ${pending} (${packets} packets) for ${this.gtid}`);
      try {
        await writeFinalityLog(this.env.DB, {
          txid: this.gtid,
          event_type: "StreamingBatchFlush",
          state_from: "STREAMING",
          state_to: "STREAMING",
          payload_json: JSON.stringify({
            connection_id: this.connectionId,
            asset_code: this.assetCode,
            asset_scale: this.assetScale,
            flushed_minor: pending.toString(),
            packets,
            through_sequence: this.lastSequence,
          }),
          txid_or_gtid: this.gtid,
        });

        // Subtract exactly what we flushed (not a reset to 0) so prepares that
        // landed during the await above are preserved for the next flush.
        this.accumulatedMinor = (BigInt(this.accumulatedMinor) - pending).toString();
        this.packetsSinceFlush -= packets;
        await this.persist();
      } catch (e) {
        // Leave the balance intact; the next alarm retries. Never drop funds.
        console.error("[StreamDO] flush failed; will retry next alarm", e);
      }
    }

    // Keep flushing while a connection is open or a balance is still pending.
    const hasConnections = this.state.getWebSockets().length > 0;
    if (hasConnections || BigInt(this.accumulatedMinor) > 0n) {
      await this.state.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async persist(): Promise<void> {
    const snapshot: StreamState = {
      gtid: this.gtid,
      connectionId: this.connectionId,
      assetCode: this.assetCode,
      assetScale: this.assetScale,
      sharedSecretB64: this.sharedSecretB64,
      accumulatedMinor: this.accumulatedMinor,
      lastSequence: this.lastSequence,
      packetsSinceFlush: this.packetsSinceFlush,
    };
    await this.state.storage.put("stream_state", snapshot);
  }

  private send(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      console.error("[StreamDO] send failed", e);
    }
  }
}

// ---------------------------------------------------------------------------
// ILP STREAM crypto helpers
// ---------------------------------------------------------------------------

/** Derive the deterministic fulfillment for a packet: HMAC-SHA256(secret, sequence). */
async function streamFulfillment(secret: Uint8Array, sequence: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(sequence)));
  return new Uint8Array(sig);
}

/** SHA-256 digest as raw bytes. */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** Constant-time byte comparison to avoid leaking the condition via timing. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
