/**
 * @file zc_signature.ts — ZC's OWN egress signing (asymmetric).
 *
 * Historically ZC signed every outbound request with a single shared
 * HMAC-SHA256 secret (`ZC_HMAC_SECRET`) — a symmetric key every participant
 * holds, so any holder could forge ZC's signature and rotation is all-or-nothing.
 * This module lets ZC instead sign with an ASYMMETRIC private key; participants
 * verify against ZC's PUBLIC key in `KeyRegistry` (`owner_type='ZC'`), exactly
 * like every other external signer the system already verifies
 * (`external_signature.ts`). The private key never leaves ZC (an HSM-backed
 * binding in production); rotation is per-`key_id`.
 *
 * Wire contract (headers on a ZC egress request):
 *   X-ZC-Key-Id     KeyRegistry key_id of the signing key (presence selects this
 *                   path over legacy HMAC on the verifier).
 *   X-ZC-Sig-Nonce  unique-per-key nonce (replay protection).
 *   X-ZC-Sig-Time   RFC3339 signing time.
 *   X-ZC-Signature  base64 signature over buildSignedMessage(payload, …).
 *
 * The signed bytes are identical to the external-signer canonicalization
 * (`buildSignedMessage`), so `verifyExternalSignature` verifies a ZC signature
 * with no special-casing — `verifyZcSignature` only adds the `owner_type='ZC'`
 * assertion on top.
 *
 * @module shared/zc_signature
 */
import type { Env } from "../types";
import { nowISO } from "../types";
import type { KeyAlgo, KeyRegistryRow } from "../types";
import { DomainError } from "./errors";
import { newUUID } from "./idempotency";
import { buildSignedMessage, verifyExternalSignature } from "./external_signature";

/** Header names carrying a ZC asymmetric egress signature. */
export const ZC_SIG_HEADERS = {
  keyId: "X-ZC-Key-Id",
  nonce: "X-ZC-Sig-Nonce",
  time: "X-ZC-Sig-Time",
  signature: "X-ZC-Signature",
} as const;

/** True when the env carries a complete ZC asymmetric signing key configuration. */
export function zcSigningConfigured(env: Env): boolean {
  return !!(env.ZC_SIGNING_KEY_ID && env.ZC_SIGNING_KEY_PKCS8);
}

function normalizeAlgo(algo: string | undefined): KeyAlgo {
  return algo === "ED25519" ? "ED25519" : "ECDSA_P256";
}

function signParams(algo: KeyAlgo): SubtleCryptoSignAlgorithm {
  return algo === "ECDSA_P256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "Ed25519" };
}

function importParams(algo: KeyAlgo): SubtleCryptoImportKeyAlgorithm {
  return algo === "ECDSA_P256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "Ed25519" };
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

/** A fully-formed ZC egress signature bundle, ready to attach as headers. */
export interface ZcSignatureBundle {
  keyId: string;
  nonce: string;
  occurredAt: string;
  signatureB64: string;
}

/** Render a {@link ZcSignatureBundle} as the canonical request headers. */
export function zcSignatureHeaders(bundle: ZcSignatureBundle): Record<string, string> {
  return {
    [ZC_SIG_HEADERS.keyId]: bundle.keyId,
    [ZC_SIG_HEADERS.nonce]: bundle.nonce,
    [ZC_SIG_HEADERS.time]: bundle.occurredAt,
    [ZC_SIG_HEADERS.signature]: bundle.signatureB64,
  };
}

/** Read a {@link ZcSignatureBundle} from request headers, or null if absent. */
export function readZcSignatureHeaders(headers: Headers): ZcSignatureBundle | null {
  const keyId = headers.get(ZC_SIG_HEADERS.keyId);
  const nonce = headers.get(ZC_SIG_HEADERS.nonce);
  const occurredAt = headers.get(ZC_SIG_HEADERS.time);
  const signatureB64 = headers.get(ZC_SIG_HEADERS.signature);
  if (!keyId || !nonce || !occurredAt || !signatureB64) return null;
  return { keyId, nonce, occurredAt, signatureB64 };
}

/**
 * Sign a payload as ZC with an explicit PKCS#8 private key. Lower-level entry
 * used by tests and provisioning; most callers use {@link signAsZcFromEnv}.
 */
export async function signAsZc(params: {
  keyId: string;
  privateKeyPkcs8B64: string;
  algo: KeyAlgo;
  payload: unknown;
  nonce?: string;
  occurredAt?: string;
}): Promise<ZcSignatureBundle> {
  const nonce = params.nonce ?? newUUID();
  const occurredAt = params.occurredAt ?? nowISO();
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    base64ToBytes(params.privateKeyPkcs8B64),
    importParams(params.algo),
    false,
    ["sign"]
  );
  const message = buildSignedMessage(params.payload, params.keyId, nonce, occurredAt);
  const sig = await crypto.subtle.sign(signParams(params.algo), privateKey, message);
  return {
    keyId: params.keyId,
    nonce,
    occurredAt,
    signatureB64: bytesToBase64(new Uint8Array(sig)),
  };
}

/**
 * Sign a payload as ZC using the env-configured signing key. Throws
 * `ZC_SIGNING_NOT_CONFIGURED` when the env lacks a complete key — callers that
 * want a graceful fallback should gate on {@link zcSigningConfigured} first.
 */
export async function signAsZcFromEnv(env: Env, payload: unknown): Promise<ZcSignatureBundle> {
  if (!zcSigningConfigured(env)) {
    throw new DomainError(
      "ZC_SIGNING_NOT_CONFIGURED",
      "ZC asymmetric signing key is not configured",
      {}
    );
  }
  return signAsZc({
    keyId: env.ZC_SIGNING_KEY_ID!,
    privateKeyPkcs8B64: env.ZC_SIGNING_KEY_PKCS8!,
    algo: normalizeAlgo(env.ZC_SIGNING_ALGO),
    payload,
  });
}

/**
 * Verify a ZC egress signature against `KeyRegistry`. Delegates the cryptographic
 * check + freshness + revocation + replay to `verifyExternalSignature`, then
 * asserts the signer is a ZC key (`owner_type='ZC'`) so a participant/attester
 * key can never masquerade as the coordinator. Returns the verified key row.
 */
export async function verifyZcSignature(
  db: D1Database,
  payload: unknown,
  bundle: ZcSignatureBundle
): Promise<KeyRegistryRow> {
  const key = await verifyExternalSignature(db, {
    keyId: bundle.keyId,
    nonce: bundle.nonce,
    occurredAt: bundle.occurredAt,
    signatureB64: bundle.signatureB64,
    payload,
  });
  if (key.owner_type !== "ZC") {
    throw new DomainError(
      "ZC_SIGNATURE_WRONG_OWNER",
      `Key ${key.key_id} (owner_type=${key.owner_type}) is not a ZC signing key`,
      { key_id: key.key_id, owner_type: key.owner_type }
    );
  }
  return key;
}
