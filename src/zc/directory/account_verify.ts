/**
 * @file Pre-payment account verification (name-check). Queries target bank via
 *       ZC ingress to verify account holder name before payment.
 * @module zc/account_verify
 */
import type {
  Env,
  AccountVerificationRow,
  AccountVerifyRequest,
  AccountVerifyBatchRequest,
  BankAccountVerifyIngressRequest,
  BankAccountVerifyIngressResponse,
  VerificationStatus,
} from "../../types";
import { nowISO } from "../../types";
import { newUUID } from "../../shared/idempotency";
import { signPayload } from "../../shared/hmac";
import {
  zcSigningConfigured,
  signAsZcFromEnv,
  zcSignatureHeaders,
} from "../../shared/zc_signature";

// ---------------------------------------------------------------------------
// buildBankAccountVerifyPayload
// ---------------------------------------------------------------------------
/**
 * Build the `account-verify` ingress body. Exported so the seam itself is
 * testable: the ZC caller and the bank handler agree on
 * `BankAccountVerifyIngressRequest`, and the round-trip test drives the handler
 * with exactly the object that goes on the wire — the previous shape
 * (`{account_id, name_to_verify}`) type-checked against a stale duplicate
 * interface and left the handler reading `undefined` for the account hash.
 */
export function buildBankAccountVerifyPayload(
  req: AccountVerifyRequest,
  accountHash: string,
  requestId: string
): BankAccountVerifyIngressRequest {
  return {
    request_id: requestId,
    verification_id: req.verification_id,
    target_account_hash: accountHash,
    target_account_name: req.name_to_verify,
  };
}

// ---------------------------------------------------------------------------
// requestAccountVerification
// ---------------------------------------------------------------------------
/**
 * Creates an account verification request and calls the target bank's ZC Ingress API.
 * Skips the bank call on a cache hit.
 *
 * @returns verification_id
 */
export async function requestAccountVerification(
  db: D1Database,
  req: AccountVerifyRequest,
  env: Env
): Promise<string> {
  const now = nowISO();

  // Idempotency check: if the same idempotency_key exists, return the existing ID
  const existing = await db
    .prepare(`SELECT verification_id FROM AccountVerifications WHERE idempotency_key = ?`)
    .bind(req.idempotency_key)
    .first<{ verification_id: string }>();
  if (existing) return existing.verification_id;

  // Account hash (account_id is used directly as the hash equivalent)
  const accountHash = req.target_account_id;

  // Cache check: look for a record with the same (target_bank_id, target_account_hash) that is still within its validity period
  const cached = await db
    .prepare(
      `SELECT * FROM AccountVerifications
       WHERE target_bank_id = ?
         AND target_account_hash = ?
         AND status IN ('MATCHED', 'UNMATCHED', 'NOT_FOUND')
         AND cached_until IS NOT NULL
         AND cached_until > ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(req.target_bank_id, accountHash, now)
    .first<AccountVerificationRow>();

  if (cached) {
    // Cache hit: create a new record by copying the cached result
    const newId = req.verification_id;
    await db
      .prepare(
        `INSERT OR IGNORE INTO AccountVerifications
       (verification_id, request_bank_id, target_bank_id, target_account_hash,
        target_account_name, status, name_provided, match_score, fraud_warning,
        cached_until, idempotency_key, created_at, responded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        newId,
        req.request_bank_id,
        req.target_bank_id,
        accountHash,
        cached.target_account_name,
        cached.status,
        req.name_to_verify ?? null,
        cached.match_score,
        cached.fraud_warning,
        cached.cached_until,
        req.idempotency_key,
        now,
        now
      )
      .run();
    return newId;
  }

  // Insert a new record as PENDING
  await db
    .prepare(
      `INSERT OR IGNORE INTO AccountVerifications
     (verification_id, request_bank_id, target_bank_id, target_account_hash,
      target_account_name, status, name_provided, match_score, fraud_warning,
      idempotency_key, created_at)
     VALUES (?, ?, ?, ?, NULL, 'PENDING', ?, NULL, 0, ?, ?)`
    )
    .bind(
      req.verification_id,
      req.request_bank_id,
      req.target_bank_id,
      accountHash,
      req.name_to_verify ?? null,
      req.idempotency_key,
      now
    )
    .run();

  // Call the target bank's ZC Ingress API
  const idemKey = `AV-${req.verification_id}`;
  const bankPayload = buildBankAccountVerifyPayload(req, accountHash, idemKey);

  try {
    const url = `${env.BANK_BASE_URL}/bank/${req.target_bank_id}/zc-ingress/account-verify`;
    // Egress auth: prefer ZC's asymmetric signing key (participants verify against
    // the KeyRegistry public key) when configured; otherwise fall back to the
    // legacy shared-HMAC header. The verifier dual-accepts during migration.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Idempotency-Key": idemKey,
    };
    if (zcSigningConfigured(env)) {
      Object.assign(headers, zcSignatureHeaders(await signAsZcFromEnv(env, bankPayload)));
    } else {
      headers["X-ZC-Signature"] = await signPayload(bankPayload, env.ZC_HMAC_SECRET);
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(bankPayload),
    });

    if (res.ok) {
      const bankResp = (await res.json()) as BankAccountVerifyIngressResponse;
      await handleBankVerifyResponse(db, req.verification_id, bankResp);
    } else {
      const errText = await res.text().catch(() => "");
      console.error("[AccountVerify] bank call failed:", res.status, errText);
      await db
        .prepare(
          `UPDATE AccountVerifications
         SET status = 'ERROR', responded_at = ?
         WHERE verification_id = ?`
        )
        .bind(now, req.verification_id)
        .run();
    }
  } catch (err) {
    console.error("[AccountVerify] fetch error:", err);
    await db
      .prepare(
        `UPDATE AccountVerifications
       SET status = 'ERROR', responded_at = ?
       WHERE verification_id = ?`
      )
      .bind(now, req.verification_id)
      .run();
  }

  return req.verification_id;
}

// ---------------------------------------------------------------------------
// handleBankVerifyResponse
// ---------------------------------------------------------------------------
/**
 * Apply the bank's account verification response to the AccountVerifications table.
 */
export async function handleBankVerifyResponse(
  db: D1Database,
  verificationId: string,
  response: BankAccountVerifyIngressResponse
): Promise<void> {
  const now = nowISO();

  let status: VerificationStatus;
  let matchScore: number | null = null;
  let fraudWarning = 0;
  // Cache expiry: 24 hours for MATCHED/MISMATCHED, 1 hour for NOT_FOUND
  let cachedUntil: string | null = null;

  switch (response.result) {
    case "MATCHED": {
      status = "MATCHED";
      matchScore = response.match_score;
      fraudWarning = response.fraud_warning ? 1 : 0;
      cachedUntil = addSeconds(now, 86400); // 24h
      break;
    }
    case "MISMATCHED": {
      status = "UNMATCHED";
      matchScore = response.match_score;
      cachedUntil = addSeconds(now, 86400); // 24h
      break;
    }
    case "NOT_FOUND": {
      status = "NOT_FOUND";
      cachedUntil = addSeconds(now, 3600); // 1h
      break;
    }
    default: {
      status = "ERROR";
      break;
    }
  }

  // `target_account_name` is deliberately left as-is (NULL): the bank returns
  // only the name the requester supplied, never the one it holds on file, so ZC
  // has nothing to record here (`32_api_contracts.md § account-verify`).
  await db
    .prepare(
      `UPDATE AccountVerifications
     SET status = ?,
         name_provided = COALESCE(?, name_provided),
         match_score = ?,
         fraud_warning = ?,
         cached_until = ?,
         responded_at = ?
     WHERE verification_id = ?`
    )
    .bind(
      status,
      response.result === "NOT_FOUND" ? null : response.name_provided,
      matchScore,
      fraudWarning,
      cachedUntil,
      now,
      verificationId
    )
    .run();
}

// ---------------------------------------------------------------------------
// getVerificationResult
// ---------------------------------------------------------------------------
/** Return the AccountVerifications record associated with verification_id. */
export async function getVerificationResult(
  db: D1Database,
  verificationId: string
): Promise<AccountVerificationRow | null> {
  return db
    .prepare(`SELECT * FROM AccountVerifications WHERE verification_id = ?`)
    .bind(verificationId)
    .first<AccountVerificationRow>();
}

// ---------------------------------------------------------------------------
// batchVerify
// ---------------------------------------------------------------------------
/**
 * Verify multiple accounts in a single batch.
 * Calls requestAccountVerification for each item and returns an array of results.
 */
export async function batchVerify(
  db: D1Database,
  req: AccountVerifyBatchRequest,
  env: Env
): Promise<Array<{ verification_id: string; status: VerificationStatus }>> {
  const results: Array<{ verification_id: string; status: VerificationStatus }> = [];

  for (let i = 0; i < req.items.length; i++) {
    const item = req.items[i];
    if (!item) continue;
    const verificationId = newUUID();
    const itemIdemKey = `${req.idempotency_key}-${i}`;

    try {
      const vid = await requestAccountVerification(
        db,
        {
          verification_id: verificationId,
          request_bank_id: req.request_bank_id,
          target_bank_id: item.target_bank_id,
          target_account_id: item.target_account_id,
          name_to_verify: item.name_to_verify,
          idempotency_key: itemIdemKey,
        },
        env
      );

      const row = await getVerificationResult(db, vid);
      results.push({
        verification_id: vid,
        status: (row?.status ?? "ERROR") as VerificationStatus,
      });
    } catch (err) {
      console.error("[AccountVerify] batch item error:", err);
      results.push({ verification_id: verificationId, status: "ERROR" });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Add seconds to an ISO string and return a new ISO string */
function addSeconds(isoStr: string, secs: number): string {
  return new Date(new Date(isoStr).getTime() + secs * 1000).toISOString();
}
