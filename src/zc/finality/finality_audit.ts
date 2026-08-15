/**
 * @file finality_audit.ts — Scheduled integrity audit over every FinalityLog chain.
 *
 * `verifyChain` (finality_chain.ts) verifies a single chain on demand, when
 * someone asks about a specific txid or gtid via the API. That leaves a gap the
 * system's own design principle warns about: silent tampering with historical
 * audit data is only discovered if a human happens to query the affected chain.
 *
 * This module closes that gap by sweeping *all* chains on a schedule (wired into
 * the EOD batch). A detected break is escalated the same way any other
 * inexplicable state is — a CASE is opened (design principle #4: "states that
 * cannot be explained must converge into a CASE") — and a single system-level
 * FinalityLog event records the verdict so the audit itself is traceable.
 *
 * The audit is read-only with respect to financial state: it never moves money,
 * never advances a transaction, and only ever appends (CASE rows, one GLOBAL
 * FinalityLog entry on breakage). Re-running it is safe and idempotent — an
 * unresolved CASE for the same broken chain is not duplicated.
 */
import type { Env } from "../../types";
import {
  verifyChain,
  GLOBAL_CHAIN_ID,
  isNonTxChainId,
  type ChainVerification,
} from "../finality/finality_chain";
import { writeFinalityLog } from "../orchestrator";
import { openOrAggregateCase } from "../cases/case";

/** Reason code stamped on CASEs opened for a broken FinalityLog chain. */
export const FINALITY_CHAIN_BROKEN = "FINALITY_CHAIN_BROKEN";

export interface FinalityAuditResult {
  chains_checked: number;
  entries_checked: number;
  broken_chains: ChainVerification[];
  /** CASEs newly opened by this run (excludes chains that already had an unresolved CASE). */
  cases_opened: number;
}

/**
 * Enumerate every distinct hash-chain id present in FinalityLog.
 *
 * Chains are keyed by `txid` when present, otherwise `gtid`; entries with
 * neither belong to the GLOBAL sentinel chain. txid values (`TX-*`) and gtid
 * values (`GT-*` / `GTID-*` / `DNS-*` / `LSM-*`) are disjoint namespaces, so the UNION
 * cannot collapse two different chains into one id.
 */
export async function listChainIds(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT txid AS id FROM FinalityLog WHERE txid IS NOT NULL
       UNION
       SELECT DISTINCT gtid AS id FROM FinalityLog WHERE gtid IS NOT NULL`
    )
    .all<{ id: string }>();
  const ids = rows.results.map((r) => r.id);

  // GLOBAL chain: system events with neither txid nor gtid.
  const hasGlobal = await db
    .prepare(`SELECT 1 AS x FROM FinalityLog WHERE txid IS NULL AND gtid IS NULL LIMIT 1`)
    .first<{ x: number }>();
  if (hasGlobal) ids.push(GLOBAL_CHAIN_ID);

  return ids;
}

/**
 * Whether an unresolved CASE already exists for a broken chain. Keyed on the
 * chain id embedded in the description so the check is uniform across txid /
 * gtid / GLOBAL chains (GLOBAL has null related_txid and related_gtid, which
 * cannot be matched by equality). Prevents the nightly sweep from opening a
 * fresh CASE on every run while the same break persists.
 *
 * "Unresolved" is `UNRESOLVED_CASE_STATES`, not `OPEN`: a chain break is the
 * longest-lived alarm the system raises, so it is guaranteed to outlive
 * `PR-CASE-SLA` and be promoted to `ESCALATED` by the §10.7.4 sweep. Matching
 * only `OPEN` would resume duplicating the CASE — nightly, forever — from the
 * moment a human started looking at it.
 */
/**
 * Verify every FinalityLog chain. On any break, open a CASE (deduplicated) and
 * record a single GLOBAL-chain `FinalityChainAuditFailed` event summarizing the
 * run. Returns a structured result for the caller (cron log / HTTP response).
 */
export async function runFinalityChainAudit(env: Env): Promise<FinalityAuditResult> {
  const db = env.DB;
  const chainIds = await listChainIds(db);
  const broken: ChainVerification[] = [];
  let entriesChecked = 0;
  let casesOpened = 0;

  for (const chainId of chainIds) {
    const result = await verifyChain(db, chainId);
    entriesChecked += result.entries_checked;
    if (result.valid) continue;

    broken.push(result);

    // Escalate to a CASE, routed to the right entity column. Aggregation keys
    // on the chain id (§10.7.2), so a nightly audit that keeps finding the same
    // broken chain relates the finding to the existing CASE instead of piling
    // up a new one. This used to be a `description LIKE '%chain X %'` probe —
    // a dedup that depended on the wording of a human-readable sentence.
    //
    // Which column the chain id belongs in is decided by `isNonTxChainId`,
    // the single source of truth for that split (finality_chain.ts). A local
    // copy of the prefix list is how `LSM-` (a Bulk LSM optimiser run, which
    // *is* stored in the gtid column) came to be filed as a `related_txid`
    // pointing at a transaction that does not exist.
    const gtidChain = chainId !== GLOBAL_CHAIN_ID && isNonTxChainId(chainId);
    const filed = await openOrAggregateCase(db, {
      related_txid: gtidChain || chainId === GLOBAL_CHAIN_ID ? undefined : chainId,
      related_gtid: gtidChain ? chainId : undefined,
      reason_code: FINALITY_CHAIN_BROKEN,
      opened_by: "ZC",
      cause_party_id: chainId,
      description: `FinalityLog chain ${chainId} failed verification: ${result.break_reason} at event_seq=${result.break_at_seq}`,
    });
    if (!filed.aggregated) {
      casesOpened++;
    }
  }

  // Record the verdict on the GLOBAL chain — but only on breakage, so a clean
  // nightly audit does not append a row per run. The audit's own trace lives in
  // the same append-only log it guards.
  if (broken.length > 0) {
    await writeFinalityLog(db, {
      txid: null,
      event_type: "FinalityChainAuditFailed",
      state_from: null,
      state_to: "AUDIT_FAILED",
      payload_json: JSON.stringify({
        chains_checked: chainIds.length,
        entries_checked: entriesChecked,
        broken: broken.map((b) => ({
          chain_id: b.chain_id,
          break_reason: b.break_reason,
          break_at_seq: b.break_at_seq,
        })),
      }),
      txid_or_gtid: null,
    });
  }

  return {
    chains_checked: chainIds.length,
    entries_checked: entriesChecked,
    broken_chains: broken,
    cases_opened: casesOpened,
  };
}
