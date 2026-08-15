/**
 * @file Server-Sent Events (SSE) for real-time bank notifications. Delivers
 *       TX_STATE_CHANGED, CREDIT_RECEIVED, RTP_RECEIVED events.
 * @module zc/stream
 */

import type { EventStreamRow, StreamEventType } from "../../types";
import { nowISO } from "../../types";

// ---------------------------------------------------------------------------
// Emit event
// ---------------------------------------------------------------------------

/**
 * INSERT an event into the EventStream table and return the event_id.
 *
 * @param db           - D1 database
 * @param targetBankId - Delivery target bank ID
 * @param eventType    - Event type
 * @param payload      - Payload object (JSON serialized)
 * @returns event_id (UUID)
 */
export async function publishEvent(
  db: D1Database,
  targetBankId: string,
  eventType: StreamEventType,
  payload: object
): Promise<string> {
  const eventId = crypto.randomUUID();
  const now = nowISO();

  await db
    .prepare(`
    INSERT INTO EventStream
      (event_id, target_bank_id, event_type, payload_json, is_delivered, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `)
    .bind(eventId, targetBankId, eventType, JSON.stringify(payload), now)
    .run();

  return eventId;
}

// ---------------------------------------------------------------------------
// Get undelivered events
// ---------------------------------------------------------------------------

/**
 * Get undelivered events for polling.
 * If afterEventId is specified, return undelivered events from that event onward (created_at ascending).
 *
 * @param db           - D1 database
 * @param targetBankId - Delivery target bank ID
 * @param afterEventId - Get events after this event ID (optional)
 * @returns EventStreamRow[]
 */
export async function getPendingEvents(
  db: D1Database,
  targetBankId: string,
  afterEventId?: string
): Promise<EventStreamRow[]> {
  if (afterEventId) {
    // Fetch the created_at of afterEventId and use it as the cursor
    const cursor = await db
      .prepare(`
      SELECT created_at FROM EventStream WHERE event_id = ?
    `)
      .bind(afterEventId)
      .first<{ created_at: string }>();

    if (cursor) {
      const { results } = await db
        .prepare(`
        SELECT * FROM EventStream
        WHERE target_bank_id = ? AND is_delivered = 0 AND created_at > ?
        ORDER BY created_at ASC
        LIMIT 100
      `)
        .bind(targetBankId, cursor.created_at)
        .all<EventStreamRow>();
      return results ?? [];
    }
  }

  const { results } = await db
    .prepare(`
    SELECT * FROM EventStream
    WHERE target_bank_id = ? AND is_delivered = 0
    ORDER BY created_at ASC
    LIMIT 100
  `)
    .bind(targetBankId)
    .all<EventStreamRow>();

  return results ?? [];
}

// ---------------------------------------------------------------------------
// Mark events as delivered (batch)
// ---------------------------------------------------------------------------

/**
 * Mark multiple events as delivered in bulk.
 * Uses D1's batch API to complete in a single round trip.
 *
 * @param db       - D1 database
 * @param eventIds - Array of event IDs
 */
export async function markEventsDelivered(db: D1Database, eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;

  // D1 cannot use an IN clause via parameter expansion, so process with batch
  const stmts = eventIds.map((id) =>
    db.prepare(`UPDATE EventStream SET is_delivered = 1 WHERE event_id = ?`).bind(id)
  );
  await db.batch(stmts);
}

// ---------------------------------------------------------------------------
// Generate SSE Response
// ---------------------------------------------------------------------------

/**
 * Generate an SSE response using a Cloudflare Workers ReadableStream.
 *
 * Behavior:
 * 1. Create a ReadableStream
 * 2. Poll getPendingEvents every 2 seconds
 * 3. Enqueue each event in SSE format (`data: {...}\n\n`)
 * 4. Mark as delivered after sending
 *
 * @param db           - D1 database
 * @param targetBankId - Delivery target bank ID
 * @returns SSE response
 */
export function createSseResponse(db: D1Database, targetBankId: string): Response {
  let lastEventId: string | undefined;
  let timerId: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      // Initial connection notification
      const connectMsg = `data: ${JSON.stringify({ type: "CONNECTED", bank_id: targetBankId })}\n\n`;
      controller.enqueue(new TextEncoder().encode(connectMsg));

      // Polling loop (2-second interval)
      const poll = async () => {
        try {
          const events = await getPendingEvents(db, targetBankId, lastEventId);

          if (events.length > 0) {
            for (const ev of events) {
              const sseData = formatSseEvent(ev);
              controller.enqueue(new TextEncoder().encode(sseData));
              lastEventId = ev.event_id;
            }

            // Mark as delivered
            await markEventsDelivered(
              db,
              events.map((e) => e.event_id)
            );
          }
        } catch (err) {
          console.error("[stream] SSE poll error:", err);
          // Notifying the client of an error does not stop the stream
          const errMsg = `data: ${JSON.stringify({ type: "ERROR", message: "poll failed" })}\n\n`;
          try {
            controller.enqueue(new TextEncoder().encode(errMsg));
          } catch {
            // Ignore if the controller is already closed
            // Discard the stream → stop the timer
            if (timerId) {
              clearInterval(timerId);
              timerId = null;
            }
          }
        }
      };

      // Polling every 2 seconds (runs inside the Workers event loop)
      timerId = setInterval(poll, 2000);
    },
    cancel() {
      // Stop the timer on client disconnect (prevents resource leaks and erroneous delivered marks)
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------
// Delete old delivered events
// ---------------------------------------------------------------------------

/**
 * Delete delivered events older than 24 hours (for cron).
 *
 * @param db - D1 database
 * @returns number of deleted rows
 */
export async function pruneDeliveredEvents(db: D1Database): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const result = await db
    .prepare(`
    DELETE FROM EventStream
    WHERE is_delivered = 1 AND created_at < ?
  `)
    .bind(cutoff)
    .run();

  return result.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Convert an EventStreamRow into an SSE-formatted string.
 *
 * @param ev - event row
 * @returns SSE-formatted string (`id: ...\ndata: ...\n\n`)
 */
function formatSseEvent(ev: EventStreamRow): string {
  let payload: object;
  try {
    payload = JSON.parse(ev.payload_json) as object;
  } catch {
    payload = { raw: ev.payload_json };
  }

  const data = JSON.stringify({
    event_id: ev.event_id,
    event_type: ev.event_type,
    created_at: ev.created_at,
    ...payload,
  });

  return `id: ${ev.event_id}\ndata: ${data}\n\n`;
}
