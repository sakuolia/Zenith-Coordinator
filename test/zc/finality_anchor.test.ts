/**
 * @file Unit tests for src/zc/finality/finality_anchor.ts (transparency anchoring + co-signing, §G).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { writeFinalityLog } from "../../src/zc/orchestrator";
import {
  createFinalityAnchor,
  verifyChainInclusion,
  recordFinalityCosign,
  buildFinalityCosignPayload,
} from "../../src/zc/finality/finality_anchor";
import { buildSignedMessage, exportVerificationKey } from "../../src/shared/external_signature";
import type { DomainError } from "../../src/shared/errors";

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

async function appendTxEntry(
  d1: MockD1Database,
  txid: string,
  eventType: string,
  stateFrom: string | null,
  stateTo: string
) {
  await writeFinalityLog(d1 as any, {
    txid,
    event_type: eventType,
    state_from: stateFrom,
    state_to: stateTo,
    payload_json: JSON.stringify({ txid, note: `${stateFrom ?? ""}->${stateTo}` }),
    txid_or_gtid: txid,
  });
}

async function insertTx(
  d1: MockD1Database,
  txid: string,
  payerBankId: string,
  payeeBankId: string
): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO Transactions (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash, idempotency_key, schema_version, version, created_at, updated_at)
       VALUES (?, 'EXPRESS', 'RECEIVED', 1000, 'JPY', ?, '0010000001', ?, '0020000002', ?, '1.0', 0, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`
    )
    .bind(txid, payerBankId, payeeBankId, `idem-${txid}`)
    .run();
}

describe("createFinalityAnchor", () => {
  let d1: MockD1Database;

  beforeEach(() => {
    d1 = createTestDb().d1;
  });

  it("returns null when FinalityLog is empty", async () => {
    expect(await createFinalityAnchor(d1)).toBeNull();
  });

  it("snapshots every chain's tip hash at the current high-water mark", async () => {
    await insertTx(d1, "TX-A", "001", "002");
    await appendTxEntry(d1, "TX-A", "PaymentInitiated", null, "RECEIVED");
    await appendTxEntry(d1, "TX-A", "PreCheckPassed", "RECEIVED", "PRECHECKED");

    const anchor = await createFinalityAnchor(d1);
    expect(anchor).not.toBeNull();
    expect(anchor!.anchor_id).toMatch(/^ANCHOR-/);
    expect(anchor!.anchor_seq).toBe(1);

    const tips = JSON.parse(anchor!.chain_tips_json) as { chain_id: string; tip_hash: string }[];
    const txTip = tips.find((t) => t.chain_id === "TX-A");
    expect(txTip).toBeTruthy();
    expect(txTip!.tip_hash).not.toBe("GENESIS");
  });

  it("increments anchor_seq across successive anchors", async () => {
    await insertTx(d1, "TX-A", "001", "002");
    await appendTxEntry(d1, "TX-A", "PaymentInitiated", null, "RECEIVED");

    const a1 = await createFinalityAnchor(d1);
    const a2 = await createFinalityAnchor(d1);
    expect(a1!.anchor_seq).toBe(1);
    expect(a2!.anchor_seq).toBe(2);
    expect(a2!.high_watermark_seq).toBeGreaterThanOrEqual(a1!.high_watermark_seq);
  });
});

describe("verifyChainInclusion", () => {
  let d1: MockD1Database;

  beforeEach(() => {
    d1 = createTestDb().d1;
  });

  it("confirms inclusion when the chain has not been rewritten", async () => {
    await insertTx(d1, "TX-A", "001", "002");
    await appendTxEntry(d1, "TX-A", "PaymentInitiated", null, "RECEIVED");
    await appendTxEntry(d1, "TX-A", "PreCheckPassed", "RECEIVED", "PRECHECKED");

    const anchor = await createFinalityAnchor(d1);
    const result = await verifyChainInclusion(d1, anchor!.anchor_id, "TX-A");

    expect(result.included).toBe(true);
    expect(result.recomputed_tip_hash).toBe(result.anchored_tip_hash);
  });

  it("detects a rewrite of an anchored chain's tip hash", async () => {
    await insertTx(d1, "TX-A", "001", "002");
    await appendTxEntry(d1, "TX-A", "PaymentInitiated", null, "RECEIVED");
    await appendTxEntry(d1, "TX-A", "PreCheckPassed", "RECEIVED", "PRECHECKED");

    const anchor = await createFinalityAnchor(d1);

    // Tamper with the anchored entry's recorded hash after anchoring.
    await d1
      .prepare(
        `UPDATE FinalityLog SET entry_hash = ? WHERE txid = ? AND event_type = 'PreCheckPassed'`
      )
      .bind("0".repeat(64), "TX-A")
      .run();

    const result = await verifyChainInclusion(d1, anchor!.anchor_id, "TX-A");
    expect(result.included).toBe(false);
  });

  it("throws ANCHOR_NOT_FOUND for an unknown anchor_id", async () => {
    await expect(verifyChainInclusion(d1, "ANCHOR-missing", "TX-A")).rejects.toMatchObject({
      reason_code: "ANCHOR_NOT_FOUND",
    } satisfies Partial<DomainError>);
  });

  it("throws CHAIN_NOT_ANCHORED when the chain did not exist at anchor time", async () => {
    await insertTx(d1, "TX-A", "001", "002");
    await appendTxEntry(d1, "TX-A", "PaymentInitiated", null, "RECEIVED");
    const anchor = await createFinalityAnchor(d1);

    await expect(verifyChainInclusion(d1, anchor!.anchor_id, "TX-B")).rejects.toMatchObject({
      reason_code: "CHAIN_NOT_ANCHORED",
    });
  });
});

describe("recordFinalityCosign", () => {
  let d1: MockD1Database;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  beforeEach(async () => {
    d1 = createTestDb().d1;
    ({ privateKey, publicKey } = await generateKeyPair());
    await insertTx(d1, "TX-A", "001", "002");
    await appendTxEntry(d1, "TX-A", "PaymentInitiated", null, "RECEIVED");
    await appendTxEntry(d1, "TX-A", "PreCheckPassed", "RECEIVED", "PRECHECKED");
    // The co-sign basis entry for a TX chain is b (PAYEE_EXEC_CONFIRMED).
    await appendTxEntry(d1, "TX-A", "PayeeExecConfirmed", "PRECHECKED", "PAYEE_EXEC_CONFIRMED");
  });

  async function sign(
    chainId: string,
    entryHash: string,
    keyId: string,
    nonce: string,
    occurredAt: string
  ): Promise<string> {
    const message = buildSignedMessage(
      buildFinalityCosignPayload({ chainId, entryHash }),
      keyId,
      nonce,
      occurredAt
    );
    return b64(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message));
  }

  it("records a co-signature from the payer bank", async () => {
    await registerKey(d1, "KEY-BANK-001", publicKey, "PARTICIPANT", "001");

    const { resolveCosignBasis } = await import("../../src/zc/finality/finality_anchor");
    const entryHash = (await resolveCosignBasis(d1 as any, "TX-A")).entry_hash;
    const occurredAt = new Date().toISOString();
    const signatureB64 = await sign("TX-A", entryHash, "KEY-BANK-001", "nonce-1", occurredAt);

    const row = await recordFinalityCosign(d1, {
      chainId: "TX-A",
      participantId: "001",
      signerKeyId: "KEY-BANK-001",
      nonce: "nonce-1",
      occurredAt,
      signatureB64,
    });

    expect(row.cosign_id).toMatch(/^COSIGN-/);
    expect(row.entry_hash).toBe(entryHash);

    const persisted = await d1
      .prepare(`SELECT * FROM FinalityCosign WHERE cosign_id = ?`)
      .bind(row.cosign_id)
      .first();
    expect(persisted).toBeTruthy();
  });

  it("records a co-signature from the payee bank", async () => {
    await registerKey(d1, "KEY-BANK-002", publicKey, "PARTICIPANT", "002");

    const { resolveCosignBasis } = await import("../../src/zc/finality/finality_anchor");
    const entryHash = (await resolveCosignBasis(d1 as any, "TX-A")).entry_hash;
    const occurredAt = new Date().toISOString();
    const signatureB64 = await sign("TX-A", entryHash, "KEY-BANK-002", "nonce-1", occurredAt);

    const row = await recordFinalityCosign(d1, {
      chainId: "TX-A",
      participantId: "002",
      signerKeyId: "KEY-BANK-002",
      nonce: "nonce-1",
      occurredAt,
      signatureB64,
    });

    expect(row.participant_id).toBe("002");
  });

  it("returns the existing row when re-cosigning the same (chain, participant, entry_hash) without re-verifying", async () => {
    await registerKey(d1, "KEY-BANK-001", publicKey, "PARTICIPANT", "001");

    const { resolveCosignBasis } = await import("../../src/zc/finality/finality_anchor");
    const entryHash = (await resolveCosignBasis(d1 as any, "TX-A")).entry_hash;
    const occurredAt = new Date().toISOString();
    const signatureB64 = await sign("TX-A", entryHash, "KEY-BANK-001", "nonce-1", occurredAt);

    const first = await recordFinalityCosign(d1, {
      chainId: "TX-A",
      participantId: "001",
      signerKeyId: "KEY-BANK-001",
      nonce: "nonce-1",
      occurredAt,
      signatureB64,
    });
    const second = await recordFinalityCosign(d1, {
      chainId: "TX-A",
      participantId: "001",
      signerKeyId: "KEY-BANK-001",
      nonce: "nonce-1", // would be SIGNATURE_REPLAYED if re-verified
      occurredAt,
      signatureB64,
    });

    expect(second.cosign_id).toBe(first.cosign_id);

    const rows = await d1
      .prepare(`SELECT * FROM FinalityCosign WHERE chain_id = ? AND participant_id = ?`)
      .bind("TX-A", "001")
      .all();
    expect(rows.results).toHaveLength(1);
  });

  it("throws COSIGN_NOT_APPLICABLE for a participant that is not party to the transaction", async () => {
    await registerKey(d1, "KEY-BANK-003", publicKey, "PARTICIPANT", "003");

    const { resolveCosignBasis } = await import("../../src/zc/finality/finality_anchor");
    const entryHash = (await resolveCosignBasis(d1 as any, "TX-A")).entry_hash;
    const occurredAt = new Date().toISOString();
    const signatureB64 = await sign("TX-A", entryHash, "KEY-BANK-003", "nonce-1", occurredAt);

    await expect(
      recordFinalityCosign(d1, {
        chainId: "TX-A",
        participantId: "003",
        signerKeyId: "KEY-BANK-003",
        nonce: "nonce-1",
        occurredAt,
        signatureB64,
      })
    ).rejects.toMatchObject({ reason_code: "COSIGN_NOT_APPLICABLE" });
  });

  it("throws COSIGN_NOT_APPLICABLE for a non-TX chain (GTID/DNS/GLOBAL)", async () => {
    await expect(
      recordFinalityCosign(d1, {
        chainId: "GTID-X",
        participantId: "001",
        signerKeyId: "KEY-BANK-001",
        nonce: "nonce-1",
        occurredAt: new Date().toISOString(),
        signatureB64: "AAAA",
      })
    ).rejects.toMatchObject({ reason_code: "COSIGN_NOT_APPLICABLE" });
  });

  it("throws COSIGN_PARTICIPANT_MISMATCH when the verified key belongs to a different participant", async () => {
    // Key is registered to participant 002, but caller claims to be 001 (also a party to TX-A).
    await registerKey(d1, "KEY-BANK-002", publicKey, "PARTICIPANT", "002");

    const { resolveCosignBasis } = await import("../../src/zc/finality/finality_anchor");
    const entryHash = (await resolveCosignBasis(d1 as any, "TX-A")).entry_hash;
    const occurredAt = new Date().toISOString();
    const signatureB64 = await sign("TX-A", entryHash, "KEY-BANK-002", "nonce-1", occurredAt);

    await expect(
      recordFinalityCosign(d1, {
        chainId: "TX-A",
        participantId: "001",
        signerKeyId: "KEY-BANK-002",
        nonce: "nonce-1",
        occurredAt,
        signatureB64,
      })
    ).rejects.toMatchObject({ reason_code: "COSIGN_PARTICIPANT_MISMATCH" });
  });

  it("propagates EXTERNAL_SIGNATURE_INVALID for a tampered co-signature", async () => {
    await registerKey(d1, "KEY-BANK-001", publicKey, "PARTICIPANT", "001");

    const occurredAt = new Date().toISOString();
    const signatureB64 = await sign(
      "TX-A",
      "deadbeef".repeat(8),
      "KEY-BANK-001",
      "nonce-1",
      occurredAt
    );

    await expect(
      recordFinalityCosign(d1, {
        chainId: "TX-A",
        participantId: "001",
        signerKeyId: "KEY-BANK-001",
        nonce: "nonce-1",
        occurredAt,
        signatureB64,
      })
    ).rejects.toMatchObject({ reason_code: "EXTERNAL_SIGNATURE_INVALID" });
  });
});
