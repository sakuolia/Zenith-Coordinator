/**
 * @file Verification of externally-signed payloads against `KeyRegistry`.
 *
 * This is the trust-anchor layer that `SettlementProofRef`, `Attestation`,
 * `Mandate`, and transparency anchoring/counter-signatures all build on.
 *
 * ZC only ever holds *verification* (public) keys for parties other than
 * itself — participants, attesters, agents, external rails / Watchers. ZC's
 * own egress signing continues to use the existing single-secret HMAC
 * (`src/shared/hmac.ts`) and is out of scope here.
 *
 * Supported algorithms: ECDSA P-256 and Ed25519, both verified via
 * `crypto.subtle` using raw-encoded public keys (base64).
 *
 * Trust evaluation for a claimed signature is "is this key valid *as of the
 * signer's claimed `occurred_at`*":
 *   - `occurred_at` must fall within `[valid_from, valid_to)` (or `valid_to`
 *     is NULL = open-ended).
 *   - If `revoked_at` is set, `occurred_at` must be strictly before it.
 *     Revocation is immediate and does NOT retroactively invalidate prior
 *     signatures.
 *   - `status` must be `'ACTIVE'`.
 *
 * Replay protection for (`key_id`, `nonce`) piggybacks on the existing
 * `IdempotencyKeys` table via `acquireIdempotency` — no separate nonce table.
 *
 * @module shared/external_signature
 */
import type { KeyAlgo, KeyRegistryRow } from "../types";
import { DomainError } from "./errors";
import { acquireIdempotency } from "./idempotency";

const ENC = new TextEncoder();

/** Maximum allowed difference between `occurred_at` and the verifier's clock. */
export const SIGNATURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes

/** WebCrypto algorithm parameters for a given KeyRegistry `algo`. */
function algoParams(algo: KeyAlgo): SubtleCryptoImportKeyAlgorithm {
  if (algo === "ECDSA_P256") {
    return { name: "ECDSA", namedCurve: "P-256" };
  }
  return { name: "Ed25519" };
}

/** Algorithm parameters to pass to `crypto.subtle.verify`. */
function verifyParams(algo: KeyAlgo): SubtleCryptoSignAlgorithm {
  if (algo === "ECDSA_P256") {
    return { name: "ECDSA", hash: "SHA-256" };
  }
  return { name: "Ed25519" };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Import a KeyRegistry public key (base64 raw bytes) as a `CryptoKey` for
 * `crypto.subtle.verify`.
 */
export async function importVerificationKey(
  algo: KeyAlgo,
  publicKeyB64: string
): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64ToBytes(publicKeyB64), algoParams(algo), false, [
    "verify",
  ]);
}

/**
 * Export a generated public `CryptoKey` to the base64-encoded raw form stored
 * in `KeyRegistry.public_key`. Used by tests and key-provisioning tooling.
 */
export async function exportVerificationKey(publicKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", publicKey);
  return bytesToBase64(new Uint8Array(raw as ArrayBuffer));
}

/**
 * Build the canonical byte sequence that an external signer must sign.
 *
 * Binds the application payload to the replay-protection fields (`key_id`,
 * `nonce`, `occurred_at`) so a signature cannot be replayed under a different
 * key/nonce/timestamp.
 */
export function buildSignedMessage(
  payload: unknown,
  keyId: string,
  nonce: string,
  occurredAt: string
): Uint8Array {
  const canonical = JSON.stringify({ key_id: keyId, nonce, occurred_at: occurredAt, payload });
  return ENC.encode(canonical);
}

/** Look up a KeyRegistry row, raising `KEY_NOT_FOUND` if absent. */
export async function getKey(db: D1Database, keyId: string): Promise<KeyRegistryRow> {
  const row = await db
    .prepare(`SELECT * FROM KeyRegistry WHERE key_id = ?`)
    .bind(keyId)
    .first<KeyRegistryRow>();
  if (!row) {
    throw new DomainError("KEY_NOT_FOUND", `KeyRegistry entry not found: ${keyId}`, {
      key_id: keyId,
    });
  }
  return row;
}

/**
 * Check that a KeyRegistry row was valid (active, unrevoked, within its
 * validity window) as of `occurredAt`. Does not perform any signature math.
 */
export function assertKeyValidAt(key: KeyRegistryRow, occurredAt: string): void {
  if (key.status !== "ACTIVE") {
    throw new DomainError("KEY_EXPIRED", `Key ${key.key_id} is not active (status=${key.status})`, {
      key_id: key.key_id,
      status: key.status,
    });
  }
  if (occurredAt < key.valid_from || (key.valid_to !== null && occurredAt >= key.valid_to)) {
    throw new DomainError("KEY_EXPIRED", `Key ${key.key_id} is not valid at ${occurredAt}`, {
      key_id: key.key_id,
      valid_from: key.valid_from,
      valid_to: key.valid_to,
      occurred_at: occurredAt,
    });
  }
  if (key.revoked_at !== null && occurredAt >= key.revoked_at) {
    throw new DomainError("KEY_REVOKED", `Key ${key.key_id} was revoked before ${occurredAt}`, {
      key_id: key.key_id,
      revoked_at: key.revoked_at,
      occurred_at: occurredAt,
    });
  }
}

/**
 * Reject `occurred_at` values too far from "now" in either direction.
 *
 * `maxSkewMs` defaults to `SIGNATURE_SKEW_MS` (5 minutes), appropriate for
 * payloads representing a live action signed essentially at call time
 * (Mandate registration, Watcher observations, FinalityLog co-signing,
 * SettlementProofRef). A caller whose payload has its own, wider,
 * purpose-built freshness rule (e.g. Attestation's documented 60-minute
 * window, see `ATTESTATION_DEFAULT_TTL_SECONDS`) should pass a `maxSkewMs`
 * that is *wider* than that rule's own window, so this generic check only
 * ever catches grossly stale/clock-bogus timestamps and the narrower,
 * business-specific rule remains the operative — and reachable — gate.
 */
export function assertTimestampFresh(
  occurredAt: string,
  now: Date = new Date(),
  maxSkewMs: number = SIGNATURE_SKEW_MS
): void {
  const occurred = Date.parse(occurredAt);
  if (Number.isNaN(occurred)) {
    throw new DomainError("TIMESTAMP_SKEW", `occurred_at is not a valid timestamp: ${occurredAt}`, {
      occurred_at: occurredAt,
    });
  }
  if (Math.abs(now.getTime() - occurred) > maxSkewMs) {
    throw new DomainError(
      "TIMESTAMP_SKEW",
      `occurred_at ${occurredAt} is outside the allowed skew`,
      {
        occurred_at: occurredAt,
        skew_ms: maxSkewMs,
      }
    );
  }
}

export interface VerifyExternalSignatureParams {
  /** KeyRegistry.key_id of the claimed signer. */
  keyId: string;
  /** Unique-per-(key_id) nonce supplied by the signer, for replay protection. */
  nonce: string;
  /** RFC3339 timestamp claimed by the signer. */
  occurredAt: string;
  /** Base64-encoded signature over `buildSignedMessage(payload, keyId, nonce, occurredAt)`. */
  signatureB64: string;
  /** The application payload that was signed. */
  payload: unknown;
  /**
   * Override the timestamp-skew tolerance (default `SIGNATURE_SKEW_MS`).
   * Only set this when the caller has its own, wider, documented freshness
   * rule that should be the actual operative gate — see `assertTimestampFresh`.
   */
  maxSkewMs?: number;
}

/**
 * Verify an externally-signed payload end to end:
 *
 *  1. Look up `key_id` in `KeyRegistry` (`KEY_NOT_FOUND`).
 *  2. Check `occurred_at` is fresh (`TIMESTAMP_SKEW`).
 *  3. Check the key was valid at `occurred_at` (`KEY_EXPIRED` / `KEY_REVOKED`).
 *  4. Verify the cryptographic signature (`EXTERNAL_SIGNATURE_INVALID`).
 *  5. Atomically claim (`key_id`, `nonce`) via `IdempotencyKeys` to prevent
 *     replay (`SIGNATURE_REPLAYED`).
 *
 * On success, returns the verified `KeyRegistryRow`. Throws `DomainError`
 * with the reason codes above on any failure. Steps 1-4 are read-only and
 * side-effect free; only step 5 mutates state, and it is performed last so a
 * failed verification never consumes a nonce.
 */
export async function verifyExternalSignature(
  db: D1Database,
  params: VerifyExternalSignatureParams,
  now: Date = new Date()
): Promise<KeyRegistryRow> {
  const key = await getKey(db, params.keyId);
  assertTimestampFresh(params.occurredAt, now, params.maxSkewMs);
  assertKeyValidAt(key, params.occurredAt);

  const cryptoKey = await importVerificationKey(key.algo, key.public_key);
  const message = buildSignedMessage(params.payload, params.keyId, params.nonce, params.occurredAt);
  const ok = await crypto.subtle.verify(
    verifyParams(key.algo),
    cryptoKey,
    base64ToBytes(params.signatureB64),
    message
  );
  if (!ok) {
    throw new DomainError(
      "EXTERNAL_SIGNATURE_INVALID",
      `Signature verification failed for key ${params.keyId}`,
      {
        key_id: params.keyId,
      }
    );
  }

  const replayKey = `sig:${params.keyId}:${params.nonce}`;
  const acquired = await acquireIdempotency(replayKey, db);
  if (!acquired) {
    throw new DomainError(
      "SIGNATURE_REPLAYED",
      `Nonce ${params.nonce} already used for key ${params.keyId}`,
      {
        key_id: params.keyId,
        nonce: params.nonce,
      }
    );
  }

  return key;
}
