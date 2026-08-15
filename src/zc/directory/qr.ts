/**
 * @file QR code payment management. Generates static/dynamic QR codes with
 *       HMAC signatures and processes QR-initiated payments.
 * @module zc/qr
 */
import type { QrCodeRow, QrGenerateRequest, QrPayRequest } from "../../types";
import { signPayload, verifySignature } from "../../shared/hmac";
import { DomainError } from "../../shared/errors";
import { MAX_AMOUNT_VALUE } from "../../shared/constants";

const VALID_QR_TYPES = new Set(["STATIC", "DYNAMIC"]);

// ---------------------------------------------------------------------------
// QR code generation
// signature is HMAC-SHA256(qr_ref + payee_bank_id + amount, QR_SECRET)
// ---------------------------------------------------------------------------
export async function generateQrCode(
  db: D1Database,
  req: QrGenerateRequest,
  env: { QR_SECRET: string }
): Promise<QrCodeRow> {
  // Runtime validation. The router casts the JSON body to QrGenerateRequest
  // without checking it, so a request that omits required fields (or uses the
  // wrong field names — e.g. the legacy `qr_type`/`amount`-object shape) would
  // otherwise bind `undefined` into a NOT NULL column and surface as an
  // unhandled D1_TYPE_ERROR 500. Fail closed with a 400 VALIDATION error
  // instead, so malformed input never reaches the database layer.
  if (!req.type || !VALID_QR_TYPES.has(req.type))
    throw new DomainError("INVALID_REQUEST", "type must be one of STATIC|DYNAMIC", {
      field: "type",
    });
  if (!req.payee_bank_id)
    throw new DomainError("MISSING_FIELD", "payee_bank_id is required", { field: "payee_bank_id" });
  if (!req.payee_account_id)
    throw new DomainError("MISSING_FIELD", "payee_account_id is required", {
      field: "payee_account_id",
    });
  if (
    req.amount !== undefined &&
    req.amount !== null &&
    (typeof req.amount !== "number" ||
      !Number.isInteger(req.amount) ||
      req.amount <= 0 ||
      req.amount > MAX_AMOUNT_VALUE)
  )
    throw new DomainError(
      "INVALID_AMOUNT",
      `amount must be a positive integer (minor units) <= ${MAX_AMOUNT_VALUE}`,
      { field: "amount" }
    );

  const qrRef = crypto.randomUUID();
  const now = new Date().toISOString();
  const amountValue = req.amount ?? null;
  const currency = "JPY";

  // Build signature payload string: qr_ref + payee_bank_id + amount (or '' if STATIC with no amount)
  const sigPayload = buildSigPayload(qrRef, req.payee_bank_id, amountValue ?? undefined);
  const signature = await signPayload(sigPayload, env.QR_SECRET);

  await db
    .prepare(`
    INSERT INTO QrCodes
      (qr_ref, qr_type, payee_bank_id, payee_account_id, payee_name,
       amount_value, amount_currency, purpose, edi_ref,
       signature, is_used, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `)
    .bind(
      qrRef,
      req.type,
      req.payee_bank_id,
      req.payee_account_id,
      req.payee_name ?? "",
      amountValue,
      currency,
      req.purpose ?? null,
      req.edi_ref ?? null,
      signature,
      req.expires_at ?? null,
      now
    )
    .run();

  return {
    qr_ref: qrRef,
    qr_type: req.type,
    payee_bank_id: req.payee_bank_id,
    payee_account_id: req.payee_account_id,
    payee_name: req.payee_name ?? "",
    amount_value: amountValue,
    amount_currency: currency,
    purpose: req.purpose ?? null,
    edi_ref: req.edi_ref ?? null,
    signature,
    is_used: 0,
    expires_at: req.expires_at ?? null,
    created_at: now,
  };
}

// ---------------------------------------------------------------------------
// QR lookup
// ---------------------------------------------------------------------------
export async function getQrCode(db: D1Database, qrRef: string): Promise<QrCodeRow | null> {
  const row = await db
    .prepare(`
    SELECT * FROM QrCodes WHERE qr_ref = ? LIMIT 1
  `)
    .bind(qrRef)
    .first<QrCodeRow>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Execute QR payment (signature validation → mark used → return txid)
// ---------------------------------------------------------------------------
export async function processQrPayment(
  db: D1Database,
  req: QrPayRequest,
  env: { QR_SECRET: string }
): Promise<{ valid: boolean; qrRow?: QrCodeRow; effectiveAmount?: number; error?: string }> {
  const qrRow = await getQrCode(db, req.qr_ref);
  if (!qrRow) {
    return { valid: false, error: "QR_NOT_FOUND" };
  }

  // Expiry check
  if (qrRow.expires_at) {
    const expiresMs = new Date(qrRow.expires_at).getTime();
    if (expiresMs < Date.now()) {
      return { valid: false, error: "QR_EXPIRED" };
    }
  }

  // Used check (DYNAMIC QR is single-use)
  if (qrRow.qr_type === "DYNAMIC" && qrRow.is_used === 1) {
    return { valid: false, error: "QR_ALREADY_USED" };
  }

  // Amount validation: DYNAMIC QR prefers the fixed amount, falling back to req.amount; STATIC QR requires req.amount
  const effectiveAmount =
    qrRow.qr_type === "DYNAMIC" ? (qrRow.amount_value ?? req.amount) : req.amount;
  if (effectiveAmount == null || effectiveAmount <= 0) {
    return { valid: false, error: "QR_AMOUNT_REQUIRED" };
  }

  // Signature validation
  const sigOk = await verifyQrSignature(
    qrRow.qr_ref,
    qrRow.payee_bank_id,
    qrRow.amount_value ?? undefined,
    qrRow.signature,
    env.QR_SECRET
  );
  if (!sigOk) {
    return { valid: false, error: "QR_INVALID_SIGNATURE" };
  }

  // Set DYNAMIC QR to used — single-use is enforced by a CAS, not by the
  // read-time `is_used` check above. Two concurrent payments for the same QR
  // both pass that read (TOCTOU), so the `AND is_used = 0` predicate is the
  // only thing that makes consumption atomic: exactly one UPDATE flips the row
  // (changes() == 1), every other loser sees changes() == 0 and is rejected.
  // Without it the same DYNAMIC QR could be spent more than once.
  if (qrRow.qr_type === "DYNAMIC") {
    const upd = await db
      .prepare(`
      UPDATE QrCodes SET is_used = 1 WHERE qr_ref = ? AND is_used = 0
    `)
      .bind(qrRow.qr_ref)
      .run();
    if ((upd.meta.changes ?? 0) === 0) {
      // Lost the race (or already used between the read and here).
      return { valid: false, error: "QR_ALREADY_USED" };
    }
    return { valid: true, qrRow: { ...qrRow, is_used: 1 }, effectiveAmount };
  }

  // Return STATIC QR as-is (reusable any number of times)
  return { valid: true, qrRow, effectiveAmount };
}

// ---------------------------------------------------------------------------
// QR signature validation
// ---------------------------------------------------------------------------
export async function verifyQrSignature(
  qrRef: string,
  payeeBankId: string,
  amountValue: number | undefined,
  signature: string,
  secret: string
): Promise<boolean> {
  const sigPayload = buildSigPayload(qrRef, payeeBankId, amountValue);
  return verifySignature(sigPayload, signature, secret);
}

// ---------------------------------------------------------------------------
// Internal helper: build the signature payload string
// ---------------------------------------------------------------------------
function buildSigPayload(qrRef: string, payeeBankId: string, amountValue?: number): string {
  const amountStr = amountValue !== undefined ? String(amountValue) : "";
  return `${qrRef}:${payeeBankId}:${amountStr}`;
}
