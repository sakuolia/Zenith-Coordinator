/**
 * @file api_auth.ts — the outer gate on `/api/*`.
 *
 * One rule, stated in one place because it is the perimeter: **a caller reaching
 * the ZC Core API is authenticated by a credential, or not at all.**
 *
 * The gate used to also admit any request whose `Origin` header was absent or
 * matched the Worker's own origin, reasoning that a browser omits `Origin` on
 * same-origin GETs — so its absence meant "this is our own dashboard". It does
 * not. `Origin` is a *browser* header: curl, a script, and any server-to-server
 * caller omit it by default. The condition therefore admitted precisely the
 * callers it was written to exclude, and the entire ZC Core API was reachable
 * without a key by anyone who could reach the Worker.
 *
 * **No header can fix that**, and the shape of the mistake is worth keeping
 * visible: request headers are attacker-controlled, so any keyless allowance is
 * forgeable by whoever the check was supposed to exclude. `Sec-Fetch-Site` is
 * the tempting replacement — a browser refuses to let a page set it — but curl
 * sets it freely, so against a non-browser attacker it proves nothing.
 *
 * What remains is a deployment choice, not an inference: the bundled demo
 * dashboards can be served an unauthenticated API if — and only if — the
 * operator sets `ZC_ALLOW_UNAUTHENTICATED_UI="true"`. Default off, so a
 * deployment that says nothing is closed. The same-origin test is kept on top of
 * the flag as a courtesy to the browser case; it is not a second factor, and a
 * deployment with the flag on has made its API public.
 *
 * @module shared/api_auth
 */

import { matchesAcceptedSecret, type RotatableSecretEnv } from "./secret_rotation";

export interface ApiAuthEnv extends RotatableSecretEnv {
  /** `"true"` opts into serving `/api/*` without a credential. Anything else is off. */
  ZC_ALLOW_UNAUTHENTICATED_UI?: string;
}

export interface ApiAuthDecision {
  allowed: boolean;
  /**
   * `KEY` — a valid credential was presented.
   * `UI_FALLBACK` — no credential; admitted only by the explicit opt-in flag.
   * `DENIED` — no credential and no opt-in.
   */
  via: "KEY" | "UI_FALLBACK" | "DENIED";
}

/** Read the bearer/API key a caller presented, in either accepted form. */
function presentedKey(req: Request): string | undefined {
  return (
    req.headers.get("X-Api-Key") ??
    req.headers.get("Authorization")?.replace("Bearer ", "") ??
    undefined
  );
}

/**
 * Decide whether a `/api/*` request may proceed.
 *
 * `requestOrigin` is the Worker's own origin (`new URL(req.url).origin`), passed
 * in so this stays a pure function of its inputs.
 */
export function decideApiAuth(
  req: Request,
  env: ApiAuthEnv,
  requestOrigin: string,
  now: Date = new Date()
): ApiAuthDecision {
  // Constant-time, and accepts the retiring secret while its rotation window is
  // open (secret_rotation.ts).
  if (matchesAcceptedSecret(presentedKey(req), env, now)) return { allowed: true, via: "KEY" };

  if (env.ZC_ALLOW_UNAUTHENTICATED_UI !== "true") return { allowed: false, via: "DENIED" };

  const origin = req.headers.get("Origin");
  const sameOrigin = !origin || origin === requestOrigin;
  return sameOrigin ? { allowed: true, via: "UI_FALLBACK" } : { allowed: false, via: "DENIED" };
}
