/**
 * @file DNS settlement — settleDns: the net-position settlement run that posts
 *       the central-bank journals and releases suspense/H for a cycle.
 * @module zc/settlement/dns/settle
 */
import type { Env, DnsCycleRow } from "../../../types";
import { nowISO, suspenseAccountId, nostroAccountId } from "../../../types";
import { settlementAccountId } from "../../../shared/central_bank";
import { writeFinalityLog } from "../../orchestrator";
import { cycleOwner } from "../../lanes/_helpers";
import { settleSuspenseForDns } from "../../../bank/suspense";
import { insertJournalGroup } from "../../../bank/ledger";
import { releaseH } from "../../liquidity/h_model";
import { computeBojShortfalls } from "./reserve";
import { dnsHoldMessageId } from "./disclosure";

// ---------------------------------------------------------------------------
// DNS settlement complete: KICKED → SETTLED
// ---------------------------------------------------------------------------
export async function settleDns(cycleId: string, env: Env): Promise<void> {
  const db = env.DB;
  const now = nowISO();

  const cycle = await db
    .prepare(`SELECT * FROM DnsCycles WHERE cycle_id = ?`)
    .bind(cycleId)
    .first<DnsCycleRow>();
  if (!cycle || cycle.state !== "KICKED") return;

  // ---------------------------------------------------------------------------
  // Pre-check BOJ balance sufficiency: validate BOJ balance of net payer banks (prefunded RTGS requirement)
  // Report "Issue 7: Approach to fund settlement and clearing" — under the prefunded RTGS scheme,
  // before settlement, verify that each participant bank's prefunded balance covers its payment excess
  // ---------------------------------------------------------------------------
  const bojShortfalls = await computeBojShortfalls(
    db,
    cycleId,
    cycle.currency,
    cycle.settlement_chain
  );

  if (bojShortfalls.length > 0) {
    // BOJ balance insufficient: hold the cycle and ring-fence the cause
    // (docs/specs/20_method_design.md §2.4 類型B). The cause set is identified here
    // (the short banks), so igs_mode
    // escalates NORMAL → RINGFENCED (cause_identified=true) rather than STOP —
    // HIGH_VALUE may continue among non-causing participants while the defaulters
    // are isolated (see checkIgsAdmission). The set is cleared on settle.
    const causingParticipants = bojShortfalls.map((s) => s.bank_id);
    await db
      .prepare(
        `UPDATE DnsCycles SET state='HOLD_ACTIVE', igs_mode='RINGFENCED', hold_reason=?, hold_causing_participants=?, public_message_id=?, updated_at=? WHERE cycle_id=?`
      )
      .bind(
        JSON.stringify({ reason: "BOJ_INSUFFICIENT_FUNDS", shortfalls: bojShortfalls }),
        JSON.stringify(causingParticipants),
        dnsHoldMessageId(cycle.business_date),
        now,
        cycleId
      )
      .run();
    await writeFinalityLog(db, {
      txid: null,
      // Canonical hold event name (FinalityEventType / DnsCycles kick-time hold in
      // cycle.ts both use DnsHoldActivated). Emitting the off-union "DnsHeld" here
      // meant explain/story could not map this settlement-time hold to a reason.
      event_type: "DnsHoldActivated",
      state_from: "KICKED",
      state_to: "HOLD_ACTIVE",
      payload_json: JSON.stringify({
        cycle_id: cycleId,
        reason: "BOJ_INSUFFICIENT_FUNDS",
        shortfalls: bojShortfalls,
        igs_mode: "RINGFENCED",
        hold_causing_participants: causingParticipants,
      }),
      txid_or_gtid: cycleId,
    });
    console.error(`[dns] settleDns aborted: BOJ shortfall detected`, bojShortfalls);
    return;
  }

  // Settle each bank's segregated deposit (suspense)
  const participants = await db
    .prepare(`SELECT DISTINCT bank_id FROM DnsNetPositions WHERE cycle_id = ?`)
    .bind(cycleId)
    .all<{ bank_id: string }>();

  for (const { bank_id } of participants.results) {
    await settleSuspenseForDns(bank_id, cycleId, db);
  }

  // DNS settlement journal entry: transfer the payer-side segregated deposit (PAY) to the ZC settlement account by gross_send
  //
  //   Payer bank (gross_send > 0):
  //     Suspense(−gross_send) / ZCS(+gross_send) = 0 ✓
  //     → segregated deposit is cleared, and the payment obligation to ZC is recorded
  //
  //   Payee bank (gross_send = 0):
  //     no journal entry needed — at Hard Landing + execute-credit,
  //     ZCS(−) / Suspense(+) → Suspense(−) / Customer(+) is already completed
  //
  //   Two-sided bank (gross_send > 0 and gross_receive > 0):
  //     for the send portion only, Suspense(−gross_send) / ZCS(+gross_send)
  //     since the receive portion is already Hard Landed, the ZCS balance converges to net
  const netPositions = await db
    .prepare(
      `SELECT bank_id, net_position, gross_send FROM DnsNetPositions WHERE cycle_id = ? AND is_settled = 0`
    )
    .bind(cycleId)
    .all<{ bank_id: string; net_position: number; gross_send: number }>();

  for (const row of netPositions.results) {
    const suspAcctId = suspenseAccountId(row.bank_id);
    const zcsAcctId = nostroAccountId(row.bank_id); // {bankId}-ZCS

    if (row.gross_send > 0) {
      // Idempotency guard (crash-safe retry): the journal post and the
      // `is_settled=1` flip below are SEPARATE statements, so a crash between
      // them re-enters settleDns with is_settled still 0 and re-posts this
      // group — moving the suspense/ZCS position twice. `insertJournalGroup`
      // mints a fresh journal_id per call and does NOT enforce tx_group_id
      // uniqueness, so the materialized `is_settled` flag alone cannot make the
      // re-post a no-op. Skip if the group is already posted — mirrors the
      // Phase-2 BOJ group guard below.
      const sendGroupId = `DNS-SETTLE-${cycleId}-${row.bank_id}`;
      const sendAlreadyPosted = await db
        .prepare(`SELECT 1 FROM BankJournals WHERE tx_group_id = ? LIMIT 1`)
        .bind(sendGroupId)
        .first();
      if (!sendAlreadyPosted)
        await insertJournalGroup(db, {
          bankId: row.bank_id,
          txGroupId: sendGroupId,
          currency: cycle.currency,
          entries: [
            {
              accountId: suspAcctId,
              amount: -row.gross_send,
              txType: "TRANSFER",
              description: `DNS settle ${cycleId} 別段(PAY)解消`,
            },
            {
              accountId: zcsAcctId,
              amount: row.gross_send,
              txType: "TRANSFER",
              description: `DNS settle ${cycleId} ZCS支払義務計上`,
            },
          ],
          valueDate: cycle.business_date,
        });
    }
    await db
      .prepare(`UPDATE DnsNetPositions SET is_settled=1 WHERE cycle_id=? AND bank_id=?`)
      .bind(cycleId, row.bank_id)
      .run();
  }

  // ---------------------------------------------------------------------------
  // Phase 2: BOJ Settlement
  //   ZCS balance = gross_send − gross_receive = −net_position
  //   Journal entry: ZCS(−zcsBalance) / BOJ_CURRENT(+zcsBalance) ← zero-sum ✓
  //   - Payer-excess bank (zcsBalance>0): ZCS(−X) / BOJ(+X) [ZCS obligation cleared, BOJ current decreased]
  //   - Payee-excess bank (zcsBalance<0): ZCS(+Y) / BOJ(−Y) [ZCS claim cleared, BOJ current increased]
  //   Total BOJ across all banks = Σ(gross_send − gross_receive) = 0 ✓
  // ---------------------------------------------------------------------------
  const allPositions = await db
    .prepare(
      `SELECT bank_id, net_position, gross_send, gross_receive FROM DnsNetPositions WHERE cycle_id = ?`
    )
    .bind(cycleId)
    .all<{ bank_id: string; net_position: number; gross_send: number; gross_receive: number }>();

  // A. ZCS zero-clear journal entry (each bank)
  for (const row of allPositions.results) {
    const zcsBalance = row.gross_send - row.gross_receive; // = −net_position
    if (zcsBalance === 0) continue;
    const bojGroupId = `DNS-BOJ-${cycleId}-${row.bank_id}`;
    // Idempotency guard (crash-safe retry): settleDns is not atomic — if the
    // process dies after Phase 2 but before the final state='SETTLED' write,
    // the cycle is still KICKED and settleDns re-runs. Phase 1 is guarded by
    // is_settled, but `insertJournalGroup` mints a fresh journal_id per call,
    // so re-posting this BOJ group would move the bank's central-bank position
    // a second time (systemic corruption). Skip if it is already posted.
    const alreadyPosted = await db
      .prepare(`SELECT 1 FROM BankJournals WHERE tx_group_id = ? LIMIT 1`)
      .bind(bojGroupId)
      .first();
    if (alreadyPosted) continue;
    await insertJournalGroup(db, {
      bankId: row.bank_id,
      txGroupId: bojGroupId,
      currency: cycle.currency,
      entries: [
        {
          accountId: nostroAccountId(row.bank_id),
          amount: -zcsBalance,
          txType: "TRANSFER",
          description: `DNS BOJ清算 ZCS解消 ${cycleId}`,
        },
        {
          accountId: settlementAccountId(row.bank_id, cycle.currency, cycle.settlement_chain),
          amount: zcsBalance,
          txType: "TRANSFER",
          description: `DNS 中銀清算 ${cycle.currency} ${cycleId}`,
        },
      ],
      valueDate: cycle.business_date,
    });
  }

  // B. BOJ Settlement GTID (generated directly at GT_SETTLED without going through the state machine)
  //    net payer bank → PAYER leg, net receiver bank → PAYEE leg
  const payerBanks = allPositions.results.filter((r) => r.net_position < 0);
  const payeeBanks = allPositions.results.filter((r) => r.net_position > 0);
  const totalPayerAmt = payerBanks.reduce((s, r) => s + -r.net_position, 0);
  const legCount = payerBanks.length + payeeBanks.length;

  if (legCount > 0 && totalPayerAmt > 0) {
    const gtidId = `GTID-DNS-${cycleId}`;
    await db
      .prepare(
        `INSERT OR IGNORE INTO GtidTransactions
       (gtid, state, initiator_bank_id, total_amount, leg_count,
        legs_ready_count, legs_settled_count, version, created_at, updated_at)
       VALUES (?, 'GT_SETTLED', 'ZC', ?, ?, ?, ?, 0, ?, ?)`
      )
      .bind(gtidId, totalPayerAmt, legCount, legCount, legCount, now, now)
      .run();

    for (const row of payerBanks) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO GtidLegs
         (leg_id, gtid, role, bank_id, account_hash, amount_value, state, version, created_at, updated_at)
         VALUES (?, ?, 'PAYER', ?, ?, ?, 'LEG_SETTLED', 0, ?, ?)`
        )
        .bind(
          `LEG-DNS-${cycleId}-${row.bank_id}-PAY`,
          gtidId,
          row.bank_id,
          settlementAccountId(row.bank_id, cycle.currency, cycle.settlement_chain),
          -row.net_position,
          now,
          now
        )
        .run();
    }
    for (const row of payeeBanks) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO GtidLegs
         (leg_id, gtid, role, bank_id, account_hash, amount_value, state, version, created_at, updated_at)
         VALUES (?, ?, 'PAYEE', ?, ?, ?, 'LEG_SETTLED', 0, ?, ?)`
        )
        .bind(
          `LEG-DNS-${cycleId}-${row.bank_id}-RCV`,
          gtidId,
          row.bank_id,
          settlementAccountId(row.bank_id, cycle.currency, cycle.settlement_chain),
          row.net_position,
          now,
          now
        )
        .run();
    }

    await writeFinalityLog(db, {
      txid: null,
      event_type: "DnsGtidSettled",
      state_from: "GT_DECIDED_TO_SETTLE",
      state_to: "GT_SETTLED",
      payload_json: JSON.stringify({
        gtid: gtidId,
        cycle_id: cycleId,
        payer_count: payerBanks.length,
        payee_count: payeeBanks.length,
        total_amount: totalPayerAmt,
      }),
      txid_or_gtid: gtidId,
    });
  }
  // ---------------------------------------------------------------------------

  // Update cycle to SETTLED. Lift any ring-fence: a settled cycle has no
  // shortfall left to contain, so igs_mode returns to NORMAL and the cause set
  // is cleared (a no-op for a cycle that was never held).
  //
  // 単一所有者則 (§5.2 handoff #2): ownership returns to ZC in the same batch
  // as the cycle's finalizing state flip — the bulk UPDATE mirror of the
  // kickDns snapshot stamp. settleDns settles the cycle's *net position*, not
  // individual rows, so there are no per-tx settling transitions to carry
  // `issuer='CYCLE:<id>'`; the per-tx money path that follows (the BULK debit
  // enqueue below, late credits/retries) runs as ZC on ZC-owned rows again.
  // The handoff is recorded once at cycle level in the 'DnsSettled' event
  // below, matching the kick-side choice (no N per-tx log round-trips).
  await db.batch([
    db
      .prepare(
        `UPDATE DnsCycles SET state='SETTLED', igs_mode='NORMAL', hold_causing_participants=NULL, public_message_id=NULL, settled_at=? WHERE cycle_id=?`
      )
      .bind(now, cycleId),
    db
      .prepare(`UPDATE Transactions SET owner = 'ZC' WHERE dns_cycle_id = ? AND owner = ?`)
      .bind(cycleId, cycleOwner(cycleId)),
  ]);

  // Release H-reserve at DNS_CYCLE_SETTLED (spec: release after DNS settlement completes)
  const hReservations = await db
    .prepare(
      `SELECT h.reservation_id FROM HReservations h
       JOIN Transactions t ON t.txid = h.txid
       WHERE t.dns_cycle_id = ? AND h.is_released = 0`
    )
    .bind(cycleId)
    .all<{ reservation_id: string }>();
  for (const { reservation_id } of hReservations.results) {
    await releaseH(reservation_id, db);
  }

  await writeFinalityLog(db, {
    txid: null,
    event_type: "DnsSettled",
    state_from: "KICKED",
    state_to: "SETTLED",
    // ownership_returned: cycle-level record that custody of the snapshotted
    // rows went back to ZC in the SETTLED batch (単一所有者則).
    payload_json: JSON.stringify({ cycle_id: cycleId, ownership_returned: true }),
    txid_or_gtid: cycleId,
  });

  // BULK Execution: triggered by DNS settlement completion, enqueue BULK TX in DECIDED_TO_SETTLE
  // (placed here so it runs reliably whether invoked via EOD or directly)
  const bulkSettleReady = await db
    .prepare(
      `SELECT txid, payer_bank_id, payee_bank_id, amount_value, amount_currency, decision_proof_ref
       FROM Transactions
       WHERE dns_cycle_id = ? AND lane = 'BULK' AND state = 'DECIDED_TO_SETTLE'`
    )
    .bind(cycleId)
    .all<{
      txid: string;
      payer_bank_id: string;
      payee_bank_id: string;
      amount_value: number;
      amount_currency: string;
      decision_proof_ref: string | null;
    }>();

  for (const tx of bulkSettleReady.results) {
    await env.QUEUE.send({
      type: "ZC_BANK_DEBIT",
      payload: {
        txid: tx.txid,
        payer_bank_id: tx.payer_bank_id,
        payee_bank_id: tx.payee_bank_id,
        amount: { value: tx.amount_value, currency: tx.amount_currency ?? "JPY" },
        decision_proof_ref: tx.decision_proof_ref ?? "",
        lane: "BULK",
      },
      txid: tx.txid,
      attempt: 0,
      enqueued_at: now,
    });
  }
}
