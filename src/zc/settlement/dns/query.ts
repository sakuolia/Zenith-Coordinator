/**
 * @file DNS read-only queries — status, net positions, BOJ positions.
 * @module zc/settlement/dns/query
 */
import type { DnsCycleRow } from "../../../types";
import { nowISO } from "../../../types";
import {
  DNS_HOLD_CONTACT_CHANNEL,
  DNS_HOLD_RECOMMENDED_ACTIONS,
  DNS_RECOVERY_RESERVE_BUFFER_RATE,
} from "../../../shared/constants";

// ---------------------------------------------------------------------------
// DNS status query
// ---------------------------------------------------------------------------
export async function getDnsStatus(
  businessDate: string,
  db: D1Database
): Promise<DnsCycleRow | null> {
  return db
    .prepare(`SELECT * FROM DnsCycles WHERE business_date = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(businessDate)
    .first<DnsCycleRow>();
}

export async function getDnsNetPositions(
  businessDate: string,
  db: D1Database
): Promise<
  Array<{
    cycle_id: string;
    bank_id: string;
    net_position: number;
    gross_send: number;
    gross_receive: number;
    is_settled: number;
  }>
> {
  const prefix = `DNS-${businessDate}%`;
  const rows = await db
    .prepare(
      `SELECT cycle_id, bank_id, net_position, gross_send, gross_receive, is_settled
       FROM DnsNetPositions
       WHERE cycle_id LIKE ?
       ORDER BY cycle_id, bank_id`
    )
    .bind(prefix)
    .all<{
      cycle_id: string;
      bank_id: string;
      net_position: number;
      gross_send: number;
      gross_receive: number;
      is_settled: number;
    }>();
  return rows.results;
}

// ---------------------------------------------------------------------------
// Query each bank's BOJ deposit account (BOJ) balance
// Aggregate the journal entries accumulated in accounts where account_type='BOJ'
// ---------------------------------------------------------------------------
export async function getBojPositions(
  db: D1Database
): Promise<Array<{ bank_id: string; boj_balance: number }>> {
  const rows = await db
    .prepare(
      `SELECT ba.bank_id, COALESCE(SUM(j.amount), 0) AS boj_balance
       FROM BankAccounts ba
       LEFT JOIN BankJournals j ON j.account_id = ba.account_id
       WHERE ba.account_type = 'BOJ'
       GROUP BY ba.bank_id
       ORDER BY ba.bank_id`
    )
    .all<{ bank_id: string; boj_balance: number }>();
  return rows.results;
}

// ---------------------------------------------------------------------------
// Closed-domain hold detail (docs/specs/20_method_design.md §9.4.4 (B))
// ---------------------------------------------------------------------------

/**
 * Who is asking for the hold detail.
 *
 * `PARTICIPANT` is the defaulting bank itself — it may see only its own
 * shortfall. `OPERATOR` covers ZC operations, the supervisor, and the central
 * bank, which see the cycle-wide figure. There is deliberately no "any
 * participant" scope: a bank that is not causing the hold has no business
 * learning that one exists, let alone who caused it
 * (docs/specs/10_requirements.md §3.2.5.1 information control).
 */
export type HoldDetailScope = { kind: "PARTICIPANT"; bankId: string } | { kind: "OPERATOR" };

/** Closed-domain detail served to the defaulting participant and the authorities. */
export interface DnsHoldDetail {
  business_date: string;
  cycle_id: string;
  shortfall_amount: number;
  collateral_call_amount: number;
  recommended_actions: string[];
  contact_channel: string;
  as_of: string;
}

interface HoldReasonPayload {
  reason?: string;
  shortfalls?: Array<{ bank_id: string; shortfall: number }>;
}

/**
 * Resolve the closed-domain hold detail for a business date, or `null` when the
 * caller must not learn anything at all.
 *
 * `null` covers three distinct situations on purpose — no held cycle, a held
 * cycle with no recorded shortfall breakdown, and a participant that is not
 * among the hold-causing set. The caller maps all three to the same 404, so the
 * response cannot be used as an oracle for "is there a hold today?"
 * (docs/specs/32_api_contracts.md § GET /api/dns/:business_date/hold_detail).
 */
export async function getDnsHoldDetail(
  db: D1Database,
  businessDate: string,
  scope: HoldDetailScope
): Promise<DnsHoldDetail | null> {
  const cycle = await db
    .prepare(
      `SELECT cycle_id, business_date, hold_reason, hold_causing_participants
       FROM DnsCycles
       WHERE business_date = ? AND state = 'HOLD_ACTIVE'
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(businessDate)
    .first<{
      cycle_id: string;
      business_date: string;
      hold_reason: string | null;
      hold_causing_participants: string | null;
    }>();
  if (!cycle) return null;

  let payload: HoldReasonPayload = {};
  try {
    payload = cycle.hold_reason ? (JSON.parse(cycle.hold_reason) as HoldReasonPayload) : {};
  } catch {
    // A manual holdDns writes a free-text reason rather than the settleDns
    // shortfall payload. There is then no per-bank breakdown to disclose, and
    // guessing one would be worse than disclosing nothing.
    payload = {};
  }
  const shortfalls = payload.shortfalls ?? [];
  if (shortfalls.length === 0) return null;

  let shortfallAmount: number;
  if (scope.kind === "PARTICIPANT") {
    const own = shortfalls.find((s) => s.bank_id === scope.bankId);
    if (!own) return null; // not a hold-causing participant — reveal nothing
    shortfallAmount = own.shortfall;
  } else {
    shortfallAmount = shortfalls.reduce((sum, s) => sum + s.shortfall, 0);
  }

  return {
    business_date: cycle.business_date,
    cycle_id: cycle.cycle_id,
    shortfall_amount: shortfallAmount,
    // The collateral call carries the same headroom the recovery reserve uses,
    // so "what must I pledge" and "what does ZC hold against this hold" are
    // derived from one buffer rate rather than two that can drift.
    collateral_call_amount: Math.ceil(shortfallAmount * (1 + DNS_RECOVERY_RESERVE_BUFFER_RATE)),
    recommended_actions: [...DNS_HOLD_RECOMMENDED_ACTIONS],
    contact_channel: DNS_HOLD_CONTACT_CHANNEL,
    as_of: nowISO(),
  };
}
