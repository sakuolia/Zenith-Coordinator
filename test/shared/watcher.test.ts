/**
 * @file Unit tests for src/shared/watcher.ts (Watcher observation recording, W).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  recordWatcherObservation,
  buildWatcherObservationPayload,
  type RecordWatcherObservationParams,
} from "../../src/shared/watcher";
import { buildSignedMessage, exportVerificationKey } from "../../src/shared/external_signature";
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

async function signObservation(
  privateKey: CryptoKey,
  params: Omit<
    RecordWatcherObservationParams,
    "watcherKeyId" | "nonce" | "occurredAt" | "signatureB64"
  >,
  keyId: string,
  nonce: string,
  occurredAt: string
): Promise<string> {
  const message = buildSignedMessage(
    buildWatcherObservationPayload(params),
    keyId,
    nonce,
    occurredAt
  );
  return b64(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message));
}

describe("recordWatcherObservation", () => {
  let d1: MockD1Database;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  beforeEach(async () => {
    d1 = createTestDb().d1;
    ({ privateKey, publicKey } = await generateKeyPair());
  });

  it("records a valid observation from a registered EXTERNAL_RAIL watcher and mints a SettlementProofRef", async () => {
    await registerKey(d1, "KEY-WATCHER-1", publicKey, "EXTERNAL_RAIL", "watcher-eth-001");

    const params = {
      source: "ONCHAIN:ETH",
      externalRef: "0xabc123",
      venue: "ONCHAIN" as const,
      proofType: "PAYEE_EXEC_PROOF" as const,
      issuerRef: "001",
    };
    const occurredAt = new Date().toISOString();
    const signatureB64 = await signObservation(
      privateKey,
      params,
      "KEY-WATCHER-1",
      "nonce-1",
      occurredAt
    );

    const result = await recordWatcherObservation(d1, {
      ...params,
      watcherKeyId: "KEY-WATCHER-1",
      nonce: "nonce-1",
      occurredAt,
      signatureB64,
    });

    expect(result.deduped).toBe(false);
    expect(result.observation.observation_id).toMatch(/^WOBS-/);
    expect(result.proofRef.venue).toBe("ONCHAIN");
    expect(result.proofRef.external_ref).toBe("0xabc123");
    expect(result.proofRef.signer_key_id).toBe("KEY-WATCHER-1");
    expect(result.proofRef.proof_id).toMatch(/^PROOF-/);

    const persisted = await d1
      .prepare(`SELECT * FROM WatcherObservation WHERE observation_id = ?`)
      .bind(result.observation.observation_id)
      .first();
    expect(persisted).toBeTruthy();
  });

  it("records a valid observation from a registered ATTESTER watcher", async () => {
    await registerKey(d1, "KEY-WATCHER-ATT", publicKey, "ATTESTER", "watcher-igs-001");

    const params = {
      source: "IGS_BOJ",
      externalRef: "IGS-CONF-001",
      venue: "IGS_BOJ" as const,
      proofType: "PAYER_EXEC_PROOF" as const,
      issuerRef: "002",
    };
    const occurredAt = new Date().toISOString();
    const signatureB64 = await signObservation(
      privateKey,
      params,
      "KEY-WATCHER-ATT",
      "nonce-1",
      occurredAt
    );

    const result = await recordWatcherObservation(d1, {
      ...params,
      watcherKeyId: "KEY-WATCHER-ATT",
      nonce: "nonce-1",
      occurredAt,
      signatureB64,
    });

    expect(result.deduped).toBe(false);
    expect(result.proofRef.venue).toBe("IGS_BOJ");
  });

  it("records a CB_TOKEN observation (tokenized central-bank deposit) with the chain in the source", async () => {
    // The CB token issuer (e.g. ECB) is registered as an external rail; ZC can
    // only verify its signed settlement observation, never reach the CB directly.
    await registerKey(d1, "KEY-ECB-ETH", publicKey, "EXTERNAL_RAIL", "ECB");

    const params = {
      source: "CB_TOKEN:ECB:ETH",
      externalRef: "0xeur_settlement_tx",
      venue: "CB_TOKEN" as const,
      proofType: "PAYEE_EXEC_PROOF" as const,
      issuerRef: "ECB",
    };
    const occurredAt = new Date().toISOString();
    const signatureB64 = await signObservation(
      privateKey,
      params,
      "KEY-ECB-ETH",
      "nonce-eur-1",
      occurredAt
    );

    const result = await recordWatcherObservation(d1, {
      ...params,
      watcherKeyId: "KEY-ECB-ETH",
      nonce: "nonce-eur-1",
      occurredAt,
      signatureB64,
    });

    expect(result.deduped).toBe(false);
    expect(result.proofRef.venue).toBe("CB_TOKEN");
    // The minted proof is externally trusted: signer + verified_at populated.
    expect(result.proofRef.signer_key_id).toBe("KEY-ECB-ETH");
    expect(result.proofRef.verified_at).toBeTruthy();
  });

  it("rejects a CB_TOKEN observation whose key is not a registered rail (no fabricated finality)", async () => {
    // A PARTICIPANT key must not be able to assert foreign-CB finality.
    await registerKey(d1, "KEY-IMPOSTER", publicKey, "PARTICIPANT", "001");

    const params = {
      source: "CB_TOKEN:FED:ETH",
      externalRef: "0xusd_fake",
      venue: "CB_TOKEN" as const,
      proofType: "PAYEE_EXEC_PROOF" as const,
      issuerRef: "FED",
    };
    const occurredAt = new Date().toISOString();
    const signatureB64 = await signObservation(
      privateKey,
      params,
      "KEY-IMPOSTER",
      "nonce-x",
      occurredAt
    );

    await expect(
      recordWatcherObservation(d1, {
        ...params,
        watcherKeyId: "KEY-IMPOSTER",
        nonce: "nonce-x",
        occurredAt,
        signatureB64,
      })
    ).rejects.toThrow(DomainError);
  });

  it("deduplicates a repeated observation of the same (source, external_ref) without re-verifying the signature", async () => {
    await registerKey(d1, "KEY-WATCHER-2", publicKey, "EXTERNAL_RAIL", "watcher-eth-002");

    const params = {
      source: "ONCHAIN:ETH",
      externalRef: "0xdef456",
      venue: "ONCHAIN" as const,
      proofType: "PAYEE_EXEC_PROOF" as const,
      issuerRef: "001",
    };
    const occurredAt = new Date().toISOString();
    const signatureB64 = await signObservation(
      privateKey,
      params,
      "KEY-WATCHER-2",
      "nonce-1",
      occurredAt
    );

    const first = await recordWatcherObservation(d1, {
      ...params,
      watcherKeyId: "KEY-WATCHER-2",
      nonce: "nonce-1",
      occurredAt,
      signatureB64,
    });
    expect(first.deduped).toBe(false);

    // A second Watcher reports the same external event, with a different (now-unused) signature.
    const second = await recordWatcherObservation(d1, {
      ...params,
      watcherKeyId: "KEY-WATCHER-2",
      nonce: "nonce-1", // would be a replay if re-verified — but dedup short-circuits before verification
      occurredAt,
      signatureB64,
    });
    expect(second.deduped).toBe(true);
    expect(second.observation.observation_id).toBe(first.observation.observation_id);
    expect(second.proofRef.proof_id).toBe(first.proofRef.proof_id);

    const rows = await d1
      .prepare(`SELECT * FROM WatcherObservation WHERE source = ? AND external_ref = ?`)
      .bind(params.source, params.externalRef)
      .all();
    expect(rows.results).toHaveLength(1);
  });

  it("rejects a key whose owner_type is not EXTERNAL_RAIL/ATTESTER with WATCHER_UNAUTHORIZED", async () => {
    await registerKey(d1, "KEY-AGENT-1", publicKey, "AGENT", "agent-001");

    const params = {
      source: "ONCHAIN:ETH",
      externalRef: "0x999",
      venue: "ONCHAIN" as const,
      proofType: "PAYEE_EXEC_PROOF" as const,
      issuerRef: "001",
    };
    const occurredAt = new Date().toISOString();
    const signatureB64 = await signObservation(
      privateKey,
      params,
      "KEY-AGENT-1",
      "nonce-1",
      occurredAt
    );

    await expect(
      recordWatcherObservation(d1, {
        ...params,
        watcherKeyId: "KEY-AGENT-1",
        nonce: "nonce-1",
        occurredAt,
        signatureB64,
      })
    ).rejects.toMatchObject({ reason_code: "WATCHER_UNAUTHORIZED" } satisfies Partial<DomainError>);
  });

  it("propagates EXTERNAL_SIGNATURE_INVALID for a tampered observation", async () => {
    await registerKey(d1, "KEY-WATCHER-3", publicKey, "EXTERNAL_RAIL", "watcher-eth-003");

    const params = {
      source: "ONCHAIN:ETH",
      externalRef: "0xaaa",
      venue: "ONCHAIN" as const,
      proofType: "PAYEE_EXEC_PROOF" as const,
      issuerRef: "001",
    };
    const occurredAt = new Date().toISOString();
    const signatureB64 = await signObservation(
      privateKey,
      params,
      "KEY-WATCHER-3",
      "nonce-1",
      occurredAt
    );

    await expect(
      recordWatcherObservation(d1, {
        ...params,
        externalRef: "0xbbb", // tampered after signing
        watcherKeyId: "KEY-WATCHER-3",
        nonce: "nonce-1",
        occurredAt,
        signatureB64,
      })
    ).rejects.toMatchObject({ reason_code: "EXTERNAL_SIGNATURE_INVALID" });
  });

  it("propagates SIGNATURE_REPLAYED for a reused (key_id, nonce) on a new external_ref", async () => {
    await registerKey(d1, "KEY-WATCHER-4", publicKey, "EXTERNAL_RAIL", "watcher-eth-004");

    const params1 = {
      source: "ONCHAIN:ETH",
      externalRef: "0x111",
      venue: "ONCHAIN" as const,
      proofType: "PAYEE_EXEC_PROOF" as const,
      issuerRef: "001",
    };
    const occurredAt = new Date().toISOString();
    const sig1 = await signObservation(
      privateKey,
      params1,
      "KEY-WATCHER-4",
      "nonce-shared",
      occurredAt
    );
    await recordWatcherObservation(d1, {
      ...params1,
      watcherKeyId: "KEY-WATCHER-4",
      nonce: "nonce-shared",
      occurredAt,
      signatureB64: sig1,
    });

    const params2 = { ...params1, externalRef: "0x222" };
    const sig2 = await signObservation(
      privateKey,
      params2,
      "KEY-WATCHER-4",
      "nonce-shared",
      occurredAt
    );

    await expect(
      recordWatcherObservation(d1, {
        ...params2,
        watcherKeyId: "KEY-WATCHER-4",
        nonce: "nonce-shared",
        occurredAt,
        signatureB64: sig2,
      })
    ).rejects.toMatchObject({ reason_code: "SIGNATURE_REPLAYED" });
  });
});
