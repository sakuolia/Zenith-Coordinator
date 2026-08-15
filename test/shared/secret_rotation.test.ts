/**
 * @file secret_rotation.test.ts — the shared-HMAC overlap window is bounded.
 *
 * The property under test is not "two secrets work" — that is trivial and, left
 * alone, is the failure mode. It is that the second secret works *only inside a
 * declared window*, and that a rotation configured without a deadline degrades
 * to a single secret rather than to two permanent ones.
 */
import { describe, expect, it } from "vitest";
import { signPayload } from "../../src/shared/hmac";
import {
  acceptedHmacSecrets,
  hmacVerificationConfigured,
  matchesAcceptedSecret,
  verifySignatureRotating,
} from "../../src/shared/secret_rotation";

const CURRENT = "current-secret";
const PREVIOUS = "previous-secret";
const PAYLOAD = { txid: "TX-ROT-1", amount: 1000 };

const at = (iso: string) => new Date(iso);
const OPEN = at("2026-07-01T00:00:00Z"); // before the deadline below
const CLOSED = at("2026-07-09T00:00:01Z"); // after it
const UNTIL = "2026-07-09T00:00:00Z";

describe("acceptedHmacSecrets", () => {
  it("is just the current secret when no rotation is in progress", () => {
    expect(acceptedHmacSecrets({ ZC_HMAC_SECRET: CURRENT }, OPEN)).toEqual([CURRENT]);
  });

  it("adds the previous secret while the window is open, current one first", () => {
    const secrets = acceptedHmacSecrets(
      {
        ZC_HMAC_SECRET: CURRENT,
        ZC_HMAC_SECRET_PREVIOUS: PREVIOUS,
        ZC_HMAC_SECRET_PREVIOUS_UNTIL: UNTIL,
      },
      OPEN
    );
    expect(secrets).toEqual([CURRENT, PREVIOUS]);
  });

  it("drops the previous secret once the deadline has passed — no redeploy needed", () => {
    const secrets = acceptedHmacSecrets(
      {
        ZC_HMAC_SECRET: CURRENT,
        ZC_HMAC_SECRET_PREVIOUS: PREVIOUS,
        ZC_HMAC_SECRET_PREVIOUS_UNTIL: UNTIL,
      },
      CLOSED
    );
    expect(secrets).toEqual([CURRENT]);
  });

  it("ignores a previous secret with no deadline (that is two live secrets, not a window)", () => {
    const secrets = acceptedHmacSecrets(
      { ZC_HMAC_SECRET: CURRENT, ZC_HMAC_SECRET_PREVIOUS: PREVIOUS },
      OPEN
    );
    expect(secrets).toEqual([CURRENT]);
  });

  it("ignores a previous secret whose deadline does not parse", () => {
    const secrets = acceptedHmacSecrets(
      {
        ZC_HMAC_SECRET: CURRENT,
        ZC_HMAC_SECRET_PREVIOUS: PREVIOUS,
        ZC_HMAC_SECRET_PREVIOUS_UNTIL: "next tuesday",
      },
      OPEN
    );
    expect(secrets).toEqual([CURRENT]);
  });

  it("does not list the same secret twice when previous == current", () => {
    const secrets = acceptedHmacSecrets(
      {
        ZC_HMAC_SECRET: CURRENT,
        ZC_HMAC_SECRET_PREVIOUS: CURRENT,
        ZC_HMAC_SECRET_PREVIOUS_UNTIL: UNTIL,
      },
      OPEN
    );
    expect(secrets).toEqual([CURRENT]);
  });

  it("reports nothing configured when there is no secret at all", () => {
    expect(acceptedHmacSecrets({}, OPEN)).toEqual([]);
    expect(hmacVerificationConfigured({}, OPEN)).toBe(false);
    expect(hmacVerificationConfigured({ ZC_HMAC_SECRET: CURRENT }, OPEN)).toBe(true);
  });
});

describe("verifySignatureRotating", () => {
  const env = {
    ZC_HMAC_SECRET: CURRENT,
    ZC_HMAC_SECRET_PREVIOUS: PREVIOUS,
    ZC_HMAC_SECRET_PREVIOUS_UNTIL: UNTIL,
  };

  it("accepts a signature made with the current secret", async () => {
    const sig = await signPayload(PAYLOAD, CURRENT);
    expect(await verifySignatureRotating(PAYLOAD, sig, env, OPEN)).toBe(true);
  });

  it("accepts a counterparty still signing with the old secret, inside the window", async () => {
    const sig = await signPayload(PAYLOAD, PREVIOUS);
    expect(await verifySignatureRotating(PAYLOAD, sig, env, OPEN)).toBe(true);
  });

  it("rejects the old secret after the window closes", async () => {
    const sig = await signPayload(PAYLOAD, PREVIOUS);
    expect(await verifySignatureRotating(PAYLOAD, sig, env, CLOSED)).toBe(false);
    // …while the current secret keeps working across the same boundary.
    expect(
      await verifySignatureRotating(PAYLOAD, await signPayload(PAYLOAD, CURRENT), env, CLOSED)
    ).toBe(true);
  });

  it("rejects an unrelated secret in every configuration", async () => {
    const sig = await signPayload(PAYLOAD, "attacker-secret");
    expect(await verifySignatureRotating(PAYLOAD, sig, env, OPEN)).toBe(false);
    expect(await verifySignatureRotating(PAYLOAD, sig, { ZC_HMAC_SECRET: CURRENT }, OPEN)).toBe(
      false
    );
  });

  it("verifies nothing when no secret is configured (cannot-verify is not verified)", async () => {
    const sig = await signPayload(PAYLOAD, CURRENT);
    expect(await verifySignatureRotating(PAYLOAD, sig, {}, OPEN)).toBe(false);
  });

  it("rejects a signature over a different payload", async () => {
    const sig = await signPayload(PAYLOAD, CURRENT);
    expect(await verifySignatureRotating({ ...PAYLOAD, amount: 2 }, sig, env, OPEN)).toBe(false);
  });
});

describe("matchesAcceptedSecret (bearer / API key form)", () => {
  const env = {
    ZC_HMAC_SECRET: CURRENT,
    ZC_HMAC_SECRET_PREVIOUS: PREVIOUS,
    ZC_HMAC_SECRET_PREVIOUS_UNTIL: UNTIL,
  };

  it("accepts either key while the window is open", () => {
    expect(matchesAcceptedSecret(CURRENT, env, OPEN)).toBe(true);
    expect(matchesAcceptedSecret(PREVIOUS, env, OPEN)).toBe(true);
  });

  it("accepts only the current key once the window has closed", () => {
    expect(matchesAcceptedSecret(CURRENT, env, CLOSED)).toBe(true);
    expect(matchesAcceptedSecret(PREVIOUS, env, CLOSED)).toBe(false);
  });

  it("rejects an absent or wrong key, and rejects everything when unconfigured", () => {
    expect(matchesAcceptedSecret(null, env, OPEN)).toBe(false);
    expect(matchesAcceptedSecret("", env, OPEN)).toBe(false);
    expect(matchesAcceptedSecret("nope", env, OPEN)).toBe(false);
    expect(matchesAcceptedSecret(CURRENT, {}, OPEN)).toBe(false);
  });
});
