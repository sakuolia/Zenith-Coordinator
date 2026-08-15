/**
 * @file Unit tests for src/shared/attestation.ts (ConditionTemplate / Attestation, P2).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  recordAttestation,
  buildAttestationMessage,
  attesterInScope,
  assertAttestationFresh,
  ATTESTATION_DEFAULT_TTL_SECONDS,
} from "../../src/shared/attestation";
import type { AttestationRow } from "../../src/types";
import { exportVerificationKey } from "../../src/shared/external_signature";
import { sha256hex } from "../../src/shared/hmac";
import { DomainError } from "../../src/shared/errors";

function b64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
}

async function registerKey(
  db: MockD1Database,
  keyId: string,
  publicKey: CryptoKey,
  ownerType: string,
  ownerRef: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
       VALUES (?, ?, ?, ?, 'ED25519', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
    )
    .bind(keyId, ownerType, ownerRef, await exportVerificationKey(publicKey))
    .run();
}

async function registerTemplate(
  db: MockD1Database,
  templateId: string,
  scope: object,
  status = "ACTIVE"
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ConditionTemplate (template_id, predicate_kind, allowed_attester_scope, status, description, registered_at)
       VALUES (?, 'INSPECTION_COMPLETE', ?, ?, 'test template', '2020-01-01T00:00:00.000Z')`
    )
    .bind(templateId, JSON.stringify(scope), status)
    .run();
}

describe("recordAttestation", () => {
  let d1: MockD1Database;

  beforeEach(() => {
    d1 = createTestDb().d1;
  });

  it("records a valid attestation from an attester in scope", async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    await registerKey(d1, "KEY-ATT-1", publicKey, "ATTESTER", "attester-001");
    await registerTemplate(d1, "TPL-1", { owner_types: ["ATTESTER"] });

    const statementHash = await sha256hex("inspection report contents");
    const occurredAt = new Date().toISOString();
    const message = buildAttestationMessage(
      "TPL-1",
      "TX-001",
      statementHash,
      "PASS",
      "KEY-ATT-1",
      "nonce-1",
      occurredAt
    );
    const signatureB64 = b64(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message));

    const row = await recordAttestation(d1, {
      templateId: "TPL-1",
      subjectRef: "TX-001",
      statementHash,
      verifiedResult: "PASS",
      attesterKeyId: "KEY-ATT-1",
      nonce: "nonce-1",
      occurredAt,
      signatureB64,
    });

    expect(row.attestation_id).toMatch(/^ATT-/);
    expect(row.verified_result).toBe("PASS");
    expect(row.statement_hash).toBe(statementHash);

    const persisted = await d1
      .prepare(`SELECT * FROM Attestation WHERE attestation_id = ?`)
      .bind(row.attestation_id)
      .first();
    expect(persisted).toBeTruthy();
  });

  it("rejects an unknown template with TEMPLATE_NOT_WHITELISTED", async () => {
    const statementHash = await sha256hex("x");
    await expect(
      recordAttestation(d1, {
        templateId: "TPL-MISSING",
        subjectRef: "TX-001",
        statementHash,
        verifiedResult: "PASS",
        attesterKeyId: "KEY-1",
        nonce: "n",
        occurredAt: new Date().toISOString(),
        signatureB64: "AAAA",
      })
    ).rejects.toMatchObject({
      reason_code: "TEMPLATE_NOT_WHITELISTED",
    } satisfies Partial<DomainError>);
  });

  it("rejects a SUSPENDED template with TEMPLATE_NOT_WHITELISTED", async () => {
    await registerTemplate(d1, "TPL-SUS", { owner_types: ["ATTESTER"] }, "SUSPENDED");
    const statementHash = await sha256hex("x");
    await expect(
      recordAttestation(d1, {
        templateId: "TPL-SUS",
        subjectRef: "TX-001",
        statementHash,
        verifiedResult: "PASS",
        attesterKeyId: "KEY-1",
        nonce: "n",
        occurredAt: new Date().toISOString(),
        signatureB64: "AAAA",
      })
    ).rejects.toMatchObject({ reason_code: "TEMPLATE_NOT_WHITELISTED" });
  });

  it("rejects a non-hex statement_hash with ATTESTATION_INVALID", async () => {
    await registerTemplate(d1, "TPL-2", { owner_types: ["ATTESTER"] });
    await expect(
      recordAttestation(d1, {
        templateId: "TPL-2",
        subjectRef: "TX-001",
        statementHash: "not-a-hash",
        verifiedResult: "PASS",
        attesterKeyId: "KEY-1",
        nonce: "n",
        occurredAt: new Date().toISOString(),
        signatureB64: "AAAA",
      })
    ).rejects.toMatchObject({ reason_code: "ATTESTATION_INVALID" });
  });

  it("rejects an attester whose key is out of the template's scope with ATTESTER_UNAUTHORIZED", async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    await registerKey(d1, "KEY-AGENT-1", publicKey, "AGENT", "agent-001");
    // Scope only allows ATTESTER-typed keys; this key is an AGENT.
    await registerTemplate(d1, "TPL-3", { owner_types: ["ATTESTER"] });

    const statementHash = await sha256hex("doc");
    const occurredAt = new Date().toISOString();
    const message = buildAttestationMessage(
      "TPL-3",
      "TX-002",
      statementHash,
      "PASS",
      "KEY-AGENT-1",
      "nonce-1",
      occurredAt
    );
    const signatureB64 = b64(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message));

    await expect(
      recordAttestation(d1, {
        templateId: "TPL-3",
        subjectRef: "TX-002",
        statementHash,
        verifiedResult: "PASS",
        attesterKeyId: "KEY-AGENT-1",
        nonce: "nonce-1",
        occurredAt,
        signatureB64,
      })
    ).rejects.toMatchObject({ reason_code: "ATTESTER_UNAUTHORIZED" });
  });

  it("propagates EXTERNAL_SIGNATURE_INVALID for a tampered statement_hash", async () => {
    const { privateKey, publicKey } = await generateKeyPair();
    await registerKey(d1, "KEY-ATT-2", publicKey, "ATTESTER", "attester-002");
    await registerTemplate(d1, "TPL-4", { owner_types: ["ATTESTER"] });

    const statementHash = await sha256hex("real statement");
    const tamperedHash = await sha256hex("tampered statement");
    const occurredAt = new Date().toISOString();
    const message = buildAttestationMessage(
      "TPL-4",
      "TX-003",
      statementHash,
      "PASS",
      "KEY-ATT-2",
      "nonce-1",
      occurredAt
    );
    const signatureB64 = b64(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message));

    await expect(
      recordAttestation(d1, {
        templateId: "TPL-4",
        subjectRef: "TX-003",
        statementHash: tamperedHash,
        verifiedResult: "PASS",
        attesterKeyId: "KEY-ATT-2",
        nonce: "nonce-1",
        occurredAt,
        signatureB64,
      })
    ).rejects.toMatchObject({ reason_code: "EXTERNAL_SIGNATURE_INVALID" });
  });
});

describe("attesterInScope", () => {
  const key = {
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

  it("fails closed on an empty scope", () => {
    expect(attesterInScope(key, {})).toBe(false);
  });

  it("matches on key_ids", () => {
    expect(attesterInScope(key, { key_ids: ["KEY-X"] })).toBe(true);
    expect(attesterInScope(key, { key_ids: ["KEY-OTHER"] })).toBe(false);
  });

  it("matches on owner_refs", () => {
    expect(attesterInScope(key, { owner_refs: ["attester-001"] })).toBe(true);
  });

  it("matches on owner_types", () => {
    expect(attesterInScope(key, { owner_types: ["ATTESTER"] })).toBe(true);
    expect(attesterInScope(key, { owner_types: ["AGENT"] })).toBe(false);
  });
});

describe("assertAttestationFresh", () => {
  function makeRow(occurredAt: string): AttestationRow {
    return {
      attestation_id: "ATT-fresh-test",
      template_id: "TPL-1",
      subject_ref: "TX-001",
      attester_key_id: "KEY-ATT-1",
      statement_hash: "0".repeat(64),
      signature: "AAAA",
      nonce: "nonce-1",
      occurred_at: occurredAt,
      verified_result: "PASS",
      created_at: occurredAt,
    };
  }

  it("does not throw when now is within the default 60-minute TTL", () => {
    const row = makeRow("2025-01-01T00:00:00.000Z");
    expect(() => assertAttestationFresh(row, "2025-01-01T00:59:59.000Z")).not.toThrow();
  });

  it("does not throw exactly at the TTL boundary", () => {
    const row = makeRow("2025-01-01T00:00:00.000Z");
    expect(() => assertAttestationFresh(row, "2025-01-01T01:00:00.000Z")).not.toThrow();
  });

  it("throws ATTESTATION_EXPIRED once the default TTL has elapsed", () => {
    const row = makeRow("2025-01-01T00:00:00.000Z");
    expect(() => assertAttestationFresh(row, "2025-01-01T01:00:00.001Z")).toThrow(DomainError);
    try {
      assertAttestationFresh(row, "2025-01-01T01:00:00.001Z");
    } catch (e) {
      expect((e as DomainError).reason_code).toBe("ATTESTATION_EXPIRED");
    }
  });

  it("honors a custom ttlSeconds", () => {
    const row = makeRow("2025-01-01T00:00:00.000Z");
    expect(() => assertAttestationFresh(row, "2025-01-01T00:00:30.000Z", 10)).toThrow(DomainError);
    expect(() => assertAttestationFresh(row, "2025-01-01T00:00:05.000Z", 10)).not.toThrow();
  });

  it("ATTESTATION_DEFAULT_TTL_SECONDS is 60 minutes", () => {
    expect(ATTESTATION_DEFAULT_TTL_SECONDS).toBe(3600);
  });
});
