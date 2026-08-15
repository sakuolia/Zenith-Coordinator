/**
 * @file Transaction query API handlers (GET /api/transactions). Supports single
 *       lookup, list with filters, and QueryResponse (Appendix E.6) format.
 * @module zc/query
 */

import { FRESHNESS_GREEN_MAX_MS, FRESHNESS_YELLOW_MAX_MS } from "../../shared/constants";
import { timingSafeEqualStr } from "../../shared/hmac";
import { deserializeProof } from "../../shared/proof";
import type {
  CaseState,
  Env,
  GtidTransactionRow,
  HtlcContractRow,
  IgsStatus,
  QueryResponse,
  TransactionRow,
} from "../../types";
import { nowISO } from "../../types";
import { getWatermarks } from "../finality/watermark";
import { json, jsonError } from "../ingress";
import {
  isPurposeCode,
  recordClosedDomainAccess,
  recordDataAccessViolation,
} from "../platform/purpose";
import { getSystemMode } from "../platform/system_mode";
import {
  getDnsHoldDetail,
  getDnsNetPositions,
  getDnsStatus,
  type HoldDetailScope,
  resolveHoldDisclosure,
} from "../settlement/dns";

// ---------------------------------------------------------------------------
// GET /api/transactions/:txid
// ---------------------------------------------------------------------------
export async function handleGetTransaction(txid: string, env: Env): Promise<Response> {
  const db = env.DB;
  const tx = await db
    .prepare(`SELECT * FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<TransactionRow>();

  if (!tx) return jsonError(404, "NOT_FOUND", `txid ${txid} not found`);

  const caseInfo = tx.case_id
    ? await db
        .prepare(`SELECT case_id, state FROM Cases WHERE case_id = ?`)
        .bind(tx.case_id)
        .first<{ case_id: string; state: CaseState }>()
    : null;

  const decisionStatus: QueryResponse["decision"]["status"] =
    tx.state === "DECIDED_TO_SETTLE" ||
    ["PAYER_EXEC_CONFIRMED", "PAYEE_EXEC_CONFIRMED", "SETTLED"].includes(tx.state)
      ? "DECIDED_TO_SETTLE"
      : tx.state === "DECIDED_CANCEL" || tx.state === "CANCELLED"
        ? "DECIDED_CANCEL"
        : "NONE";

  const execA: "NONE" | "OK" | "NG" = tx.payer_bank_proof_ref
    ? "OK"
    : tx.state === "FAILED_EXECUTION"
      ? "NG"
      : "NONE";

  const execB: "NONE" | "OK" | "NG" = tx.payee_bank_proof_ref
    ? "OK"
    : tx.state === "FAILED_EXECUTION"
      ? "NG"
      : "NONE";

  const nextHint: QueryResponse["next_action_hint"] =
    tx.state === "SETTLED" || tx.state === "CANCELLED"
      ? "WAIT"
      : tx.state === "SUSPENDED" || tx.state === "FAILED_EXECUTION"
        ? "OPEN_CASE"
        : tx.state === "DECIDED_CANCEL"
          ? "CONTACT_PAYER_BANK"
          : "WAIT";

  // ---------------------------------------------------------------------------
  // Query meta information (spec: Operational Design > Query Meta Information)
  // ---------------------------------------------------------------------------

  // watermark / watermark_detail: how far the read model has caught up, as one
  // number for the counter and as a per-chain breakdown for audit. The breakdown
  // is what makes an aggregate reproducible — a GTID leg's decision is recorded
  // on the GT chain, so the leg's own MAX(event_seq) does not locate it (§13.6).
  // `tx_chain_tip_at` (the newest committed SoT fact on this tx's own chain) is
  // what `freshness_level` measures the derived row against — see below.
  const marks = await getWatermarks(db, { txid, dns_cycle_id: tx.dns_cycle_id });

  // next_retry_at: recommended time for the next query (computed based on state)
  // Terminal states are null (no further change); intermediate states recommend 5-30 seconds later
  const now = new Date();
  let nextRetryAt: string | null = null;
  if (["SETTLED", "CANCELLED", "FAILED_EXECUTION"].includes(tx.state)) {
    nextRetryAt = null; // terminal — no need to re-query
  } else if (
    ["DECIDED_TO_SETTLE", "PAYER_EXEC_CONFIRMED", "PAYEE_EXEC_CONFIRMED"].includes(tx.state)
  ) {
    nextRetryAt = new Date(now.getTime() + 5_000).toISOString(); // 5s — active execution
  } else if (["SUSPENDED", "PRECHECKED_SUSPENDED"].includes(tx.state)) {
    nextRetryAt = new Date(now.getTime() + 30_000).toISOString(); // 30s — manual review
  } else {
    nextRetryAt = new Date(now.getTime() + 10_000).toISOString(); // 10s — default
  }

  // freshness_level: how far the derived view trails the source of truth.
  //
  // This measures **read-model lag** — the gap between the newest committed
  // FinalityLog fact for this transaction and the point the derived
  // `Transactions` row was last projected to. It deliberately does NOT measure
  // "time since the transaction last moved": that reading turns every normally
  // completed transaction RED a minute after it settles, and the counter-desk
  // template for RED ("queries are congested") would then be shown for
  // transactions that are perfectly fine (docs/specs/30_internal_design.md §13.6).
  //
  // A row with no SoT entries newer than its own projection is fully caught up,
  // so a terminal transaction stays GREEN however old it is.
  const projectedAt = new Date(tx.updated_at).getTime();
  const sotTipAt = marks.tx_chain_tip_at ? new Date(marks.tx_chain_tip_at).getTime() : projectedAt;
  const lagMs = Math.max(0, sotTipAt - projectedAt);
  const freshness =
    lagMs < FRESHNESS_GREEN_MAX_MS ? "GREEN" : lagMs < FRESHNESS_YELLOW_MAX_MS ? "YELLOW" : "RED";

  // Official-disclosure context. Attached only while a cycle is held, and it
  // distinguishes "this HIGH_VALUE transfer is itself parked" from "the
  // interbank leg is held but your money already arrived" — conflating those two
  // is the specific customer-facing error §9.4.4.1 forbids.
  const disclosure = await resolveHoldDisclosure(db, {
    reason_code: tx.reason_code,
    dns_cycle_id: tx.dns_cycle_id,
  });

  // The central-bank leg's own outcome. `reason_code` collapses HOLD and FAILED
  // into IGS_FAILED, and those two need opposite answers at the counter, so the
  // distinction is surfaced from the settlement record that actually holds it.
  const igs =
    tx.external_settlement_status && tx.external_settlement_status !== "NONE"
      ? await db
          .prepare(
            `SELECT status FROM IgsRequests WHERE txid = ? ORDER BY requested_at DESC LIMIT 1`
          )
          .bind(txid)
          .first<{ status: IgsStatus }>()
      : null;
  // HOLD and TIMEOUT are "waiting may resolve this"; FAILED is not. REQUESTED is
  // still in flight. Anything unknown is treated as *not* retriable — telling a
  // customer to wait for something that will never complete is the worse error.
  const externalSettlement = igs
    ? { status: igs.status, retriable: igs.status === "HOLD" || igs.status === "TIMEOUT" }
    : undefined;

  const resp: QueryResponse = {
    txid: tx.txid,
    state: tx.state,
    reason_code: tx.reason_code ?? undefined,
    decision: {
      status: decisionStatus,
      decision_proof_ref: tx.decision_proof_ref ?? undefined,
    },
    execution: {
      a: execA,
      b: execB,
      payer_bank_proof_ref: deserializeProof(tx.payer_bank_proof_ref) ?? undefined,
      payee_bank_proof_ref: deserializeProof(tx.payee_bank_proof_ref) ?? undefined,
    },
    case: caseInfo ? { case_id: caseInfo.case_id, status: caseInfo.state } : undefined,
    as_of: nowISO(),
    watermark: marks.watermark,
    watermark_detail: marks.watermark_detail,
    freshness_level: freshness,
    next_action_hint: nextHint,
    next_retry_at: nextRetryAt,
    ...(externalSettlement ? { external_settlement: externalSettlement } : {}),
    ...(disclosure ?? {}),
  };

  // UI convenience fields (not part of formal QueryResponse spec)
  const uiExtra = {
    lane: tx.lane,
    amount_value: tx.amount_value,
    amount_currency: tx.amount_currency,
    payer_bank_id: tx.payer_bank_id,
    payer_account_hash: tx.payer_account_hash,
    payee_bank_id: tx.payee_bank_id,
    payee_account_hash: tx.payee_account_hash,
    created_at: tx.created_at,
    updated_at: tx.updated_at,
  };

  return json(200, { ...resp, ...uiExtra });
}

// ---------------------------------------------------------------------------
// GET /api/gtid/:gtid
// ---------------------------------------------------------------------------
export async function handleGetGtid(gtid: string, env: Env): Promise<Response> {
  const db = env.DB;
  const gt = await db
    .prepare(`SELECT * FROM GtidTransactions WHERE gtid = ?`)
    .bind(gtid)
    .first<GtidTransactionRow>();
  if (!gt) return jsonError(404, "NOT_FOUND", `gtid ${gtid} not found`);

  const legs = await db
    .prepare(`SELECT * FROM GtidLegs WHERE gtid = ?`)
    .bind(gtid)
    .all<{ state: string }>();

  // Derive the count fields from real leg states rather than trusting the
  // snapshot columns on GtidTransactions (see GtidTransactionRow doc-comment).
  // For DNS-synthetic GTs (`GTID-DNS-*`) that have no GtidLegs, fall back to
  // the stored snapshot so the dashboard still reflects the settled state.
  const hasLegs = (legs.results?.length ?? 0) > 0;
  const legs_ready_count = hasLegs
    ? legs.results.filter((l) => l.state === "LEG_READY_CHECKED" || l.state === "LEG_SETTLED")
        .length
    : gt.legs_ready_count;
  const legs_settled_count = hasLegs
    ? legs.results.filter((l) => l.state === "LEG_SETTLED").length
    : gt.legs_settled_count;

  return json(200, {
    ...gt,
    legs_ready_count,
    legs_settled_count,
    legs: legs.results,
  });
}

// ---------------------------------------------------------------------------
// GET /api/htlc/:htlc_id
// ---------------------------------------------------------------------------
export async function handleGetHtlc(htlcId: string, env: Env): Promise<Response> {
  const htlc = await env.DB.prepare(`SELECT * FROM HtlcContracts WHERE htlc_id = ?`)
    .bind(htlcId)
    .first<HtlcContractRow>();
  if (!htlc) return jsonError(404, "NOT_FOUND", `htlc_id ${htlcId} not found`);
  return json(200, htlc);
}

// ---------------------------------------------------------------------------
// GET /api/dns/:business_date/status
// ---------------------------------------------------------------------------
export async function handleGetDnsStatus(businessDate: string, env: Env): Promise<Response> {
  const cycle = await getDnsStatus(businessDate, env.DB);
  if (!cycle) return json(200, { state: "NOT_STARTED", business_date: businessDate });
  // `public_message_id` is the only field here that crosses into customer-facing
  // territory: it names the pre-approved template a participant may key its
  // wording to. It is NULL unless the cycle is held, and it never carries the
  // cause or the amount (docs/specs/20_method_design.md §9.4.4 の規範).
  return json(200, {
    state: cycle.state,
    igs_mode: cycle.igs_mode,
    cycle_id: cycle.cycle_id,
    business_date: businessDate,
    public_message_id: cycle.public_message_id,
  });
}

// ---------------------------------------------------------------------------
// GET /api/system-mode
// ---------------------------------------------------------------------------
export async function handleGetSystemMode(env: Env): Promise<Response> {
  const mode = await getSystemMode(env.DB);
  return json(200, mode);
}

// ---------------------------------------------------------------------------
// GET /api/dns/:business_date/hold_detail  (closed domain)
// ---------------------------------------------------------------------------
/**
 * Serve the closed-domain hold detail to the defaulting participant, the
 * supervisor, the central bank, and ZC operations
 * (docs/specs/20_method_design.md §9.4.4 (B); contract in
 * docs/specs/32_api_contracts.md § GET /api/dns/:business_date/hold_detail).
 *
 * Two rules shape this handler and both are institutional, not technical:
 *
 *  1. **Every refusal is 404, never 403.** A 403 would confirm that a hold
 *     exists to a caller who is not entitled to know — and "is bank X short
 *     today?" is precisely the question that starts a run. Missing purpose code,
 *     unidentified caller, no hold, and "you are not the defaulter" all return
 *     the same body.
 *  2. **No purpose code, no access.** docs/specs/10_requirements.md §3.3.2.2.1.1-2
 *     requires purpose-less access to be blocked in real time and to raise
 *     `DataAccessViolationDetected`, not to be logged for a later review.
 */
export async function handleGetDnsHoldDetail(
  req: Request,
  businessDate: string,
  env: Env
): Promise<Response> {
  const db = env.DB;
  const resource = `dns/${businessDate}/hold_detail`;
  // Uniform refusal: the existence of a hold is itself closed-domain.
  const refuse = () => jsonError(404, "NOT_FOUND", "not found");

  const purposeCode = req.headers.get("X-Purpose-Code");
  const bankId = req.headers.get("X-Bank-Id");
  const cronSecret = req.headers.get("X-Cron-Secret");
  const isOperator =
    !!cronSecret && !!env.CRON_SECRET && timingSafeEqualStr(cronSecret, env.CRON_SECRET);

  if (!isPurposeCode(purposeCode)) {
    await recordDataAccessViolation(db, {
      resource,
      subject: bankId ?? (isOperator ? "OPERATOR" : "UNIDENTIFIED"),
      purpose_code: purposeCode,
      reason: "PURPOSE_CODE_MISSING",
    });
    return refuse();
  }

  if (!isOperator && !bankId) {
    await recordDataAccessViolation(db, {
      resource,
      subject: "UNIDENTIFIED",
      purpose_code: purposeCode,
      reason: "REQUESTER_UNIDENTIFIED",
    });
    return refuse();
  }

  const scope: HoldDetailScope = isOperator
    ? { kind: "OPERATOR" }
    : { kind: "PARTICIPANT", bankId: bankId! };

  const detail = await getDnsHoldDetail(db, businessDate, scope);
  if (!detail) return refuse();

  // Who read the defaulter's shortfall, under what purpose, and when. This is
  // the most sensitive read ZC serves, so the grant is audited too — not only
  // the denials.
  await recordClosedDomainAccess(db, {
    resource,
    subject: isOperator ? "OPERATOR" : bankId!,
    purpose_code: purposeCode,
    scope: scope.kind,
  });

  return json(200, detail);
}

// ---------------------------------------------------------------------------
// GET /api/dns/:business_date/position
// ---------------------------------------------------------------------------
export async function handleGetDnsPosition(businessDate: string, env: Env): Promise<Response> {
  const db = env.DB;
  const positions = await getDnsNetPositions(businessDate, db);

  // Freshness meta, required of this query by docs/specs/20_method_design.md §9.4.4 (A)
  // as an "事務が回るための必須要件": a treasury desk reading a net position has
  // to know how current it is before acting on it, and the transaction query has
  // carried this from the start while the position query did not.
  //
  // `watermark` is the newest FinalityLog sequence for the cycles of this
  // business date — the point in the log the figures reflect. Absent cycles give
  // 0, which reads correctly as "nothing recorded yet".
  const wm = await db
    .prepare(
      `SELECT MAX(f.event_seq) AS wm
         FROM FinalityLog f
         JOIN DnsCycles c ON f.gtid = c.cycle_id
        WHERE c.business_date = ?`
    )
    .bind(businessDate)
    .first<{ wm: number | null }>();

  // The desk's next step: while a cycle is held there is nothing for a
  // participant to do but wait for the official status; otherwise the figures
  // are live and re-reading is the action. The value domain is the same closed
  // four as the transaction query — a new hint value here would break the 1:1
  // mapping to counter wording (§13.6).
  const held = await db
    .prepare(
      `SELECT 1 AS x FROM DnsCycles WHERE business_date = ? AND state = 'HOLD_ACTIVE' LIMIT 1`
    )
    .bind(businessDate)
    .first<{ x: number }>();

  return json(200, {
    business_date: businessDate,
    positions,
    as_of: nowISO(),
    watermark: wm?.wm ?? 0,
    next_action_hint: held ? "WAIT" : "RETRY_LATER",
  });
}

// ---------------------------------------------------------------------------
// GET /api/cases/:case_id
// ---------------------------------------------------------------------------
export async function handleGetCase(caseId: string, env: Env): Promise<Response> {
  const c = await env.DB.prepare(`SELECT * FROM Cases WHERE case_id = ?`).bind(caseId).first();
  if (!c) return jsonError(404, "NOT_FOUND", `case ${caseId} not found`);
  return json(200, c);
}

// ---------------------------------------------------------------------------
// GET /api/transactions  (list: for the dashboard)
// ---------------------------------------------------------------------------
export async function handleListTransactions(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const state = url.searchParams.get("state");
  const txid = url.searchParams.get("txid");
  const account = url.searchParams.get("account"); // payer or payee account
  const bankId = url.searchParams.get("bank_id"); // payer or payee bank
  const dateFrom = url.searchParams.get("date_from"); // ISO datetime
  const dateTo = url.searchParams.get("date_to"); // ISO datetime

  let query = `SELECT txid, lane, state, reason_code, amount_value, payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash, created_at, updated_at FROM Transactions`;
  const params: unknown[] = [];
  const conds: string[] = [];

  if (state) {
    conds.push(`state = ?`);
    params.push(state);
  }
  if (txid) {
    conds.push(`txid LIKE ?`);
    params.push(`${txid}%`);
  }
  if (account) {
    conds.push(`(payer_account_hash = ? OR payee_account_hash = ?)`);
    params.push(account, account);
  }
  if (bankId) {
    conds.push(`(payer_bank_id = ? OR payee_bank_id = ?)`);
    params.push(bankId, bankId);
  }
  if (dateFrom) {
    conds.push(`created_at >= ?`);
    params.push(dateFrom);
  }
  if (dateTo) {
    conds.push(`created_at <= ?`);
    params.push(dateTo);
  }

  // Query row count
  let countQuery = `SELECT COUNT(*) as count FROM Transactions`;
  if (conds.length > 0) countQuery += ` WHERE ${conds.join(` AND `)}`;
  const countRow = await env.DB.prepare(countQuery)
    .bind(...params)
    .first<{ count: number }>();
  const totalCount = countRow?.count ?? 0;

  if (conds.length > 0) query += ` WHERE ${conds.join(` AND `)}`;
  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = await env.DB.prepare(query)
    .bind(...params)
    .all();
  return json(200, {
    transactions: rows.results,
    count: rows.results.length,
    total_count: totalCount,
  });
}

// ---------------------------------------------------------------------------
// GET /api/htlc  (HTLC list: for the dashboard)
// ---------------------------------------------------------------------------
export async function handleListHtlcs(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const countRow = await env.DB.prepare(`SELECT COUNT(*) as count FROM HtlcContracts`).first<{
    count: number;
  }>();
  const totalCount = countRow?.count ?? 0;

  const rows = await env.DB.prepare(
    `SELECT h.htlc_id, h.txid, h.state, h.hashlock, h.timelock, h.amount_value,
            h.payer_bank_id, h.payee_bank_id, h.secret_verified, h.created_at, h.updated_at,
            t.state AS tx_state
     FROM HtlcContracts h
     LEFT JOIN Transactions t ON h.txid = t.txid
     ORDER BY h.created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(limit, offset)
    .all();
  return json(200, { htlcs: rows.results, count: rows.results.length, total_count: totalCount });
}

// ---------------------------------------------------------------------------
// GET /api/gtid  (GTID list: for the dashboard)
// ---------------------------------------------------------------------------
export async function handleListGtids(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const countRow = await env.DB.prepare(`SELECT COUNT(*) as count FROM GtidTransactions`).first<{
    count: number;
  }>();
  const totalCount = countRow?.count ?? 0;

  const rows = await env.DB.prepare(
    `SELECT * FROM GtidTransactions ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(limit, offset)
    .all<GtidTransactionRow>();
  return json(200, { gtids: rows.results, count: rows.results.length, total_count: totalCount });
}
