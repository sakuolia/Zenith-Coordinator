/**
 * @file FX HTLC binding — cross-rail atomicity for true cross-currency FX
 * (docs/specs/20_method_design.md §4, §13 Phase 2).
 *
 * An HTLC-bound FX transfer locks every currency segment of the route under one
 * **shared hashlock** with **staggered timelocks** (upstream legs expire later),
 * and defers settlement until the secret is revealed:
 *
 *   - lock    — record each edge in FxLegLocks (LOCKED); no GTID/H committed yet.
 *   - claim   — reveal the secret (sha256 == hashlock); cascade all legs to
 *               CLAIMED and *only then* register + advance the conduit GTID, so
 *               the rails settle. All-or-nothing: one secret settles every leg.
 *   - refund  — if the secret never arrives, every LOCKED leg refunds after its
 *               timelock and the transfer never settles (no money moves).
 *
 * Because settlement happens exactly once, atomically, on full claim — and a
 * refund forecloses it — a mixed outcome (some legs paid, some not) is
 * impossible even though the legs would settle on independent rails. This is the
 * hashlock guarantee layered over the GTID coordinator (the "hybrid" model),
 * built without touching the shared settlement core.
 *
 * @module zc/fx/htlc
 */
import type { Env } from "../../types";
import { nowISO } from "../../types";
import { sha256hex } from "../../shared/hmac";
import { DomainError } from "../../shared/errors";
import { registerGtid, advanceGtid } from "../lanes/gtid";
import { writeFinalityLog } from "../orchestrator";
import { openCase, UNRESOLVED_CASE_STATES_SQL } from "../cases/case";
import type { FxRoute } from "./routing";
import { getQuote } from "./quotes";
import {
  buildFxEdges,
  edgesToGtidLegs,
  type FxEdge,
  type FxParty,
  type BuildFxLegsParams,
} from "./transfer";

/** Base timelock for the downstream (payee) leg. */
export const FX_HTLC_BASE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Extra margin added per upstream hop, so upstream legs always outlive downstream. */
export const FX_HTLC_HOP_MARGIN_MS = 12 * 60 * 60 * 1000;

/**
 * Upper bound on how long a transfer may sit in `SETTLING` (the 決済中 marker of
 * the CAS gate below) before it is treated as stranded.
 *
 * The gate makes claim and refund mutually exclusive, which is what stops a
 * half-settled/half-refunded transfer — but it also means a claim that crashes
 * mid-flight leaves the row in SETTLING where refund *cannot* interpose, and
 * `sweepExpiredFxLocks` cannot see it either (it selects on `FxLegLocks.state =
 * 'LOCKED'`, and the winner has already cascaded the legs to CLAIMED). Without a
 * timeout on SETTLING itself, a permanently failing downstream rail strands the
 * transfer forever: neither settled nor refunded, and the staggered-timelock
 * guarantee (an upstream leg can still be claimed once a downstream one was)
 * quietly stops holding.
 *
 * The effective timeout is the *smaller* of this bound and the time left to the
 * most upstream leg's timelock less one hop margin — see `settlingDeadline`.
 */
export const FX_SETTLING_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/** Generate a random 32-byte hex secret (the HTLC preimage). */
function generateSecret(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface LockFxTransferParams {
  gtid: string;
  route: FxRoute;
  payer: FxParty;
  payee: FxParty;
  resolveFxpAccount: (fxpBankId: string, currency: string) => string;
  /** Optional pre-supplied 64-hex hashlock; one (and its secret) is generated when omitted. */
  hashlock?: string;
}

export interface LockFxTransferResult {
  gtid: string;
  hashlock: string;
  /** Present only when the secret was generated here (hand to the payee out-of-band). */
  secret?: string;
  amount_from: number;
  amount_to: number;
  legs: number;
}

export interface FxLegLockRow {
  gtid: string;
  leg_index: number;
  currency: string;
  amount: number;
  from_bank_id: string;
  from_account_hash: string;
  to_bank_id: string;
  to_account_hash: string;
  hashlock: string;
  timelock: string;
  state: "LOCKED" | "CLAIMED" | "REFUNDED";
  created_at: string;
  updated_at: string;
  version: number;
}

/**
 * The point by which a transfer that entered `SETTLING` at `settlingStartedAt`
 * must have reached `SETTLED`, given the most upstream leg's timelock.
 *
 * Two bounds, whichever comes first: `FX_SETTLING_TIMEOUT_MS`, and one hop margin
 * before the latest (most upstream) timelock. The second is the binding one —
 * that timelock is the last moment the coordinator can still claim upstream, so
 * settlement that is still running past it is exactly the case where the
 * intermediary has paid downstream and can no longer collect upstream.
 */
export function settlingDeadline(settlingStartedAt: string, latestTimelock: string): string {
  const byBound = Date.parse(settlingStartedAt) + FX_SETTLING_TIMEOUT_MS;
  const byTimelock = Date.parse(latestTimelock) - FX_HTLC_HOP_MARGIN_MS;
  return new Date(Math.min(byBound, byTimelock)).toISOString();
}

/** Staggered timelock for edge `index` of `total` edges: upstream (lower index) later. */
function timelockFor(baseMs: number, index: number, total: number): string {
  const last = total - 1;
  return new Date(
    baseMs + FX_HTLC_BASE_TIMEOUT_MS + (last - index) * FX_HTLC_HOP_MARGIN_MS
  ).toISOString();
}

/**
 * Lock an HTLC-bound FX transfer: verify the route's quotes are live, record the
 * FxTransfers facts (status LOCKED), and write one FxLegLocks row per currency
 * segment under a shared hashlock with staggered timelocks. No GTID/H is
 * committed — settlement is deferred to {@link claimFxTransfer}.
 */
export async function lockFxTransfer(
  env: Env,
  params: LockFxTransferParams
): Promise<LockFxTransferResult> {
  const db = env.DB;
  const now = nowISO();
  const { route } = params;

  for (const hop of route.hops) {
    const q = await getQuote(db, hop.quote_id);
    if (!q || q.status !== "ACTIVE" || q.valid_to < now || q.valid_from > now) {
      throw new DomainError("FX_QUOTE_EXPIRED", "a quote on the route is no longer valid", {
        gtid: params.gtid,
        quote_id: hop.quote_id,
      });
    }
  }

  const secret = params.hashlock ? undefined : generateSecret();
  const hashlock = params.hashlock ?? (await sha256hex(secret!));

  const buildParams: BuildFxLegsParams = {
    gtid: params.gtid,
    payer: params.payer,
    payee: params.payee,
    resolveFxpAccount: params.resolveFxpAccount,
  };
  const edges = buildFxEdges(route, buildParams);
  const baseMs = Date.parse(now);

  const quoteIds = route.hops.map((h) => h.quote_id).join(",");
  const stmts = [
    db
      .prepare(
        `INSERT OR IGNORE INTO FxTransfers
           (gtid, from_currency, to_currency, amount_from, amount_to, effective_rate,
            hashlock, route_json, quote_ids, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'LOCKED', ?, ?)`
      )
      .bind(
        params.gtid,
        route.from_currency,
        route.to_currency,
        route.amount_from,
        route.amount_to,
        route.effective_rate,
        hashlock,
        JSON.stringify(route),
        quoteIds,
        now,
        now
      ),
  ];
  for (const edge of edges) {
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO FxLegLocks
             (gtid, leg_index, currency, amount, from_bank_id, from_account_hash,
              to_bank_id, to_account_hash, hashlock, timelock, state, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LOCKED', ?, ?, 0)`
        )
        .bind(
          params.gtid,
          edge.index,
          edge.currency,
          edge.amount,
          edge.from.bank_id,
          edge.from.account_hash,
          edge.to.bank_id,
          edge.to.account_hash,
          hashlock,
          timelockFor(baseMs, edge.index, edges.length),
          now,
          now
        )
    );
  }
  await db.batch(stmts);

  return {
    gtid: params.gtid,
    hashlock,
    secret,
    amount_from: route.amount_from,
    amount_to: route.amount_to,
    legs: edges.length,
  };
}

/** Fetch the leg locks for a transfer, ordered by leg_index. */
export async function getFxLegLocks(env: Env, gtid: string): Promise<FxLegLockRow[]> {
  const res = await env.DB.prepare(`SELECT * FROM FxLegLocks WHERE gtid = ? ORDER BY leg_index`)
    .bind(gtid)
    .all<FxLegLockRow>();
  return res.results ?? [];
}

/** Rebuild the route edges from persisted leg locks (claim-time settlement path). */
function legsToEdges(legs: FxLegLockRow[]): FxEdge[] {
  return legs.map((l) => ({
    index: l.leg_index,
    currency: l.currency,
    amount: l.amount,
    from: { bank_id: l.from_bank_id, account_hash: l.from_account_hash },
    to: { bank_id: l.to_bank_id, account_hash: l.to_account_hash },
  }));
}

export interface ClaimFxTransferResult {
  gtid: string;
  status: "SETTLED";
  gtid_state: string | null;
  already: boolean;
}

/**
 * Claim an HTLC-bound FX transfer by revealing the secret. Verifies
 * `sha256(secret) == hashlock`, then settles: cascades every LOCKED leg to
 * CLAIMED and registers + advances the conduit GTID so the rails settle.
 * Idempotent: a second claim returns the settled state. Rejects a wrong secret
 * (PREIMAGE_MISMATCH) or a transfer that has already refunded.
 *
 * Cross-rail multi-operation boundary (the reason this is more than a batch):
 * settlement spans several writes that cannot share one transaction —
 * FxLegLocks, GtidTransactions/GtidLegs (registerGtid), the H reservations and
 * lane rows (advanceGtid). Rather than rely on the single-node store's
 * serialization, the claim/refund decision is funnelled through ONE
 * authoritative single-row CAS on `FxTransfers.status`:
 *
 *     LOCKED ──claim──▶ SETTLING ──▶ SETTLED
 *        └────refund──▶ REFUNDED
 *
 * Exactly one of {claim, refund} can move the row off LOCKED, so they are
 * mutually exclusive by construction even when interleaved. The steps after the
 * gate are all idempotent (CAS leg updates, idempotent registerGtid/advanceGtid,
 * a final SETTLING→SETTLED CAS), so a crash mid-settle is *resumed* by a retry
 * (status stays SETTLING and a refund still cannot interpose) rather than
 * leaving a half-settled, half-refunded transfer. This is the saga pattern that
 * holds on a distributed backend without a distributed transaction.
 */
export async function claimFxTransfer(
  env: Env,
  gtid: string,
  secret: string
): Promise<ClaimFxTransferResult> {
  const db = env.DB;
  const now = nowISO();

  const legs = await getFxLegLocks(env, gtid);
  if (legs.length === 0)
    throw new DomainError("GTID_NOT_FOUND", "no FX leg locks for gtid", { gtid });

  // Verify the preimage BEFORE touching any state: a wrong secret must leave the
  // transfer exactly as it was (still LOCKED), regardless of the race gate.
  const hashlock = legs[0]!.hashlock;
  const computed = await sha256hex(secret);
  if (computed !== hashlock) {
    throw new DomainError("PREIMAGE_MISMATCH", "secret does not match hashlock", { gtid });
  }

  // Do not open a settlement we already know cannot finish. If the time left to
  // the most upstream timelock is under one hop margin, taking the gate would
  // park the transfer in SETTLING — where refund cannot interpose — for a window
  // that closes before settlement could complete. Take the cancel side instead,
  // which is the same branch the mutual exclusion would have reached anyway.
  const latestTimelock = legs.reduce(
    (max, l) => (l.timelock > max ? l.timelock : max),
    legs[0]!.timelock
  );
  if (now >= settlingDeadline(now, latestTimelock)) {
    await refundFxTransfer(env, gtid, now, { allowBeforeTimelock: true });
    throw new DomainError(
      "FX_CLAIM_WINDOW_EXPIRED",
      "too little time left to the upstream timelock to settle; transfer refunded instead",
      { gtid, latest_timelock: latestTimelock, now }
    );
  }

  // Authoritative gate: win the exclusive right to settle by CASing the transfer
  // LOCKED → SETTLING. This single-row CAS is the serialization point shared with
  // refund; a concurrent refund's LOCKED → REFUNDED CAS can no longer win.
  const gate = await db
    .prepare(
      `UPDATE FxTransfers SET status='SETTLING', updated_at=? WHERE gtid=? AND status='LOCKED'`
    )
    .bind(now, gtid)
    .run();
  const wonGate = (gate.meta.changes ?? 0) > 0;

  if (!wonGate) {
    // Did not win LOCKED → SETTLING. The committed status decides the outcome.
    const cur = await db
      .prepare(`SELECT status FROM FxTransfers WHERE gtid=?`)
      .bind(gtid)
      .first<{ status: string }>();
    if (!cur) throw new DomainError("GTID_NOT_FOUND", "no FX transfer for gtid", { gtid });
    if (cur.status === "REFUNDED") {
      throw new DomainError("FX_ALREADY_REFUNDED", "transfer already refunded; cannot claim", {
        gtid,
      });
    }
    if (cur.status === "SETTLED") {
      const gtDone = await db
        .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
        .bind(gtid)
        .first<{ state: string }>();
      return { gtid, status: "SETTLED", gtid_state: gtDone?.state ?? null, already: true };
    }
    // status === 'SETTLING': another claim owns settlement (concurrent) or a
    // prior claim crashed mid-flight (retry). Either way, fall through and
    // complete it idempotently — only the gate winner reports `already:false`.
  }

  // We own settlement. Cascade all legs LOCKED → CLAIMED (idempotent: a resumed
  // claim simply re-affirms already-CLAIMED legs via the state guard).
  await db.batch(
    legs.map((l) =>
      db
        .prepare(
          `UPDATE FxLegLocks SET state='CLAIMED', updated_at=?, version=version+1
           WHERE gtid=? AND leg_index=? AND state='LOCKED'`
        )
        .bind(now, gtid, l.leg_index)
    )
  );

  // Settlement is deferred to the claim: register and advance the conduit GTID
  // now. Both are idempotent, so a resumed claim does not double-settle.
  const gtidLegs = edgesToGtidLegs(gtid, legsToEdges(legs));
  await registerGtid({ gtid, legs: gtidLegs, idempotency_key: `IK-FXCLAIM-${gtid}` }, env);
  await advanceGtid(gtid, env);

  // Finalize the saga: SETTLING → SETTLED (CAS, so it only fires for the owner).
  await db
    .prepare(
      `UPDATE FxTransfers SET status='SETTLED', updated_at=? WHERE gtid=? AND status='SETTLING'`
    )
    .bind(now, gtid)
    .run();

  const gt = await db
    .prepare(`SELECT state FROM GtidTransactions WHERE gtid=?`)
    .bind(gtid)
    .first<{ state: string }>();

  // `already:false` iff this call won the LOCKED→SETTLING gate; a concurrent /
  // resuming claim that found SETTLING also completes the work but reports true.
  return { gtid, status: "SETTLED", gtid_state: gt?.state ?? null, already: !wonGate };
}

export interface RefundFxTransferResult {
  gtid: string;
  status: "REFUNDED";
  refunded_legs: number;
}

/**
 * Refund an HTLC-bound FX transfer whose secret never arrived. Requires every
 * leg to be LOCKED and past its timelock (the latest, upstream lock — so no
 * claim can still settle), marks all legs REFUNDED and the transfer REFUNDED.
 * No money moves (settlement was never triggered). Rejects if already claimed.
 */
export async function refundFxTransfer(
  env: Env,
  gtid: string,
  at: string = nowISO(),
  /**
   * `allowBeforeTimelock` skips the "latest timelock has passed" guard. The one
   * legitimate caller is the claim path deciding, before it opens the gate, that
   * it cannot settle in time (`FX_CLAIM_WINDOW_EXPIRED`): the transfer is still
   * LOCKED, no money has moved, and refusing to refund would only strand it until
   * the timelock. Never set this from an external request path.
   */
  opts: { allowBeforeTimelock?: boolean } = {}
): Promise<RefundFxTransferResult> {
  const db = env.DB;
  const legs = await getFxLegLocks(env, gtid);
  if (legs.length === 0)
    throw new DomainError("GTID_NOT_FOUND", "no FX leg locks for gtid", { gtid });

  if (legs.some((l) => l.state === "CLAIMED")) {
    throw new DomainError("STATE_GUARD", "transfer already claimed; cannot refund", { gtid });
  }
  if (legs.every((l) => l.state === "REFUNDED")) {
    return { gtid, status: "REFUNDED", refunded_legs: 0 }; // idempotent
  }

  // Guard: only refund once the latest (upstream) timelock has passed, so the
  // claim window is fully closed and no settlement can still occur.
  const latestTimelock = legs.reduce(
    (max, l) => (l.timelock > max ? l.timelock : max),
    legs[0]!.timelock
  );
  if (at < latestTimelock && !opts.allowBeforeTimelock) {
    throw new DomainError("STATE_GUARD", "timelock has not expired; cannot refund yet", {
      gtid,
      latest_timelock: latestTimelock,
      now: at,
    });
  }

  const now = nowISO();
  // Authoritative gate (symmetric to claim): win the exclusive right to refund by
  // CASing LOCKED → REFUNDED on the transfer. If a claim already moved the row off
  // LOCKED (SETTLING/SETTLED), this fails and the refund is refused — even if the
  // legs still read LOCKED in the snapshot above (the claim had not yet cascaded
  // them when we read). This is the multi-operation boundary that the per-leg CAS
  // alone did not close.
  const gate = await db
    .prepare(
      `UPDATE FxTransfers SET status='REFUNDED', updated_at=? WHERE gtid=? AND status='LOCKED'`
    )
    .bind(now, gtid)
    .run();
  if ((gate.meta.changes ?? 0) === 0) {
    const cur = await db
      .prepare(`SELECT status FROM FxTransfers WHERE gtid=?`)
      .bind(gtid)
      .first<{ status: string }>();
    if (cur?.status === "REFUNDED") return { gtid, status: "REFUNDED", refunded_legs: 0 }; // idempotent
    throw new DomainError("STATE_GUARD", "transfer is settling/settled; cannot refund", {
      gtid,
      status: cur?.status ?? null,
    });
  }

  // We own the refund. Cascade every LOCKED leg → REFUNDED.
  const upd = await db.batch(
    legs.map((l) =>
      db
        .prepare(
          `UPDATE FxLegLocks SET state='REFUNDED', updated_at=?, version=version+1
           WHERE gtid=? AND leg_index=? AND state='LOCKED'`
        )
        .bind(now, gtid, l.leg_index)
    )
  );

  const refunded = upd.reduce((n, r) => n + ((r.meta.changes ?? 0) > 0 ? 1 : 0), 0);
  return { gtid, status: "REFUNDED", refunded_legs: refunded };
}

/**
 * Sweep every HTLC-bound FX transfer whose locks have all expired (the latest,
 * upstream timelock has passed) and refund it. Idempotent and safe to run on a
 * schedule — already-claimed/refunded transfers are excluded by the LOCKED
 * filter and the per-transfer guard. Returns the number of transfers refunded.
 */
export async function sweepExpiredFxLocks(env: Env, at: string = nowISO()): Promise<number> {
  const due = await env.DB.prepare(
    `SELECT gtid FROM FxLegLocks WHERE state='LOCKED' GROUP BY gtid HAVING MAX(timelock) < ?`
  )
    .bind(at)
    .all<{ gtid: string }>();
  let refunded = 0;
  for (const row of due.results ?? []) {
    try {
      const res = await refundFxTransfer(env, row.gtid, at);
      if (res.refunded_legs > 0) refunded++;
    } catch {
      // A transfer that raced to CLAIMED between the query and the refund is
      // skipped (refundFxTransfer guards it); keep sweeping the rest.
    }
  }
  return refunded;
}

/**
 * Sweep transfers stranded in `SETTLING` past their deadline (`settlingDeadline`).
 *
 * `sweepExpiredFxLocks` cannot reach these: it selects on legs still `LOCKED`,
 * and a claim that won the gate has already cascaded them to `CLAIMED`. So a
 * claim that crashed — or a downstream rail failing long enough that the retry
 * never completes — leaves the transfer where refund is (correctly) barred and
 * nothing else looks. That is the one path in the saga with no bounded outcome.
 *
 * The sweep does not force a settlement or a refund: by this point legs are
 * CLAIMED and money may have moved on some rail, so the safe convergence is the
 * declared one — suspend the aggregate and raise an exception record that a human
 * must close. Idempotent: an already-suspended GTID with an open CASE is skipped.
 * Returns the number of transfers newly converged.
 */
export async function sweepStuckFxSettling(env: Env, at: string = nowISO()): Promise<number> {
  const db = env.DB;
  const settling = await db
    .prepare(`SELECT gtid, updated_at FROM FxTransfers WHERE status='SETTLING'`)
    .all<{ gtid: string; updated_at: string }>();

  let converged = 0;
  for (const row of settling.results ?? []) {
    const legs = await getFxLegLocks(env, row.gtid);
    if (legs.length === 0) continue;
    const latestTimelock = legs.reduce(
      (max, l) => (l.timelock > max ? l.timelock : max),
      legs[0]!.timelock
    );
    if (at < settlingDeadline(row.updated_at, latestTimelock)) continue;

    const open = await db
      .prepare(
        `SELECT case_id FROM Cases WHERE related_gtid = ? AND reason_code = 'FX_SETTLING_STUCK'
           AND ${UNRESOLVED_CASE_STATES_SQL}`
      )
      .bind(row.gtid)
      .first<{ case_id: string }>();
    if (open) continue;

    // Suspend the aggregate when one exists. A claim that crashed before
    // registerGtid has no GtidTransactions row at all — the CASE is then the
    // whole convergence, which is the point: the exception is never only logged.
    const gt = await db
      .prepare(`SELECT state FROM GtidTransactions WHERE gtid = ?`)
      .bind(row.gtid)
      .first<{ state: string }>();
    if (gt?.state === "GT_DECIDED_TO_SETTLE") {
      await db
        .prepare(
          `UPDATE GtidTransactions SET state='GT_SUSPENDED', updated_at=?, version=version+1
           WHERE gtid=? AND state='GT_DECIDED_TO_SETTLE'`
        )
        .bind(at, row.gtid)
        .run();
      await writeFinalityLog(db, {
        txid: null,
        event_type: "GtidSuspended",
        state_from: "GT_DECIDED_TO_SETTLE",
        state_to: "GT_SUSPENDED",
        payload_json: JSON.stringify({ gtid: row.gtid, reason: "FX_SETTLING_STUCK" }),
        txid_or_gtid: row.gtid,
      });
    }

    await openCase(db, {
      related_gtid: row.gtid,
      reason_code: "FX_SETTLING_STUCK",
      description: `FX transfer stuck in SETTLING since ${row.updated_at}; deadline ${settlingDeadline(row.updated_at, latestTimelock)} passed`,
      opened_by: "ZC",
    });
    converged++;
  }
  return converged;
}
