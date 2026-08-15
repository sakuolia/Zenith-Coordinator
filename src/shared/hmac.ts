/**
 * @file HMAC-SHA256 signing and verification using the Web Crypto API.
 *
 * All cryptographic operations use `globalThis.crypto.subtle` (available in
 * Cloudflare Workers). Node.js `crypto` module is NOT used.
 *
 * @module shared/hmac
 */

// V8 perf: a single shared TextEncoder per isolate. Constructing TextEncoder
// is cheap but non-zero, and signPayload/sha256hex are called multiple times
// per transaction. Reusing one instance avoids the allocation and gives V8 a
// monomorphic call-site for `enc.encode(...)`.
const ENC = new TextEncoder();

// HMAC CryptoKey cache. crypto.subtle.importKey is async and not free; the
// secret is essentially constant per Worker isolate (env.ZC_HMAC_SECRET), so
// caching by secret string makes every signature after the first one a single
// crypto.subtle.sign() call. Keyed by the raw secret string — Workers run in a
// trusted isolate, so leaking a key into a Map is not a meaningful concern.
const HMAC_KEY_CACHE = new Map<string, Promise<CryptoKey>>();

function getHmacKey(secret: string): Promise<CryptoKey> {
  let p = HMAC_KEY_CACHE.get(secret);
  if (p) return p;
  p = crypto.subtle.importKey("raw", ENC.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  HMAC_KEY_CACHE.set(secret, p);
  return p;
}

/**
 * Sign a payload with HMAC-SHA256 and return the hex digest.
 *
 * If `payload` is not already a string it is JSON-stringified first.
 *
 * @param payload - The data to sign (object or string)
 * @param secret  - The shared HMAC secret
 * @returns Hex-encoded HMAC-SHA256 signature
 */
export async function signPayload(payload: unknown, secret: string): Promise<string> {
  const msgData = ENC.encode(typeof payload === "string" ? payload : JSON.stringify(payload));
  const cryptoKey = await getHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  return bufToHex(sig);
}

/**
 * Verify an X-ZC-Signature header against a payload.
 *
 * Uses constant-time comparison to mitigate timing attacks.
 *
 * @param payload   - The original payload that was signed
 * @param signature - The hex signature to verify
 * @param secret    - The shared HMAC secret
 * @returns `true` if the signature is valid
 */
export async function verifySignature(
  payload: unknown,
  signature: string,
  secret: string
): Promise<boolean> {
  const expected = await signPayload(payload, secret);
  return timingSafeEqualStr(expected, signature);
}

/**
 * Constant-time string equality for secrets/MACs over ASCII (hex signatures,
 * shared admin secrets, etc.). A plain `a === b` short-circuits on the first
 * differing byte, leaking the length of the matching prefix through timing; an
 * attacker can use that to recover a secret byte-by-byte. This compares every
 * position regardless. Length mismatch returns false (the length itself is not
 * secret for fixed-width MACs; for variable-width secrets it only reveals the
 * length, not the content).
 *
 * @param a - first string (e.g. the expected secret)
 * @param b - second string (e.g. the supplied value)
 * @returns `true` iff the strings are equal
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // ASCII strings compare in constant time via charCodeAt without a
  // per-call TextEncoder allocation.
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Compute a SHA-256 hash and return it as a hex string.
 *
 * @param data - The input string to hash
 * @returns 64-character hex-encoded SHA-256 digest
 */
export async function sha256hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", ENC.encode(data));
  return bufToHex(buf);
}

// Pre-built byte→hex lookup table. Avoids per-call .toString(16)/.padStart()
// which are dominant costs in this hot path (FinalityLog, signing, idempotency).
// Each lookup is a property load on a 256-entry frozen array — V8 can keep this
// as a PACKED_ELEMENTS array with monomorphic load shape.
const HEX_BYTE_TABLE: readonly string[] = (() => {
  const t = new Array<string>(256);
  for (let i = 0; i < 256; i++) t[i] = (i < 16 ? "0" : "") + i.toString(16);
  return t;
})();

function bufToHex(buf: ArrayBuffer): string {
  // Single-pass over a typed array, no intermediate Array allocation, no
  // per-byte toString/padStart, no .map/.join chain. Concatenation into a
  // local string is amortized O(n) on V8's cons-string fast path.
  const bytes = new Uint8Array(buf);
  const len = bytes.length;
  let out = "";
  for (let i = 0; i < len; i++) {
    out += HEX_BYTE_TABLE[bytes[i]!];
  }
  return out;
}
