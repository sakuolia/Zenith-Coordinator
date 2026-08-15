/**
 * @file Whitelist management for HTLC Auth (admin only).
 * @module zc/lanes/htlc_auth/whitelist
 */
import type { HtlcAuthWhitelistRow, HtlcAuthWhitelistRegisterRequest } from "../../../types";
import { nowISO } from "../../../types";
import { newUUID } from "../../../shared/idempotency";

export async function registerAuthWhitelist(
  req: HtlcAuthWhitelistRegisterRequest,
  db: D1Database
): Promise<{ whitelist_id: string }> {
  const whitelistId = `WL-${newUUID()}`;
  const now = nowISO();
  await db
    .prepare(
      `INSERT INTO HtlcAuthWhitelist
     (whitelist_id, payee_bank_id, payee_account_hash, allowed_payer_bank_id,
      max_amount, allowed_purposes, description, is_active, registered_at, expires_at,
      eligibility_template_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    )
    .bind(
      whitelistId,
      req.payee_bank_id,
      req.payee_account_hash,
      req.allowed_payer_bank_id ?? null,
      req.max_amount ?? null,
      req.allowed_purposes ? JSON.stringify(req.allowed_purposes) : null,
      req.description ?? null,
      now,
      req.expires_at ?? null,
      req.eligibility_template_id ?? null
    )
    .run();
  return { whitelist_id: whitelistId };
}

export async function revokeAuthWhitelist(whitelistId: string, db: D1Database): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE HtlcAuthWhitelist SET is_active=0 WHERE whitelist_id=?`)
    .bind(whitelistId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function listAuthWhitelist(db: D1Database): Promise<HtlcAuthWhitelistRow[]> {
  const rows = await db
    .prepare(`SELECT * FROM HtlcAuthWhitelist ORDER BY registered_at DESC`)
    .all<HtlcAuthWhitelistRow>();
  return rows.results;
}
