/**
 * @file htlc_crosschain_quorum.test.ts — n-of-m Watcher quorum for cross-chain
 *       HTLC settlement (trust minimization).
 *
 * The cross-chain HTLC trust root is the Watcher's signed observation of the
 * onchain release. With `min_watchers: N` (N≥2), a single Watcher key can no
 * longer settle a cross-chain leg on its own: ZC holds the HTLC in
 * HTLC_ONCHAIN_PENDING until N *distinct Watcher operators* (KeyRegistry
 * owner_ref, not key_id) have independently attested the same release. These
 * tests pin: one Watcher → held; same Watcher twice → still held (no faked
 * quorum); a second distinct Watcher → settles. Confirmation depth and the
 * preimage check remain enforced per vote.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { isDomainError } from "../../src/shared/errors";
import { buildSignedMessage, exportVerificationKey } from "../../src/shared/external_signature";
import {
  buildWatcherObservationPayload,
  countDistinctWatchers,
  type RecordWatcherObservationParams,
  recordWatcherObservation,
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

/** Register a Watcher key under a distinct operator (owner_ref). */
async function registerWatcher(
  db: MockD1Database,
  keyId: string,
  ownerRef: string,
  publicKey: CryptoKey
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
       VALUES (?, 'EXTERNAL_RAIL', ?, ?, 'ED25519', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
    )
    .bind(keyId, ownerRef, await exportVerificationKey(publicKey))
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

interface Watcher {
  keyId: string;
  ownerRef: string;
  privateKey: CryptoKey;
}

async function makeWatcher(keyId: string, ownerRef: string): Promise<Watcher> {
  const { privateKey, publicKey } = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  await registerWatcher(d1, keyId, ownerRef, publicKey);
  return { keyId, ownerRef, privateKey };
}

let w1: Watcher;
let w2: Watcher;

beforeEach(async () => {
  ({ d1 } = createTestDb());
  seedParticipant(d1, BANK_A);
  seedParticipant(d1, BANK_B);
  w1 = await makeWatcher("KEY-W1", "watcher-eth-001");
  w2 = await makeWatcher("KEY-W2", "watcher-eth-002");
});

const RELEASE_REF = "0xrelease-id";

/** Lock a cross-chain HTLC requiring `minWatchers` and advance to ONCHAIN_PENDING. */
async function lockToOnchainPending(env: TestEnv, htlcId: string, minWatchers: number) {
  const outer = new Date(Date.now() + 24 * 3600_000).toISOString();
  const inner = new Date(Date.now() + 12 * 3600_000).toISOString();
  const created = await createHtlc(
    {
      htlc_id: htlcId,
      idempotency_key: `IK-${htlcId}`,
      amount: { value: 10_000, currency: "JPY" },
      payer_bank_id: BANK_A,
      payer_account_hash: ACC_A,
      payee_bank_id: BANK_B,
      payee_account_hash: ACC_B,
      timelock: outer,
      cross_chain: {
        source: "ONCHAIN:ETH",
        onchain_timelock: inner,
        min_confirmations: 0,
        min_watchers: minWatchers,
      },
      // Deterministic chain: the class-derived default is 1, so a test that
      // passes no `min_watchers` still exercises the single-Watcher path.
      onchain_chain_class: "PRIVATE",
    } as any,
    env as any
  );
  const preimage = created.preimage!;
  await drain(env); // HTLC_RECEIVED -> HTLC_LOCKED

  // Watcher w1 observes the onchain escrow lock (lock is not quorum-gated).
  const occ = new Date().toISOString();
  const sig = await signObservation(
    w1.privateKey,
    {
      source: "ONCHAIN:ETH",
      externalRef: "0xlock-id",
      venue: "ONCHAIN",
      proofType: "ONCHAIN_ESCROW_LOCK_PROOF",
      issuerRef: BANK_B,
    },
    w1.keyId,
    "nonce-lock",
    occ
  );
  const lockRes = await recordCrossChainLock(
    {
      htlc_id: htlcId,
      external_ref: "0xlock-id",
      watcher_key_id: w1.keyId,
      nonce: "nonce-lock",
      occurred_at: occ,
      signature: sig,
      idempotency_key: `IK-LOCK-${htlcId}`,
    },
    env as any
  );
  expect(lockRes.state).toBe("HTLC_ONCHAIN_PENDING");
  return preimage;
}

/** A release vote by `w` for the shared release event. */
async function releaseVote(
  env: TestEnv,
  htlcId: string,
  preimage: string,
  w: Watcher,
  nonce: string
) {
  const occ = new Date().toISOString();
  const sig = await signObservation(
    w.privateKey,
    {
      source: "ONCHAIN:ETH",
      externalRef: RELEASE_REF,
      venue: "ONCHAIN",
      proofType: "ONCHAIN_RELEASE_PROOF",
      issuerRef: BANK_B,
    },
    w.keyId,
    nonce,
    occ
  );
  return recordOnchainFulfillment(
    {
      htlc_id: htlcId,
      external_ref: RELEASE_REF,
      preimage,
      watcher_key_id: w.keyId,
      nonce,
      occurred_at: occ,
      signature: sig,
      idempotency_key: `IK-FULFILL-${htlcId}-${w.keyId}-${nonce}`,
    },
    env as any
  );
}

async function htlcState(htlcId: string): Promise<string | undefined> {
  return (
    await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id=?`)
      .bind(htlcId)
      .first<{ state: string }>()
  )?.state;
}

describe("cross-chain HTLC Watcher quorum (min_watchers = 2)", () => {
  it("holds settlement on a single Watcher's release (ONCHAIN_QUORUM_PENDING), no money moves", async () => {
    const env = makeEnv(d1);
    const preimage = await lockToOnchainPending(env, "HTLC-Q-1", 2);

    const first = await releaseVote(env, "HTLC-Q-1", preimage, w1, "nonce-r1");
    expect(first.result).toBe("ACCEPTED");
    expect(first.reason_code).toBe("ONCHAIN_QUORUM_PENDING");
    expect(first.state).toBe("HTLC_ONCHAIN_PENDING");
    expect(await htlcState("HTLC-Q-1")).toBe("HTLC_ONCHAIN_PENDING");
    await drain(env);
    expect(await balanceOf(d1, ACC_B)).toBe(1_000_000); // not credited yet
  });

  it("cannot fake quorum by the same Watcher voting twice", async () => {
    const env = makeEnv(d1);
    const preimage = await lockToOnchainPending(env, "HTLC-Q-2", 2);

    await releaseVote(env, "HTLC-Q-2", preimage, w1, "nonce-r1");
    // Same operator (w1) signs again with a fresh nonce: a new signature, but the
    // distinct-operator count stays 1, so settlement is still held.
    const second = await releaseVote(env, "HTLC-Q-2", preimage, w1, "nonce-r1-again");
    expect(second.reason_code).toBe("ONCHAIN_QUORUM_PENDING");
    expect(await htlcState("HTLC-Q-2")).toBe("HTLC_ONCHAIN_PENDING");
    await drain(env);
    expect(await balanceOf(d1, ACC_B)).toBe(1_000_000);
  });

  it("settles once a second DISTINCT Watcher attests the same release (quorum met)", async () => {
    const env = makeEnv(d1);
    const preimage = await lockToOnchainPending(env, "HTLC-Q-3", 2);

    const first = await releaseVote(env, "HTLC-Q-3", preimage, w1, "nonce-r1");
    expect(first.reason_code).toBe("ONCHAIN_QUORUM_PENDING");

    const second = await releaseVote(env, "HTLC-Q-3", preimage, w2, "nonce-r2");
    expect(second.result).toBe("ACCEPTED");
    expect(second.state).toBe("PAYER_EXEC_CONFIRMED");
    expect(await htlcState("HTLC-Q-3")).not.toBe("DECIDED_CANCEL");

    // Settlement completes end-to-end: the payee is credited the amount exactly
    // once (the definitive proof that quorum unblocked settlement).
    await drain(env);
    expect(await balanceOf(d1, ACC_B)).toBe(1_000_000 + 10_000);
  });

  it("default min_watchers = 1 keeps the single-Watcher path settling (backward compatible)", async () => {
    const env = makeEnv(d1);
    const preimage = await lockToOnchainPending(env, "HTLC-Q-4", 1);

    const only = await releaseVote(env, "HTLC-Q-4", preimage, w1, "nonce-r1");
    expect(only.result).toBe("ACCEPTED");
    expect(only.state).toBe("PAYER_EXEC_CONFIRMED");
    await drain(env);
    expect(await balanceOf(d1, ACC_B)).toBe(1_000_000 + 10_000);
  });
});

// ---------------------------------------------------------------------------
// Equivocation: a quorum only counts if the distinct Watchers agree on WHAT
// they observed. A second Watcher contradicting the first about the same event
// must not pad the count — it converges into a CASE and settlement stays held.
// ---------------------------------------------------------------------------

/** Build a release vote with explicit overrides (external_ref / confirmations). */
async function releaseVoteEx(
  env: TestEnv,
  htlcId: string,
  preimage: string,
  w: Watcher,
  nonce: string,
  opts: { confirmations?: number; externalRef?: string } = {}
) {
  const externalRef = opts.externalRef ?? RELEASE_REF;
  const occ = new Date().toISOString();
  const params = {
    source: "ONCHAIN:ETH",
    externalRef,
    venue: "ONCHAIN" as any,
    proofType: "ONCHAIN_RELEASE_PROOF" as any,
    issuerRef: BANK_B,
    confirmations: opts.confirmations,
  };
  const sig = await signObservation(w.privateKey, params, w.keyId, nonce, occ);
  return recordOnchainFulfillment(
    {
      htlc_id: htlcId,
      external_ref: externalRef,
      preimage,
      watcher_key_id: w.keyId,
      nonce,
      occurred_at: occ,
      signature: sig,
      confirmations: opts.confirmations,
      idempotency_key: `IK-FULFILL-${htlcId}-${w.keyId}-${nonce}`,
    } as any,
    env as any
  );
}

/** Sign + record a Watcher observation DIRECTLY (bypassing the lane handlers) so
 *  the equivocation guard can be exercised at its own level. */
async function recordObs(
  db: MockD1Database,
  w: Watcher,
  externalRef: string,
  proofType: string,
  nonce: string
) {
  const occ = new Date().toISOString();
  const params = {
    source: "ONCHAIN:ETH",
    externalRef,
    venue: "ONCHAIN" as any,
    proofType: proofType as any,
    issuerRef: BANK_B,
  };
  const sig = await signObservation(w.privateKey, params, w.keyId, nonce, occ);
  return recordWatcherObservation(db as any, {
    source: "ONCHAIN:ETH",
    externalRef,
    venue: "ONCHAIN",
    proofType: proofType as any,
    issuerRef: BANK_B,
    watcherKeyId: w.keyId,
    nonce,
    occurredAt: occ,
    signatureB64: sig,
  });
}

/** Lock a depth-gated cross-chain HTLC: PUBLIC chain, min_confirmations, inner timelock in the PAST. */
async function lockDepthGated(
  env: TestEnv,
  htlcId: string,
  minWatchers: number,
  minConfirmations: number
) {
  const outer = new Date(Date.now() + 24 * 3600_000).toISOString();
  const innerPast = new Date(Date.now() - 60_000).toISOString(); // already elapsed → depth gate applies
  const created = await createHtlc(
    {
      htlc_id: htlcId,
      idempotency_key: `IK-${htlcId}`,
      amount: { value: 10_000, currency: "JPY" },
      payer_bank_id: BANK_A,
      payer_account_hash: ACC_A,
      payee_bank_id: BANK_B,
      payee_account_hash: ACC_B,
      timelock: outer,
      cross_chain: {
        source: "ONCHAIN:ETH",
        onchain_timelock: innerPast,
        min_confirmations: minConfirmations,
        min_watchers: minWatchers,
      },
      onchain_chain_class: "PUBLIC",
    } as any,
    env as any
  );
  const preimage = created.preimage!;
  await drain(env);
  const occ = new Date().toISOString();
  const sig = await signObservation(
    w1.privateKey,
    {
      source: "ONCHAIN:ETH",
      externalRef: `0xlock-${htlcId}`,
      venue: "ONCHAIN",
      proofType: "ONCHAIN_ESCROW_LOCK_PROOF",
      issuerRef: BANK_B,
    },
    w1.keyId,
    `nonce-lock-${htlcId}`,
    occ
  );
  const lockRes = await recordCrossChainLock(
    {
      htlc_id: htlcId,
      external_ref: `0xlock-${htlcId}`,
      watcher_key_id: w1.keyId,
      nonce: `nonce-lock-${htlcId}`,
      occurred_at: occ,
      signature: sig,
      idempotency_key: `IK-LOCK-${htlcId}`,
    },
    env as any
  );
  expect(lockRes.state).toBe("HTLC_ONCHAIN_PENDING");
  return preimage;
}

describe("cross-chain HTLC Watcher equivocation", () => {
  it("recordWatcherObservation rejects a second Watcher contradicting the proof_type, and does not count it", async () => {
    // w1 attests (ONCHAIN, RELEASE_PROOF) for an event; w2 then attests the SAME
    // (source, external_ref) as an ESCROW_LOCK_PROOF — a contradiction about what
    // happened on the rail. The guard rejects it so disagreement cannot pad a quorum.
    await recordObs(d1, w1, "0xevt-1", "ONCHAIN_RELEASE_PROOF", "n1");
    await expect(
      recordObs(d1, w2, "0xevt-1", "ONCHAIN_ESCROW_LOCK_PROOF", "n2")
    ).rejects.toMatchObject({
      reason_code: "WATCHER_EQUIVOCATION",
    });
    // The conflicting vote was never stored: still exactly one distinct operator.
    expect(await countDistinctWatchers(d1 as any, "ONCHAIN:ETH", "0xevt-1")).toBe(1);
    // A concurring second Watcher (same proof_type) IS counted.
    await recordObs(d1, w2, "0xevt-1", "ONCHAIN_RELEASE_PROOF", "n3");
    expect(await countDistinctWatchers(d1 as any, "ONCHAIN:ETH", "0xevt-1")).toBe(2);
  });

  it("through the cross-chain handlers: reusing the lock's external_ref for a release is rejected + CASEd", async () => {
    const env = makeEnv(d1);
    // lockToOnchainPending records w1's ESCROW_LOCK observation on external_ref "0xlock-id".
    const preimage = await lockToOnchainPending(env, "HTLC-EQ-1", 2);

    // A second Watcher submits a RELEASE proof reusing the LOCK's external_ref —
    // contradicting w1's lock observation on that same ref. Rejected, not counted.
    const conflicting = await releaseVoteEx(env, "HTLC-EQ-1", preimage, w2, "nonce-bad", {
      externalRef: "0xlock-id",
    });
    expect(conflicting.result).toBe("REJECTED");
    expect(conflicting.reason_code).toBe("WATCHER_EQUIVOCATION");

    expect(await htlcState("HTLC-EQ-1")).toBe("HTLC_ONCHAIN_PENDING");
    await drain(env);
    expect(await balanceOf(d1, ACC_B)).toBe(1_000_000); // no money moved

    // The contradiction is explained, not dropped: audit event + open CASE.
    const ev = await d1
      .prepare(
        `SELECT payload_json FROM FinalityLog WHERE event_type='WatcherEquivocationDetected' AND txid=?`
      )
      .bind("TX-HTLC-HTLC-EQ-1")
      .first<{ payload_json: string }>();
    expect(ev).toBeTruthy();
    const theCase = await d1
      .prepare(
        `SELECT state FROM Cases WHERE related_txid=? AND reason_code='WATCHER_EQUIVOCATION'`
      )
      .bind("TX-HTLC-HTLC-EQ-1")
      .first<{ state: string }>();
    expect(theCase?.state).toBe("OPEN");
  });

  it("a genuine 2-of-2 quorum on the real release ref still settles after a rejected equivocation", async () => {
    const env = makeEnv(d1);
    const preimage = await lockToOnchainPending(env, "HTLC-EQ-2", 2);
    // w1 genuinely attests the real release event (quorum 1/2).
    const first = await releaseVote(env, "HTLC-EQ-2", preimage, w1, "nonce-r1");
    expect(first.reason_code).toBe("ONCHAIN_QUORUM_PENDING");
    // w2 tries to reuse the lock ref → rejected, not counted.
    await releaseVoteEx(env, "HTLC-EQ-2", preimage, w2, "nonce-bad", { externalRef: "0xlock-id" });
    expect(await htlcState("HTLC-EQ-2")).toBe("HTLC_ONCHAIN_PENDING");
    // w2 then attests the CORRECT release ref → quorum 2/2 → settles.
    const good = await releaseVote(env, "HTLC-EQ-2", preimage, w2, "nonce-good");
    expect(good.result).toBe("ACCEPTED");
    await drain(env);
    expect(await balanceOf(d1, ACC_B)).toBe(1_000_000 + 10_000);
  });

  it("isDomainError narrows the thrown equivocation for callers", async () => {
    await recordObs(d1, w1, "0xevt-2", "ONCHAIN_RELEASE_PROOF", "n1");
    try {
      await recordObs(d1, w2, "0xevt-2", "ONCHAIN_ESCROW_LOCK_PROOF", "n2");
      throw new Error("expected equivocation to throw");
    } catch (e) {
      expect(isDomainError(e) && e.reason_code === "WATCHER_EQUIVOCATION").toBe(true);
    }
  });
});

describe("cross-chain HTLC quorum-minimum confirmation depth", () => {
  it("a single deep Watcher cannot satisfy the depth gate while another observer is shallow", async () => {
    const env = makeEnv(d1);
    const preimage = await lockDepthGated(env, "HTLC-D-1", 2, 6);

    // w1 claims a deep 6-confirmation release; w2 (honest, observed earlier) sees only 2.
    await releaseVoteEx(env, "HTLC-D-1", preimage, w1, "nonce-r1", { confirmations: 6 });
    const shallow = await releaseVoteEx(env, "HTLC-D-1", preimage, w2, "nonce-r2", {
      confirmations: 2,
    });

    // Quorum met (2 distinct), but the quorum-MIN depth is 2 < 6 → still held.
    expect(shallow.reason_code).toBe("ONCHAIN_INSUFFICIENT_CONFIRMATIONS");
    expect(await htlcState("HTLC-D-1")).toBe("HTLC_ONCHAIN_PENDING");
    await drain(env);
    expect(await balanceOf(d1, ACC_B)).toBe(1_000_000);
  });

  it("settles once the quorum-minimum depth meets the requirement", async () => {
    const env = makeEnv(d1);
    const preimage = await lockDepthGated(env, "HTLC-D-2", 2, 6);

    await releaseVoteEx(env, "HTLC-D-2", preimage, w1, "nonce-r1", { confirmations: 6 });
    const second = await releaseVoteEx(env, "HTLC-D-2", preimage, w2, "nonce-r2", {
      confirmations: 6,
    });
    expect(second.result).toBe("ACCEPTED");
    await drain(env);
    expect(await balanceOf(d1, ACC_B)).toBe(1_000_000 + 10_000);
  });
});

describe("cross-chain HTLC finality-class-aware min_watchers default (②)", () => {
  it("a PUBLIC (probabilistic) chain defaults to a 2-of-m quorum", async () => {
    const env = makeEnv(d1);
    const outer = new Date(Date.now() + 24 * 3600_000).toISOString();
    const inner = new Date(Date.now() + 12 * 3600_000).toISOString();
    await createHtlc(
      {
        htlc_id: "HTLC-DEF-PUB",
        idempotency_key: "IK-HTLC-DEF-PUB",
        amount: { value: 10_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock: outer,
        // NOTE: min_watchers intentionally omitted.
        cross_chain: { source: "ONCHAIN:ETH", onchain_timelock: inner, min_confirmations: 0 },
        onchain_chain_class: "PUBLIC",
      } as any,
      env as any
    );
    const row = await d1
      .prepare(`SELECT onchain_min_watchers FROM HtlcContracts WHERE htlc_id='HTLC-DEF-PUB'`)
      .first<{ onchain_min_watchers: number }>();
    expect(row?.onchain_min_watchers).toBe(2);
  });

  it("a PRIVATE / unclassified chain keeps the single-Watcher default", async () => {
    const env = makeEnv(d1);
    const outer = new Date(Date.now() + 24 * 3600_000).toISOString();
    const inner = new Date(Date.now() + 12 * 3600_000).toISOString();
    await createHtlc(
      {
        htlc_id: "HTLC-DEF-PRIV",
        idempotency_key: "IK-HTLC-DEF-PRIV",
        amount: { value: 10_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock: outer,
        cross_chain: {
          source: "ONCHAIN:CONSORTIUM",
          onchain_timelock: inner,
          min_confirmations: 0,
        },
        onchain_chain_class: "PRIVATE",
      } as any,
      env as any
    );
    const row = await d1
      .prepare(`SELECT onchain_min_watchers FROM HtlcContracts WHERE htlc_id='HTLC-DEF-PRIV'`)
      .first<{ onchain_min_watchers: number }>();
    expect(row?.onchain_min_watchers).toBe(1);
  });
});
