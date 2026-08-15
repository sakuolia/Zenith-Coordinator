/**
 * @file zc_signature.test.ts — ZC asymmetric egress signing (replacing single HMAC).
 *
 * Proves the round trip a participant performs: ZC signs an egress payload with
 * its PRIVATE key; the participant verifies against ZC's PUBLIC key in
 * KeyRegistry (owner_type='ZC'). Also pins the failure modes that make the
 * change worth doing — a tampered payload, a non-ZC key, and an unconfigured env.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  signAsZc,
  signAsZcFromEnv,
  verifyZcSignature,
  zcSigningConfigured,
  zcSignatureHeaders,
  readZcSignatureHeaders,
} from "../../src/shared/zc_signature";
import { exportVerificationKey } from "../../src/shared/external_signature";
import { isDomainError } from "../../src/shared/errors";

let d1: MockD1Database;

function bytesToBase64(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString("base64");
}

/** Generate an ECDSA P-256 keypair; return { keyId pkcs8(private b64), raw(public b64) }. */
async function genEcdsaKey() {
  const { privateKey, publicKey } = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const pkcs8 = bytesToBase64(await crypto.subtle.exportKey("pkcs8", privateKey));
  const rawPub = await exportVerificationKey(publicKey);
  return { pkcs8, rawPub };
}

/** Register a KeyRegistry row. */
async function registerKey(keyId: string, ownerType: string, ownerRef: string, rawPubB64: string) {
  await d1
    .prepare(
      `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
       VALUES (?, ?, ?, ?, 'ECDSA_P256', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
    )
    .bind(keyId, ownerType, ownerRef, rawPubB64)
    .run();
}

beforeEach(() => {
  ({ d1 } = createTestDb());
});

describe("ZC asymmetric egress signing", () => {
  it("signs as ZC and verifies against the KeyRegistry public key", async () => {
    const { pkcs8, rawPub } = await genEcdsaKey();
    await registerKey("ZC-KEY-1", "ZC", "ZC", rawPub);

    const payload = { verification_id: "V-1", account_id: "0020000001" };
    const bundle = await signAsZc({
      keyId: "ZC-KEY-1",
      privateKeyPkcs8B64: pkcs8,
      algo: "ECDSA_P256",
      payload,
    });

    const key = await verifyZcSignature(d1 as any, payload, bundle);
    expect(key.key_id).toBe("ZC-KEY-1");
    expect(key.owner_type).toBe("ZC");
  });

  it("rejects a tampered payload", async () => {
    const { pkcs8, rawPub } = await genEcdsaKey();
    await registerKey("ZC-KEY-1", "ZC", "ZC", rawPub);

    const bundle = await signAsZc({
      keyId: "ZC-KEY-1",
      privateKeyPkcs8B64: pkcs8,
      algo: "ECDSA_P256",
      payload: { amount: 100 },
    });
    await expect(verifyZcSignature(d1 as any, { amount: 999 }, bundle)).rejects.toMatchObject({
      reason_code: "EXTERNAL_SIGNATURE_INVALID",
    });
  });

  it("rejects a valid signature from a non-ZC key (owner_type guard)", async () => {
    const { pkcs8, rawPub } = await genEcdsaKey();
    // Same key material, but registered as a PARTICIPANT — must not pass as ZC.
    await registerKey("BANK-KEY-1", "PARTICIPANT", "001", rawPub);

    const payload = { x: 1 };
    const bundle = await signAsZc({
      keyId: "BANK-KEY-1",
      privateKeyPkcs8B64: pkcs8,
      algo: "ECDSA_P256",
      payload,
    });
    try {
      await verifyZcSignature(d1 as any, payload, bundle);
      throw new Error("expected rejection");
    } catch (e) {
      expect(isDomainError(e) && e.reason_code === "ZC_SIGNATURE_WRONG_OWNER").toBe(true);
    }
  });

  it("a replayed nonce is rejected on the second verify", async () => {
    const { pkcs8, rawPub } = await genEcdsaKey();
    await registerKey("ZC-KEY-1", "ZC", "ZC", rawPub);
    const payload = { x: 1 };
    const bundle = await signAsZc({
      keyId: "ZC-KEY-1",
      privateKeyPkcs8B64: pkcs8,
      algo: "ECDSA_P256",
      payload,
    });

    await verifyZcSignature(d1 as any, payload, bundle); // consumes the nonce
    await expect(verifyZcSignature(d1 as any, payload, bundle)).rejects.toMatchObject({
      reason_code: "SIGNATURE_REPLAYED",
    });
  });

  it("zcSigningConfigured + signAsZcFromEnv gate on a complete env", async () => {
    const { pkcs8, rawPub } = await genEcdsaKey();
    await registerKey("ZC-KEY-1", "ZC", "ZC", rawPub);

    const bareEnv = { DB: d1, ZC_HMAC_SECRET: "s" } as any;
    expect(zcSigningConfigured(bareEnv)).toBe(false);
    await expect(signAsZcFromEnv(bareEnv, { x: 1 })).rejects.toMatchObject({
      reason_code: "ZC_SIGNING_NOT_CONFIGURED",
    });

    const signedEnv = {
      DB: d1,
      ZC_HMAC_SECRET: "s",
      ZC_SIGNING_KEY_ID: "ZC-KEY-1",
      ZC_SIGNING_KEY_PKCS8: pkcs8,
      ZC_SIGNING_ALGO: "ECDSA_P256",
    } as any;
    expect(zcSigningConfigured(signedEnv)).toBe(true);
    const bundle = await signAsZcFromEnv(signedEnv, { x: 1 });
    const key = await verifyZcSignature(d1 as any, { x: 1 }, bundle);
    expect(key.owner_type).toBe("ZC");
  });

  it("header round-trips through write + read", async () => {
    const { pkcs8 } = await genEcdsaKey();
    const bundle = await signAsZc({
      keyId: "ZC-KEY-1",
      privateKeyPkcs8B64: pkcs8,
      algo: "ECDSA_P256",
      payload: { x: 1 },
    });
    const headers = new Headers(zcSignatureHeaders(bundle));
    const read = readZcSignatureHeaders(headers);
    expect(read).toEqual(bundle);
    // A request with no ZC headers reads back null (verifier falls through to HMAC).
    expect(readZcSignatureHeaders(new Headers({ "X-ZC-Signature": "legacy-hmac" }))).toBeNull();
  });
});
