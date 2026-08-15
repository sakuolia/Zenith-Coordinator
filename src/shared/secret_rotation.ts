/**
 * @file secret_rotation.ts — bounded overlap window for the shared HMAC secret.
 *
 * `ZC_HMAC_SECRET` is a symmetric secret every participant holds. Rotating it
 * without an overlap window is an all-or-nothing cutover: the instant ZC starts
 * verifying against the new secret, every counterparty still signing with the
 * old one gets 401 — so in practice the rotation never happens, which is the
 * worse outcome for a credential that is shared this widely.
 *
 * The overlap is deliberately **asymmetric and time-bounded**:
 *
 *   - **Signing** always uses `ZC_HMAC_SECRET`. There is exactly one current
 *     secret; the previous one is never used to produce a signature, so the
 *     cutover for outbound traffic is atomic.
 *   - **Verification** accepts `ZC_HMAC_SECRET_PREVIOUS` *in addition*, and only
 *     until `ZC_HMAC_SECRET_PREVIOUS_UNTIL` (RFC3339). Past that instant the old
 *     secret stops being accepted with no redeploy — the window closes by the
 *     clock, not by someone remembering to unset a variable.
 *
 * **A previous secret with no deadline is ignored.** That is the fail-closed
 * reading and it is the point of the feature: an unbounded second valid secret
 * is not an overlap window, it is two live credentials, which is the state this
 * module exists to prevent. The same applies to an unparseable or already-past
 * deadline. Each case logs a warning so a misconfigured rotation is visible in
 * the operator's logs rather than silently degrading to "old secret works
 * forever".
 *
 * @module shared/secret_rotation
 */

import { timingSafeEqualStr, verifySignature } from "./hmac";

/** The env fields this module reads (a subset of `Env`, so tests can pass literals). */
export interface RotatableSecretEnv {
  ZC_HMAC_SECRET?: string;
  /** Secret being retired. Accepted for verification only, and only until the deadline. */
  ZC_HMAC_SECRET_PREVIOUS?: string;
  /** RFC3339 instant after which the previous secret is no longer accepted. */
  ZC_HMAC_SECRET_PREVIOUS_UNTIL?: string;
}

/**
 * Secrets that may currently verify an inbound signature, most-current first.
 *
 * The current secret is always first so the common case costs one HMAC; the
 * previous secret is appended only while its window is open.
 */
export function acceptedHmacSecrets(env: RotatableSecretEnv, now: Date = new Date()): string[] {
  const secrets: string[] = [];
  if (env.ZC_HMAC_SECRET) secrets.push(env.ZC_HMAC_SECRET);

  const previous = env.ZC_HMAC_SECRET_PREVIOUS;
  if (!previous) return secrets;

  const until = env.ZC_HMAC_SECRET_PREVIOUS_UNTIL;
  if (!until) {
    console.warn(
      "[secret_rotation] ZC_HMAC_SECRET_PREVIOUS is set without " +
        "ZC_HMAC_SECRET_PREVIOUS_UNTIL — ignoring it. An overlap window must have " +
        "an end; set the deadline or unset the previous secret."
    );
    return secrets;
  }
  const deadline = Date.parse(until);
  if (Number.isNaN(deadline)) {
    console.warn(
      `[secret_rotation] ZC_HMAC_SECRET_PREVIOUS_UNTIL="${until}" is not a parseable ` +
        "RFC3339 instant — ignoring the previous secret."
    );
    return secrets;
  }
  if (now.getTime() >= deadline) {
    // Expected end state of a rotation, not an error: the window closed and the
    // variables have not been cleaned up yet.
    return secrets;
  }

  // A previous secret identical to the current one adds nothing but an extra
  // HMAC per request.
  if (previous !== env.ZC_HMAC_SECRET) secrets.push(previous);
  return secrets;
}

/**
 * Verify an `X-ZC-Signature` against every secret whose window is open.
 *
 * Returns false when no secret is configured at all: callers gate on
 * {@link hmacVerificationConfigured} first, so reaching here with no secret
 * means "cannot verify", which must not read as "verified".
 */
export async function verifySignatureRotating(
  payload: unknown,
  signature: string,
  env: RotatableSecretEnv,
  now: Date = new Date()
): Promise<boolean> {
  for (const secret of acceptedHmacSecrets(env, now)) {
    if (await verifySignature(payload, signature, secret)) return true;
  }
  return false;
}

/** True when at least one secret is available to verify against. */
export function hmacVerificationConfigured(
  env: RotatableSecretEnv,
  now: Date = new Date()
): boolean {
  return acceptedHmacSecrets(env, now).length > 0;
}

/**
 * Constant-time comparison of a caller-supplied bearer/API key against every
 * accepted secret.
 *
 * Every candidate is compared even after a match so the answer does not leak
 * *which* secret matched through timing — during an overlap window that would
 * tell an attacker whether a captured key is the current or the retiring one.
 */
export function matchesAcceptedSecret(
  provided: string | null | undefined,
  env: RotatableSecretEnv,
  now: Date = new Date()
): boolean {
  if (!provided) return false;
  let matched = false;
  for (const secret of acceptedHmacSecrets(env, now)) {
    if (timingSafeEqualStr(secret, provided)) matched = true;
  }
  return matched;
}
