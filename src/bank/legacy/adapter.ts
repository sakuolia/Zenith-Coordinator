/**
 * @file adapter.ts — The legacy adapter (対外接続系) that fronts a hostile core.
 *
 * ZC speaks its clean 13-command ingress to THIS layer; the adapter translates
 * to whatever a real legacy core (`legacy_core.ts`) can actually do, driven by a
 * per-participant capability profile. It implements the six legacy-friendliness
 * proposals:
 *
 *   #1 capability profile   — every branch below reads {@link LegacyProfile}.
 *   #2 prefund shadow        — authorise against AdapterShadow, never block on the core.
 *   #3 reconciliation        — see reconcile.ts (drift → real Cases row).
 *   #4 no-reserve + reversal — reservation_mode='NONE' + {@link compensateReversal}.
 *   #5 pull-based notify     — creditNotify stores; the bank pulls.
 *   #6 batch ingest          — {@link ingestBatchCredits} enqueues many at once.
 *   idempotency              — reuses the existing IdempotencyKeys atomic-claim
 *                               primitive (src/shared/idempotency.ts), not an
 *                               ad-hoc read-then-write table.
 *
 * Money never moves without its shadow entry; the shadow, outbox backlog, and
 * core balance obey one invariant that reconcile.ts checks:
 *
 *   core == shadow.available + shadow.reserved + Σpending_debits − Σpending_credits
 *
 * IMPORTANT — this subsystem is NOT wired into `bank/ingress.ts` / the ZC
 * orchestrator. It is an independently testable reference design for how the
 * 13-command ingress *could* be fronted for a non-idealised core; live ZC
 * traffic does not flow through it yet. See docs/specs/20_method_design.md § 現状の
 *割り切り.
 */

import { DomainError } from "../../shared/errors";
import { completeIdempotency, newUUID, resolveIdempotency } from "../../shared/idempotency";
import { nowISO } from "../../types";
import { openOrAggregateCase } from "../../zc/cases/case";
import { type LegacyCore, LegacyCoreError } from "./legacy_core";

export type ReservationMode = "SUSPENSE" | "NONE";
export type SettlementMode = "DIRECT" | "PREFUNDED_SHADOW";
export type NotifyMode = "PUSH" | "PULL";
export type ParticipantRole = "FULL" | "PAYEE_ONLY" | "PAYER_ONLY";

export interface LegacyProfile {
  bank_id: string;
  role: ParticipantRole;
  reservation_mode: ReservationMode;
  settlement_mode: SettlementMode;
  notify_mode: NotifyMode;
  sync_reserve: boolean;
  realtime_name_check: boolean;
  batch_ingest: boolean;
  window_open_hour: number | null;
  window_close_hour: number | null;
}

export interface AdapterResult {
  result: "OK" | "REJECTED" | "DEFERRED";
  reason_code?: string;
  [k: string]: unknown;
}

interface ProfileRow {
  bank_id: string;
  role: ParticipantRole;
  reservation_mode: ReservationMode;
  settlement_mode: SettlementMode;
  notify_mode: NotifyMode;
  sync_reserve: number;
  realtime_name_check: number;
  batch_ingest: number;
  window_open_hour: number | null;
  window_close_hour: number | null;
}

const DEFAULT_PROFILE: Omit<LegacyProfile, "bank_id"> = {
  role: "FULL",
  reservation_mode: "SUSPENSE",
  settlement_mode: "DIRECT",
  notify_mode: "PUSH",
  sync_reserve: true,
  realtime_name_check: true,
  batch_ingest: false,
  window_open_hour: null,
  window_close_hour: null,
};

// ---------------------------------------------------------------------------
// Capability profile (#1)
// ---------------------------------------------------------------------------

export async function upsertProfile(
  db: D1Database,
  profile: Partial<LegacyProfile> & { bank_id: string }
): Promise<void> {
  const p = { ...DEFAULT_PROFILE, ...profile };
  await db
    .prepare(
      `INSERT INTO LegacyProfiles
         (bank_id, role, reservation_mode, settlement_mode, notify_mode,
          sync_reserve, realtime_name_check, batch_ingest,
          window_open_hour, window_close_hour, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bank_id) DO UPDATE SET
         role=excluded.role, reservation_mode=excluded.reservation_mode,
         settlement_mode=excluded.settlement_mode, notify_mode=excluded.notify_mode,
         sync_reserve=excluded.sync_reserve, realtime_name_check=excluded.realtime_name_check,
         batch_ingest=excluded.batch_ingest,
         window_open_hour=excluded.window_open_hour, window_close_hour=excluded.window_close_hour`
    )
    .bind(
      p.bank_id,
      p.role,
      p.reservation_mode,
      p.settlement_mode,
      p.notify_mode,
      p.sync_reserve ? 1 : 0,
      p.realtime_name_check ? 1 : 0,
      p.batch_ingest ? 1 : 0,
      p.window_open_hour,
      p.window_close_hour,
      nowISO()
    )
    .run();
}

export async function getProfile(db: D1Database, bankId: string): Promise<LegacyProfile> {
  const row = await db
    .prepare(`SELECT * FROM LegacyProfiles WHERE bank_id=?`)
    .bind(bankId)
    .first<ProfileRow>();
  if (!row) return { bank_id: bankId, ...DEFAULT_PROFILE };
  return {
    bank_id: row.bank_id,
    role: row.role,
    reservation_mode: row.reservation_mode,
    settlement_mode: row.settlement_mode,
    notify_mode: row.notify_mode,
    sync_reserve: row.sync_reserve === 1,
    realtime_name_check: row.realtime_name_check === 1,
    batch_ingest: row.batch_ingest === 1,
    window_open_hour: row.window_open_hour,
    window_close_hour: row.window_close_hour,
  };
}

/**
 * Pure window math for #1: is the core expected online at `hourJST`? A null
 * window means always-online. Handles windows that wrap midnight
 * (e.g. close 23, open 5 → offline 23:00–05:00).
 */
export function isCoreOnlineAt(profile: LegacyProfile, hourJST: number): boolean {
  const { window_open_hour: open, window_close_hour: close } = profile;
  if (open === null || close === null) return true;
  if (close <= open) return hourJST < close || hourJST >= open;
  return hourJST >= open && hourJST < close;
}

export interface LegacyAdapter {
  reserveFunds(cmd: PostingCmd): Promise<AdapterResult>;
  executeDebit(cmd: PostingCmd): Promise<AdapterResult>;
  executeCredit(cmd: PostingCmd): Promise<AdapterResult>;
  releaseReserve(cmd: PostingCmd): Promise<AdapterResult>;
  compensateReversal(cmd: PostingCmd): Promise<AdapterResult>;
  legReadyCheck(cmd: LegReadyCheckCmd): Promise<AdapterResult>;
  authorityCheck(cmd: { bank_id: string; request_id: string }): Promise<AdapterResult>;
  nameCheck(cmd: {
    bank_id: string;
    account_id: string;
    request_id: string;
  }): Promise<AdapterResult>;
  accountVerify(cmd: {
    bank_id: string;
    account_id: string;
    request_id: string;
  }): Promise<AdapterResult>;
  creditNotify(cmd: NotifyCmd): Promise<AdapterResult>;
  rtpNotify(cmd: {
    bank_id: string;
    rtp_id: string;
    amount: number;
    request_id: string;
  }): Promise<AdapterResult>;
  pullNotifications(bankId: string): Promise<NotifyItem[]>;
  ingestBatchCredits(bankId: string, items: BatchCreditItem[]): Promise<AdapterResult>;
  debitSettled(cmd: { bank_id: string; txid: string; request_id: string }): Promise<AdapterResult>;
  drainOutbox(bankId: string): Promise<{ applied: number; deferred: number; blocked: number }>;
  initAccount(
    bankId: string,
    accountId: string,
    openingBalance: number,
    customerName?: string
  ): Promise<void>;
  cleanupAccount(bankId: string, accountId: string): Promise<void>;
}

export interface LegReadyCheckCmd {
  bank_id: string;
  account_id: string;
  leg_id: string;
  role: "PAYER" | "PAYEE";
  amount: number;
  request_id: string;
}

export interface PostingCmd {
  bank_id: string;
  account_id: string;
  amount: number;
  request_id: string;
  txid?: string;
}

export interface NotifyCmd {
  bank_id: string;
  account_id: string;
  amount: number;
  txid: string;
  request_id: string;
}

export interface NotifyItem {
  notify_id: string;
  txid: string;
  account_id: string | null; // null for an rtp-notify(10) not yet scoped to an account
  amount: number;
}

export interface BatchCreditItem {
  account_id: string;
  amount: number;
  txid: string;
  request_id: string;
}

/**
 * Build an adapter bound to a db + a specific hostile core. Kept as a factory
 * rather than a class so callers hold a plain object and the profile is fetched
 * per call (heterogeneous banks share one adapter binding in a real deployment).
 */
export function makeLegacyAdapter(db: D1Database, core: LegacyCore): LegacyAdapter {
  // -- idempotency: atomic claim-first, reusing the shared IdempotencyKeys ----
  // primitive (src/shared/idempotency.ts) rather than a bespoke read-then-write
  // table. `resolveIdempotency` INSERTs a PROCESSING row with a PK conflict
  // check as the FIRST operation — no read-then-decide window — so two
  // concurrent calls with the same request_id cannot both proceed to execute
  // side effects. The loser gets the in-flight sentinel and must retry.
  async function withIdempotency(
    requestId: string,
    fn: () => Promise<AdapterResult>
  ): Promise<AdapterResult> {
    // requestBody omitted (undefined): the adapter keys purely on request_id
    // (already unique per command per txid upstream), so body fingerprinting
    // is opted out of, matching the nonce-style usage documented on
    // acquireIdempotency.
    const resolved = await resolveIdempotency(requestId, undefined, db);
    if (resolved.status === "NEW") {
      const result = await fn();
      await completeIdempotency(requestId, result, db);
      return result;
    }
    if (resolved.status === "REPLAY") {
      const cached = resolved.response as { result?: string } | null;
      if (cached && cached.result === "PROCESSING") {
        // Another call with the SAME request_id is still in flight (a true
        // concurrent duplicate, not a completed replay). Fail retryable rather
        // than silently re-executing the side effects a second time.
        throw new DomainError(
          "LEGACY_ADAPTER_REQUEST_IN_FLIGHT",
          `request_id ${requestId} is already being processed by a concurrent call`,
          { request_id: requestId }
        );
      }
      return cached as AdapterResult;
    }
    // CONFLICT: same request_id reused with a different body. Unreachable with
    // fingerprinting opted out (above), kept only for type completeness.
    throw new DomainError(
      "IDEMPOTENCY_KEY_CONFLICT",
      `request_id ${requestId} reused with a conflicting body`,
      { request_id: requestId }
    );
  }

  async function getShadow(
    bankId: string,
    accountId: string
  ): Promise<{ available: number; reserved: number }> {
    const row = await db
      .prepare(`SELECT available, reserved FROM AdapterShadow WHERE bank_id=? AND account_id=?`)
      .bind(bankId, accountId)
      .first<{ available: number; reserved: number }>();
    return row ?? { available: 0, reserved: 0 };
  }

  function shadowUpdateStmt(
    bankId: string,
    accountId: string,
    dAvailable: number,
    dReserved: number
  ): D1PreparedStatement {
    return db
      .prepare(
        `INSERT INTO AdapterShadow (bank_id, account_id, available, reserved)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(bank_id, account_id)
           DO UPDATE SET available = available + ?, reserved = reserved + ?`
      )
      .bind(bankId, accountId, dAvailable, dReserved, dAvailable, dReserved);
  }

  function outboxInsertStmt(cmd: PostingCmd, op: "DEBIT" | "CREDIT"): D1PreparedStatement {
    return db
      .prepare(
        `INSERT INTO AdapterOutbox
           (outbox_id, bank_id, account_id, op, amount, txid, request_id, status, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?)`
      )
      .bind(
        `OBX-${newUUID()}`,
        cmd.bank_id,
        cmd.account_id,
        op,
        cmd.amount,
        cmd.txid ?? null,
        cmd.request_id,
        nowISO()
      );
  }

  async function initAccount(
    bankId: string,
    accountId: string,
    openingBalance: number,
    customerName?: string
  ): Promise<void> {
    // Prefund sync: the shadow opens equal to the core balance. This is the
    // moment (an online window) at which mirror and core agree. Uses the
    // core's production seeding method (not the test-only drift injector).
    await core.seedOpeningBalance(bankId, accountId, openingBalance, customerName);
    await db
      .prepare(
        `INSERT INTO AdapterShadow (bank_id, account_id, available, reserved)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(bank_id, account_id) DO UPDATE SET available=excluded.available, reserved=0`
      )
      .bind(bankId, accountId, openingBalance)
      .run();
  }

  // -- cleanup-bank(13) --------------------------------------------------------
  async function cleanupAccount(bankId: string, accountId: string): Promise<void> {
    await core.removeAccount(bankId, accountId);
    await db
      .prepare(`DELETE FROM AdapterShadow WHERE bank_id=? AND account_id=?`)
      .bind(bankId, accountId)
      .run();
  }

  /**
   * The reservation mode this profile can actually run, as opposed to the one
   * it declares.
   *
   * `sync_reserve=false` says the core cannot hold and return a reservation
   * synchronously. A declared `SUSPENSE` on such a core would be a hold that
   * nothing behind the adapter is aware of — the shadow would carry a `reserved`
   * balance the core can neither honour nor release, which is exactly the drift
   * reconcile.ts exists to catch. The design already has the right degradation
   * for a core with no reservation primitive: proposal #4, `NONE` + a
   * compensating reversal on failure. So an unsupported `SUSPENSE` degrades to
   * `NONE` rather than being taken on trust.
   *
   * Every branch that reads `reservation_mode` must read it through here;
   * otherwise reserve takes one path and debit/release take the other, and
   * executeDebit looks for a reservation that was never made.
   */
  function effectiveReservationMode(profile: LegacyProfile): ReservationMode {
    return profile.sync_reserve ? profile.reservation_mode : "NONE";
  }

  // -- reserveFunds -----------------------------------------------------------
  async function reserveFunds(cmd: PostingCmd): Promise<AdapterResult> {
    return withIdempotency(cmd.request_id, async () => {
      const profile = await getProfile(db, cmd.bank_id);
      if (profile.role === "PAYEE_ONLY")
        return { result: "REJECTED", reason_code: "PARTICIPANT_CANNOT_SEND" };

      const shadow = await getShadow(cmd.bank_id, cmd.account_id);
      if (shadow.available < cmd.amount)
        return { result: "REJECTED", reason_code: "INSUFFICIENT_FUNDS" };

      // NONE mode (#4): no hold at all — reserve is a pure availability check.
      // The core never sees a reservation; a later failure is undone by a
      // compensating reversal, not by releasing a hold.
      const mode = effectiveReservationMode(profile);
      if (mode === "NONE") {
        // Report the degradation when it was not what the profile asked for, so
        // a mis-declared capability shows up in the caller's trace instead of
        // looking like a deliberate NONE.
        return profile.reservation_mode === "NONE"
          ? { result: "OK", reservation_mode: "NONE" }
          : { result: "OK", reservation_mode: "NONE", degraded: "SYNC_RESERVE_UNSUPPORTED" };
      }

      // SUSPENSE mode: move available → reserved in the SHADOW only. The core —
      // which has no reservation primitive — is never touched here.
      await shadowUpdateStmt(cmd.bank_id, cmd.account_id, -cmd.amount, cmd.amount).run();
      return { result: "OK", reservation_mode: "SUSPENSE" };
    });
  }

  // -- executeDebit -----------------------------------------------------------
  async function executeDebit(cmd: PostingCmd): Promise<AdapterResult> {
    return withIdempotency(cmd.request_id, async () => {
      const profile = await getProfile(db, cmd.bank_id);
      if (profile.role === "PAYEE_ONLY")
        return { result: "REJECTED", reason_code: "PARTICIPANT_CANNOT_SEND" };

      if (effectiveReservationMode(profile) === "SUSPENSE") {
        // Consume the shadow reservation; enqueue the real posting for the core.
        const shadow = await getShadow(cmd.bank_id, cmd.account_id);
        if (shadow.reserved < cmd.amount)
          return { result: "REJECTED", reason_code: "NO_RESERVATION" };
        await db.batch([
          shadowUpdateStmt(cmd.bank_id, cmd.account_id, 0, -cmd.amount),
          outboxInsertStmt(cmd, "DEBIT"),
        ]);
      } else {
        // NONE mode: debit straight off available.
        const shadow = await getShadow(cmd.bank_id, cmd.account_id);
        if (shadow.available < cmd.amount)
          return { result: "REJECTED", reason_code: "INSUFFICIENT_FUNDS" };
        await db.batch([
          shadowUpdateStmt(cmd.bank_id, cmd.account_id, -cmd.amount, 0),
          outboxInsertStmt(cmd, "DEBIT"),
        ]);
      }

      // DIRECT settlement (capable core): try to apply synchronously now; on
      // offline/timeout leave it queued and report DEFERRED. PREFUNDED_SHADOW
      // never blocks on the core — always drained later.
      if (profile.settlement_mode === "DIRECT") {
        const outcome = await tryApplyOutboxForRequest(cmd.request_id);
        return outcome === "APPLIED"
          ? { result: "OK", settled: "SYNC" }
          : { result: "OK", settled: "DEFERRED" };
      }
      return { result: "OK", settled: "DEFERRED" };
    });
  }

  // -- executeCredit ----------------------------------------------------------
  async function executeCredit(cmd: PostingCmd): Promise<AdapterResult> {
    return withIdempotency(cmd.request_id, async () => {
      const profile = await getProfile(db, cmd.bank_id);
      if (profile.role === "PAYER_ONLY")
        return { result: "REJECTED", reason_code: "PARTICIPANT_CANNOT_RECEIVE" };

      await db.batch([
        shadowUpdateStmt(cmd.bank_id, cmd.account_id, cmd.amount, 0),
        outboxInsertStmt(cmd, "CREDIT"),
      ]);
      if (profile.settlement_mode === "DIRECT") {
        const outcome = await tryApplyOutboxForRequest(cmd.request_id);
        return outcome === "APPLIED"
          ? { result: "OK", settled: "SYNC" }
          : { result: "OK", settled: "DEFERRED" };
      }
      return { result: "OK", settled: "DEFERRED" };
    });
  }

  // -- releaseReserve ---------------------------------------------------------
  async function releaseReserve(cmd: PostingCmd): Promise<AdapterResult> {
    return withIdempotency(cmd.request_id, async () => {
      const profile = await getProfile(db, cmd.bank_id);
      if (effectiveReservationMode(profile) === "NONE") return { result: "OK", released: "NOOP" };
      const shadow = await getShadow(cmd.bank_id, cmd.account_id);
      const amt = Math.min(cmd.amount, shadow.reserved);
      await shadowUpdateStmt(cmd.bank_id, cmd.account_id, amt, -amt).run();
      return { result: "OK", released: amt };
    });
  }

  // -- leg-ready-check(5) -------------------------------------------------------
  // GTID multi-leg pre-readiness. The GTID all-or-nothing coordination across
  // legs (GtidLegs / checkAndFinalizeGtid) lives entirely in the ZC
  // orchestrator and never crosses the bank/core boundary — from the core's
  // side a GTID leg is INDISTINGUISHABLE from an ordinary reserve-funds
  // (PAYER) or account-verify (PAYEE) call (mirrors bank/ingress/reserve.ts's
  // bankLegReadyCheck, whose own doc comment says "equivalent to
  // reserve-funds"). This is a thin wrapper delegating to the same functions,
  // not new core logic — see docs/specs/10_requirements.md §1 row 5.
  async function legReadyCheck(cmd: LegReadyCheckCmd): Promise<AdapterResult> {
    if (cmd.role === "PAYER") {
      const predictedTxid = `TX-GT-${cmd.leg_id}`;
      return reserveFunds({
        bank_id: cmd.bank_id,
        account_id: cmd.account_id,
        amount: cmd.amount,
        request_id: cmd.request_id,
        txid: predictedTxid,
      });
    }
    return accountVerify({
      bank_id: cmd.bank_id,
      account_id: cmd.account_id,
      request_id: cmd.request_id,
    });
  }

  // -- compensateReversal (#4) ------------------------------------------------
  async function compensateReversal(cmd: PostingCmd): Promise<AdapterResult> {
    return withIdempotency(cmd.request_id, async () => {
      // Undo a completed debit by crediting the payer back — a new posting, the
      // way ZC treats a Reversal (never an in-place rollback). Carries the same
      // txid as the original debit so the two postings are traceable as a pair
      // via AdapterOutbox.txid / LegacyCoreJournal.txid.
      await db.batch([
        shadowUpdateStmt(cmd.bank_id, cmd.account_id, cmd.amount, 0),
        outboxInsertStmt(cmd, "CREDIT"),
      ]);
      const profile = await getProfile(db, cmd.bank_id);
      if (profile.settlement_mode === "DIRECT") await tryApplyOutboxForRequest(cmd.request_id);
      return { result: "OK", reversal: "COMPENSATED" };
    });
  }

  // -- accountVerify ----------------------------------------------------------
  async function accountVerify(cmd: {
    bank_id: string;
    account_id: string;
    request_id: string;
  }): Promise<AdapterResult> {
    const profile = await getProfile(db, cmd.bank_id);
    // A batch-only core cannot answer name-check in real time; rather than fail
    // the transfer, degrade to DEFERRED (report: name-check is optional).
    if (!profile.realtime_name_check)
      return { result: "DEFERRED", reason_code: "NAME_CHECK_DEFERRED" };
    try {
      const bal = await core.getBalance(cmd.bank_id, cmd.account_id);
      return { result: "OK", exists: bal !== 0 || true };
    } catch (e) {
      if (e instanceof LegacyCoreError && e.code === "CORE_OFFLINE")
        return { result: "DEFERRED", reason_code: "CORE_OFFLINE" };
      throw e;
    }
  }

  // -- authority-check(6) -------------------------------------------------------
  // AML/sanctions screening. docs/specs/10_requirements.md §1 row 6: this
  // is not a capability requested of the core (mirrors the greenfield mock,
  // which always returns OK — a real deployment would integrate an external
  // compliance engine here, not the legacy core).
  async function authorityCheck(_cmd: {
    bank_id: string;
    request_id: string;
  }): Promise<AdapterResult> {
    return { result: "OK" };
  }

  // -- name-check(7) -------------------------------------------------------------
  // Distinct from account-verify(8): returns the holder name on MATCH rather
  // than a fuzzy match score (fuzzy matching is deliberately NOT requested of
  // the core — docs/specs/10_requirements.md §4-b).
  async function nameCheck(cmd: {
    bank_id: string;
    account_id: string;
    request_id: string;
  }): Promise<AdapterResult> {
    const profile = await getProfile(db, cmd.bank_id);
    if (!profile.realtime_name_check)
      return { result: "DEFERRED", reason_code: "NAME_CHECK_DEFERRED" };
    try {
      const name = await core.getAccountName(cmd.bank_id, cmd.account_id);
      return name === null
        ? { result: "REJECTED", reason_code: "NAME_MISMATCH" }
        : { result: "OK", customer_name: name };
    } catch (e) {
      if (e instanceof LegacyCoreError && e.code === "CORE_OFFLINE")
        return { result: "DEFERRED", reason_code: "CORE_OFFLINE" };
      throw e;
    }
  }

  // -- debit-settled(11) ---------------------------------------------------------
  // Passive acknowledgement to the payer bank that end-to-end settlement is
  // final. Requires nothing from the core (docs/specs/10_requirements.md
  // §1 row 11) — mirrors the greenfield ingress, which always ACKNOWLEDGEs.
  async function debitSettled(cmd: {
    bank_id: string;
    txid: string;
    request_id: string;
  }): Promise<AdapterResult> {
    return withIdempotency(cmd.request_id, async () => ({ result: "OK", txid: cmd.txid }));
  }

  // -- creditNotify (#5) ------------------------------------------------------
  async function creditNotify(cmd: NotifyCmd): Promise<AdapterResult> {
    return withIdempotency(cmd.request_id, async () => {
      const profile = await getProfile(db, cmd.bank_id);
      // PULL is the legacy-friendly default: store, let the bank pull. PUSH to a
      // batch-only core has no endpoint, so we still store and mark it — the
      // core is never required to accept an inbound connection.
      await db
        .prepare(
          `INSERT INTO AdapterNotifications
             (notify_id, bank_id, txid, account_id, amount, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'UNREAD', ?)`
        )
        .bind(`NTF-${newUUID()}`, cmd.bank_id, cmd.txid, cmd.account_id, cmd.amount, nowISO())
        .run();
      return { result: "OK", notify_mode: profile.notify_mode };
    });
  }

  // -- rtp-notify(10) -----------------------------------------------------------
  // Request-to-Pay notification to the payer bank. Structurally identical to
  // credit-notify(9): a pure notification requiring nothing from the core
  // (mirrors bank/ingress/notify.ts's bankRtpNotify, which only stores to
  // RtpRequests — no debit, no balance check). If the payer later approves,
  // that approval flows through the ORDINARY reserve-funds/execute-debit
  // path, not through this command. See docs/specs/10_requirements.md §1
  // row 10. account_id is null (not yet scoped to a specific account); txid
  // holds the rtp_id (no txid exists yet either).
  async function rtpNotify(cmd: {
    bank_id: string;
    rtp_id: string;
    amount: number;
    request_id: string;
  }): Promise<AdapterResult> {
    return withIdempotency(cmd.request_id, async () => {
      await db
        .prepare(
          `INSERT INTO AdapterNotifications
             (notify_id, bank_id, txid, account_id, amount, status, created_at)
           VALUES (?, ?, ?, NULL, ?, 'UNREAD', ?)`
        )
        .bind(`NTF-${newUUID()}`, cmd.bank_id, cmd.rtp_id, cmd.amount, nowISO())
        .run();
      return { result: "OK" };
    });
  }

  async function pullNotifications(bankId: string): Promise<NotifyItem[]> {
    const rows = await db
      .prepare(
        `SELECT notify_id, txid, account_id, amount FROM AdapterNotifications
          WHERE bank_id=? AND status='UNREAD' ORDER BY created_at`
      )
      .bind(bankId)
      .all<NotifyItem>();
    if (rows.results.length > 0) {
      await db
        .prepare(
          `UPDATE AdapterNotifications SET status='READ', read_at=? WHERE bank_id=? AND status='UNREAD'`
        )
        .bind(nowISO(), bankId)
        .run();
    }
    return rows.results;
  }

  // -- batch ingest (#6) ------------------------------------------------------
  async function ingestBatchCredits(
    bankId: string,
    items: BatchCreditItem[]
  ): Promise<AdapterResult> {
    let accepted = 0;
    for (const item of items) {
      const r = await executeCredit({
        bank_id: bankId,
        account_id: item.account_id,
        amount: item.amount,
        txid: item.txid,
        request_id: item.request_id,
      });
      if (r.result === "OK") accepted++;
    }
    return { result: "OK", accepted, total: items.length };
  }

  // -- outbox drain (#2), claim-then-apply -------------------------------------
  //
  // Two-phase to survive concurrent drain invocations: PENDING --(claim)-->
  // CLAIMED --(apply)--> APPLIED | BLOCKED. The claim is a single guarded
  // UPDATE (`WHERE status='PENDING'`) whose `meta.changes` is the sole
  // arbiter of ownership — exactly the CAS idiom used elsewhere in this
  // codebase (`transitionWithLog`, H reservations). Only the caller that
  // wins the claim proceeds to touch the core, so two overlapping drains can
  // no longer both post the same row (the bug the original single-phase
  // "post unconditionally, flip status as an afterthought" design had: since
  // `db.batch()` runs every statement in the array regardless of another
  // statement's row count, a trailing guard does not stop the posting
  // statements ahead of it from firing twice).
  type OutboxRow = {
    outbox_id: string;
    bank_id: string;
    account_id: string;
    op: "DEBIT" | "CREDIT";
    amount: number;
    txid: string | null;
    request_id: string;
  };

  async function claimOutboxRow(outboxId: string): Promise<boolean> {
    const now = nowISO();
    const r = await db
      .prepare(
        `UPDATE AdapterOutbox SET status='CLAIMED', claimed_at=? WHERE outbox_id=? AND status='PENDING'`
      )
      .bind(now, outboxId)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  /** Claimed but not applied (offline/timeout mid-drain): safe to retry. */
  async function releaseClaim(outboxId: string): Promise<void> {
    await db
      .prepare(
        `UPDATE AdapterOutbox SET status='PENDING', attempts=attempts+1 WHERE outbox_id=? AND status='CLAIMED'`
      )
      .bind(outboxId)
      .run();
  }

  async function tryApplyOutboxForRequest(
    requestId: string
  ): Promise<"APPLIED" | "DEFERRED" | "BLOCKED"> {
    const row = await db
      .prepare(
        `SELECT outbox_id, bank_id, account_id, op, amount, txid, request_id FROM AdapterOutbox
          WHERE request_id=? AND status='PENDING' LIMIT 1`
      )
      .bind(requestId)
      .first<OutboxRow>();
    if (!row) return "DEFERRED";
    return applyOutboxRow(row);
  }

  /**
   * Apply one claimed outbox row by calling the core's OPAQUE posting API
   * (postCredit/postDebit — see legacy_core.ts's file-level doc comment on
   * why the contract stays call-based rather than sharing a transaction
   * across the adapter/core boundary). This is deliberately NOT one atomic
   * batch spanning the core's tables and AdapterOutbox: a real, physically
   * separate core could never join such a transaction, so pretending it can
   * here would prove a contract no real core-banking vendor could implement.
   *
   * Residual risk this creates, stated plainly: if the process crashes AFTER
   * `core.postDebit`/`postCredit` returns `applied:true` but BEFORE the
   * following outbox-flip commits, `recoverStaleClaims` reverts the row to
   * PENDING and a retry calls the core again. For a core with genuine zero
   * idempotency (constraint #2 — no request-dedup, no "was X already
   * applied" query), that retry DOES double-post. No adapter-side design can
   * close this window without cooperation from the core (a caller-supplied
   * idempotency key the core itself honours, or a receipt/reference the
   * adapter can poll) — see docs/specs/20_method_design.md § ベンダー接続可否 for
   * which real cores actually offer that, and why reconciliation (#3), not
   * this claim mechanism, is the load-bearing safety net for a core that
   * does not.
   */
  async function applyOutboxRow(row: OutboxRow): Promise<"APPLIED" | "DEFERRED" | "BLOCKED"> {
    if (!(await claimOutboxRow(row.outbox_id))) return "DEFERRED"; // lost the claim race; another caller owns it

    let posted: { applied: boolean };
    try {
      posted =
        row.op === "CREDIT"
          ? await core.postCredit(row.bank_id, row.account_id, row.amount, {
              txid: row.txid ?? undefined,
              requestId: row.request_id,
            })
          : await core.postDebit(row.bank_id, row.account_id, row.amount, {
              txid: row.txid ?? undefined,
              requestId: row.request_id,
            });
    } catch (e) {
      if (e instanceof LegacyCoreError) {
        await releaseClaim(row.outbox_id);
        return "DEFERRED";
      }
      throw e;
    }

    if (posted.applied) {
      await db
        .prepare(
          `UPDATE AdapterOutbox SET status='APPLIED', applied_at=? WHERE outbox_id=? AND status='CLAIMED'`
        )
        .bind(nowISO(), row.outbox_id)
        .run();
      return "APPLIED";
    }

    // Insufficient funds discovered at drain time — the core rejected a
    // posting the shadow had already authorised (drift, or the shadow's
    // authorisation outpaced real settlement resources). This is exactly the
    // "unexplained state" ZC's own principles forbid leaving unresolved:
    // converge it into a real Cases row rather than silently retrying forever
    // or losing the money movement.
    await db
      .prepare(`UPDATE AdapterOutbox SET status='BLOCKED' WHERE outbox_id=? AND status='CLAIMED'`)
      .bind(row.outbox_id)
      .run();
    await openOrAggregateCase(db, {
      related_txid: row.txid ?? undefined,
      reason_code: "LEGACY_CORE_INSUFFICIENT_FUNDS",
      opened_by: "ZC",
      // One core rejecting postings is one cause; the blocked txids ride along
      // as relations (§10.7.2) rather than as one CASE each.
      cause_party_id: row.bank_id,
      description: `Legacy adapter: DEBIT of ${row.amount} for ${row.bank_id}/${row.account_id} (outbox ${row.outbox_id}, request ${row.request_id}) blocked — core balance insufficient at drain time.`,
    });
    return "BLOCKED";
  }

  async function drainOutbox(
    bankId: string
  ): Promise<{ applied: number; deferred: number; blocked: number }> {
    const rows = await db
      .prepare(
        `SELECT outbox_id, bank_id, account_id, op, amount, txid, request_id FROM AdapterOutbox
          WHERE bank_id=? AND status='PENDING' ORDER BY created_at`
      )
      .bind(bankId)
      .all<OutboxRow>();
    let applied = 0;
    let deferred = 0;
    let blocked = 0;
    for (const row of rows.results) {
      const outcome = await applyOutboxRow(row);
      if (outcome === "APPLIED") applied++;
      else if (outcome === "BLOCKED") blocked++;
      else deferred++;
    }
    return { applied, deferred, blocked };
  }

  return {
    reserveFunds,
    executeDebit,
    executeCredit,
    releaseReserve,
    compensateReversal,
    legReadyCheck,
    authorityCheck,
    nameCheck,
    accountVerify,
    creditNotify,
    rtpNotify,
    pullNotifications,
    ingestBatchCredits,
    debitSettled,
    drainOutbox,
    initAccount,
    cleanupAccount,
  };
}

/**
 * Recover outbox rows stuck CLAIMED past `staleAfterMs` (a drain that crashed
 * or was killed between claiming a row and committing its apply batch — the
 * claim itself is durable, so a crash there does not lose or duplicate the
 * underlying posting, but it does leave the row unclaimable by design unless
 * swept back to PENDING). Mirrors the existing orphaned-IdempotencyKeys sweep
 * in cron/timeout_sweep.ts; intended to be called from the same cron tick.
 */
export async function recoverStaleClaims(
  db: D1Database,
  staleAfterMs = 15 * 60 * 1000
): Promise<number> {
  const deadline = new Date(Date.now() - staleAfterMs).toISOString();
  const r = await db
    .prepare(
      `UPDATE AdapterOutbox SET status='PENDING', attempts=attempts+1
        WHERE status='CLAIMED' AND claimed_at < ?`
    )
    .bind(deadline)
    .run();
  return r.meta.changes ?? 0;
}
