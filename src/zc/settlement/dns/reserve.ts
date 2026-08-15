/**
 * @file DNS recovery-reserve math — BOJ shortfall computation, recovery-reserve
 *       sizing, and RINGFENCED_PLUS promotion. Leaf module (no other DNS deps).
 * @module zc/settlement/dns/reserve
 */
import type { Env, IgsMode } from "../../../types";
import { nowISO } from "../../../types";
import { settlementAccountId } from "../../../shared/central_bank";
import { writeFinalityLog } from "../../orchestrator";
import { sha256hex } from "../../../shared/hmac";
import { calcBalance } from "../../../bank/ledger";
import {
  DNS_RECOVERY_RESERVE_BUFFER_RATE,
  RESERVE_CONFIDENCE_THRESHOLD,
} from "../../../shared/constants";

/**
 * Compute the net-debtor BOJ shortfalls for a cycle (prefunded RTGS check).
 * A net-debtor bank (net_position < 0) is short if its current BOJ balance
 * cannot absorb the required debit. Shared by settleDns (pre-check) and
 * resumeDns (re-check after bridge liquidity) so the two never drift.
 *
 * Sign convention: BOJ balance is negative (liability accounting), so a bank is
 * insufficient when `bojBalance + requiredDebit > 0`.
 */
export async function computeBojShortfalls(
  db: D1Database,
  cycleId: string,
  currency: string = "JPY",
  chain?: string | null
): Promise<Array<{ bank_id: string; shortfall: number }>> {
  const debitPositions = await db
    .prepare(
      `SELECT bank_id, net_position FROM DnsNetPositions WHERE cycle_id = ? AND net_position < 0`
    )
    .bind(cycleId)
    .all<{ bank_id: string; net_position: number }>();

  const shortfalls: Array<{ bank_id: string; shortfall: number }> = [];
  for (const row of debitPositions.results) {
    // JPY → BOJ current account; non-JPY → the tokenized CB deposit (CBT) on the
    // cycle's chain. Prefund/shortfall is checked per currency either way.
    const settleAcct = settlementAccountId(row.bank_id, currency, chain);
    const cbBalance = await calcBalance(settleAcct, db, currency);
    const requiredDebit = -row.net_position; // positive since net_position < 0
    if (cbBalance + requiredDebit > 0) {
      shortfalls.push({ bank_id: row.bank_id, shortfall: cbBalance + requiredDebit });
    }
  }
  return shortfalls;
}

// ---------------------------------------------------------------------------
// DNS recovery reserve (RINGFENCED_PLUS promotion evidence).
// ---------------------------------------------------------------------------
/**
 * The reserve ZC should keep available to complete a held cycle, computed in
 * real time from the live shortfall, plus the audit evidence that makes the
 * RINGFENCED → RINGFENCED_PLUS promotion reproducible (docs/specs/20_method_design.md §2.4 類型B).
 *
 * The exact figure is left to institutional debate (docs/specs/20_method_design.md §2.4 類型B); the
 * *method* is what is normative here: a deterministic formula whose inputs,
 * formula id, and output are hashed (`explain_hash`) and scored (`confidence`)
 * so anyone can later re-derive "why this reserve".
 */
export interface DnsRecoveryReserve {
  reserve: number;
  explain_hash: string;
  confidence: number;
  inputs: {
    cycle_id: string;
    currency: string;
    formula_id: string;
    buffer_rate: number;
    total_shortfall: number;
    shortfalls: Array<{ bank_id: string; shortfall: number }>;
  };
}

const RESERVE_FORMULA_ID = "dns_recovery_reserve.v1";

/**
 * Compute `dns_recovery_reserve` for a held cycle: the outstanding BOJ shortfall
 * plus a buffer for measurement error. Confidence reflects how completely the
 * priced shortfall is backed by snapshotted net positions (1.0 when every short
 * debtor appears in DnsNetPositions — the norm after settleDns ring-fenced the
 * cycle; 0 when there is nothing to reserve, e.g. the shortfall already cleared).
 */
export async function computeDnsRecoveryReserve(
  db: D1Database,
  cycleId: string,
  currency: string = "JPY",
  chain?: string | null
): Promise<DnsRecoveryReserve> {
  const shortfalls = await computeBojShortfalls(db, cycleId, currency, chain);
  const totalShortfall = shortfalls.reduce((s, r) => s + r.shortfall, 0);
  const reserve = totalShortfall + Math.ceil(totalShortfall * DNS_RECOVERY_RESERVE_BUFFER_RATE);

  // Coverage: of the debtors that are currently short, how many are backed by a
  // snapshotted DnsNetPositions debit row. computeBojShortfalls derives from
  // those rows, so this is 1.0 in normal operation; the metric is here so a
  // future, less-complete data source surfaces as lower confidence rather than
  // silently producing an unreproducible reserve.
  const snapshotDebtors = await db
    .prepare(`SELECT bank_id FROM DnsNetPositions WHERE cycle_id = ? AND net_position < 0`)
    .bind(cycleId)
    .all<{ bank_id: string }>();
  const snapshotSet = new Set((snapshotDebtors.results ?? []).map((r) => r.bank_id));
  const covered = shortfalls.filter((s) => snapshotSet.has(s.bank_id)).length;
  const confidence =
    reserve > 0 && shortfalls.length > 0
      ? Math.round((covered / shortfalls.length) * 10000) / 10000
      : 0;

  const inputs = {
    cycle_id: cycleId,
    currency,
    formula_id: RESERVE_FORMULA_ID,
    buffer_rate: DNS_RECOVERY_RESERVE_BUFFER_RATE,
    total_shortfall: totalShortfall,
    // Stable order (bank_id asc) so the digest is reproducible regardless of
    // the row order computeBojShortfalls returned.
    shortfalls: [...shortfalls].sort((a, b) => (a.bank_id < b.bank_id ? -1 : 1)),
  };
  // Digest of inputs + formula + output: the canonical "explain hash".
  const explain_hash = await sha256hex(JSON.stringify({ inputs, output: { reserve, confidence } }));

  return { reserve, explain_hash, confidence, inputs };
}

/**
 * Promote a held cycle RINGFENCED → RINGFENCED_PLUS once a recovery reserve has
 * been computed with enough confidence (docs/specs/20_method_design.md §2.4 類型B: "リザーブ算定が説明可能な形で
 * 成立"). Mode 2 is *stricter* on a held cycle's defaulters but, paired with the
 * throttle budget, lets non-causing participants keep settling fairly.
 *
 * Idempotent and CAS-guarded (only acts on a HOLD_ACTIVE + RINGFENCED cycle).
 * Records the reserve, explain hash, and confidence so the promotion is
 * auditable. A reserve of 0 (shortfall cleared) or sub-threshold confidence
 * leaves the cycle in RINGFENCED — the caller (resumeDns) handles the cleared
 * case by settling instead.
 *
 * Returns the promotion decision and the computed reserve evidence.
 */
export async function promoteRingfencePlus(
  cycleId: string,
  env: Env
): Promise<{ promoted: boolean; reserve?: DnsRecoveryReserve; reason?: string }> {
  const db = env.DB;
  const now = nowISO();

  const cycle = await db
    .prepare(`SELECT cycle_id, state, igs_mode, currency FROM DnsCycles WHERE cycle_id = ?`)
    .bind(cycleId)
    .first<{ cycle_id: string; state: string; igs_mode: IgsMode; currency: string }>();
  if (!cycle || cycle.state !== "HOLD_ACTIVE" || cycle.igs_mode !== "RINGFENCED") {
    return { promoted: false, reason: "NOT_RINGFENCED" };
  }

  const reserve = await computeDnsRecoveryReserve(db, cycleId, cycle.currency);
  if (reserve.reserve <= 0) {
    // Nothing to reserve — the shortfall has cleared; resumeDns will settle.
    return { promoted: false, reserve, reason: "NO_SHORTFALL" };
  }
  if (reserve.confidence < RESERVE_CONFIDENCE_THRESHOLD) {
    return { promoted: false, reserve, reason: "LOW_CONFIDENCE" };
  }

  const upd = await db
    .prepare(
      `UPDATE DnsCycles
         SET igs_mode='RINGFENCED_PLUS', dns_recovery_reserve=?, reserve_explain_hash=?,
             reserve_confidence=?, updated_at=?
       WHERE cycle_id=? AND state='HOLD_ACTIVE' AND igs_mode='RINGFENCED'`
    )
    .bind(reserve.reserve, reserve.explain_hash, reserve.confidence, now, cycleId)
    .run();
  if ((upd.meta.changes ?? 0) === 0) return { promoted: false, reserve, reason: "CAS_LOST" };

  await writeFinalityLog(db, {
    txid: null,
    event_type: "DnsRingfencePromoted",
    state_from: "RINGFENCED",
    state_to: "RINGFENCED_PLUS",
    payload_json: JSON.stringify({
      cycle_id: cycleId,
      dns_recovery_reserve: reserve.reserve,
      reserve_explain_hash: reserve.explain_hash,
      reserve_confidence: reserve.confidence,
      formula_id: RESERVE_FORMULA_ID,
    }),
    txid_or_gtid: cycleId,
  });

  return { promoted: true, reserve };
}
