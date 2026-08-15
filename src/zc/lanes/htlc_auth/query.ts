/**
 * @file Read-only queries for HtlcAuthRequests rows.
 * @module zc/lanes/htlc_auth/query
 */
import type { HtlcAuthRequestRow } from "../../../types";

export async function getAuthRequest(
  authId: string,
  db: D1Database
): Promise<HtlcAuthRequestRow | null> {
  return db
    .prepare(
      `SELECT auth_id, htlc_id, txid, status, payee_bank_id, payee_account_hash,
            payer_bank_id, payer_account_hash, amount_value, purpose, description,
            auth_expires_at, capture_expires_at, hashlock, whitelist_id,
            approved_at, captured_at, voided_at, decline_reason,
            version, created_at, updated_at
     FROM HtlcAuthRequests WHERE auth_id=?`
    )
    .bind(authId)
    .first<HtlcAuthRequestRow>();
}

export async function listAuthRequests(
  db: D1Database,
  params: { payer_bank_id?: string; payee_bank_id?: string; status?: string; limit?: number }
): Promise<HtlcAuthRequestRow[]> {
  let sql = `SELECT auth_id, htlc_id, txid, status, payee_bank_id, payee_account_hash,
             payer_bank_id, payer_account_hash, amount_value, purpose, description,
             auth_expires_at, capture_expires_at, hashlock, whitelist_id,
             approved_at, captured_at, voided_at, decline_reason, created_at, updated_at
             FROM HtlcAuthRequests WHERE 1=1`;
  const binds: unknown[] = [];
  if (params.payer_bank_id) {
    sql += ` AND payer_bank_id=?`;
    binds.push(params.payer_bank_id);
  }
  if (params.payee_bank_id) {
    sql += ` AND payee_bank_id=?`;
    binds.push(params.payee_bank_id);
  }
  if (params.status) {
    sql += ` AND status=?`;
    binds.push(params.status);
  }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  binds.push(params.limit ?? 50);
  const rows = await db
    .prepare(sql)
    .bind(...binds)
    .all<HtlcAuthRequestRow>();
  return rows.results;
}
