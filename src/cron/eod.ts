/**
 * @file End-of-day (EOD) batch settlement. Executes 8 steps: DNS kick, DNS
 * settle, interest accrual, daily balance snapshots, suspense cleanup, daily
 * limit reset, and audit logging.
 * @module cron/eod
 */
// 3. Bank side: interest calculation, daily snapshot
// 4. Zero-sum validation
import type { Env } from "../types";
import { todayJST } from "../types";
import { kickDns, settleDns } from "../zc/settlement/dns";
import { cancelHtlc } from "../zc/lanes/htlc";
import { runBulkLsm } from "../zc/liquidity/bulk_lsm";
import { snapshotDailyBalance, applyDailyInterest, verifyZeroSum } from "../bank/ledger";
import { retryPendingNotifications } from "../zc/events/credit_notify";
import { retryFailedIgs } from "../zc/settlement/igs";
import { pruneDeliveredEvents } from "../zc/events/stream";
import { runFinalityChainAudit } from "../zc/finality/finality_audit";
import { createFinalityAnchor } from "../zc/finality/finality_anchor";

export async function runEod(env: Env): Promise<{ ok: boolean; log: string[] }> {
  const log: string[] = [];
  const db = env.DB;
  const today = todayJST();

  try {
    // 1. BULK preprocessing via the LSM optimiser: select an execution set under
    // the H constraints by the lexicographic objective (due_at → fairness →
    // throughput), commit the selected (RECEIVED → DECIDED_TO_SETTLE), and defer
    // the rest to the next window. Running before kickDns ensures the committed
    // tx are assigned the day's OPEN cycle. The run is recorded (LsmRuns +
    // FinalityLog) so the adoption is auditable; a thrown optimiser error
    // degrades to a FIFO fallback rather than stopping EOD (§14.3).
    const lsm = await runBulkLsm(env, { businessDate: today, windowId: `EOD-${today}` });
    log.push(
      `BULK LSM[${lsm.mode}${lsm.is_fallback ? " FALLBACK" : ""}]: ` +
        `${lsm.committed.length} committed, ${lsm.deferred.length} deferred ` +
        `(run=${lsm.run_id})`
    );

    // 2-3. DNS Kick + settle, per currency (Theme D: per-currency netting).
    // JPY is always processed (kickDns creates the day's cycle if absent). Other
    // currencies are settled only if they already have an OPEN cycle today —
    // otherwise non-JPY cycles would stay OPEN forever, stranding their tx and
    // H-reservations. Each currency nets and settles into its own central-bank /
    // nostro account ({bank}-BOJ-{CCY}), so a non-JPY close never disturbs the
    // JPY prefund/shortfall accounting. settleDns enqueues ZC_BANK_DEBIT for that
    // cycle's BULK DECIDED_TO_SETTLE tx.
    // Discover the day's currencies to net/settle. Include KICKED cycles, not
    // just OPEN ones: EOD is not transactional, so a crash *between* a currency's
    // kick and its settle (or mid-settle, before the state='SETTLED' write)
    // strands that cycle in KICKED. JPY is force-added below and so is always
    // re-driven, but a non-JPY cycle stranded in KICKED would be invisible to an
    // OPEN-only re-run and never settle (BOJ half-posted, BULK never executed,
    // H-reservations never released). kickDns returns 'KICKED' for an already-
    // kicked cycle and settleDns is re-run safe (probe #6 idempotency guard), so
    // re-driving it here completes the unfinished settle exactly once.
    const pendingCurrencies = await db
      .prepare(
        `SELECT DISTINCT currency FROM DnsCycles WHERE business_date = ? AND state IN ('OPEN','KICKED')`
      )
      .bind(today)
      .all<{ currency: string }>();
    const currencies = new Set<string>([
      "JPY",
      ...pendingCurrencies.results.map((r) => r.currency),
    ]);
    for (const ccy of currencies) {
      const kickResult = await kickDns(today, env, ccy);
      log.push(`DNS Kick[${ccy}]: cycle=${kickResult.cycle_id} state=${kickResult.state}`);
      if (kickResult.state === "KICKED") {
        await settleDns(kickResult.cycle_id, env);
        log.push(`DNS Settled[${ccy}]: ${kickResult.cycle_id}`);
      }
    }

    // 4. HTLC expiry check
    const expiredHtlcs = await db
      .prepare(
        `SELECT htlc_id, txid FROM HtlcContracts WHERE state IN ('HTLC_RECEIVED','HTLC_LOCKED') AND timelock < ?`
      )
      .bind(new Date().toISOString())
      .all<{ htlc_id: string; txid: string }>();

    for (const htlc of expiredHtlcs.results) {
      // Pass env to also send the bank-side suspense release notification (reserve-funds has already run when HTLC_LOCKED)
      await cancelHtlc(htlc.htlc_id, htlc.txid, "TIMELOCK_EXPIRED", db, env);
      log.push(`HTLC expired: ${htlc.htlc_id}`);
    }

    // 5. Interest calculation + balance snapshot
    const accounts = await db
      .prepare(`SELECT DISTINCT bank_id, account_id FROM BankAccounts WHERE status='NORMAL'`)
      .all<{ bank_id: string; account_id: string }>();

    // V8 perf: single-pass dedup. The previous `[...new Set(rows.map(...))]`
    // allocates an intermediate Array (from map), a Set, and a final Array
    // (from spread). Walking once and inserting into the Set directly avoids
    // both intermediates while preserving uniqueness semantics.
    const bankIdSet = new Set<string>();
    const accountRows = accounts.results;
    for (let i = 0; i < accountRows.length; i++) {
      bankIdSet.add(accountRows[i]!.bank_id);
    }
    for (const bankId of bankIdSet) {
      await applyDailyInterest(bankId, today, db);
    }

    for (let i = 0; i < accountRows.length; i++) {
      await snapshotDailyBalance(accountRows[i]!.account_id, today, db);
    }
    log.push(`Snapshots saved for ${accountRows.length} accounts`);

    // 6. Zero-sum validation
    for (const bankId of bankIdSet) {
      const ok = await verifyZeroSum(bankId, db);
      log.push(`ZeroSum ${bankId}: ${ok ? "OK" : "VIOLATED!"}`);
      if (!ok) {
        console.error(`[EOD] Zero-sum violation for ${bankId}`);
      }
    }

    // 7. Reset participating banks' daily cumulative transfer totals (for tx_amount_limit/daily_amount_limit)
    try {
      const today = todayJST();
      await db
        .prepare(`UPDATE Participants SET daily_amount_used = 0, daily_amount_last_reset_date = ?`)
        .bind(today)
        .run();
      log.push("daily_amount_used reset for all participants");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("no such column")) {
        log.push("daily_amount_used missing, skipped participant reset");
      } else {
        throw e;
      }
    }

    // 8. Notification retry / IGS retry / SSE event pruning
    await retryPendingNotifications(db, env);
    await retryFailedIgs(db, env);
    await pruneDeliveredEvents(db);
    log.push("Notification retry, IGS retry, event prune: done");

    // 9. FinalityLog hash chain daily audit
    // Scan the entire chain, and if tampering (prev_hash break / entry_hash mismatch) is detected,
    // converge to CASE. The integrity of FinalityLog, the single source of truth for explainability,
    // is verified daily, without waiting for someone to look up an individual txid.
    const audit = await runFinalityChainAudit(env);
    log.push(
      `Finality audit: ${audit.chains_checked} chains / ${audit.entries_checked} entries, ` +
        `${audit.broken_chains.length} broken, ${audit.cases_opened} cases opened`
    );
    if (audit.broken_chains.length > 0) {
      console.error("[EOD] FinalityLog chain audit detected breakage:", audit.broken_chains);
    }

    // 10. Transparency anchor: snapshot every FinalityLog chain's tip at the
    // day's event_seq high-water mark into an append-only FinalityAnchor row.
    // This is the fixed reference point participants verify chain inclusion
    // against (Certificate-Transparency style); taken right after the audit
    // confirms the chains are intact. No-op when FinalityLog is still empty.
    const anchor = await createFinalityAnchor(db);
    log.push(
      anchor
        ? `Finality anchor: ${anchor.anchor_id} (seq=${anchor.anchor_seq}, watermark=${anchor.high_watermark_seq})`
        : "Finality anchor: skipped (no FinalityLog entries)"
    );

    return { ok: true, log };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.push(`ERROR: ${msg}`);
    console.error("[EOD] Error:", err);
    return { ok: false, log };
  }
}
