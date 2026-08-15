/**
 * @module bank/ingress/_shared
 * @description Shared helpers for the bank ingress command handlers:
 * audit logging, idempotency claim, and response persistence (all backed by
 * the ZcRequests / BankAuditLog tables).
 */
import { nowISO } from "../../types";
import { newUUID } from "../../shared/idempotency";

/**
 * Write an entry to the BankAuditLog table. Failures are silently swallowed
 * so that audit logging never blocks the critical payment path.
 * @param db - D1 database handle
 * @param params - Audit log fields (bank_id, command, status, etc.)
 */
export async function auditLog(
  db: D1Database,
  params: {
    bank_id: string;
    txid?: string | null;
    request_id?: string | null;
    command: string;
    status: "OK" | "NG";
    reason_code?: string | null;
    amount?: number | null;
    account_id?: string | null;
    details?: Record<string, unknown> | null;
  }
): Promise<void> {
  try {
    const logId = `AUD-${newUUID()}`;
    await db
      .prepare(
        `INSERT INTO BankAuditLog
       (log_id, bank_id, txid, request_id, command, status, reason_code,
        amount, account_id, details_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        logId,
        params.bank_id,
        params.txid ?? null,
        params.request_id ?? null,
        params.command,
        params.status,
        params.reason_code ?? null,
        params.amount ?? null,
        params.account_id ?? null,
        params.details ? JSON.stringify(params.details) : null,
        nowISO()
      )
      .run();
  } catch (err) {
    console.error("[bank/audit] BankAuditLog write failed:", err);
  }
}

/**
 * Check idempotency for a given request_id. Uses D1's INSERT OR IGNORE to
 * atomically claim the request_id. If the row already exists, returns the
 * previously stored response (or a PROCESSING sentinel if still in-flight).
 *
 * @param requestId   - Unique request identifier for idempotency
 * @param bankId      - Bank identifier
 * @param txid        - Associated transaction ID (nullable for some commands)
 * @param commandType - Command name for auditing
 * @param db          - D1 database handle
 * @returns `{ existing: true, response }` if already processed; `{ existing: false }` if new
 */
export async function checkIdempotency(
  requestId: string,
  bankId: string,
  txid: string | null,
  commandType: string,
  db: D1Database
): Promise<{ existing: boolean; response: unknown | null }> {
  const now = nowISO();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO ZcRequests (request_id, bank_id, txid, command_type, status, created_at)
     VALUES (?, ?, ?, ?, 'PROCESSING', ?)`
    )
    .bind(requestId, bankId, txid, commandType, now)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    const existing = await db
      .prepare(`SELECT response_body FROM ZcRequests WHERE request_id = ?`)
      .bind(requestId)
      .first<{ response_body: string | null }>();
    if (existing?.response_body) {
      return { existing: true, response: JSON.parse(existing.response_body) };
    }
    return { existing: true, response: { result: "PROCESSING" } };
  }
  return { existing: false, response: null };
}

/**
 * Persist the command response to ZcRequests so that future idempotent
 * retries return the same result.
 *
 * @param requestId - The request_id to update
 * @param response  - Response object to serialize as JSON
 * @param db        - D1 database handle
 */
export async function saveResponse(
  requestId: string,
  response: unknown,
  db: D1Database
): Promise<void> {
  await db
    .prepare(
      `UPDATE ZcRequests SET status='DONE', response_body=?, updated_at=? WHERE request_id=?`
    )
    .bind(JSON.stringify(response), nowISO(), requestId)
    .run();
}
