/**
 * @file Unit tests for src/shared/external_signature.ts (KeyRegistry verification).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  buildSignedMessage,
  exportVerificationKey,
  verifyExternalSignature,
  assertTimestampFresh,
  assertKeyValidAt,
  SIGNATURE_SKEW_MS,
} from "../../src/shared/external_signature";
import { DomainError } from "../../src/shared/errors";
import type { KeyAlgo, KeyOwnerType } from "../../src/types";

function b64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

async function generateKeyPair(algo: KeyAlgo): Promise<CryptoKeyPair> {
  if (algo === "ECDSA_P256") {
    return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
  }
  return crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
}

async function sign(privateKey: CryptoKey, algo: KeyAlgo, message: Uint8Array): Promise<string> {
  const params = algo === "ECDSA_P256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "Ed25519" };
  const sig = await crypto.subtle.sign(params, privateKey, message);
  return b64(sig);
}

async function registerKey(
  db: MockD1Database,
  opts: {
    keyId: string;
    algo: KeyAlgo;
    publicKey: CryptoKey;
    ownerType?: KeyOwnerType;
    validFrom?: string;
    validTo?: string | null;
    revokedAt?: string | null;
    status?: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      opts.keyId,
      opts.ownerType ?? "ATTESTER",
      "attester-001",
      await exportVerificationKey(opts.publicKey),
      opts.algo,
      opts.validFrom ?? "2020-01-01T00:00:00.000Z",
      opts.validTo ?? null,
      opts.revokedAt ?? null,
      opts.status ?? "ACTIVE",
      "2020-01-01T00:00:00.000Z"
    )
    .run();
}

describe.each([["ECDSA_P256"], ["ED25519"]] as const)("verifyExternalSignature (%s)", (algo) => {
  let d1: MockD1Database;

  beforeEach(() => {
    d1 = createTestDb().d1;
  });

  it("verifies a valid signature and returns the KeyRegistry row", async () => {
    const { privateKey, publicKey } = await generateKeyPair(algo);
    await registerKey(d1, { keyId: "KEY-1", algo, publicKey });

    const payload = { subject_ref: "TX-001", verified_result: "PASS" };
    const occurredAt = new Date().toISOString();
    const message = buildSignedMessage(payload, "KEY-1", "nonce-1", occurredAt);
    const signatureB64 = await sign(privateKey, algo, message);

    const row = await verifyExternalSignature(d1, {
      keyId: "KEY-1",
      nonce: "nonce-1",
      occurredAt,
      signatureB64,
      payload,
    });

    expect(row.key_id).toBe("KEY-1");
    expect(row.algo).toBe(algo);
  });

  it("rejects an unknown key_id with KEY_NOT_FOUND", async () => {
    const payload = { foo: "bar" };
    const occurredAt = new Date().toISOString();
    await expect(
      verifyExternalSignature(d1, {
        keyId: "KEY-MISSING",
        nonce: "nonce-1",
        occurredAt,
        signatureB64: "AAAA",
        payload,
      })
    ).rejects.toMatchObject({ reason_code: "KEY_NOT_FOUND" } satisfies Partial<DomainError>);
  });

  it("rejects a tampered payload with EXTERNAL_SIGNATURE_INVALID", async () => {
    const { privateKey, publicKey } = await generateKeyPair(algo);
    await registerKey(d1, { keyId: "KEY-2", algo, publicKey });

    const occurredAt = new Date().toISOString();
    const message = buildSignedMessage({ amount: 100 }, "KEY-2", "nonce-1", occurredAt);
    const signatureB64 = await sign(privateKey, algo, message);

    await expect(
      verifyExternalSignature(d1, {
        keyId: "KEY-2",
        nonce: "nonce-1",
        occurredAt,
        signatureB64,
        payload: { amount: 999 }, // tampered
      })
    ).rejects.toMatchObject({ reason_code: "EXTERNAL_SIGNATURE_INVALID" });
  });

  it("rejects a replayed (key_id, nonce) with SIGNATURE_REPLAYED", async () => {
    const { privateKey, publicKey } = await generateKeyPair(algo);
    await registerKey(d1, { keyId: "KEY-3", algo, publicKey });

    const payload = { subject_ref: "TX-002" };
    const occurredAt = new Date().toISOString();
    const message = buildSignedMessage(payload, "KEY-3", "nonce-replay", occurredAt);
    const signatureB64 = await sign(privateKey, algo, message);

    await verifyExternalSignature(d1, {
      keyId: "KEY-3",
      nonce: "nonce-replay",
      occurredAt,
      signatureB64,
      payload,
    });

    await expect(
      verifyExternalSignature(d1, {
        keyId: "KEY-3",
        nonce: "nonce-replay",
        occurredAt,
        signatureB64,
        payload,
      })
    ).rejects.toMatchObject({ reason_code: "SIGNATURE_REPLAYED" });
  });

  it("rejects a revoked key with KEY_REVOKED when occurred_at is after revocation", async () => {
    const { privateKey, publicKey } = await generateKeyPair(algo);
    const revokedAt = "2024-01-01T00:00:00.000Z";
    await registerKey(d1, { keyId: "KEY-4", algo, publicKey, revokedAt });

    const occurredAt = new Date().toISOString(); // after revokedAt
    const message = buildSignedMessage({ x: 1 }, "KEY-4", "nonce-1", occurredAt);
    const signatureB64 = await sign(privateKey, algo, message);

    await expect(
      verifyExternalSignature(d1, {
        keyId: "KEY-4",
        nonce: "nonce-1",
        occurredAt,
        signatureB64,
        payload: { x: 1 },
      })
    ).rejects.toMatchObject({ reason_code: "KEY_REVOKED" });
  });

  it("accepts a signature from before revocation (non-retroactive)", async () => {
    const { privateKey, publicKey } = await generateKeyPair(algo);
    const revokedAt = "2024-06-01T00:00:00.000Z";
    await registerKey(d1, {
      keyId: "KEY-5",
      algo,
      publicKey,
      revokedAt,
      validFrom: "2020-01-01T00:00:00.000Z",
    });

    // occurred_at before revocation, but must still be within the skew window
    // of "now" for assertTimestampFresh — so we use a fake "now" close to it.
    const occurredAt = "2024-05-31T23:59:00.000Z";
    const message = buildSignedMessage({ x: 1 }, "KEY-5", "nonce-1", occurredAt);
    const signatureB64 = await sign(privateKey, algo, message);

    const row = await verifyExternalSignature(
      d1,
      { keyId: "KEY-5", nonce: "nonce-1", occurredAt, signatureB64, payload: { x: 1 } },
      new Date("2024-05-31T23:59:30.000Z")
    );
    expect(row.key_id).toBe("KEY-5");
  });

  it("rejects a key outside its validity window with KEY_EXPIRED", async () => {
    const { privateKey, publicKey } = await generateKeyPair(algo);
    await registerKey(d1, {
      keyId: "KEY-6",
      algo,
      publicKey,
      validFrom: "2030-01-01T00:00:00.000Z",
      validTo: "2031-01-01T00:00:00.000Z",
    });

    const occurredAt = "2030-06-01T00:00:00.000Z";
    const message = buildSignedMessage({ x: 1 }, "KEY-6", "nonce-1", occurredAt);
    const signatureB64 = await sign(privateKey, algo, message);

    // occurred_at is far from "now", so freshness check fires first with the
    // fake "now" set to occurred_at to isolate the validity-window check.
    const row = await verifyExternalSignature(
      d1,
      { keyId: "KEY-6", nonce: "nonce-1", occurredAt, signatureB64, payload: { x: 1 } },
      new Date(occurredAt)
    );
    expect(row.key_id).toBe("KEY-6");

    // Now check a timestamp before valid_from is rejected.
    const before = "2029-12-31T23:59:00.000Z";
    const message2 = buildSignedMessage({ x: 1 }, "KEY-6", "nonce-2", before);
    const signatureB64_2 = await sign(privateKey, algo, message2);
    await expect(
      verifyExternalSignature(
        d1,
        {
          keyId: "KEY-6",
          nonce: "nonce-2",
          occurredAt: before,
          signatureB64: signatureB64_2,
          payload: { x: 1 },
        },
        new Date(before)
      )
    ).rejects.toMatchObject({ reason_code: "KEY_EXPIRED" });
  });

  it("rejects a revoked-status key regardless of timestamps with KEY_EXPIRED", async () => {
    const { privateKey, publicKey } = await generateKeyPair(algo);
    await registerKey(d1, { keyId: "KEY-7", algo, publicKey, status: "REVOKED" });

    const occurredAt = new Date().toISOString();
    const message = buildSignedMessage({ x: 1 }, "KEY-7", "nonce-1", occurredAt);
    const signatureB64 = await sign(privateKey, algo, message);

    await expect(
      verifyExternalSignature(d1, {
        keyId: "KEY-7",
        nonce: "nonce-1",
        occurredAt,
        signatureB64,
        payload: { x: 1 },
      })
    ).rejects.toMatchObject({ reason_code: "KEY_EXPIRED" });
  });
});

describe("assertTimestampFresh", () => {
  it("accepts a timestamp within the skew window", () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    expect(() => assertTimestampFresh("2025-01-01T00:00:00.000Z", now)).not.toThrow();
  });

  it("rejects a timestamp outside the skew window", () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const tooOld = new Date(now.getTime() - SIGNATURE_SKEW_MS - 1000).toISOString();
    expect(() => assertTimestampFresh(tooOld, now)).toThrow(DomainError);
    try {
      assertTimestampFresh(tooOld, now);
    } catch (e) {
      expect((e as DomainError).reason_code).toBe("TIMESTAMP_SKEW");
    }
  });

  it("rejects an unparseable timestamp", () => {
    expect(() => assertTimestampFresh("not-a-date")).toThrow(DomainError);
  });
});

describe("assertKeyValidAt", () => {
  const baseKey = {
    key_id: "KEY-X",
    owner_type: "ATTESTER" as const,
    owner_ref: "attester-001",
    public_key: "deadbeef",
    algo: "ED25519" as const,
    valid_from: "2020-01-01T00:00:00.000Z",
    valid_to: null,
    revoked_at: null,
    status: "ACTIVE" as const,
    created_at: "2020-01-01T00:00:00.000Z",
  };

  it("passes for an active key within range", () => {
    expect(() => assertKeyValidAt(baseKey, "2025-01-01T00:00:00.000Z")).not.toThrow();
  });

  it("throws KEY_EXPIRED before valid_from", () => {
    expect(() => assertKeyValidAt(baseKey, "2019-12-31T23:59:59.000Z")).toThrow(DomainError);
    let err: unknown;
    try {
      assertKeyValidAt(baseKey, "2019-12-31T23:59:59.000Z");
    } catch (e) {
      err = e;
    }
    expect((err as DomainError).reason_code).toBe("KEY_EXPIRED");
  });

  it("throws KEY_EXPIRED at/after valid_to", () => {
    const key = { ...baseKey, valid_to: "2024-01-01T00:00:00.000Z" };
    let err: unknown;
    try {
      assertKeyValidAt(key, "2024-01-01T00:00:00.000Z");
    } catch (e) {
      err = e;
    }
    expect((err as DomainError).reason_code).toBe("KEY_EXPIRED");
  });

  it("throws KEY_REVOKED at/after revoked_at", () => {
    const key = { ...baseKey, revoked_at: "2024-01-01T00:00:00.000Z" };
    let err: unknown;
    try {
      assertKeyValidAt(key, "2024-01-01T00:00:00.000Z");
    } catch (e) {
      err = e;
    }
    expect((err as DomainError).reason_code).toBe("KEY_REVOKED");
  });

  it("allows a timestamp strictly before revoked_at", () => {
    const key = { ...baseKey, revoked_at: "2024-01-01T00:00:00.000Z" };
    expect(() => assertKeyValidAt(key, "2023-12-31T23:59:59.999Z")).not.toThrow();
  });
});
