/**
 * @file Alias payment proxy directory. Maps phone/email/national_id to bank
 *       account for payee resolution.
 * @module zc/proxy
 */
import type {
  ProxyDirectoryRow,
  ProxyRegisterRequest,
  ProxyResolveResponse,
  ProxyType,
} from "../../types";

// ---------------------------------------------------------------------------
// Proxy registration (phone number/email/My Number → account)
// Duplicate registration updates the existing record (INSERT OR REPLACE)
// ---------------------------------------------------------------------------
export async function registerProxy(
  db: D1Database,
  req: ProxyRegisterRequest
): Promise<ProxyDirectoryRow> {
  const now = new Date().toISOString();

  // Check if an existing record exists for this proxy_type + proxy_value
  const existing = await db
    .prepare(`
    SELECT proxy_id FROM ProxyDirectory
    WHERE proxy_type = ? AND proxy_value = ?
  `)
    .bind(req.proxy_type, req.proxy_value)
    .first<{ proxy_id: string }>();

  const holderName = req.account_holder_name ?? "";
  let proxyId: string;
  if (existing) {
    // Update existing record
    proxyId = existing.proxy_id;
    await db
      .prepare(`
      UPDATE ProxyDirectory
      SET bank_id = ?, account_id = ?, account_holder_name = ?,
          is_active = 1, updated_at = ?
      WHERE proxy_id = ?
    `)
      .bind(req.bank_id, req.account_id, holderName, now, proxyId)
      .run();
  } else {
    // Insert new record
    proxyId = crypto.randomUUID();
    await db
      .prepare(`
      INSERT INTO ProxyDirectory
        (proxy_id, proxy_type, proxy_value, bank_id, account_id,
         account_holder_name, is_active, registered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `)
      .bind(
        proxyId,
        req.proxy_type,
        req.proxy_value,
        req.bank_id,
        req.account_id,
        holderName,
        now,
        now
      )
      .run();
  }

  // On update, fetch the correct registered_at from the DB
  const saved = await db
    .prepare(`SELECT registered_at FROM ProxyDirectory WHERE proxy_id = ?`)
    .bind(proxyId)
    .first<{ registered_at: string }>();

  return {
    proxy_id: proxyId,
    proxy_type: req.proxy_type,
    proxy_value: req.proxy_value,
    bank_id: req.bank_id,
    account_id: req.account_id,
    // Bug #1 fix: Return the normalized holder_name (defaults to empty string if not provided)
    // to match what was actually stored in the database. Using req.account_holder_name
    // would return undefined, causing mismatch between API response and DB state.
    account_holder_name: holderName,
    is_active: 1,
    registered_at: saved?.registered_at ?? now,
    updated_at: now,
  };
}

// ---------------------------------------------------------------------------
// Proxy resolution (alias → bank_id + account_id)
// ---------------------------------------------------------------------------
export async function resolveProxy(
  db: D1Database,
  proxyType: ProxyType,
  proxyValue: string
): Promise<ProxyResolveResponse | null> {
  const row = await db
    .prepare(`
    SELECT * FROM ProxyDirectory
    WHERE proxy_type = ? AND proxy_value = ? AND is_active = 1
    LIMIT 1
  `)
    .bind(proxyType, proxyValue)
    .first<ProxyDirectoryRow>();

  if (!row) return null;

  return {
    proxy_type: row.proxy_type,
    proxy_value: row.proxy_value,
    bank_id: row.bank_id,
    account_id: row.account_id,
    account_holder_name: row.account_holder_name,
    resolved: true,
  };
}

// ---------------------------------------------------------------------------
// Proxy deactivation
// ---------------------------------------------------------------------------
export async function deactivateProxy(db: D1Database, proxyId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(`
    UPDATE ProxyDirectory SET is_active = 0, updated_at = ? WHERE proxy_id = ?
  `)
    .bind(now, proxyId)
    .run();
}
