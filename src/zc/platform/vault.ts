/**
 * @file Short-term confidential data store (Vault). Stores AML evaluations,
 *       PII, and risk hints with TTL-based eviction.
 * @module zc/vault
 */
import type { VaultRow } from "../../types";
import { nowISO } from "../../types";
import { newUUID } from "../../shared/idempotency";

export type VaultDataType = "AML_EVAL" | "PII" | "RISK_HINT" | "HTLC_PREIMAGE";

export interface StoreVaultOptions {
  /** vault_ref prefix (default "VLT"); the UUID is always appended after it. */
  refPrefix?: string;
  /** Absolute expiry ISO timestamp. Takes precedence over `ttlSeconds`. */
  expiresAt?: string;
  /** TTL seconds from now (default 3600). Ignored when `expiresAt` is set. */
  ttlSeconds?: number;
}

/**
 * Store in the Vault and return vault_ref
 */
export async function storeVault(
  db: D1Database,
  txid: string | null,
  dataType: VaultDataType,
  payload: unknown,
  opts: StoreVaultOptions = {}
): Promise<string> {
  const vaultRef = `${opts.refPrefix ?? "VLT"}-${newUUID()}`;
  const now = nowISO();
  const expiresAt =
    opts.expiresAt ?? new Date(Date.now() + (opts.ttlSeconds ?? 3600) * 1000).toISOString();

  await db
    .prepare(
      `INSERT INTO Vault (vault_ref, txid, data_type, payload_json, expires_at, is_evicted, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
    )
    .bind(vaultRef, txid, dataType, JSON.stringify(payload), expiresAt, now)
    .run();

  return vaultRef;
}

/**
 * Fetch from the Vault (null if TTL expired or already evicted)
 */
export async function fetchVault(db: D1Database, vaultRef: string): Promise<unknown | null> {
  const row = await db
    .prepare(`SELECT * FROM Vault WHERE vault_ref = ? AND is_evicted = 0`)
    .bind(vaultRef)
    .first<VaultRow>();

  if (!row) return null;
  if (new Date(row.expires_at) <= new Date()) {
    await db.prepare(`UPDATE Vault SET is_evicted=1 WHERE vault_ref=?`).bind(vaultRef).run();
    return null;
  }

  return JSON.parse(row.payload_json);
}

/**
 * Explicit Evict
 */
export async function evictVault(db: D1Database, vaultRef: string): Promise<void> {
  await db.prepare(`UPDATE Vault SET is_evicted=1 WHERE vault_ref=?`).bind(vaultRef).run();
}

/**
 * Bulk-evict every entry whose TTL has elapsed (logical delete). Returns the
 * number of rows evicted. Used by the per-minute timeout sweep.
 */
export async function evictExpiredVault(db: D1Database, nowIso: string): Promise<number> {
  const res = await db
    .prepare(`UPDATE Vault SET is_evicted=1 WHERE is_evicted=0 AND expires_at < ?`)
    .bind(nowIso)
    .run();
  return res.meta.changes ?? 0;
}
