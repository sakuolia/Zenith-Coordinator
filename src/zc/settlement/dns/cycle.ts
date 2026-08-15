/**
 * @file DNS cycle lifecycle — kick / resume / hold / intraday-cutoff and the
 *       getOrCreateDnsCycle entry point used across lanes.
 * @module zc/settlement/dns/cycle
 */

import { DEFAULT_SETTLEMENT_CHAIN } from "../../../shared/central_bank";
import type { DnsCycleRow, Env } from "../../../types";
import { businessDateJST, nowISO } from "../../../types";
import { cycleOwner } from "../../lanes/_helpers";
import { writeFinalityLog } from "../../orchestrator";
import { DEFAULT_DNS_CURRENCY, formatDnsCycleId, legacyDnsCycleIdentity } from "../dns_cycle_id";
import { dnsHoldMessageId } from "./disclosure";
import { computeBojShortfalls } from "./reserve";
import { settleDns } from "./settle";

// ---------------------------------------------------------------------------
// DNS Kick: move the current-day cycle OPEN → KICKED
// ---------------------------------------------------------------------------
export async function kickDns(
  businessDate: string,
  env: Env,
  currency: string = DEFAULT_DNS_CURRENCY
): Promise<{
  cycle_id: string;
  state: string;
  net_positions: Record<string, number>;
}> {
  const db = env.DB;
  const now = nowISO();

  // Get the current-day OPEN cycle FOR THIS CURRENCY (including late-arriving
  // cycles). DNS netting is multiplexed along the currency axis (Theme D): a day
  // can carry one OPEN cycle per currency, so the selection must be currency-
  // scoped — otherwise kickDns could pick a foreign-currency cycle as "the"
  // cycle and settle it through the JPY rail. If none exists, create one.
  let cycle = await db
    .prepare(
      `SELECT * FROM DnsCycles WHERE business_date = ? AND currency = ? AND state = 'OPEN' ORDER BY created_at ASC LIMIT 1`
    )
    .bind(businessDate, currency)
    .first<DnsCycleRow>();

  if (!cycle) {
    // Only the canonical single-daily JPY cycle is auto-created here (its id is
    // the legacy `DNS-{date}` form). Non-JPY cycles are minted by
    // getOrCreateDnsCycle with the canonical `DNS-{CCY}-…` id; kickDns does not
    // fabricate one, so for a non-default currency with no OPEN cycle there is
    // simply nothing to kick.
    if (currency !== DEFAULT_DNS_CURRENCY) {
      const existing = await db
        .prepare(
          `SELECT * FROM DnsCycles WHERE business_date = ? AND currency = ? ORDER BY created_at DESC LIMIT 1`
        )
        .bind(businessDate, currency)
        .first<DnsCycleRow>();
      return {
        cycle_id: existing?.cycle_id ?? "",
        state: existing?.state ?? "NO_OPEN_CYCLE",
        net_positions: {},
      };
    }
    const cycleId = `DNS-${businessDate}`;
    const identity = legacyDnsCycleIdentity(businessDate);
    await db
      .prepare(
        `INSERT OR IGNORE INTO DnsCycles (cycle_id, business_date, state, igs_mode, currency, intraday_seq, created_at)
       VALUES (?, ?, 'OPEN', 'NORMAL', ?, ?, ?)`
      )
      .bind(cycleId, businessDate, identity.currency, identity.intradaySeq, now)
      .run();
    cycle = await db
      .prepare(
        `SELECT * FROM DnsCycles WHERE business_date = ? AND currency = ? AND state = 'OPEN' ORDER BY created_at ASC LIMIT 1`
      )
      .bind(businessDate, currency)
      .first<DnsCycleRow>();
    if (!cycle) {
      // The current-day cycle is already KICKED or SETTLED → early return
      const existing = await db
        .prepare(
          `SELECT * FROM DnsCycles WHERE business_date = ? AND currency = ? ORDER BY created_at DESC LIMIT 1`
        )
        .bind(businessDate, currency)
        .first<DnsCycleRow>();
      if (existing)
        return { cycle_id: existing.cycle_id, state: existing.state, net_positions: {} };
      throw new Error(`Failed to create DNS cycle for ${businessDate} (${currency})`);
    }
  }

  // Associate unassigned TX with the cycle first → then compute net positions.
  // HIGH_VALUE settles immediately via RTGS, so it is excluded from DNS Kick.
  // DATE filter removed: include all pending TX with dns_cycle_id=NULL (including
  // carryover from the previous day); advanceBulk does not set dns_cycle_id, so
  // kickDns is the only assigning authority.
  // CURRENCY filter (Theme D): only sweep tx of this cycle's currency, so a
  // foreign-currency tx is never netted into another currency's cycle at par.
  //
  // 単一所有者則 (§5.2 handoff #1): the same batch that stamps `dns_cycle_id`
  // also stamps `owner='CYCLE:<id>'` — from this commit the cycle, not ZC,
  // governs each snapshotted row's fate, so the timeout sweep is structurally
  // unable to abandon it (docs/specs/30_internal_design.md §5.1 の二元帳乖離カタログ #2). The second UPDATE also covers rows that
  // pre-attached `dns_cycle_id` at decision time (EXPRESS/STANDARD/HTLC via
  // getOrCreateDnsCycle) — those stay ZC-owned until this snapshot. The stamp
  // is a bulk UPDATE without per-tx FinalityLog rows, matching the existing
  // snapshot shape: the handoff is recorded once at cycle level in the
  // 'DnsKicked' event below (owned_tx_count), not as N per-tx log round-trips.
  // Deliberately no `version` bump (the assignment never bumped it either);
  // the transition helpers re-assert `owner` in their CAS instead.
  const stampResults = await db.batch([
    db
      .prepare(
        `UPDATE Transactions SET dns_cycle_id = ?
       WHERE dns_cycle_id IS NULL
         AND lane != 'HIGH_VALUE'
         AND amount_currency = ?
         AND state IN ('DECIDED_TO_SETTLE','PAYER_EXEC_CONFIRMED','PAYEE_EXEC_CONFIRMED')`
      )
      .bind(cycle.cycle_id, cycle.currency),
    db
      .prepare(
        `UPDATE Transactions SET owner = ?
       WHERE dns_cycle_id = ?
         AND amount_currency = ?
         AND owner = 'ZC'
         AND state IN ('DECIDED_TO_SETTLE','PAYER_EXEC_CONFIRMED','PAYEE_EXEC_CONFIRMED')`
      )
      .bind(cycleOwner(cycle.cycle_id), cycle.cycle_id, cycle.currency),
  ]);
  const ownedTxCount = stampResults[1]?.meta.changes ?? 0;

  // Compute net positions (targeting all TX after assignment). Currency-scoped
  // defensively so a pre-existing mis-assignment cannot mix non-fungible units.
  const txRows = await db
    .prepare(
      `SELECT payer_bank_id, payee_bank_id, amount_value
     FROM Transactions
     WHERE dns_cycle_id = ? AND amount_currency = ? AND state IN ('DECIDED_TO_SETTLE','PAYER_EXEC_CONFIRMED','PAYEE_EXEC_CONFIRMED','SETTLED')`
    )
    .bind(cycle.cycle_id, cycle.currency)
    .all<{ payer_bank_id: string; payee_bank_id: string; amount_value: number }>();

  // Aggregate net / grossSend / grossReceive together in a single pass (O(n) / O(participants)).
  // Previously it used filter+reduce, which was O(n*participants) and allocated intermediate arrays each time.
  const netPositions: Record<string, number> = {};
  const grossSendByBank: Record<string, number> = {};
  const grossReceiveByBank: Record<string, number> = {};
  for (const tx of txRows.results) {
    const payer = tx.payer_bank_id;
    const payee = tx.payee_bank_id;
    const amt = tx.amount_value;
    netPositions[payer] = (netPositions[payer] ?? 0) - amt;
    netPositions[payee] = (netPositions[payee] ?? 0) + amt;
    grossSendByBank[payer] = (grossSendByBank[payer] ?? 0) + amt;
    grossReceiveByBank[payee] = (grossReceiveByBank[payee] ?? 0) + amt;
  }

  // Save to DnsNetPositions
  const netStmts: ReturnType<typeof db.prepare>[] = [];
  for (const bankId in netPositions) {
    netStmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO DnsNetPositions (id, cycle_id, bank_id, gross_send, gross_receive, net_position, is_settled)
         VALUES (?, ?, ?, ?, ?, ?, 0)`
        )
        .bind(
          `DNSNET-${cycle.cycle_id}-${bankId}`,
          cycle.cycle_id,
          bankId,
          grossSendByBank[bankId] ?? 0,
          grossReceiveByBank[bankId] ?? 0,
          netPositions[bankId] ?? 0
        )
    );
  }

  // Update cycle to KICKED
  await db.batch([
    ...netStmts,
    db
      .prepare(`UPDATE DnsCycles SET state='KICKED', kicked_at=?, net_positions=? WHERE cycle_id=?`)
      .bind(now, JSON.stringify(netPositions), cycle.cycle_id),
  ]);

  await writeFinalityLog(db, {
    txid: null,
    event_type: "DnsKicked",
    state_from: "OPEN",
    state_to: "KICKED",
    payload_json: JSON.stringify({
      cycle_id: cycle.cycle_id,
      business_date: businessDate,
      net_positions: netPositions,
      // Cycle-level record of the ownership handoff (単一所有者則): how many
      // in-flight rows this snapshot took custody of.
      owned_tx_count: ownedTxCount,
    }),
    txid_or_gtid: cycle.cycle_id,
  });

  return { cycle_id: cycle.cycle_id, state: "KICKED", net_positions: netPositions };
}

/**
 * Resume a held DNS cycle once a net-debtor shortfall has been covered.
 *
 * Implements the recovery edge of the DNS_HOLD protocol (docs/specs/10_requirements.md
 * §2.5.2): self-help / LPB / mutual contribution / central-bank supply all
 * deliver bridge liquidity into the central-bank pool, which raises the net
 * debtor's BOJ balance. The technical resolution is then "re-check the shortfall
 * and, if cleared, complete the clearing" — the "不足解消? → はい → SETTLED" edge.
 *
 * Re-validates the held cycle's shortfalls; if all are cleared it transitions
 * HOLD_ACTIVE → KICKED (CAS-guarded against double-resume) and runs settleDns to
 * completion. If any shortfall remains, the cycle stays HOLD_ACTIVE.
 */
export async function resumeDns(
  cycleId: string,
  env: Env
): Promise<{ resumed: boolean; shortfalls?: Array<{ bank_id: string; shortfall: number }> }> {
  const db = env.DB;
  const now = nowISO();

  const cycle = await db
    .prepare(`SELECT cycle_id, state, currency, settlement_chain FROM DnsCycles WHERE cycle_id = ?`)
    .bind(cycleId)
    .first<{
      cycle_id: string;
      state: string;
      currency: string;
      settlement_chain: string | null;
    }>();
  if (!cycle || cycle.state !== "HOLD_ACTIVE") return { resumed: false };

  const shortfalls = await computeBojShortfalls(
    db,
    cycleId,
    cycle.currency,
    cycle.settlement_chain
  );
  if (shortfalls.length > 0) {
    // Bridge liquidity has not (yet) cleared the shortfall — remain held.
    return { resumed: false, shortfalls };
  }

  // Shortfall cleared. HOLD_ACTIVE → KICKED (CAS guards against a concurrent
  // double-resume), then settle to completion. settleDns re-runs the pre-check
  // (now empty) and its Phase 2 is idempotent, so this is crash-safe.
  const upd = await db
    .prepare(
      `UPDATE DnsCycles SET state='KICKED', hold_reason=NULL, public_message_id=NULL, updated_at=? WHERE cycle_id=? AND state='HOLD_ACTIVE'`
    )
    .bind(now, cycleId)
    .run();
  if ((upd.meta.changes ?? 0) === 0) return { resumed: false };

  await writeFinalityLog(db, {
    txid: null,
    event_type: "DnsResumed",
    state_from: "HOLD_ACTIVE",
    state_to: "KICKED",
    payload_json: JSON.stringify({ cycle_id: cycleId, reason: "SHORTFALL_CLEARED" }),
    txid_or_gtid: cycleId,
  });

  await settleDns(cycleId, env);
  return { resumed: true };
}

// ---------------------------------------------------------------------------
// Get or create the current-day DNS cycle (shared helper: used by each lane to set dns_cycle_id)
// ---------------------------------------------------------------------------
export async function getOrCreateDnsCycle(
  db: D1Database,
  now: string,
  currency: string = "JPY"
): Promise<string> {
  const today = businessDateJST(now);

  if (currency === "JPY") {
    // Return only OPEN cycles (KICKED has already been netted, so no new TX can be assigned)
    const existing = await db
      .prepare(`SELECT cycle_id FROM DnsCycles WHERE business_date = ? AND state = 'OPEN'`)
      .bind(today)
      .first<{ cycle_id: string }>();
    if (existing) return existing.cycle_id;

    // Attempt INSERT with the standard cycle ID
    const cycleId = `DNS-${today}`;
    const identity = legacyDnsCycleIdentity(today);
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO DnsCycles (cycle_id, business_date, state, igs_mode, currency, intraday_seq, created_at)
       VALUES (?, ?, 'OPEN', 'NORMAL', ?, ?, ?)`
      )
      .bind(cycleId, today, identity.currency, identity.intradaySeq, now)
      .run();

    if ((result.meta.changes ?? 0) > 0) return cycleId;

    // INSERT IGNORE failure = the current-day cycle is already SETTLED
    // → create a new OPEN cycle with a suffix for late-arriving TX
    const lateId = `DNS-${today}-${now.slice(11, 19).replace(/:/g, "")}`;
    const priorCount = await db
      .prepare(`SELECT COUNT(*) AS n FROM DnsCycles WHERE business_date = ?`)
      .bind(today)
      .first<{ n: number }>();
    await db
      .prepare(
        `INSERT OR IGNORE INTO DnsCycles (cycle_id, business_date, state, igs_mode, currency, intraday_seq, created_at)
       VALUES (?, ?, 'OPEN', 'NORMAL', ?, ?, ?)`
      )
      .bind(lateId, today, identity.currency, (priorCount?.n ?? 0) + 1, now)
      .run();
    return lateId;
  }

  // Non-JPY: DNS netting is multiplexed along the currency axis
  // (Theme D: per-currency netting). Cycle IDs follow the
  // `DNS-{CCY}-YYYYMMDD-NN` format from dns_cycle_id.ts. EOD settlement
  // (kickDns) of non-JPY cycles is an open item — these cycles remain OPEN
  // until a future theme wires up multi-currency netting/settlement.
  const existingCcy = await db
    .prepare(
      `SELECT cycle_id FROM DnsCycles WHERE business_date = ? AND currency = ? AND state = 'OPEN'`
    )
    .bind(today, currency)
    .first<{ cycle_id: string }>();
  if (existingCcy) return existingCcy.cycle_id;

  const priorCount = await db
    .prepare(`SELECT COUNT(*) AS n FROM DnsCycles WHERE business_date = ? AND currency = ?`)
    .bind(today, currency)
    .first<{ n: number }>();
  const intradaySeq = (priorCount?.n ?? 0) + 1;
  const cycleId = formatDnsCycleId({ currency, businessDate: today, intradaySeq });
  // Non-JPY cycles settle on a tokenized central-bank deposit (CBT); pin the
  // chain at creation so the whole cycle settles on one rail. JPY cycles leave
  // settlement_chain NULL and use the classic BOJ-Net account.
  await db
    .prepare(
      `INSERT OR IGNORE INTO DnsCycles (cycle_id, business_date, state, igs_mode, currency, intraday_seq, settlement_chain, created_at)
     VALUES (?, ?, 'OPEN', 'NORMAL', ?, ?, ?, ?)`
    )
    .bind(cycleId, today, currency, intradaySeq, DEFAULT_SETTLEMENT_CHAIN, now)
    .run();
  return cycleId;
}

// ---------------------------------------------------------------------------
// Intraday DNS cutoff (24/365: 日次1回 → 複数回 → ローリング).
// ---------------------------------------------------------------------------
/**
 * Run one intraday DNS cutoff for a currency: kick + settle the currently OPEN
 * cycle, then open the next intraday cycle (`DNS-{CCY}-YYYYMMDD-NN`, NN+1) so new
 * transactions accumulate into a fresh window. This generalizes the once-daily
 * EOD close into the multiple-per-day / rolling model the canonical cycle-id
 * format was introduced for (30_internal_design.md § 7 "24/365稼働").
 *
 * Exactly one OPEN cycle exists per (date, currency) at a time, so the next
 * cutoff settles the just-opened window, and so on. If settlement holds (a BOJ
 * shortfall), the held cycle is left to resumeDns and the next window still
 * opens, keeping acceptance continuous (the held funds are contained, not the
 * rail). Idempotent on the open step (INSERT OR IGNORE on the canonical id).
 *
 * Returns the settled and newly-opened cycle ids, or `{ cutoff:false }` when
 * there was no OPEN cycle to close.
 */
export async function runIntradayDnsCutoff(
  businessDate: string,
  env: Env,
  currency: string = DEFAULT_DNS_CURRENCY
): Promise<{
  cutoff: boolean;
  settled_cycle?: string;
  settled_state?: string;
  opened_cycle?: string;
  intraday_seq?: number;
}> {
  const db = env.DB;
  const now = nowISO();

  const open = await db
    .prepare(
      `SELECT cycle_id, intraday_seq FROM DnsCycles
       WHERE business_date = ? AND currency = ? AND state = 'OPEN'
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(businessDate, currency)
    .first<{ cycle_id: string; intraday_seq: number }>();
  if (!open) return { cutoff: false };

  // Close the current window: kick (snapshot net positions) then settle.
  await kickDns(businessDate, env, currency);
  await settleDns(open.cycle_id, env);
  const after = await db
    .prepare(`SELECT state FROM DnsCycles WHERE cycle_id = ?`)
    .bind(open.cycle_id)
    .first<{ state: string }>();

  // Open the next intraday window with the canonical NN+1 id.
  const nextSeq = open.intraday_seq + 1;
  const nextId = formatDnsCycleId({ currency, businessDate, intradaySeq: nextSeq });
  await db
    .prepare(
      `INSERT OR IGNORE INTO DnsCycles (cycle_id, business_date, state, igs_mode, currency, intraday_seq, created_at)
       VALUES (?, ?, 'OPEN', 'NORMAL', ?, ?, ?)`
    )
    .bind(nextId, businessDate, currency, nextSeq, now)
    .run();

  await writeFinalityLog(db, {
    txid: null,
    event_type: "DnsIntradayCutoff",
    state_from: open.cycle_id,
    state_to: nextId,
    payload_json: JSON.stringify({
      business_date: businessDate,
      currency,
      settled_cycle: open.cycle_id,
      settled_state: after?.state ?? "UNKNOWN",
      opened_cycle: nextId,
      intraday_seq: nextSeq,
    }),
    txid_or_gtid: nextId,
  });

  return {
    cutoff: true,
    settled_cycle: open.cycle_id,
    settled_state: after?.state ?? "UNKNOWN",
    opened_cycle: nextId,
    intraday_seq: nextSeq,
  };
}

// ---------------------------------------------------------------------------
// DNS HOLD: OPEN → HOLD_ACTIVE
// ---------------------------------------------------------------------------
export async function holdDns(businessDate: string, reason: string, env: Env): Promise<void> {
  const db = env.DB;

  // Resolve the cycle *before* touching it: the request has to be recorded
  // against a cycle id, and finding no OPEN cycle means there is nothing to
  // hold — in which case neither event is written. Emitting an activation for a
  // CAS that matched no rows would put a hold in the audit trail that never
  // happened.
  const target = await db
    .prepare(
      `SELECT cycle_id FROM DnsCycles WHERE business_date=? AND state='OPEN' ORDER BY created_at DESC LIMIT 1`
    )
    .bind(businessDate)
    .first<{ cycle_id: string }>();
  if (!target) return;
  const cycleId = target.cycle_id;

  // The Runbook's evidence is a single line of three events —
  // DnsHoldRequested → DnsHoldActivated → DnsResumed
  // (docs/specs/20_method_design.md §10.9.3.1). The first was missing, so an audit
  // could see that a hold became active but not when it was called for; the two
  // differ by however long detection and declaration take, which is exactly the
  // interval a crisis post-mortem asks about.
  await writeFinalityLog(db, {
    txid: null,
    event_type: "DnsHoldRequested",
    state_from: "OPEN",
    state_to: "HOLD_REQUESTED",
    payload_json: JSON.stringify({ cycle_id: cycleId, reason }),
    txid_or_gtid: cycleId,
  });

  // The official-disclosure template id is minted with the hold itself, never
  // afterwards: a participant asked to explain a delay must be able to key its
  // customer wording to an id that already exists (docs/specs/10_requirements.md §3.3.1-4).
  await db
    .prepare(
      `UPDATE DnsCycles SET state='HOLD_ACTIVE', igs_mode='STOP', hold_reason=?, public_message_id=? WHERE cycle_id=? AND state='OPEN'`
    )
    .bind(reason, dnsHoldMessageId(businessDate), cycleId)
    .run();

  await writeFinalityLog(db, {
    txid: null,
    event_type: "DnsHoldActivated",
    state_from: "HOLD_REQUESTED",
    state_to: "HOLD_ACTIVE",
    payload_json: JSON.stringify({ cycle_id: cycleId, reason }),
    txid_or_gtid: cycleId,
  });
}
