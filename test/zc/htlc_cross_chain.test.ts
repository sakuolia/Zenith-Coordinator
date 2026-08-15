/**
 * @file Cross-chain HTLC tests (Theme A: オンチェーン決済手段との接続).
 *
 * Covers:
 *  - createHtlc: cross_chain.onchain_timelock must be strictly before timelock
 *    (ONCHAIN_TIMELOCK_INVALID otherwise)
 *  - recordCrossChainLock: HTLC_LOCKED -> HTLC_ONCHAIN_PENDING via a
 *    Watcher-signed CrossChainLocked observation
 *  - recordOnchainFulfillment: HTLC_ONCHAIN_PENDING -> ... -> PAYER_EXEC_CONFIRMED
 *    via a Watcher-signed OnchainProofObserved observation (same hashlock
 *    unlocks both legs)
 *  - ONCHAIN_PROOF_MISMATCH on a preimage that doesn't hash to `hashlock`
 *  - ONCHAIN_TIMEOUT cancellation when the onchain inner timelock has passed
 *  - TIMELOCK_EXPIRED cancellation when the ZC-side outer timelock has passed
 *  - NOT_CROSS_CHAIN / HTLC_NOT_FOUND / INVALID_STATE rejections
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { DomainError } from "../../src/shared/errors";
import { buildSignedMessage, exportVerificationKey } from "../../src/shared/external_signature";
import {
  buildWatcherObservationPayload,
  type RecordWatcherObservationParams,
} from "../../src/shared/watcher";
import {
  createHtlc,
  recordCrossChainLock,
  recordOnchainFulfillment,
} from "../../src/zc/lanes/htlc";
import { processQueueMessage } from "../../src/zc/orchestrator";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";

const BANK_A = "001";
const BANK_B = "002";
const ACC_A = "0010000001"; // payer (seeded with 1,000,000)
const ACC_B = "0020000001"; // payee

let d1: MockD1Database;

interface TestEnv {
  DB: MockD1Database;
  QUEUE: { _sink: any[]; send: (m: any) => Promise<void> };
  ZC_HMAC_SECRET: string;
}

function makeEnv(db: MockD1Database): TestEnv {
  const sink: any[] = [];
  return {
    DB: db,
    QUEUE: {
      _sink: sink,
      send: async (m: any) => {
        sink.push(m);
      },
    },
    ZC_HMAC_SECRET: "test-secret",
  };
}

async function drain(env: TestEnv, max = 20): Promise<void> {
  let n = 0;
  while (env.QUEUE._sink.length > 0 && n < max) {
    const msg = env.QUEUE._sink.shift()!;
    await processQueueMessage(msg, env as any);
    n++;
  }
  if (n >= max) throw new Error("drain: queue did not converge");
}

function seedParticipant(db: MockD1Database, bankId: string) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 10000000, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId)
    ._runSync();
}

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

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  seedParticipant(d1, BANK_A);
  seedParticipant(d1, BANK_B);
});

// ---------------------------------------------------------------------------
// createHtlc: cross_chain.onchain_timelock validation
// ---------------------------------------------------------------------------

describe("createHtlc cross_chain validation", () => {
  it("rejects with ONCHAIN_TIMELOCK_INVALID when onchain_timelock >= timelock", async () => {
    const env = makeEnv(d1);
    const timelock = new Date(Date.now() + 24 * 3600_000).toISOString();
    const onchainTimelock = new Date(Date.now() + 25 * 3600_000).toISOString(); // after timelock

    await expect(
      createHtlc(
        {
          htlc_id: "HTLC-XC-BADTL",
          idempotency_key: "IK-HTLC-XC-BADTL",
          amount: { value: 10_000, currency: "JPY" },
          payer_bank_id: BANK_A,
          payer_account_hash: ACC_A,
          payee_bank_id: BANK_B,
          payee_account_hash: ACC_B,
          timelock,
          cross_chain: { source: "ONCHAIN:ETH", onchain_timelock: onchainTimelock },
          onchain_chain_class: "PRIVATE",
        } as any,
        env as any
      )
    ).rejects.toMatchObject({
      reason_code: "ONCHAIN_TIMELOCK_INVALID",
    } satisfies Partial<DomainError>);
  });

  // S-4: the Watcher quorum default is derived from the finality class, so an
  // unclassified leg would silently take the weakest default (a single Watcher
  // attesting a possibly-reorgable release). Refuse the leg instead.
  it("rejects with ONCHAIN_CHAIN_CLASS_REQUIRED when cross_chain has no onchain_chain_class", async () => {
    const env = makeEnv(d1);
    const timelock = new Date(Date.now() + 24 * 3600_000).toISOString();
    const onchainTimelock = new Date(Date.now() + 12 * 3600_000).toISOString();

    await expect(
      createHtlc(
        {
          htlc_id: "HTLC-XC-NOCLASS",
          idempotency_key: "IK-HTLC-XC-NOCLASS",
          amount: { value: 10_000, currency: "JPY" },
          payer_bank_id: BANK_A,
          payer_account_hash: ACC_A,
          payee_bank_id: BANK_B,
          payee_account_hash: ACC_B,
          timelock,
          cross_chain: { source: "ONCHAIN:ETH", onchain_timelock: onchainTimelock },
        } as any,
        env as any
      )
    ).rejects.toMatchObject({
      reason_code: "ONCHAIN_CHAIN_CLASS_REQUIRED",
      category: "VALIDATION",
    } satisfies Partial<DomainError>);
  });

  // An explicit quorum is not a substitute for the classification: it sets how
  // many Watchers must attest, not whether confirmation depth means anything.
  it("still rejects an unclassified leg that names min_watchers explicitly", async () => {
    const env = makeEnv(d1);
    const timelock = new Date(Date.now() + 24 * 3600_000).toISOString();
    const onchainTimelock = new Date(Date.now() + 12 * 3600_000).toISOString();

    await expect(
      createHtlc(
        {
          htlc_id: "HTLC-XC-NOCLASS-2",
          idempotency_key: "IK-HTLC-XC-NOCLASS-2",
          amount: { value: 10_000, currency: "JPY" },
          payer_bank_id: BANK_A,
          payer_account_hash: ACC_A,
          payee_bank_id: BANK_B,
          payee_account_hash: ACC_B,
          timelock,
          cross_chain: {
            source: "ONCHAIN:ETH",
            onchain_timelock: onchainTimelock,
            min_watchers: 3,
          },
        } as any,
        env as any
      )
    ).rejects.toMatchObject({
      reason_code: "ONCHAIN_CHAIN_CLASS_REQUIRED",
    } satisfies Partial<DomainError>);
  });

  // A same-chain (non cross-chain) HTLC has no onchain leg to classify.
  it("does not require onchain_chain_class when there is no cross_chain leg", async () => {
    const env = makeEnv(d1);
    const created = await createHtlc(
      {
        htlc_id: "HTLC-XC-NONE",
        idempotency_key: "IK-HTLC-XC-NONE",
        amount: { value: 10_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock: new Date(Date.now() + 24 * 3600_000).toISOString(),
      } as any,
      env as any
    );
    expect(created.result).toBe("CREATED");
  });
});

// ---------------------------------------------------------------------------
// Full happy path: HTLC_LOCKED -> HTLC_ONCHAIN_PENDING -> PAYER_EXEC_CONFIRMED
// ---------------------------------------------------------------------------

describe("recordCrossChainLock / recordOnchainFulfillment", () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  beforeEach(async () => {
    ({ privateKey, publicKey } = await generateKeyPair());
    await registerKey(d1, "KEY-WATCHER-XC", publicKey, "EXTERNAL_RAIL", "watcher-eth-001");
  });

  async function createAndLockCrossChainHtlc(
    htlcId: string,
    overrides: { timelock?: string; onchain_timelock?: string } = {}
  ) {
    const env = makeEnv(d1);
    const timelock = overrides.timelock ?? new Date(Date.now() + 24 * 3600_000).toISOString();
    const onchainTimelock =
      overrides.onchain_timelock ?? new Date(Date.now() + 12 * 3600_000).toISOString();

    const created = await createHtlc(
      {
        htlc_id: htlcId,
        idempotency_key: `IK-${htlcId}`,
        amount: { value: 10_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock,
        // PUBLIC because these cases are about confirmation depth, which only
        // has meaning on a probabilistic chain. `min_watchers: 1` keeps the
        // class-derived quorum default (2) out of the way — the quorum is
        // covered by htlc_crosschain_quorum.test.ts.
        cross_chain: {
          source: "ONCHAIN:ETH",
          onchain_timelock: onchainTimelock,
          min_watchers: 1,
        },
        onchain_chain_class: "PUBLIC",
      } as any,
      env as any
    );
    expect(created.result).toBe("CREATED");
    await drain(env);

    const locked = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ state: string }>();
    expect(locked?.state).toBe("HTLC_LOCKED");

    return { env, hashlock: created.hashlock!, preimage: created.preimage! };
  }

  it("HTLC_LOCKED -> HTLC_ONCHAIN_PENDING -> PAYER_EXEC_CONFIRMED via Watcher proofs", async () => {
    const htlcId = "HTLC-XC-001";
    const { env, preimage } = await createAndLockCrossChainHtlc(htlcId);

    // --- CrossChainLocked observation ---
    const lockParams = {
      source: "ONCHAIN:ETH",
      externalRef: "0xlock-001",
      venue: "ONCHAIN" as const,
      proofType: "ONCHAIN_ESCROW_LOCK_PROOF" as const,
      issuerRef: BANK_B,
    };
    const occurredAt1 = new Date().toISOString();
    const sig1 = await signObservation(
      privateKey,
      lockParams,
      "KEY-WATCHER-XC",
      "nonce-lock-1",
      occurredAt1
    );

    const lockResult = await recordCrossChainLock(
      {
        htlc_id: htlcId,
        external_ref: "0xlock-001",
        watcher_key_id: "KEY-WATCHER-XC",
        nonce: "nonce-lock-1",
        occurred_at: occurredAt1,
        signature: sig1,
        idempotency_key: `IK-XC-LOCK-${htlcId}`,
      },
      env as any
    );
    expect(lockResult.result).toBe("ACCEPTED");
    expect(lockResult.state).toBe("HTLC_ONCHAIN_PENDING");

    const pendingRow = await d1
      .prepare(`SELECT state, onchain_lock_ref FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ state: string; onchain_lock_ref: string }>();
    expect(pendingRow?.state).toBe("HTLC_ONCHAIN_PENDING");
    expect(pendingRow?.onchain_lock_ref).toBe("0xlock-001");

    // --- OnchainProofObserved observation (preimage release) ---
    const releaseParams = {
      source: "ONCHAIN:ETH",
      externalRef: "0xrelease-001",
      venue: "ONCHAIN" as const,
      proofType: "ONCHAIN_RELEASE_PROOF" as const,
      issuerRef: BANK_B,
    };
    const occurredAt2 = new Date().toISOString();
    const sig2 = await signObservation(
      privateKey,
      releaseParams,
      "KEY-WATCHER-XC",
      "nonce-release-1",
      occurredAt2
    );

    const fulfillResult = await recordOnchainFulfillment(
      {
        htlc_id: htlcId,
        external_ref: "0xrelease-001",
        preimage,
        watcher_key_id: "KEY-WATCHER-XC",
        nonce: "nonce-release-1",
        occurred_at: occurredAt2,
        signature: sig2,
        idempotency_key: `IK-XC-FULFILL-${htlcId}`,
      },
      env as any
    );
    expect(fulfillResult.result).toBe("ACCEPTED");
    expect(fulfillResult.state).toBe("PAYER_EXEC_CONFIRMED");

    const txRow = await d1
      .prepare(
        `SELECT t.state FROM Transactions t JOIN HtlcContracts h ON h.txid = t.txid WHERE h.htlc_id = ?`
      )
      .bind(htlcId)
      .first<{ state: string }>();
    expect(txRow?.state).toBe("PAYER_EXEC_CONFIRMED");

    // Theme I: the externally-signed SettlementProofRef behind this "b"
    // transition is recorded as its own audit event, distinct from
    // OnchainProofObserved.
    const contractRow = await d1
      .prepare(`SELECT txid FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ txid: string }>();
    const acceptedEvent = await d1
      .prepare(
        `SELECT event_type, payload_json FROM FinalityLog WHERE txid = ? AND event_type = 'SettlementProofAccepted'`
      )
      .bind(contractRow?.txid)
      .first<{ event_type: string; payload_json: string }>();
    expect(acceptedEvent?.event_type).toBe("SettlementProofAccepted");
    const acceptedPayload = JSON.parse(acceptedEvent!.payload_json);
    expect(acceptedPayload.htlc_id).toBe(htlcId);
    expect(acceptedPayload.proof_ref.venue).toBe("ONCHAIN");
    expect(acceptedPayload.proof_ref.signer_key_id).toBe("KEY-WATCHER-XC");
    expect(acceptedPayload.proof_ref.verified_at).toBeTruthy();
  });

  it("rejects with ONCHAIN_PROOF_MISMATCH when the preimage does not hash to hashlock", async () => {
    const htlcId = "HTLC-XC-MISMATCH";
    const { env } = await createAndLockCrossChainHtlc(htlcId);

    const lockParams = {
      source: "ONCHAIN:ETH",
      externalRef: "0xlock-mismatch",
      venue: "ONCHAIN" as const,
      proofType: "ONCHAIN_ESCROW_LOCK_PROOF" as const,
      issuerRef: BANK_B,
    };
    const occurredAt1 = new Date().toISOString();
    const sig1 = await signObservation(
      privateKey,
      lockParams,
      "KEY-WATCHER-XC",
      "nonce-lm-1",
      occurredAt1
    );
    await recordCrossChainLock(
      {
        htlc_id: htlcId,
        external_ref: "0xlock-mismatch",
        watcher_key_id: "KEY-WATCHER-XC",
        nonce: "nonce-lm-1",
        occurred_at: occurredAt1,
        signature: sig1,
        idempotency_key: `IK-XC-LOCK-${htlcId}`,
      },
      env as any
    );

    const releaseParams = {
      source: "ONCHAIN:ETH",
      externalRef: "0xrelease-mismatch",
      venue: "ONCHAIN" as const,
      proofType: "ONCHAIN_RELEASE_PROOF" as const,
      issuerRef: BANK_B,
    };
    const occurredAt2 = new Date().toISOString();
    const sig2 = await signObservation(
      privateKey,
      releaseParams,
      "KEY-WATCHER-XC",
      "nonce-rm-1",
      occurredAt2
    );

    const fulfillResult = await recordOnchainFulfillment(
      {
        htlc_id: htlcId,
        external_ref: "0xrelease-mismatch",
        preimage: "00".repeat(32), // wrong preimage
        watcher_key_id: "KEY-WATCHER-XC",
        nonce: "nonce-rm-1",
        occurred_at: occurredAt2,
        signature: sig2,
        idempotency_key: `IK-XC-FULFILL-${htlcId}`,
      },
      env as any
    );
    expect(fulfillResult.result).toBe("REJECTED");
    expect(fulfillResult.reason_code).toBe("ONCHAIN_PROOF_MISMATCH");

    // State unchanged — still HTLC_ONCHAIN_PENDING.
    const row = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ state: string }>();
    expect(row?.state).toBe("HTLC_ONCHAIN_PENDING");
  });

  // Confirmation depth: once the inner timelock has passed, a
  // release is HELD (not cancelled) until it is confirmed deeply enough. ZC no
  // longer treats its own clock crossing the inner timelock as proof of refund.
  it("holds a release observed after the inner timelock until it is sufficiently confirmed", async () => {
    const htlcId = "HTLC-XC-UNDERCONF";
    const { env, preimage } = await createAndLockCrossChainHtlc(htlcId);

    const lockParams = {
      source: "ONCHAIN:ETH",
      externalRef: "0xlock-underconf",
      venue: "ONCHAIN" as const,
      proofType: "ONCHAIN_ESCROW_LOCK_PROOF" as const,
      issuerRef: BANK_B,
    };
    const occurredAt1 = new Date().toISOString();
    const sig1 = await signObservation(
      privateKey,
      lockParams,
      "KEY-WATCHER-XC",
      "nonce-uc-1",
      occurredAt1
    );
    await recordCrossChainLock(
      {
        htlc_id: htlcId,
        external_ref: "0xlock-underconf",
        watcher_key_id: "KEY-WATCHER-XC",
        nonce: "nonce-uc-1",
        occurred_at: occurredAt1,
        signature: sig1,
        idempotency_key: `IK-XC-LOCK-${htlcId}`,
      },
      env as any
    );

    // Require deep confirmations, and backdate the inner timelock so the gate applies.
    d1.prepare(
      `UPDATE HtlcContracts SET onchain_min_confirmations=6, onchain_timelock='2000-01-01T00:00:00Z' WHERE htlc_id=?`
    )
      .bind(htlcId)
      ._runSync();

    const releaseParams = {
      source: "ONCHAIN:ETH",
      externalRef: "0xrelease-underconf",
      venue: "ONCHAIN" as const,
      proofType: "ONCHAIN_RELEASE_PROOF" as const,
      issuerRef: BANK_B,
      confirmations: 2, // below the required 6
    };
    const occurredAt2 = new Date().toISOString();
    const sig2 = await signObservation(
      privateKey,
      releaseParams,
      "KEY-WATCHER-XC",
      "nonce-uc-2",
      occurredAt2
    );

    const fulfillResult = await recordOnchainFulfillment(
      {
        htlc_id: htlcId,
        external_ref: "0xrelease-underconf",
        preimage, // VALID preimage — the claim really happened, just shallowly confirmed
        watcher_key_id: "KEY-WATCHER-XC",
        nonce: "nonce-uc-2",
        occurred_at: occurredAt2,
        signature: sig2,
        confirmations: 2,
        idempotency_key: `IK-XC-FULFILL-${htlcId}`,
      },
      env as any
    );
    expect(fulfillResult.result).toBe("REJECTED");
    expect(fulfillResult.reason_code).toBe("ONCHAIN_INSUFFICIENT_CONFIRMATIONS");

    // HELD, not cancelled: the HTLC stays HTLC_ONCHAIN_PENDING so a deeper
    // observation can still settle it (outer timelock is the hard backstop).
    const htlcRow = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id=?`)
      .bind(htlcId)
      .first<{ state: string }>();
    expect(htlcRow?.state).toBe("HTLC_ONCHAIN_PENDING");
  });

  // A sufficiently-confirmed valid release after the inner timelock settles —
  // the fix for the inner-timelock divergence (chaos probe #5).
  it("settles a release observed after the inner timelock when confirmed deeply enough", async () => {
    const htlcId = "HTLC-XC-CONFIRMED";
    const { env, preimage } = await createAndLockCrossChainHtlc(htlcId);

    const lockParams = {
      source: "ONCHAIN:ETH",
      externalRef: "0xlock-conf",
      venue: "ONCHAIN" as const,
      proofType: "ONCHAIN_ESCROW_LOCK_PROOF" as const,
      issuerRef: BANK_B,
    };
    const occurredAt1 = new Date().toISOString();
    const sig1 = await signObservation(
      privateKey,
      lockParams,
      "KEY-WATCHER-XC",
      "nonce-cf-1",
      occurredAt1
    );
    await recordCrossChainLock(
      {
        htlc_id: htlcId,
        external_ref: "0xlock-conf",
        watcher_key_id: "KEY-WATCHER-XC",
        nonce: "nonce-cf-1",
        occurred_at: occurredAt1,
        signature: sig1,
        idempotency_key: `IK-XC-LOCK-${htlcId}`,
      },
      env as any
    );

    d1.prepare(
      `UPDATE HtlcContracts SET onchain_min_confirmations=6, onchain_timelock='2000-01-01T00:00:00Z' WHERE htlc_id=?`
    )
      .bind(htlcId)
      ._runSync();

    const releaseParams = {
      source: "ONCHAIN:ETH",
      externalRef: "0xrelease-conf",
      venue: "ONCHAIN" as const,
      proofType: "ONCHAIN_RELEASE_PROOF" as const,
      issuerRef: BANK_B,
      confirmations: 6,
    };
    const occurredAt2 = new Date().toISOString();
    const sig2 = await signObservation(
      privateKey,
      releaseParams,
      "KEY-WATCHER-XC",
      "nonce-cf-2",
      occurredAt2
    );

    const fulfillResult = await recordOnchainFulfillment(
      {
        htlc_id: htlcId,
        external_ref: "0xrelease-conf",
        preimage,
        watcher_key_id: "KEY-WATCHER-XC",
        nonce: "nonce-cf-2",
        occurred_at: occurredAt2,
        signature: sig2,
        confirmations: 6,
        idempotency_key: `IK-XC-FULFILL-${htlcId}`,
      },
      env as any
    );
    expect(fulfillResult.result).toBe("ACCEPTED");
    expect(fulfillResult.state).toBe("PAYER_EXEC_CONFIRMED");
  });

  it("cancels with TIMELOCK_EXPIRED when the ZC-side outer timelock has passed", async () => {
    const htlcId = "HTLC-XC-TIMELOCKEXPIRED";
    const { env } = await createAndLockCrossChainHtlc(htlcId);

    const lockParams = {
      source: "ONCHAIN:ETH",
      externalRef: "0xlock-zctimeout",
      venue: "ONCHAIN" as const,
      proofType: "ONCHAIN_ESCROW_LOCK_PROOF" as const,
      issuerRef: BANK_B,
    };
    const occurredAt1 = new Date().toISOString();
    const sig1 = await signObservation(
      privateKey,
      lockParams,
      "KEY-WATCHER-XC",
      "nonce-zc-1",
      occurredAt1
    );
    await recordCrossChainLock(
      {
        htlc_id: htlcId,
        external_ref: "0xlock-zctimeout",
        watcher_key_id: "KEY-WATCHER-XC",
        nonce: "nonce-zc-1",
        occurred_at: occurredAt1,
        signature: sig1,
        idempotency_key: `IK-XC-LOCK-${htlcId}`,
      },
      env as any
    );

    // Backdate both timelocks so the ZC-side outer timelock is the one that's expired.
    d1.prepare(`UPDATE HtlcContracts SET timelock = ?, onchain_timelock = ? WHERE htlc_id = ?`)
      .bind("2000-01-01T01:00:00Z", "2000-01-01T00:00:00Z", htlcId)
      ._runSync();

    const releaseParams = {
      source: "ONCHAIN:ETH",
      externalRef: "0xrelease-zctimeout",
      venue: "ONCHAIN" as const,
      proofType: "ONCHAIN_RELEASE_PROOF" as const,
      issuerRef: BANK_B,
    };
    const occurredAt2 = new Date().toISOString();
    const sig2 = await signObservation(
      privateKey,
      releaseParams,
      "KEY-WATCHER-XC",
      "nonce-zc-2",
      occurredAt2
    );

    const fulfillResult = await recordOnchainFulfillment(
      {
        htlc_id: htlcId,
        external_ref: "0xrelease-zctimeout",
        preimage: "00".repeat(32),
        watcher_key_id: "KEY-WATCHER-XC",
        nonce: "nonce-zc-2",
        occurred_at: occurredAt2,
        signature: sig2,
        idempotency_key: `IK-XC-FULFILL-${htlcId}`,
      },
      env as any
    );
    expect(fulfillResult.result).toBe("REJECTED");
    expect(fulfillResult.reason_code).toBe("TIMELOCK_EXPIRED");
    expect(fulfillResult.state).toBe("DECIDED_CANCEL");
  });

  it("rejects recordCrossChainLock with NOT_CROSS_CHAIN for a regular HTLC", async () => {
    const env = makeEnv(d1);
    const htlcId = "HTLC-XC-NOTCROSS";
    const timelock = new Date(Date.now() + 24 * 3600_000).toISOString();

    const created = await createHtlc(
      {
        htlc_id: htlcId,
        idempotency_key: `IK-${htlcId}`,
        amount: { value: 10_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock,
      } as any,
      env as any
    );
    expect(created.result).toBe("CREATED");
    await drain(env);

    const result = await recordCrossChainLock(
      {
        htlc_id: htlcId,
        external_ref: "0xirrelevant",
        watcher_key_id: "KEY-WATCHER-XC",
        nonce: "nonce-nc-1",
        occurred_at: new Date().toISOString(),
        signature: "irrelevant",
        idempotency_key: `IK-XC-LOCK-${htlcId}`,
      },
      env as any
    );
    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("NOT_CROSS_CHAIN");
  });

  it("rejects recordCrossChainLock with HTLC_NOT_FOUND for an unknown htlc_id", async () => {
    const env = makeEnv(d1);
    const result = await recordCrossChainLock(
      {
        htlc_id: "HTLC-XC-NOPE",
        external_ref: "0xirrelevant",
        watcher_key_id: "KEY-WATCHER-XC",
        nonce: "nonce-nf-1",
        occurred_at: new Date().toISOString(),
        signature: "irrelevant",
        idempotency_key: "IK-XC-LOCK-NOPE",
      },
      env as any
    );
    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("HTLC_NOT_FOUND");
  });

  it("rejects recordCrossChainLock with INVALID_STATE when the HTLC is not HTLC_LOCKED", async () => {
    const htlcId = "HTLC-XC-WRONGSTATE";
    const env = makeEnv(d1);
    const timelock = new Date(Date.now() + 24 * 3600_000).toISOString();
    const onchainTimelock = new Date(Date.now() + 12 * 3600_000).toISOString();

    const created = await createHtlc(
      {
        htlc_id: htlcId,
        idempotency_key: `IK-${htlcId}`,
        amount: { value: 10_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock,
        cross_chain: { source: "ONCHAIN:ETH", onchain_timelock: onchainTimelock },
        onchain_chain_class: "PRIVATE",
      } as any,
      env as any
    );
    expect(created.result).toBe("CREATED");
    // Do NOT drain — HTLC is still HTLC_RECEIVED, not HTLC_LOCKED.

    const result = await recordCrossChainLock(
      {
        htlc_id: htlcId,
        external_ref: "0xirrelevant",
        watcher_key_id: "KEY-WATCHER-XC",
        nonce: "nonce-ws-1",
        occurred_at: new Date().toISOString(),
        signature: "irrelevant",
        idempotency_key: `IK-XC-LOCK-${htlcId}`,
      },
      env as any
    );
    expect(result.result).toBe("REJECTED");
    expect(result.reason_code).toBe("INVALID_STATE");
  });
});
