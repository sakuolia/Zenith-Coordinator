/**
 * @file zc_egress_signing.test.ts — bank ingress dual-accepts ZC's asymmetric
 *       egress signature (X-ZC-Key-Id path) AND the legacy shared HMAC.
 *
 * Drives the real HTTP verifier (handleBankIngressHttp). The command "ping" is
 * unknown, so a request that PASSES auth returns 200 with UNKNOWN_COMMAND, while
 * a request that FAILS auth returns 401 — this isolates the signature gate from
 * any command side effects.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { handleBankIngressHttp } from "../../src/bank/ingress";
import { signAsZc } from "../../src/shared/zc_signature";
import { exportVerificationKey } from "../../src/shared/external_signature";
import { signPayload } from "../../src/shared/hmac";

let d1: MockD1Database;
const HMAC = "legacy-shared-secret";

function bytesToBase64(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString("base64");
}

async function genKey() {
  const { privateKey, publicKey } = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  return {
    pkcs8: bytesToBase64(await crypto.subtle.exportKey("pkcs8", privateKey)),
    rawPub: await exportVerificationKey(publicKey),
  };
}

function makeEnv(): any {
  return { DB: d1, ZC_HMAC_SECRET: HMAC };
}

function ingressReq(headers: Record<string, string>, body: unknown): Request {
  return new Request("https://zc.test/bank/001/zc-ingress/ping", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  ({ d1 } = createTestDb());
});

describe("bank ingress signature dual-accept", () => {
  it("accepts a valid ZC asymmetric signature (X-ZC-Key-Id path)", async () => {
    const { pkcs8, rawPub } = await genKey();
    await d1
      .prepare(
        `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
         VALUES ('ZC-KEY-1', 'ZC', 'ZC', ?, 'ECDSA_P256', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
      )
      .bind(rawPub)
      .run();

    const body = { hello: "world" };
    const bundle = await signAsZc({
      keyId: "ZC-KEY-1",
      privateKeyPkcs8B64: pkcs8,
      algo: "ECDSA_P256",
      payload: body,
    });
    const res = await handleBankIngressHttp(
      ingressReq(
        {
          "X-ZC-Key-Id": bundle.keyId,
          "X-ZC-Sig-Nonce": bundle.nonce,
          "X-ZC-Sig-Time": bundle.occurredAt,
          "X-ZC-Signature": bundle.signatureB64,
        },
        body
      ),
      "001",
      "ping",
      makeEnv()
    );
    expect(res.status).toBe(200); // auth passed → reaches dispatch
    expect(await res.json()).toMatchObject({ reason_code: "UNKNOWN_COMMAND" });
  });

  it("rejects a tampered ZC asymmetric signature with 401", async () => {
    const { pkcs8, rawPub } = await genKey();
    await d1
      .prepare(
        `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
         VALUES ('ZC-KEY-1', 'ZC', 'ZC', ?, 'ECDSA_P256', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
      )
      .bind(rawPub)
      .run();

    const bundle = await signAsZc({
      keyId: "ZC-KEY-1",
      privateKeyPkcs8B64: pkcs8,
      algo: "ECDSA_P256",
      payload: { hello: "world" },
    });
    const res = await handleBankIngressHttp(
      // Body differs from what was signed → signature must fail.
      ingressReq(
        {
          "X-ZC-Key-Id": bundle.keyId,
          "X-ZC-Sig-Nonce": bundle.nonce,
          "X-ZC-Sig-Time": bundle.occurredAt,
          "X-ZC-Signature": bundle.signatureB64,
        },
        { hello: "tampered" }
      ),
      "001",
      "ping",
      makeEnv()
    );
    expect(res.status).toBe(401);
  });

  it("still accepts the legacy shared HMAC when no ZC key headers are present", async () => {
    const body = { hello: "world" };
    const res = await handleBankIngressHttp(
      ingressReq({ "X-ZC-Signature": await signPayload(body, HMAC) }, body),
      "001",
      "ping",
      makeEnv()
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reason_code: "UNKNOWN_COMMAND" });
  });

  it("rejects a request with neither a ZC key nor a valid HMAC", async () => {
    const res = await handleBankIngressHttp(
      ingressReq({}, { hello: "world" }),
      "001",
      "ping",
      makeEnv()
    );
    expect(res.status).toBe(401);
  });
});
