/**
 * @file api_auth.test.ts — the `/api/*` perimeter admits credentials, not
 *       inferences.
 *
 * The gate previously allowed any request whose `Origin` header was absent,
 * treating absence as "a browser on our own origin". Absence means nothing of
 * the sort: curl and every other non-browser client omit `Origin` by default, so
 * the check admitted exactly the callers it was written to exclude and left the
 * whole ZC Core API keyless to anyone who could reach the Worker.
 *
 * The first test below is the regression, written as the attacker's request: no
 * key, no headers at all. If it ever passes with the flag off, the perimeter is
 * open again.
 */
import { describe, expect, it } from "vitest";
import { decideApiAuth, type ApiAuthEnv } from "../../src/shared/api_auth";

const ORIGIN = "https://zc.example";
const KEY = "the-api-key";

const req = (headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/transactions/TX-1`, { headers });

const CLOSED: ApiAuthEnv = { ZC_HMAC_SECRET: KEY };
const OPEN_UI: ApiAuthEnv = { ZC_HMAC_SECRET: KEY, ZC_ALLOW_UNAUTHENTICATED_UI: "true" };

describe("no credential, no access (default)", () => {
  it("denies a request with no key and no headers — the curl case", () => {
    // The regression: this used to be allowed, because `Origin` was absent.
    expect(decideApiAuth(req(), CLOSED, ORIGIN)).toEqual({ allowed: false, via: "DENIED" });
  });

  it("denies even when the caller claims the right Origin", () => {
    // Headers are attacker-controlled: asserting the origin proves nothing.
    expect(decideApiAuth(req({ Origin: ORIGIN }), CLOSED, ORIGIN).allowed).toBe(false);
  });

  it("denies a caller asserting browser fetch metadata", () => {
    // `Sec-Fetch-Site` is unforgeable *by a page*, not by a client. curl sets it.
    const r = req({ "Sec-Fetch-Site": "same-origin", Origin: ORIGIN });
    expect(decideApiAuth(r, CLOSED, ORIGIN).allowed).toBe(false);
  });

  it("denies a wrong key", () => {
    expect(decideApiAuth(req({ "X-Api-Key": "guess" }), CLOSED, ORIGIN).allowed).toBe(false);
  });

  it("denies everything when the deployment has no secret configured", () => {
    expect(decideApiAuth(req({ "X-Api-Key": KEY }), {}, ORIGIN).allowed).toBe(false);
  });
});

describe("a valid credential is accepted in either form", () => {
  it("accepts X-Api-Key", () => {
    expect(decideApiAuth(req({ "X-Api-Key": KEY }), CLOSED, ORIGIN)).toEqual({
      allowed: true,
      via: "KEY",
    });
  });

  it("accepts Authorization: Bearer", () => {
    expect(decideApiAuth(req({ Authorization: `Bearer ${KEY}` }), CLOSED, ORIGIN).via).toBe("KEY");
  });

  it("accepts the retiring secret while its rotation window is open", () => {
    const env: ApiAuthEnv = {
      ZC_HMAC_SECRET: KEY,
      ZC_HMAC_SECRET_PREVIOUS: "old-key",
      ZC_HMAC_SECRET_PREVIOUS_UNTIL: "2026-07-09T00:00:00Z",
    };
    const inside = new Date("2026-07-01T00:00:00Z");
    const after = new Date("2026-07-09T00:00:01Z");
    expect(decideApiAuth(req({ "X-Api-Key": "old-key" }), env, ORIGIN, inside).allowed).toBe(true);
    expect(decideApiAuth(req({ "X-Api-Key": "old-key" }), env, ORIGIN, after).allowed).toBe(false);
  });
});

describe("the keyless UI path is an explicit deployment choice", () => {
  it('stays closed unless the flag is exactly "true"', () => {
    for (const value of ["false", "1", "yes", "TRUE", ""]) {
      const env: ApiAuthEnv = { ZC_HMAC_SECRET: KEY, ZC_ALLOW_UNAUTHENTICATED_UI: value };
      expect(decideApiAuth(req(), env, ORIGIN).allowed, `flag=${value}`).toBe(false);
    }
  });

  it("admits a same-origin keyless call once opted in, and says so", () => {
    expect(decideApiAuth(req({ Origin: ORIGIN }), OPEN_UI, ORIGIN)).toEqual({
      allowed: true,
      via: "UI_FALLBACK",
    });
    // The caller is reported as UI_FALLBACK rather than KEY so the entry point
    // can log that the API was served without a credential.
    expect(decideApiAuth(req(), OPEN_UI, ORIGIN).via).toBe("UI_FALLBACK");
  });

  it("still refuses a cross-origin page even with the flag on", () => {
    const r = req({ Origin: "https://attacker.example" });
    expect(decideApiAuth(r, OPEN_UI, ORIGIN).allowed).toBe(false);
  });
});
