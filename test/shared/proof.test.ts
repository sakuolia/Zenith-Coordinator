/**
 * @file Unit tests for src/shared/proof.ts, including the
 * SettlementProofRef generalization.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  createProof,
  createSettlementProof,
  serializeProof,
  deserializeProof,
  assertTrustedSettlementProof,
} from "../../src/shared/proof";
import { buildSignedMessage, exportVerificationKey } from "../../src/shared/external_signature";
import type { DomainError } from "../../src/shared/errors";

function b64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

describe("createProof (BANK_LEDGER, unchanged)", () => {
  it("creates a proof without venue/external_ref fields", async () => {
    const proof = await createProof("001", "PAYER_EXEC_PROOF", "TX-001", 1000);
    expect(proof.issuer_bank_id).toBe("001");
    expect(proof.proof_type).toBe("PAYER_EXEC_PROOF");
    expect(proof.proof_id).toMatch(/^PROOF-/);
    expect(proof.venue).toBeUndefined();
    expect(proof.external_ref).toBeUndefined();
  });
});

describe("serializeProof / deserializeProof round-trip with P1 fields", () => {
  it("preserves venue/external_ref/signer_key_id/verified_at", () => {
    const proof = {
      issuer_bank_id: "IGS",
      proof_type: "PAYEE_EXEC_PROOF" as const,
      proof_id: "PROOF-abc",
      recorded_at: "2025-01-01T00:00:00.000Z",
      venue: "IGS_BOJ" as const,
      external_ref: "IGS-12345",
      signer_key_id: "KEY-IGS-1",
      verified_at: "2025-01-01T00:00:01.000Z",
    };
    const json = serializeProof(proof);
    const round = deserializeProof(json);
    expect(round).toEqual(proof);
  });

  it("returns null for invalid JSON", () => {
    expect(deserializeProof("not json")).toBeNull();
    expect(deserializeProof(null)).toBeNull();
  });
});

describe("createSettlementProof", () => {
  let d1: MockD1Database;

  beforeEach(() => {
    d1 = createTestDb().d1;
  });

  it("mints a SettlementProofRef once the external signature verifies", async () => {
    const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]);
    await d1
      .prepare(
        `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
         VALUES (?, 'EXTERNAL_RAIL', 'IGS-BOJ', ?, 'ED25519', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
      )
      .bind("KEY-IGS-1", await exportVerificationKey(publicKey))
      .run();

    const payload = { txid: "TX-001", result: "SETTLED" };
    const occurredAt = new Date().toISOString();
    const message = buildSignedMessage(payload, "KEY-IGS-1", "nonce-1", occurredAt);
    const signatureB64 = b64(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message));

    const proof = await createSettlementProof(
      d1,
      "IGS-BOJ",
      "PAYEE_EXEC_PROOF",
      "IGS_BOJ",
      "IGS-REF-001",
      {
        keyId: "KEY-IGS-1",
        nonce: "nonce-1",
        occurredAt,
        signatureB64,
        payload,
      }
    );

    expect(proof.venue).toBe("IGS_BOJ");
    expect(proof.external_ref).toBe("IGS-REF-001");
    expect(proof.signer_key_id).toBe("KEY-IGS-1");
    expect(proof.verified_at).toBeTruthy();
    expect(proof.proof_id).toMatch(/^PROOF-/);
  });

  it("propagates KEY_NOT_FOUND when the signer key is not registered", async () => {
    const payload = { txid: "TX-002" };
    const occurredAt = new Date().toISOString();

    await expect(
      createSettlementProof(d1, "WATCHER-1", "PAYEE_EXEC_PROOF", "ONCHAIN", "0xabc123", {
        keyId: "KEY-UNKNOWN",
        nonce: "nonce-1",
        occurredAt,
        signatureB64: "AAAA",
        payload,
      })
    ).rejects.toMatchObject({ reason_code: "KEY_NOT_FOUND" } satisfies Partial<DomainError>);
  });
});

describe("assertTrustedSettlementProof", () => {
  it("accepts a BankProofRef (no venue field)", async () => {
    const proof = await createProof("001", "PAYEE_EXEC_PROOF", "TX-001", 1000);
    expect(() => assertTrustedSettlementProof(proof)).not.toThrow();
  });

  it("accepts a SettlementProofRef with venue=BANK_LEDGER even without signer_key_id/verified_at", () => {
    const proof = {
      issuer_bank_id: "001",
      proof_type: "PAYEE_EXEC_PROOF" as const,
      proof_id: "PROOF-bankledger",
      recorded_at: "2025-01-01T00:00:00.000Z",
      venue: "BANK_LEDGER" as const,
    };
    expect(() => assertTrustedSettlementProof(proof)).not.toThrow();
  });

  it("accepts an externally-sourced SettlementProofRef minted with signer_key_id/verified_at", () => {
    const proof = {
      issuer_bank_id: "IGS",
      proof_type: "PAYEE_EXEC_PROOF" as const,
      proof_id: "PROOF-igs",
      recorded_at: "2025-01-01T00:00:00.000Z",
      venue: "IGS_BOJ" as const,
      external_ref: "IGS-12345",
      signer_key_id: "KEY-IGS-1",
      verified_at: "2025-01-01T00:00:01.000Z",
    };
    expect(() => assertTrustedSettlementProof(proof)).not.toThrow();
  });

  it("rejects with PROOF_SOURCE_UNTRUSTED when a non-BANK_LEDGER venue proof is missing signer_key_id/verified_at", () => {
    const proof = {
      issuer_bank_id: "IGS",
      proof_type: "PAYEE_EXEC_PROOF" as const,
      proof_id: "PROOF-fabricated",
      recorded_at: "2025-01-01T00:00:00.000Z",
      venue: "ONCHAIN" as const,
      external_ref: "0xfabricated",
    };
    expect(() => assertTrustedSettlementProof(proof)).toThrowError(
      expect.objectContaining({ reason_code: "PROOF_SOURCE_UNTRUSTED" })
    );
  });

  it("rejects a fabricated CB_TOKEN (tokenized central-bank deposit) proof with no verified signer", () => {
    // Non-JPY finality must be backed by the issuing central bank's verified
    // signature; a CB_TOKEN proof minted from request payload alone is untrusted.
    const proof = {
      issuer_bank_id: "ECB",
      proof_type: "PAYEE_EXEC_PROOF" as const,
      proof_id: "PROOF-cbtoken-fake",
      recorded_at: "2025-01-01T00:00:00.000Z",
      venue: "CB_TOKEN" as const,
      external_ref: "0xeur_unsigned",
    };
    expect(() => assertTrustedSettlementProof(proof)).toThrowError(
      expect.objectContaining({ reason_code: "PROOF_SOURCE_UNTRUSTED" })
    );
  });

  it("accepts a CB_TOKEN proof carrying a verified signer_key_id/verified_at", () => {
    const proof = {
      issuer_bank_id: "ECB",
      proof_type: "PAYEE_EXEC_PROOF" as const,
      proof_id: "PROOF-cbtoken",
      recorded_at: "2025-01-01T00:00:00.000Z",
      venue: "CB_TOKEN" as const,
      external_ref: "0xeur_settlement_tx",
      signer_key_id: "KEY-ECB-ETH",
      verified_at: "2025-01-01T00:00:01.000Z",
    };
    expect(() => assertTrustedSettlementProof(proof)).not.toThrow();
  });
});
