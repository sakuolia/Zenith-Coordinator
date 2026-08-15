/**
 * @file Unit tests for src/shared/mandate.ts (Mandate registration/validation, P3).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  registerMandate,
  assertMandateValid,
  buildMandatePayload,
  type RegisterMandateParams,
} from "../../src/shared/mandate";
import { buildSignedMessage, exportVerificationKey } from "../../src/shared/external_signature";
import type { DomainError } from "../../src/shared/errors";

function b64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
}

async function registerKey(db: MockD1Database, keyId: string, publicKey: CryptoKey): Promise<void> {
  await db
    .prepare(
      `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
       VALUES (?, 'PARTICIPANT', 'participant-001', ?, 'ED25519', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
    )
    .bind(keyId, await exportVerificationKey(publicKey))
    .run();
}

async function signMandate(
  privateKey: CryptoKey,
  terms: Omit<RegisterMandateParams, "principalKeyId" | "nonce" | "occurredAt" | "signatureB64">,
  keyId: string,
  nonce: string,
  occurredAt: string
): Promise<string> {
  const message = buildSignedMessage(buildMandatePayload(terms), keyId, nonce, occurredAt);
  return b64(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message));
}

describe("registerMandate", () => {
  let d1: MockD1Database;

  beforeEach(() => {
    d1 = createTestDb().d1;
  });

  it("registers a root mandate after verifying the principal's signature", async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    await registerKey(d1, "KEY-PRIN-1", publicKey);

    const terms = {
      principalParticipantId: "participant-001",
      granteeRef: "agent-001",
      maxAmount: 100000,
      allowedPurposes: ["P01"],
      allowedLanes: ["EXPRESS"],
      validFrom: "2025-01-01T00:00:00.000Z",
      validTo: "2026-01-01T00:00:00.000Z",
    };
    const occurredAt = new Date().toISOString();
    const signatureB64 = await signMandate(privateKey, terms, "KEY-PRIN-1", "nonce-1", occurredAt);

    const row = await registerMandate(d1, {
      ...terms,
      principalKeyId: "KEY-PRIN-1",
      nonce: "nonce-1",
      occurredAt,
      signatureB64,
    });

    expect(row.mandate_id).toMatch(/^MANDATE-/);
    expect(row.principal_participant_id).toBe("participant-001");
    expect(JSON.parse(row.allowed_purposes!)).toEqual(["P01"]);
  });

  it("propagates EXTERNAL_SIGNATURE_INVALID for a tampered mandate", async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    await registerKey(d1, "KEY-PRIN-2", publicKey);

    const terms = {
      principalParticipantId: "participant-001",
      granteeRef: "agent-001",
      validFrom: "2025-01-01T00:00:00.000Z",
      validTo: "2026-01-01T00:00:00.000Z",
    };
    const occurredAt = new Date().toISOString();
    const signatureB64 = await signMandate(privateKey, terms, "KEY-PRIN-2", "nonce-1", occurredAt);

    await expect(
      registerMandate(d1, {
        ...terms,
        granteeRef: "agent-002", // tampered after signing
        principalKeyId: "KEY-PRIN-2",
        nonce: "nonce-1",
        occurredAt,
        signatureB64,
      })
    ).rejects.toMatchObject({
      reason_code: "EXTERNAL_SIGNATURE_INVALID",
    } satisfies Partial<DomainError>);
  });
});

describe("assertMandateValid", () => {
  let d1: MockD1Database;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  beforeEach(async () => {
    d1 = createTestDb().d1;
    ({ privateKey, publicKey } = await generateKeyPair());
    await registerKey(d1, "KEY-PRIN", publicKey);
  });

  async function register(
    terms: Omit<RegisterMandateParams, "principalKeyId" | "nonce" | "occurredAt" | "signatureB64">,
    nonce: string
  ) {
    const occurredAt = new Date().toISOString();
    const signatureB64 = await signMandate(privateKey, terms, "KEY-PRIN", nonce, occurredAt);
    return registerMandate(d1, {
      ...terms,
      principalKeyId: "KEY-PRIN",
      nonce,
      occurredAt,
      signatureB64,
    });
  }

  it("returns the chain for a valid root mandate within scope", async () => {
    const m = await register(
      {
        principalParticipantId: "participant-001",
        granteeRef: "agent-001",
        maxAmount: 100000,
        allowedPurposes: ["P01"],
        allowedLanes: ["EXPRESS"],
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: "2099-01-01T00:00:00.000Z",
      },
      "n1"
    );

    const chain = await assertMandateValid(d1, m.mandate_id, {
      amount: 50000,
      purpose: "P01",
      lane: "EXPRESS",
    });
    expect(chain).toHaveLength(1);
    expect(chain[0]!.mandate_id).toBe(m.mandate_id);
  });

  it("throws MANDATE_NOT_FOUND for an unknown mandate_id", async () => {
    await expect(assertMandateValid(d1, "MANDATE-missing")).rejects.toMatchObject({
      reason_code: "MANDATE_NOT_FOUND",
    });
  });

  it("throws MANDATE_BREACH when amount exceeds max_amount", async () => {
    const m = await register(
      {
        principalParticipantId: "participant-001",
        granteeRef: "agent-001",
        maxAmount: 100000,
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: "2099-01-01T00:00:00.000Z",
      },
      "n2"
    );
    await expect(assertMandateValid(d1, m.mandate_id, { amount: 200000 })).rejects.toMatchObject({
      reason_code: "MANDATE_BREACH",
    });
  });

  it("throws MANDATE_BREACH when purpose is not allowed", async () => {
    const m = await register(
      {
        principalParticipantId: "participant-001",
        granteeRef: "agent-001",
        allowedPurposes: ["P01"],
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: "2099-01-01T00:00:00.000Z",
      },
      "n3"
    );
    await expect(assertMandateValid(d1, m.mandate_id, { purpose: "P02" })).rejects.toMatchObject({
      reason_code: "MANDATE_BREACH",
    });
  });

  it("throws MANDATE_BREACH when lane is not allowed", async () => {
    const m = await register(
      {
        principalParticipantId: "participant-001",
        granteeRef: "agent-001",
        allowedLanes: ["EXPRESS"],
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: "2099-01-01T00:00:00.000Z",
      },
      "n4"
    );
    await expect(assertMandateValid(d1, m.mandate_id, { lane: "HTLC" })).rejects.toMatchObject({
      reason_code: "MANDATE_BREACH",
    });
  });

  it("throws MANDATE_EXPIRED outside the validity window", async () => {
    const m = await register(
      {
        principalParticipantId: "participant-001",
        granteeRef: "agent-001",
        validFrom: "2099-01-01T00:00:00.000Z",
        validTo: "2099-06-01T00:00:00.000Z",
      },
      "n5"
    );
    await expect(
      assertMandateValid(d1, m.mandate_id, {}, "2025-01-01T00:00:00.000Z")
    ).rejects.toMatchObject({
      reason_code: "MANDATE_EXPIRED",
    });
  });

  it("throws MANDATE_REVOKED once revoked_at has passed", async () => {
    const m = await register(
      {
        principalParticipantId: "participant-001",
        granteeRef: "agent-001",
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: "2099-01-01T00:00:00.000Z",
      },
      "n6"
    );
    await d1
      .prepare(`UPDATE Mandate SET revoked_at = ? WHERE mandate_id = ?`)
      .bind("2024-01-01T00:00:00.000Z", m.mandate_id)
      .run();

    await expect(
      assertMandateValid(d1, m.mandate_id, {}, "2025-01-01T00:00:00.000Z")
    ).rejects.toMatchObject({
      reason_code: "MANDATE_REVOKED",
    });
  });

  describe("delegation chains", () => {
    it("enforces a sub-mandate that narrows the parent's scope", async () => {
      const root = await register(
        {
          principalParticipantId: "participant-001",
          granteeRef: "agent-001",
          maxAmount: 100000,
          allowedPurposes: ["P01", "P02"],
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2099-01-01T00:00:00.000Z",
        },
        "n7"
      );

      const sub = await register(
        {
          principalParticipantId: "participant-001",
          granteeRef: "sub-agent-001",
          parentMandateId: root.mandate_id,
          maxAmount: 50000, // narrower than root
          allowedPurposes: ["P01"], // narrower than root
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2099-01-01T00:00:00.000Z",
        },
        "n8"
      );

      // Within both: ok
      const chain = await assertMandateValid(d1, sub.mandate_id, { amount: 40000, purpose: "P01" });
      expect(chain.map((m) => m.mandate_id)).toEqual([sub.mandate_id, root.mandate_id]);

      // Exceeds sub's max_amount (even though within root's)
      await expect(assertMandateValid(d1, sub.mandate_id, { amount: 60000 })).rejects.toMatchObject(
        {
          reason_code: "MANDATE_BREACH",
        }
      );

      // Purpose allowed by sub but would also need to be allowed by root (P02 not allowed by sub)
      await expect(
        assertMandateValid(d1, sub.mandate_id, { purpose: "P02" })
      ).rejects.toMatchObject({
        reason_code: "MANDATE_BREACH",
      });
    });

    it("rejects if an ancestor in the chain has been revoked", async () => {
      const root = await register(
        {
          principalParticipantId: "participant-001",
          granteeRef: "agent-001",
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2099-01-01T00:00:00.000Z",
        },
        "n9"
      );
      const sub = await register(
        {
          principalParticipantId: "participant-001",
          granteeRef: "sub-agent-001",
          parentMandateId: root.mandate_id,
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2099-01-01T00:00:00.000Z",
        },
        "n10"
      );

      await d1
        .prepare(`UPDATE Mandate SET revoked_at = ? WHERE mandate_id = ?`)
        .bind("2024-01-01T00:00:00.000Z", root.mandate_id)
        .run();

      await expect(
        assertMandateValid(d1, sub.mandate_id, {}, "2025-01-01T00:00:00.000Z")
      ).rejects.toMatchObject({
        reason_code: "MANDATE_REVOKED",
      });
    });
  });
});
