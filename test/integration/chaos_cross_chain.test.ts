/**
 * @file chaos_cross_chain.test.ts — Adversarial probe #5: cross-chain HTLC
 *       in-doubt at the inner (onchain) timelock boundary.
 *
 * This is the cross-chain analogue of the HIGH_VALUE IGS in-doubt bug
 * (chaos_delivery.test.ts probe #4). A cross-chain HTLC locks the same hashlock
 * on an external chain (escrow) and on the ZC side. Safety relies on the inner
 * (onchain) timelock expiring strictly before the ZC-side outer timelock: the
 * party holding the preimage must claim the onchain escrow before the inner
 * timelock, and the Watcher relays that claim to ZC as an OnchainProofObserved.
 *
 * THE GAP this probe documents: `recordOnchainFulfillment` checks the inner
 * timelock against ZC's own clock *before* it verifies the preimage. So a
 * release observation that is VALID (its preimage hashes to the hashlock — i.e.
 * the counterparty really did claim the onchain escrow) but arrives just after
 * the inner timelock is discarded with ONCHAIN_TIMEOUT, and the HTLC is
 * cancelled / the payer refunded. ZC concludes "onchain leg refunded" while the
 * onchain reality is "onchain leg claimed" — the exact two-ledger divergence
 * the "finality is external" design must survive.
 *
 * The Watcher relays only final on-chain events and cannot model confirmation
 * depth / reorgs yet (docs/specs/30_internal_design.md "提言アンサーソング" roadmap:
 * "確認数 confirmations を proof メタへ ... は未着手"). This test pins the
 * current behaviour as a CHARACTERIZATION so the divergence is visible and a
 * fix can be designed against it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildSignedMessage, exportVerificationKey } from "../../src/shared/external_signature";
import { sha256hex } from "../../src/shared/hmac";
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
const ACC_A = "0010000001";
const ACC_B = "0020000001";

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
      send: async (m) => {
        sink.push(m);
      },
    },
    ZC_HMAC_SECRET: "test-secret",
  };
}

async function drain(env: TestEnv, max = 20): Promise<void> {
  let n = 0;
  while (env.QUEUE._sink.length > 0 && n < max) {
    await processQueueMessage(env.QUEUE._sink.shift()!, env as any);
    n++;
  }
  if (n >= max) throw new Error("drain: did not converge");
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

async function balanceOf(db: MockD1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ?`)
    .bind(accountId)
    .first<{ b: number }>();
  return row?.b ?? 0;
}

function b64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

async function registerKey(db: MockD1Database, keyId: string, publicKey: CryptoKey): Promise<void> {
  await db
    .prepare(
      `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
       VALUES (?, 'EXTERNAL_RAIL', 'watcher-eth-001', ?, 'ED25519', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
    )
    .bind(keyId, await exportVerificationKey(publicKey))
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

let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeEach(async () => {
  ({ d1 } = createTestDb());
  seedParticipant(d1, BANK_A);
  seedParticipant(d1, BANK_B);
  ({ privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]));
  await registerKey(d1, "KEY-WATCHER-XC", publicKey);
});

describe("chaos #5: cross-chain HTLC release lands just after the inner timelock", () => {
  it("honors a deeply-confirmed valid claim past the inner timelock instead of discarding it (no divergence)", async () => {
    const env = makeEnv(d1);
    const htlcId = "HTLC-XC-INDOUBT";
    const outerTimelock = new Date(Date.now() + 24 * 3600_000).toISOString();
    const innerTimelock = new Date(Date.now() + 12 * 3600_000).toISOString(); // valid: inner < outer

    const created = await createHtlc(
      {
        htlc_id: htlcId,
        idempotency_key: `IK-${htlcId}`,
        amount: { value: 10_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock: outerTimelock,
        cross_chain: {
          source: "ONCHAIN:ETH",
          onchain_timelock: innerTimelock,
          min_confirmations: 6,
          // This case is about confirmation depth, not the Watcher quorum, so
          // pin the quorum to 1 rather than inherit PUBLIC's default of 2.
          min_watchers: 1,
        },
        // A confirmation depth of 6 only means anything on a probabilistic
        // chain, so classify the leg as such.
        onchain_chain_class: "PUBLIC",
      } as any,
      env as any
    );
    expect(created.result).toBe("CREATED");
    const preimage = created.preimage!;
    const hashlock = created.hashlock!;
    await drain(env); // HTLC_RECEIVED -> HTLC_LOCKED

    // Watcher observes the onchain escrow lock: HTLC_LOCKED -> HTLC_ONCHAIN_PENDING.
    const occ1 = new Date().toISOString();
    const sig1 = await signObservation(
      privateKey,
      {
        source: "ONCHAIN:ETH",
        externalRef: "0xlock-id",
        venue: "ONCHAIN",
        proofType: "ONCHAIN_ESCROW_LOCK_PROOF",
        issuerRef: BANK_B,
      },
      "KEY-WATCHER-XC",
      "nonce-lock",
      occ1
    );
    const lockRes = await recordCrossChainLock(
      {
        htlc_id: htlcId,
        external_ref: "0xlock-id",
        watcher_key_id: "KEY-WATCHER-XC",
        nonce: "nonce-lock",
        occurred_at: occ1,
        signature: sig1,
        idempotency_key: `IK-LOCK-${htlcId}`,
      },
      env as any
    );
    expect(lockRes.state).toBe("HTLC_ONCHAIN_PENDING");

    // The counterparty claims the onchain escrow at the last moment by revealing
    // the preimage, but the Watcher's relay lags: by the time the release
    // observation reaches ZC, ZC's clock says the inner timelock has passed.
    // Simulate by aging the inner timelock into the past.
    d1.prepare(
      `UPDATE HtlcContracts SET onchain_timelock='2000-01-01T00:00:00.000Z' WHERE htlc_id=?`
    )
      .bind(htlcId)
      ._runSync();

    // The preimage is genuinely VALID — it hashes to the hashlock, i.e. the
    // onchain claim really happened. ZC should not be able to pretend it didn't.
    expect(await sha256hex(preimage)).toBe(hashlock);

    // The Watcher relays the claim with sufficient confirmation depth (>= the
    // HTLC's onchain_min_confirmations=6), i.e. the onchain claim is deep enough
    // to be reorg-irreversible. Confirmations are part of the signed payload.
    const occ2 = new Date().toISOString();
    const sig2 = await signObservation(
      privateKey,
      {
        source: "ONCHAIN:ETH",
        externalRef: "0xrelease-id",
        venue: "ONCHAIN",
        proofType: "ONCHAIN_RELEASE_PROOF",
        issuerRef: BANK_B,
        confirmations: 6,
      },
      "KEY-WATCHER-XC",
      "nonce-release",
      occ2
    );
    const fulfill = await recordOnchainFulfillment(
      {
        htlc_id: htlcId,
        external_ref: "0xrelease-id",
        preimage,
        watcher_key_id: "KEY-WATCHER-XC",
        nonce: "nonce-release",
        occurred_at: occ2,
        signature: sig2,
        confirmations: 6,
        idempotency_key: `IK-FULFILL-${htlcId}`,
      },
      env as any
    );

    // ---- FIXED (confirmation depth) ----
    // The valid, deeply-confirmed claim is HONORED even though ZC's clock is
    // past the inner timelock — the preimage is verified and the confirmation
    // gate is satisfied, so ZC settles instead of discarding it.
    expect(fulfill.result).toBe("ACCEPTED");
    expect(fulfill.state).toBe("PAYER_EXEC_CONFIRMED");

    const htlc = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id=?`)
      .bind(htlcId)
      .first<{ state: string }>();
    expect(htlc?.state).not.toBe("DECIDED_CANCEL");

    // No divergence: ZC's view now matches the onchain reality (claimed). The
    // settlement completes and the payee is credited (+10,000 over the seed).
    await drain(env);
    expect(await balanceOf(d1, ACC_B)).toBe(1_000_000 + 10_000);
  });
});
