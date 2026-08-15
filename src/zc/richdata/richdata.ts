/**
 * @file Rich data storage for structured transaction attachments (EDI,
 *       invoices, remittance info). Supports R2 offloading for large payloads.
 * @module zc/richdata
 */
import type { RichDataStoreRow, RichDataStoreRequest, RichDataType } from "../../types";

// 50KB threshold for R2 offload
const R2_THRESHOLD_BYTES = 50 * 1024;

// ---------------------------------------------------------------------------
// Rich data registration
// Large data (>50KB) is stored in R2; content_json holds only the summary
// ---------------------------------------------------------------------------
export async function storeRichData(
  db: D1Database,
  req: RichDataStoreRequest,
  createdByBankId: string,
  env: { R2_BUCKET?: R2Bucket }
): Promise<RichDataStoreRow> {
  const dataRef = crypto.randomUUID();
  const now = new Date().toISOString();
  const { RICHDATA_DEFAULT_RETENTION_DAYS } = await import("../../shared/constants");
  const retentionDays = RICHDATA_DEFAULT_RETENTION_DAYS;

  // Compute expiry
  const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();

  // Serialize content
  const fullJson = JSON.stringify(req.content);
  const contentBytes = new TextEncoder().encode(fullJson).length;

  // Compute SHA-256 hash of full content
  const contentHash = await computeContentHash(req.content);

  let contentJson: string;
  let r2Key: string | null = null;

  if (contentBytes > R2_THRESHOLD_BYTES && env.R2_BUCKET) {
    // Store full content in R2
    r2Key = `richdata/${dataRef}`;
    await env.R2_BUCKET.put(r2Key, fullJson, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { data_ref: dataRef, data_type: req.data_type, content_hash: contentHash },
    });
    // Store only a summary in D1
    const summary = buildSummary(req.content, req.data_type);
    contentJson = JSON.stringify(summary);
  } else {
    contentJson = fullJson;
  }

  await db
    .prepare(`
    INSERT INTO RichDataStore
      (data_ref, data_type, txid, content_json, content_hash, r2_key,
       created_by_bank_id, retention_days, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      dataRef,
      req.data_type,
      req.txid ?? null,
      contentJson,
      contentHash,
      r2Key,
      createdByBankId,
      retentionDays,
      now,
      expiresAt
    )
    .run();

  return {
    data_ref: dataRef,
    data_type: req.data_type,
    txid: req.txid ?? null,
    content_json: contentJson,
    content_hash: contentHash,
    r2_key: r2Key,
    created_by_bank_id: createdByBankId,
    retention_days: retentionDays,
    created_at: now,
    expires_at: expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Fetch rich data (data_ref)
// ---------------------------------------------------------------------------
export async function getRichData(
  db: D1Database,
  dataRef: string
): Promise<RichDataStoreRow | null> {
  const row = await db
    .prepare(`
    SELECT * FROM RichDataStore WHERE data_ref = ? LIMIT 1
  `)
    .bind(dataRef)
    .first<RichDataStoreRow>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// List of rich data linked to a txid
// ---------------------------------------------------------------------------
export async function listRichDataByTxid(
  db: D1Database,
  txid: string
): Promise<RichDataStoreRow[]> {
  const result = await db
    .prepare(`
    SELECT * FROM RichDataStore WHERE txid = ? ORDER BY created_at ASC
  `)
    .bind(txid)
    .all<RichDataStoreRow>();
  return result.results ?? [];
}

// ---------------------------------------------------------------------------
// Compute content hash (SHA-256 of JSON)
// ---------------------------------------------------------------------------
export async function computeContentHash(content: object): Promise<string> {
  const json = JSON.stringify(content);
  const msgBuf = new TextEncoder().encode(json);
  const hashBuf = await crypto.subtle.digest("SHA-256", msgBuf);
  return bufToHex(hashBuf);
}

// ---------------------------------------------------------------------------
// Internal helper: generate the D1 summary when storing to R2
// ---------------------------------------------------------------------------
function buildSummary(
  content: Record<string, unknown>,
  dataType: RichDataType
): Record<string, unknown> {
  // Extract a small representative subset for the D1 summary
  const base: Record<string, unknown> = {
    _summary: true,
    _data_type: dataType,
  };

  switch (dataType) {
    case "INVOICE":
      return {
        ...base,
        invoice_number: content.invoice_number,
        invoice_date: content.invoice_date,
        total_amount: content.total_amount,
        payee_name: content.payee_name,
      };
    case "EDI":
      return {
        ...base,
        invoice_number: content.invoice_number,
        sender_ref: content.sender_ref,
        receiver_ref: content.receiver_ref,
        item_count: Array.isArray(content.line_items)
          ? (content.line_items as unknown[]).length
          : null,
      };
    case "REMITTANCE":
      return {
        ...base,
        remittance_id: content.remittance_id,
        amount: content.amount,
        purpose: content.purpose,
      };
    case "ATTACHMENT_META":
      return {
        ...base,
        filename: content.filename,
        mime_type: content.mime_type,
        file_size: content.file_size,
      };
    default:
      // Generic: keep only top-level scalar values, truncate
      return Object.fromEntries(
        Object.entries(content)
          .filter(([, v]) => typeof v !== "object" || v === null)
          .slice(0, 10)
          .concat([["_summary", true]])
      );
  }
}

// ---------------------------------------------------------------------------
// Internal helper: ArrayBuffer → hex string
// ---------------------------------------------------------------------------
function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
