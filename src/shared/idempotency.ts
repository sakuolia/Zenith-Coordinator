import { nowISO } from "../types";
import { sha256hex } from "./hmac";

/**
 * Attempt to acquire an idempotency key atomically.
 *
 * Inserts a row with status PROCESSING. If the key already exists the
 * INSERT OR IGNORE is a no-op and `meta.changes` will be 0.
 *
 * When `requestBody` is supplied, its hash is stored alongside the key so a
 * later call can detect the same key being reused with a different body (see
 * {@link idempotencyConflict}). Callers that key purely on a single-use nonce
 * (e.g. signature-replay protection) omit `requestBody`, leaving the stored
 * hash NULL and opting out of conflict detection.
 *
 * @param key         - Idempotency key from the X-Idempotency-Key header
 * @param db          - D1 database binding
 * @param requestBody - Optional request payload to fingerprint for conflict detection
 * @returns `true` if the key was newly acquired (caller should proceed),
 *          `false` if the key already existed (caller should replay)
 */
export async function acquireIdempotency(
  key: string,
  db: D1Database,
  requestBody?: unknown
): Promise<boolean> {
  const now = nowISO();
  const requestHash =
    requestBody === undefined ? null : await sha256hex(JSON.stringify(requestBody));
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO IdempotencyKeys (key, status, created_at, request_hash)
       VALUES (?, 'PROCESSING', ?, ?)`
    )
    .bind(key, now, requestHash)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Check whether a previously-acquired idempotency key was stored with a
 * different request body than the one supplied now.
 *
 * Only meaningful for keys acquired with a `requestBody` (see
 * {@link acquireIdempotency}); a key with no stored hash (NULL) never
 * conflicts, since its caller opted out of body comparison.
 *
 * @param key         - Idempotency key to check
 * @param requestBody - The current request's payload
 * @param db          - D1 database binding
 * @returns `true` if the key exists with a stored hash that differs from `requestBody`'s hash
 */
export async function idempotencyConflict(
  key: string,
  requestBody: unknown,
  db: D1Database
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT request_hash FROM IdempotencyKeys WHERE key = ?`)
    .bind(key)
    .first<{ request_hash: string | null }>();
  if (!row || row.request_hash == null) return false;
  const hash = await sha256hex(JSON.stringify(requestBody));
  return hash !== row.request_hash;
}

/**
 * One-call wrapper around the acquire / conflict-check / replay sequence
 * shared by every idempotency-key-bearing ingress handler.
 *
 * @param key         - Idempotency key from the request body
 * @param requestBody - The full request payload, fingerprinted for conflict detection
 * @param db          - D1 database binding
 * @returns `{status:"NEW"}` if the caller should proceed and later call
 *          {@link completeIdempotency}; `{status:"REPLAY",response}` if the
 *          same request was already completed (or is in flight); or
 *          `{status:"CONFLICT"}` if the key was reused with a different body
 */
export async function resolveIdempotency(
  key: string,
  requestBody: unknown,
  db: D1Database
): Promise<{ status: "NEW" } | { status: "REPLAY"; response: unknown } | { status: "CONFLICT" }> {
  const acquired = await acquireIdempotency(key, db, requestBody);
  if (acquired) return { status: "NEW" };
  if (await idempotencyConflict(key, requestBody, db)) return { status: "CONFLICT" };
  return { status: "REPLAY", response: await getIdempotentResponse(key, db) };
}

/**
 * Mark an idempotency key as DONE and persist the response body.
 *
 * On subsequent duplicate requests the stored response is returned
 * verbatim via {@link getIdempotentResponse}.
 *
 * @param key          - Idempotency key to finalize
 * @param responseBody - The JSON-serializable response to cache
 * @param db           - D1 database binding
 */
export async function completeIdempotency(
  key: string,
  responseBody: unknown,
  db: D1Database
): Promise<void> {
  await db
    .prepare(
      `UPDATE IdempotencyKeys
       SET status = 'DONE', response_body = ?, updated_at = ?
       WHERE key = ?`
    )
    .bind(JSON.stringify(responseBody), nowISO(), key)
    .run();
}

/**
 * Retrieve a previously stored idempotent response for replay.
 *
 * - If the key is still PROCESSING, returns `{ result: 'PROCESSING' }`.
 * - If DONE, returns the deserialized response body.
 * - If not found, returns `null`.
 *
 * @param key - Idempotency key to look up
 * @param db  - D1 database binding
 * @returns Cached response, a PROCESSING sentinel, or null
 */
export async function getIdempotentResponse(key: string, db: D1Database): Promise<unknown | null> {
  const row = await db
    .prepare(`SELECT response_body, status FROM IdempotencyKeys WHERE key = ?`)
    .bind(key)
    .first<{ response_body: string | null; status: string }>();

  if (!row) return null;
  if (row.status === "PROCESSING") return { result: "PROCESSING" };
  if (row.response_body) return JSON.parse(row.response_body);
  return null;
}

/**
 * Generate a UUID v4 using the Web Crypto API (`crypto.randomUUID()`).
 *
 * @returns A new random UUID string (e.g. `"550e8400-e29b-41d4-a716-446655440000"`)
 */
export function newUUID(): string {
  return crypto.randomUUID();
}
