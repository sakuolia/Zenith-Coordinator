/**
 * @file HTLC cross-chain (テーマA) — recordCrossChainLock / recordOnchainFulfillment.
 *       Watcher-observed onchain escrow lock + release under the same hashlock.
 * @module zc/lanes/htlc/crosschain
 */
import type {
  Env,
  HtlcCrossChainLockRequest,
  HtlcOnchainFulfillmentRequest,
  HtlcContractRow,
} from "../../../types";
import { nowISO } from "../../../types";
import { writeFinalityLog } from "../../orchestrator";
import { sha256hex } from "../../../shared/hmac";
import {
  recordWatcherObservation,
  countDistinctWatchers,
  minConfirmationsAcrossWatchers,
} from "../../../shared/watcher";
import { meetsQuorum } from "../../../shared/operator_quorum";
import { assertTrustedSettlementProof } from "../../../shared/proof";
import { requiredConfirmations, type FinalityClass } from "../../finality/onchain_finality";
import { DomainError } from "../../../shared/errors";
import { openCase } from "../../cases/case";
import { transitionWithLog, transferOwnership, OWNER_CHAIN_DEFAULT } from "../_helpers";
import { settleAfterPreimage, type HtlcFulfillResult } from "./_fulfill";
import { cancelHtlc } from "./cancel";

/**
 * Convert a Watcher equivocation (two distinct Watchers contradicting each other
 * about the same external event) into the system's "explain it, don't drop it"
 * contract: record a `WatcherEquivocationDetected` audit event on the tx chain
 * and open a CASE for investigation. The conflicting vote was never persisted by
 * `recordWatcherObservation`, so it cannot pad the quorum; settlement stays held.
 */
async function convergeEquivocationToCase(
  db: D1Database,
  htlc: HtlcContractRow,
  err: DomainError
): Promise<void> {
  await writeFinalityLog(db, {
    txid: htlc.txid,
    event_type: "WatcherEquivocationDetected",
    state_from: htlc.state,
    state_to: htlc.state,
    payload_json: JSON.stringify({
      htlc_id: htlc.htlc_id,
      reason_code: err.reason_code,
      ...err.details,
    }),
    txid_or_gtid: htlc.txid,
  });
  await openCase(db, {
    related_txid: htlc.txid,
    reason_code: "WATCHER_EQUIVOCATION",
    opened_by: "ZC",
    description: `Cross-chain Watcher equivocation on ${htlc.cross_chain_source}: ${err.message}`,
  });
}

/**
 * テーマA (cross-chain HTLC): record that the onchain escrow under the same
 * `hashlock` has been locked, as observed and signed by a Watcher.
 * HTLC_LOCKED → HTLC_ONCHAIN_PENDING.
 *
 * ZC never inspects the chain itself — it only accepts the Watcher's
 * `SettlementProofRef` (venue=ONCHAIN) once the signature verifies against
 * KeyRegistry.
 */
export async function recordCrossChainLock(
  req: HtlcCrossChainLockRequest,
  env: Env
): Promise<HtlcFulfillResult> {
  const db = env.DB;
  const now = nowISO();

  const htlc = await db
    .prepare(`SELECT * FROM HtlcContracts WHERE htlc_id = ?`)
    .bind(req.htlc_id)
    .first<HtlcContractRow>();
  if (!htlc)
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: "NOT_FOUND",
      reason_code: "HTLC_NOT_FOUND",
    };
  if (!htlc.cross_chain_source)
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "NOT_CROSS_CHAIN",
    };
  if (htlc.state !== "HTLC_LOCKED")
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "INVALID_STATE",
    };

  let proofRef: Awaited<ReturnType<typeof recordWatcherObservation>>["proofRef"];
  try {
    ({ proofRef } = await recordWatcherObservation(db, {
      source: htlc.cross_chain_source,
      externalRef: req.external_ref,
      venue: "ONCHAIN",
      proofType: "ONCHAIN_ESCROW_LOCK_PROOF",
      issuerRef: htlc.payee_bank_id,
      watcherKeyId: req.watcher_key_id,
      nonce: req.nonce,
      occurredAt: req.occurred_at,
      signatureB64: req.signature,
    }));
  } catch (err) {
    if (err instanceof DomainError && err.reason_code === "WATCHER_EQUIVOCATION") {
      await convergeEquivocationToCase(db, htlc, err);
      return {
        result: "REJECTED",
        htlc_id: req.htlc_id,
        state: htlc.state,
        reason_code: "WATCHER_EQUIVOCATION",
      };
    }
    throw err;
  }

  // 単一所有者則 (§5.2 handoff #4): entering HTLC_ONCHAIN_PENDING hands the
  // row to the Watcher set — its fate is now governed by the onchain escrow
  // (claim relayed by Watchers, or the outer-timelock lease expiry), not by
  // ZC's clock. The handoff rides in the transition's own atomic batch.
  const transition = await transitionWithLog(db, {
    txid: htlc.txid,
    fromState: "HTLC_LOCKED",
    toState: "HTLC_ONCHAIN_PENDING",
    eventType: "CrossChainLocked",
    payload: { htlc_id: req.htlc_id, external_ref: req.external_ref, proof_ref: proofRef },
    setColumns: { owner: OWNER_CHAIN_DEFAULT },
    sideUpdates: [
      {
        sql: `UPDATE HtlcContracts SET state='HTLC_ONCHAIN_PENDING', onchain_lock_ref=?, onchain_lock_proof_json=?, version=version+1, updated_at=? WHERE htlc_id=? AND state='HTLC_LOCKED'`,
        binds: [req.external_ref, JSON.stringify(proofRef), now, req.htlc_id],
      },
    ],
  });
  if (!transition.applied) {
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: transition.previousState ?? htlc.state,
      reason_code: "INVALID_STATE",
    };
  }
  return { result: "ACCEPTED", htlc_id: req.htlc_id, state: "HTLC_ONCHAIN_PENDING" };
}

/**
 * テーマA (cross-chain HTLC): record that the onchain escrow has been
 * released with a preimage matching `hashlock`, as observed and signed by a
 * Watcher. HTLC_ONCHAIN_PENDING → HTLC_FULFILL_REQUESTED → DECIDED_TO_SETTLE
 * via `settleAfterPreimage`, mirroring `claimHtlc`'s settlement path (the
 * same `hashlock` unlocks both legs — design invariant: no double-spend
 * across the ZC-side and onchain legs).
 */
export async function recordOnchainFulfillment(
  req: HtlcOnchainFulfillmentRequest,
  env: Env
): Promise<HtlcFulfillResult> {
  const db = env.DB;
  const now = nowISO();

  const htlc = await db
    .prepare(`SELECT * FROM HtlcContracts WHERE htlc_id = ?`)
    .bind(req.htlc_id)
    .first<HtlcContractRow>();
  if (!htlc)
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: "NOT_FOUND",
      reason_code: "HTLC_NOT_FOUND",
    };
  if (!htlc.cross_chain_source)
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "NOT_CROSS_CHAIN",
    };
  if (htlc.state !== "HTLC_ONCHAIN_PENDING")
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "INVALID_STATE",
    };

  // ZC-side outer timelock expired — the hard cancellation backstop. Past this
  // point no onchain claim can settle (ZC's H reservation is released).
  // 期限切れ→回収 (S1 lease expiry): the outer timelock is the Watcher set's
  // contractual lease on the row; its expiry lets ZC reclaim ownership first
  // (recorded as OwnershipReclaimed) and only then cancel as itself — the same
  // reclaim path the timeout sweep takes when it discovers the expiry.
  if (new Date(htlc.timelock) < new Date(now)) {
    await transferOwnership(db, {
      txid: htlc.txid,
      fromOwner: OWNER_CHAIN_DEFAULT,
      toOwner: "ZC",
      eventType: "OwnershipReclaimed",
      payload: { reason: "OUTER_TIMELOCK_EXPIRED", htlc_id: req.htlc_id },
    });
    await cancelHtlc(req.htlc_id, htlc.txid, "TIMELOCK_EXPIRED", db, env);
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: "DECIDED_CANCEL",
      reason_code: "TIMELOCK_EXPIRED",
    };
  }

  // Same secret_hash must unlock both legs: validate the preimage BEFORE acting
  // on the inner timelock. A release whose preimage hashes to the hashlock is
  // proof the onchain escrow was actually claimed; ZC must never discard that
  // on the strength of its own clock alone (the inner-timelock divergence —
  // see test/integration/chaos_cross_chain.test.ts).
  const computedHash = await sha256hex(req.preimage);
  if (computedHash !== htlc.hashlock) {
    await writeFinalityLog(db, {
      txid: htlc.txid,
      event_type: "HtlcClaimRejected",
      state_from: htlc.state,
      state_to: htlc.state,
      payload_json: JSON.stringify({
        htlc_id: req.htlc_id,
        reason_code: "ONCHAIN_PROOF_MISMATCH",
        computed_hash_prefix: `${computedHash.slice(0, 8)}…`,
      }),
      txid_or_gtid: htlc.txid,
    });
    return {
      result: "REJECTED",
      htlc_id: req.htlc_id,
      state: htlc.state,
      reason_code: "ONCHAIN_PROOF_MISMATCH",
    };
  }

  // Record this Watcher's vote FIRST so both gates below evaluate over the full
  // set of independent observers (including this one). The conflicting-vote case
  // (equivocation) is rejected inside recordWatcherObservation and never stored,
  // so it cannot pad the quorum or the depth set.
  let proofRef: Awaited<ReturnType<typeof recordWatcherObservation>>["proofRef"];
  try {
    ({ proofRef } = await recordWatcherObservation(db, {
      source: htlc.cross_chain_source,
      externalRef: req.external_ref,
      venue: "ONCHAIN",
      proofType: "ONCHAIN_RELEASE_PROOF",
      issuerRef: htlc.payee_bank_id,
      watcherKeyId: req.watcher_key_id,
      nonce: req.nonce,
      occurredAt: req.occurred_at,
      signatureB64: req.signature,
      confirmations: req.confirmations,
    }));
  } catch (err) {
    if (err instanceof DomainError && err.reason_code === "WATCHER_EQUIVOCATION") {
      await convergeEquivocationToCase(db, htlc, err);
      return {
        result: "REJECTED",
        htlc_id: req.htlc_id,
        state: htlc.state,
        reason_code: "WATCHER_EQUIVOCATION",
      };
    }
    throw err;
  }

  // Watcher quorum (trust minimization): settlement may proceed only once enough
  // *distinct* Watcher operators have independently attested this same release.
  // Until then the HTLC stays in HTLC_ONCHAIN_PENDING — a single Watcher key can
  // no longer settle a cross-chain leg on its own. We re-count after recording
  // this vote so the Nth distinct operator is the one that crosses the threshold.
  const requiredWatchers = htlc.onchain_min_watchers ?? 1;
  const haveWatchers = await countDistinctWatchers(db, htlc.cross_chain_source, req.external_ref);
  if (!meetsQuorum(haveWatchers, requiredWatchers)) {
    await writeFinalityLog(db, {
      txid: htlc.txid,
      event_type: "OnchainQuorumPending",
      state_from: htlc.state,
      state_to: htlc.state,
      payload_json: JSON.stringify({
        htlc_id: req.htlc_id,
        have_watchers: haveWatchers,
        required_watchers: requiredWatchers,
        watcher_key_id: req.watcher_key_id,
      }),
      txid_or_gtid: htlc.txid,
    });
    return {
      result: "ACCEPTED",
      htlc_id: req.htlc_id,
      state: "HTLC_ONCHAIN_PENDING",
      reason_code: "ONCHAIN_QUORUM_PENDING",
    };
  }

  // Theme A confirmation depth: once the inner `onchain_timelock` has passed, the
  // onchain escrow may also be refunded, so a release is only safe to settle on
  // if it is confirmed deeply enough to be reorg-irreversible. The depth is taken
  // as the MINIMUM across the distinct Watcher operators (not this single voter's
  // claim): a lone Watcher can no longer unblock the gate by inflating its own
  // confirmations — the release is only as deep as the shallowest independent
  // observer. A valid-but-shallow release is HELD (not settled, not cancelled);
  // the outer timelock remains the hard backstop. Before the inner timelock a
  // quorum-backed release settles immediately (no depth gate).
  if (htlc.onchain_timelock && new Date(htlc.onchain_timelock) < new Date(now)) {
    // Effective depth depends on the chain's finality model (B2): a deterministic
    // (private/permissioned) chain is final at 1 confirmation, while a public
    // (probabilistic) chain honours the configured depth for reorg safety.
    const required = requiredConfirmations(
      (htlc.onchain_finality_class as FinalityClass | null) ?? null,
      htlc.onchain_min_confirmations ?? 0
    );
    const quorumDepth = await minConfirmationsAcrossWatchers(
      db,
      htlc.cross_chain_source,
      req.external_ref
    );
    if (quorumDepth < required) {
      await writeFinalityLog(db, {
        txid: htlc.txid,
        event_type: "HtlcClaimRejected",
        state_from: htlc.state,
        state_to: htlc.state,
        payload_json: JSON.stringify({
          htlc_id: req.htlc_id,
          reason_code: "ONCHAIN_INSUFFICIENT_CONFIRMATIONS",
          confirmations: quorumDepth,
          quorum_min_confirmations: quorumDepth,
          required,
          chain_class: htlc.onchain_chain_class,
          finality_class: htlc.onchain_finality_class,
        }),
        txid_or_gtid: htlc.txid,
      });
      return {
        result: "REJECTED",
        htlc_id: req.htlc_id,
        state: htlc.state,
        reason_code: "ONCHAIN_INSUFFICIENT_CONFIRMATIONS",
      };
    }
  }

  // Theme I: "b" (DECIDED_TO_SETTLE) below
  // may only proceed on the strength of this externally-signed
  // SettlementProofRef — assert it before consuming it, and record its
  // acceptance as its own audit event distinct from OnchainProofObserved.
  assertTrustedSettlementProof(proofRef);
  await writeFinalityLog(db, {
    txid: htlc.txid,
    event_type: "SettlementProofAccepted",
    state_from: htlc.state,
    state_to: htlc.state,
    payload_json: JSON.stringify({
      htlc_id: req.htlc_id,
      proof_ref: proofRef,
      quorum_watchers: haveWatchers,
      required_watchers: requiredWatchers,
    }),
    txid_or_gtid: htlc.txid,
  });

  return settleAfterPreimage(
    htlc,
    "HTLC_ONCHAIN_PENDING",
    "OnchainProofObserved",
    { external_ref: req.external_ref, proof_ref: proofRef },
    {
      sql: `UPDATE HtlcContracts SET state='HTLC_FULFILL_REQUESTED', onchain_release_proof_json=?, version=version+1, updated_at=? WHERE htlc_id=? AND state='HTLC_ONCHAIN_PENDING'`,
      binds: [JSON.stringify(proofRef), now, req.htlc_id],
    },
    env
  );
}
