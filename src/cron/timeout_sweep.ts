/**
 * @file Timeout sweep (runs every minute). Expires stale transactions in
 * T2/T3 timeout, recovers SUSPENDED->FAILED, expires HTLC timelocks,
 * cleans up stalled GTID transactions, sweeps orphaned/expired idempotency
 * keys, and auto-releases CUSTODY suspense funds once the payee account
 * recovers.
 * @module cron/timeout_sweep
 */
// - Vault TTL expired → logical delete (is_evicted = 1)
// - Recover GTIDs stuck in GT_DECIDED_TO_SETTLE

import { recoverStaleClaims } from "../bank/legacy/adapter";
import { AUTHORITY_PENDING_REASON } from "../zc/lanes/_authority_check";
import { releaseRecoveredCustody } from "../bank/suspense";
import type { Env } from "../types";
import { businessDateJST, nowISO } from "../types";
import {
  escalateOverdueCases,
  openOrAggregateCase,
  sweepSecondaryEscalations,
} from "../zc/cases/case";
import { retryPendingNotifications } from "../zc/events/credit_notify";
import { sweepExpiredFxLocks, sweepStuckFxSettling } from "../zc/fx/htlc";
import {
  cancelInFlightTx,
  OWNER_CHAIN_DEFAULT,
  transferOwnership,
  transitionWithLog,
} from "../zc/lanes/_helpers";
import { resumeSuspendedExpress } from "../zc/lanes/express";
import { recoverStuckPrecheckedGtid } from "../zc/lanes/gtid";
import { resumeRingfencedIgs } from "../zc/lanes/highvalue";
import { cancelHtlc } from "../zc/lanes/htlc";
import { checkAndFinalizeGtid, suspendTx } from "../zc/orchestrator";
import { evictExpiredVault } from "../zc/platform/vault";
import { expireRtpRequests } from "../zc/rtp";
import { promoteRingfencePlus } from "../zc/settlement/dns";
import { getDueDeferredIgs, markDeferResumed } from "../zc/settlement/igs_hold";

/**
 * Every timer below measures from `COALESCE(pending_since, updated_at)`, never
 * from `updated_at` alone.
 *
 * `pending_since` records when the row entered the wait being measured — set by
 * the lane helpers on every transition and INSERT, and by the Authority Check
 * marker. `updated_at` moves on any write to the row, including ones unrelated
 * to progress (`case_id` from src/zc/cases/case.ts, `edi_ref` from
 * src/zc/richdata/edi.ts — neither carries a state guard). Measuring from
 * `updated_at` therefore let an incidental write postpone a deadline, and
 * repeated writes postpone it without bound; opening a CASE against a stalled
 * transfer did exactly that. See migrations/0001_consolidated_schema.sql
 * (`Transactions.pending_since`) and docs/disclosure/CORE_DISCLOSURE.md【0124】4.
 *
 * The COALESCE fallback covers rows written before the column existed.
 * `test/invariants/pending_since.test.ts` fails if a timer here reverts to a
 * bare `updated_at` comparison.
 */
// Timeout threshold (seconds)
const T_PRECHECK_TIMEOUT_SEC = 300; // 5 minutes: RECEIVED → PRECHECKED
const T_AUTH_TIMEOUT_SEC = 300; // 5 minutes: PRECHECKED awaiting an Authority Check verdict
const T2_EXEC_TIMEOUT_SEC = 300; // 5 minutes: DECIDED_TO_SETTLE → PAYER_EXEC_CONFIRMED
const T3_PAYEE_TIMEOUT_SEC = 300; // 5 minutes: PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED
const IDEMP_PROCESSING_STUCK_SEC = 900; // 15 minutes: orphaned PROCESSING idempotency keys
const IDEMP_DONE_TTL_SEC = 24 * 3600; // 24 hours: DONE idempotency-key replay-cache TTL
const ADAPTER_CLAIM_STUCK_SEC = 900; // 15 minutes: orphaned CLAIMED legacy-adapter outbox rows

/**
 * Lanes with no T2 SLA — TIMEOUT POLICY, not ownership. Deliberate deviation
 * from the brief's「レーン列挙を全削除」(§5.4 Phase 3): the 単一所有者則 owner
 * column replaced the *exclusion predicates that encoded custody*
 * (`dns_cycle_id IS NULL`, `external_settlement_status != 'REQUESTED'`), but
 * these lanes are exempt for a different reason — BULK/DEFERRED wait in
 * DECIDED_TO_SETTLE until EOD by design, and HTLC's abandonment clock is its
 * timelock (sweep step 4), not T2. Which lanes carry a 5-minute execution SLA
 * is a product decision that stays declarative here.
 */
const T2_EXEMPT_LANES = ["BULK", "DEFERRED", "HTLC"] as const;

export async function runTimeoutSweep(env: Env): Promise<{ swept: number }> {
  const db = env.DB;
  const now = new Date();
  let swept = 0;

  // 0. T_precheck timeout: RECEIVED for 5 minutes or more
  //    (docs/specs/20_method_design.md §3.3.1).
  //
  // A row that never left RECEIVED is one nothing picked up — the queue message
  // was lost, or the lane rejected it before advancing. Without this sweep such
  // a row sits forever: every other timer starts at DECIDED_TO_SETTLE or later,
  // so the very first hop had no clock at all. That is the state design
  // principle 4 forbids outright — "説明できない状態は禁止" — and it is worse
  // than a visible failure, because the payer's own bank shows an accepted
  // transfer that is not moving and nothing ever contradicts it.
  //
  // Cancelling (rather than suspending) is right here: no Decision exists yet,
  // so there is nothing to compensate and no H to unwind beyond the reservation
  // `cancelInFlightTx` releases. HTLC rows enter at RECEIVED too but are moved
  // on by their own creation path within the same request; their abandonment
  // clock is the timelock (step 4), so they are exempt exactly as in T2.
  const precheckDeadline = new Date(now.getTime() - T_PRECHECK_TIMEOUT_SEC * 1000).toISOString();
  const receivedOld = await db
    .prepare(
      `SELECT txid FROM Transactions
       WHERE state='RECEIVED' AND owner='ZC'
         AND lane NOT IN (${T2_EXEMPT_LANES.map(() => "?").join(",")})
         AND COALESCE(pending_since, updated_at) < ?`
    )
    .bind(...T2_EXEMPT_LANES, precheckDeadline)
    .all<{ txid: string }>();

  for (const tx of receivedOld.results) {
    const cancelled = await cancelInFlightTx(db, {
      txid: tx.txid,
      reasonCode: "CANCEL_PRECHECK_TIMEOUT",
      fromStates: ["RECEIVED"],
    });
    if (cancelled) swept++;
  }

  // 0b. T_auth timeout: PRECHECKED and awaiting an Authority Check verdict for
  //     5 minutes or more (docs/specs/20_method_design.md §3.3.1).
  //
  // The AML/sanctions screening is fail-closed: when the payer bank returns no
  // verdict (circuit OPEN, or a non-verdict response) the lane leaves the row in
  // PRECHECKED and stamps `reason_code='SUSPEND_AUTHORITY_PENDING'` together
  // with `pending_since` (src/zc/lanes/_authority_check.ts). The reason_code
  // selects the rows; `pending_since` is the clock, and this step reads it.
  //
  // Suspending rather than cancelling: a screening host that cannot be reached
  // says nothing about the transfer, so the row moves to a state a person can
  // act on (PRECHECKED_SUSPENDED), keeping the reason it is waiting for. Only
  // rows carrying the marker are touched, so a transaction that stalled in
  // PRECHECKED for some other reason is never mislabelled as an AML wait.
  const authDeadline = new Date(now.getTime() - T_AUTH_TIMEOUT_SEC * 1000).toISOString();
  const authPending = await db
    .prepare(
      `SELECT txid FROM Transactions
       WHERE state='PRECHECKED' AND owner='ZC'
         AND reason_code=? AND COALESCE(pending_since, updated_at) < ?`
    )
    .bind(AUTHORITY_PENDING_REASON, authDeadline)
    .all<{ txid: string }>();

  for (const tx of authPending.results) {
    const { applied } = await transitionWithLog(db, {
      txid: tx.txid,
      fromState: "PRECHECKED",
      toState: "PRECHECKED_SUSPENDED",
      eventType: "PreCheckSuspended",
      payload: { txid: tx.txid, reason_code: AUTHORITY_PENDING_REASON },
      setColumns: { reason_code: AUTHORITY_PENDING_REASON },
    });
    if (applied) swept++;
  }

  // 1. T2_exec timeout: DECIDED_TO_SETTLE for 5 minutes or more.
  // `owner='ZC'` (単一所有者則, §5.4 Phase 3): the sweep may only abandon rows
  // ZC itself holds. A row snapshotted into a DNS cycle is owned by
  // 'CYCLE:<id>' and structurally invisible here — the exclusion-predicate
  // enumeration (`dns_cycle_id IS NULL`, …) this replaces is now a theorem of
  // the owner column instead of a per-venue rule (docs/specs/30_internal_design.md §5.1 の二元帳乖離カタログ #2, chaos_dns #7).
  const t2Deadline = new Date(now.getTime() - T2_EXEC_TIMEOUT_SEC * 1000).toISOString();
  const decidedOld = await db
    .prepare(
      `SELECT txid FROM Transactions
       WHERE state='DECIDED_TO_SETTLE' AND owner='ZC'
         AND lane NOT IN (${T2_EXEMPT_LANES.map(() => "?").join(",")})
         AND COALESCE(pending_since, updated_at) < ?`
    )
    .bind(...T2_EXEMPT_LANES, t2Deadline)
    .all<{ txid: string }>();

  for (const tx of decidedOld.results) {
    await suspendTx(tx.txid, "SUSPEND_EXEC_TIMEOUT", db);
    swept++;
  }

  // 2. T3_payee_proof timeout: PAYER_EXEC_CONFIRMED for 5 minutes or more.
  // `owner='ZC'` (単一所有者則): a tx whose money leg is in flight at an
  // external settlement venue is owned by 'VENUE:BOJ' (stamped atomically with
  // external_settlement_status='REQUESTED') and structurally invisible here —
  // the central bank, not T3, governs its fate until the callback returns
  // ownership (docs/specs/30_internal_design.md §5.1 の二元帳乖離カタログ #1). Same for 'CYCLE:<id>'-owned rows.
  const t3Deadline = new Date(now.getTime() - T3_PAYEE_TIMEOUT_SEC * 1000).toISOString();
  const payerConfOld = await db
    .prepare(
      `SELECT txid FROM Transactions
       WHERE state='PAYER_EXEC_CONFIRMED' AND owner='ZC'
         AND COALESCE(pending_since, updated_at) < ?`
    )
    .bind(t3Deadline)
    .all<{ txid: string }>();

  for (const tx of payerConfOld.results) {
    await suspendTx(tx.txid, "SUSPEND_PAYEE_PROOF_TIMEOUT", db);
    swept++;
  }

  // 2b. One-release verification of the owner predicate (§5.4 Phase 3 step 2;
  // REMOVE after one release). The old exclusion predicates and the new owner
  // column encode the same custody facts — a row where they disagree
  // (owner='ZC' but the old predicates say "someone else holds this") is a
  // handoff bug and must converge into a CASE, not be silently swept or
  // skipped. Pre-attached dns_cycle_id on a not-yet-kicked (OPEN) cycle is
  // legitimate ZC custody, so only live/settling cycles (KICKED/HOLD_ACTIVE)
  // count as disagreement.
  const divergent = await db
    .prepare(
      `SELECT t.txid FROM Transactions t
       WHERE t.owner='ZC'
         AND t.state IN ('DECIDED_TO_SETTLE','PAYER_EXEC_CONFIRMED','PAYEE_EXEC_CONFIRMED')
         AND (
           t.external_settlement_status = 'REQUESTED'
           OR EXISTS (
             SELECT 1 FROM DnsCycles c
             WHERE c.cycle_id = t.dns_cycle_id AND c.state IN ('KICKED','HOLD_ACTIVE')
           )
         )`
    )
    .all<{ txid: string }>();

  for (const tx of divergent.results) {
    // Aggregated on the detection path (§10.7.2): the responsible party is not
    // known here — an ownership handoff bug shows up as many transactions at
    // once, and it is the same defect each time. The per-txid pre-check this
    // replaces deduplicated only within one transaction, so a single bug still
    // produced one CASE per transaction it touched. Re-detection of the same
    // txid is now absorbed by the relation key rather than by a probe.
    await openOrAggregateCase(db, {
      related_txid: tx.txid,
      reason_code: "OWNER_PREDICATE_DIVERGENCE",
      opened_by: "ZC",
      detection_path: "TIMEOUT_SWEEP_OWNER_PREDICATE",
      description:
        "owner='ZC' but the legacy exclusion predicates (dns_cycle_id on a live cycle / " +
        "external_settlement_status='REQUESTED') indicate external custody — ownership handoff bug",
    });
  }

  // 3. FAILED_EXECUTION transition: when SUSPENDED exceeds expires_at
  const failedOld = await db
    .prepare(
      `SELECT txid FROM Transactions WHERE state='SUSPENDED' AND expires_at IS NOT NULL AND expires_at < ?`
    )
    .bind(now.toISOString())
    .all<{ txid: string }>();

  for (const tx of failedOld.results) {
    // Route through transitionWithLog so the SUSPENDED → FAILED_EXECUTION
    // advance writes its paired FinalityLog entry atomically. A raw UPDATE
    // here moved a transaction to a *terminal* state with no audit record —
    // exactly the "state advanced without evidence" window the system forbids
    // (design principle #1). FAILED_EXECUTION is terminal, so a missing log is
    // unrecoverable after the fact.
    const { applied } = await transitionWithLog(db, {
      txid: tx.txid,
      fromState: "SUSPENDED",
      toState: "FAILED_EXECUTION",
      eventType: "FailedExecution",
      setColumns: { reason_code: "FAILED_EXEC_TIMEOUT" },
      payload: { txid: tx.txid, reason_code: "FAILED_EXEC_TIMEOUT" },
    });
    if (applied) swept++;
  }

  // 4. HTLC timelock expired (ZC-side outer timelock; also covers cross-chain
  // HTLCs stuck in HTLC_ONCHAIN_PENDING past the outer `timelock`).
  const expiredHtlcs = await db
    .prepare(
      `SELECT htlc_id, txid, state FROM HtlcContracts WHERE state IN ('HTLC_RECEIVED','HTLC_LOCKED','HTLC_ONCHAIN_PENDING') AND timelock < ?`
    )
    .bind(now.toISOString())
    .all<{ htlc_id: string; txid: string; state: string }>();

  for (const htlc of expiredHtlcs.results) {
    // 期限切れ→回収 (単一所有者則, S1 lease expiry): an HTLC_ONCHAIN_PENDING row
    // is owned by the Watcher set ('CHAIN:default'), and the OUTER timelock is
    // that lease's contractual expiry — the one moment ZC may take the row
    // back without hearing from the watchers. Reclaim first (recorded as
    // OwnershipReclaimed), then cancel as ZC. If a watcher-relayed claim won
    // the race meanwhile, the reclaim CAS misses and the cancel's state guard
    // no-ops — the claim keeps the row.
    if (htlc.state === "HTLC_ONCHAIN_PENDING") {
      await transferOwnership(db, {
        txid: htlc.txid,
        fromOwner: OWNER_CHAIN_DEFAULT,
        toOwner: "ZC",
        eventType: "OwnershipReclaimed",
        payload: { reason: "OUTER_TIMELOCK_EXPIRED", htlc_id: htlc.htlc_id },
      });
    }
    // Pass env to also send the bank-side suspense release notification (reserve-funds has already run when HTLC_LOCKED)
    await cancelHtlc(htlc.htlc_id, htlc.txid, "TIMELOCK_EXPIRED", db, env);
    swept++;
  }

  // 4b. Cross-chain HTLC inner timelock (テーマA, confirmation depth):
  // intentionally NOT auto-cancelled here. ZC must not treat its own
  // clock crossing `onchain_timelock` as proof the onchain escrow refunded — a
  // valid claim may still be relayed by the Watcher and, if confirmed deeply
  // enough, settle (see recordOnchainFulfillment). The ZC-side OUTER `timelock`
  // (step 4a above) remains the hard cancellation backstop. Cancelling at the
  // inner timelock here caused a two-ledger divergence (payer refunded while
  // the escrow was actually claimed); see test/integration/chaos_cross_chain.

  // 5. Vault TTL expired (logical delete)
  swept += await evictExpiredVault(db, now.toISOString());

  // 6. RTP expired (update only the state column)
  swept += await expireRtpRequests(db);

  // 7. Retry undelivered notifications
  await retryPendingNotifications(db, env);

  // 8. Recover GTIDs stuck in GT_DECIDED_TO_SETTLE (no update for 10 minutes or more)
  // Rescue GTIDs for which checkAndFinalizeGtid was not called due to leg execution failure or 0-legs
  const gtStuckDeadline = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const stuckGtids = await db
    .prepare(
      `SELECT gtid FROM GtidTransactions WHERE state='GT_DECIDED_TO_SETTLE' AND updated_at < ?`
    )
    .bind(gtStuckDeadline)
    .all<{ gtid: string }>();

  for (const g of stuckGtids.results) {
    await checkAndFinalizeGtid(g.gtid, db);
    swept++;
  }

  // 8b. Recover GTIDs stuck in GT_PRECHECKED (no update for 10 minutes or more).
  // advanceGtid CASes GT_RECEIVED -> GT_PRECHECKED before running the per-leg
  // ready-check loop; a crash during that loop (or before the GT_DECIDED_TO_SETTLE/
  // GT_DECIDED_CANCEL CAS) leaves the row permanently stuck since the GT_RECEIVED
  // CAS guard makes a retry of ZC_BANK_LEG_READY a no-op.
  const stuckPrechecked = await db
    .prepare(`SELECT gtid FROM GtidTransactions WHERE state='GT_PRECHECKED' AND updated_at < ?`)
    .bind(gtStuckDeadline)
    .all<{ gtid: string }>();

  for (const g of stuckPrechecked.results) {
    if (await recoverStuckPrecheckedGtid(g.gtid, db, env)) swept++;
  }

  // 9. Bulk-fix records that are already GT_SETTLED but whose GtidLegs.state is not updated
  const legFixResult = await db
    .prepare(`
    UPDATE GtidLegs SET state='LEG_SETTLED', updated_at=?
    WHERE state NOT IN ('LEG_SETTLED','LEG_FAILED','LEG_REGISTERED')
      AND gtid IN (SELECT gtid FROM GtidTransactions WHERE state='GT_SETTLED')
  `)
    .bind(nowISO())
    .run();
  swept += legFixResult.meta.changes ?? 0;

  // 10. IdempotencyKeys hygiene (both DELETEs are served by idx_idemp_created).
  // 10a. PROCESSING keys stuck > 15 min: the acquiring request died between
  // acquireIdempotency and completeIdempotency, so every client retry replays
  // the {result:'PROCESSING'} sentinel forever. Deleting the orphaned key lets
  // a retry with the same X-Idempotency-Key re-acquire and re-execute; the
  // UNIQUE constraint on Transactions.idempotency_key still prevents a
  // duplicate TX if the original request had already inserted one.
  const idempStuckDeadline = new Date(
    now.getTime() - IDEMP_PROCESSING_STUCK_SEC * 1000
  ).toISOString();
  const stuckIdemp = await db
    .prepare(`DELETE FROM IdempotencyKeys WHERE status='PROCESSING' AND created_at < ?`)
    .bind(idempStuckDeadline)
    .run();
  swept += stuckIdemp.meta.changes ?? 0;

  // 10b. DONE keys past the 24h replay-cache TTL.
  const idempTtlDeadline = new Date(now.getTime() - IDEMP_DONE_TTL_SEC * 1000).toISOString();
  const expiredIdemp = await db
    .prepare(`DELETE FROM IdempotencyKeys WHERE status='DONE' AND created_at < ?`)
    .bind(idempTtlDeadline)
    .run();
  swept += expiredIdemp.meta.changes ?? 0;

  // 11. Auto-release CUSTODY suspense records whose payee account has recovered
  // (e.g. FROZEN -> NORMAL). Without this, funds landed in custody stayed there
  // indefinitely unless a teller manually resolved them.
  swept += await releaseRecoveredCustody(db);

  // 12. Resume EXPRESS transactions suspended on COUNTERPARTY_WINDOW_CLOSED
  // (Theme E: 24/365 operating windows) once the payee bank's
  // operating window has reopened.
  const windowSuspended = await db
    .prepare(
      `SELECT txid FROM Transactions WHERE state='PRECHECKED_SUSPENDED' AND reason_code='COUNTERPARTY_WINDOW_CLOSED'`
    )
    .all<{ txid: string }>();

  for (const tx of windowSuspended.results) {
    const { ok } = await resumeSuspendedExpress(tx.txid, env);
    if (ok) swept++;
  }

  // 13. Resume HIGH_VALUE (IGS) transactions parked in PRECHECKED_SUSPENDED by a
  // DNS ring-fence (igs_mode RINGFENCED/STOP) once the hold has lifted (docs/specs/20_method_design.md §2.4 類型B).
  // checkIgsAdmission inside resumeRingfencedIgs re-evaluates the live cycle
  // state, so a still-held tx is a no-op; the per-minute cadence is the liveness
  // backstop that keeps a contained transfer from stranding after recovery.
  const ringfencedIgs = await db
    .prepare(
      `SELECT txid FROM Transactions
       WHERE state='PRECHECKED_SUSPENDED' AND lane='HIGH_VALUE'
         AND reason_code IN ('DNS_RINGFENCED','DNS_HOLD_IGS_STOPPED')`
    )
    .all<{ txid: string }>();

  for (const tx of ringfencedIgs.results) {
    const { ok } = await resumeRingfencedIgs(tx.txid, env);
    if (ok) {
      // A ring-fenced tx is also on the Defer queue (isolation = last position),
      // so close its queue row here too; otherwise this backstop would resume the
      // tx and leave a DEFERRED row that step 15 can never retire. No-op for a tx
      // that was never queued (STOP-mode blanket holds).
      await markDeferResumed(db, tx.txid);
      swept++;
    }
  }

  // 14. Promote held cycles RINGFENCED → RINGFENCED_PLUS once a recovery reserve
  // can be computed with enough confidence (docs/specs/20_method_design.md §2.4 類型B). promoteRingfencePlus
  // is CAS-guarded and idempotent, so re-running every minute is safe; a cleared
  // shortfall or low confidence leaves the cycle in RINGFENCED.
  const today = businessDateJST();
  const ringfencedCycles = await db
    .prepare(
      `SELECT cycle_id FROM DnsCycles
       WHERE business_date = ? AND state='HOLD_ACTIVE' AND igs_mode='RINGFENCED'`
    )
    .bind(today)
    .all<{ cycle_id: string }>();
  for (const c of ringfencedCycles.results) {
    const { promoted } = await promoteRingfencePlus(c.cycle_id, env);
    if (promoted) swept++;
  }

  // 15. Re-inject due Deferred IGS in priority order (docs/specs/20_method_design.md §2.4 類型B Defer queue).
  // A blocked-by-fairness IGS was queued with a scheduled window; once due, drive
  // it through the same resume edge and mark it RESUMED only when it actually
  // re-enters settlement (a still-throttled / still-ring-fenced tx stays queued).
  const dueDeferred = await getDueDeferredIgs(db);
  for (const d of dueDeferred) {
    const { ok } = await resumeRingfencedIgs(d.txid, env);
    if (ok) {
      await markDeferResumed(db, d.txid);
      swept++;
    }
  }

  // 16. Refund expired HTLC-bound FX transfers (docs/specs/30_internal_design.md §13 P3). A
  // cross-currency transfer whose secret never arrived is refunded once all its
  // legs' timelocks have passed; no money has moved, so this only flips the
  // FxLegLocks/FxTransfers records to REFUNDED.
  swept += await sweepExpiredFxLocks(env, now.toISOString());

  // 16b. Converge FX transfers stranded in SETTLING (docs/specs/20_method_design.md
  // §17.4.2.1). The claim/refund CAS gate deliberately bars a refund once a claim
  // owns settlement; if that claim never completes, the transfer is invisible to
  // 16 (its legs are CLAIMED, not LOCKED) and sits between the two outcomes. This
  // is the bounded-detection backstop for that window: suspend the GTID and raise
  // a CASE rather than force either outcome.
  swept += await sweepStuckFxSettling(env, now.toISOString());

  // 17. Legacy adapter (docs/specs/30_internal_design.md): recover AdapterOutbox rows
  // stuck CLAIMED — a drain that crashed between claiming a row and
  // committing its apply batch. Mirrors the IdempotencyKeys PROCESSING sweep
  // above (10a): the claim itself is durable (no money was lost or
  // duplicated), it is just unclaimable again until swept back to PENDING.
  swept += await recoverStaleClaims(db, ADAPTER_CLAIM_STUCK_SEC * 1000);

  // 18. Auto-Progress → Manual-Only promotion (docs/specs/20_method_design.md §10.7.4).
  // A CASE past its sla_deadline is no longer progressing by itself; escalate it
  // so it leaves the automatic pool and reaches a person. Until Cases carried a
  // deadline this norm could not be evaluated at all — every CASE waited
  // indefinitely, which is the exact condition the rule exists to catch.
  swept += await escalateOverdueCases(db, now.toISOString());

  // 19. Secondary escalation (docs/specs/20_method_design.md §10.7.2.2). Step 18
  // queues a person; §10.7.2.1 then folds every further occurrence of the same
  // cause into that CASE and §10.7.4 declines to auto-close it. Between them,
  // a cause that keeps spreading after a person was queued moves neither the
  // CASE count nor any state — so nothing would report the growth. This does.
  swept += (await sweepSecondaryEscalations(db, now.toISOString())).length;

  return { swept };
}
