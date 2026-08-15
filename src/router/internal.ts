/**
 * @file Internal API router (/internal/*: seed, cron, DNS management).
 * @module router/internal
 */
import { runEod } from "../cron/eod";
import { runTimeoutSweep } from "../cron/timeout_sweep";
import type { Env } from "../types";
import { handleSeed, handleSimSetup, handleSimSetupOneBank, json, jsonError } from "../zc/ingress";
import { timingSafeEqualStr } from "../shared/hmac";
import {
  activateBcpReadOnly,
  deactivateBcpReadOnly,
  getSystemMode,
} from "../zc/platform/system_mode";
import { quorumMembership, reconcileQuorum } from "../zc/platform/quorum";
import {
  getBojPositions,
  kickDns,
  resumeDns,
  runIntradayDnsCutoff,
  settleDns,
} from "../zc/settlement/dns";

// =========================================================================
// Internal API
// =========================================================================
export async function handleInternal(
  req: Request,
  path: string,
  method: string,
  env: Env
): Promise<Response> {
  // CRON_SECRET validation. Compared in constant time so the shared secret
  // cannot be recovered byte-by-byte via response-timing. Fail-closed: a missing
  // header or an unset env secret both reject (never treat "" === "" as a pass).
  const cronSecret = req.headers.get("X-Cron-Secret");
  if (!cronSecret || !env.CRON_SECRET || !timingSafeEqualStr(cronSecret, env.CRON_SECRET)) {
    return jsonError(403, "FORBIDDEN", "X-Cron-Secret required");
  }

  // Operational metrics (read-only projection of authoritative state). Served in
  // the Prometheus text exposition format for `?format=prometheus` (default) or
  // JSON for `?format=json`. Safe to scrape while read-only — it never writes.
  if (method === "GET" && path === "/internal/metrics") {
    const { collectOperationalMetrics, renderPrometheus } = await import("../zc/platform/metrics");
    const metrics = await collectOperationalMetrics(env.DB);
    const url = new URL(req.url);
    if (url.searchParams.get("format") === "json") {
      return json(200, metrics);
    }
    return new Response(renderPrometheus(metrics), {
      status: 200,
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  }

  if (method === "POST" && path === "/internal/cron/eod") {
    const result = await runEod(env);
    return json(200, result);
  }

  if (method === "POST" && path === "/internal/cron/timeout-sweep") {
    const result = await runTimeoutSweep(env);
    return json(200, result);
  }

  if (method === "POST" && path === "/internal/cron/finality-audit") {
    const { runFinalityChainAudit } = await import("../zc/finality/finality_audit");
    const result = await runFinalityChainAudit(env);
    return json(200, result);
  }

  if (method === "POST" && path === "/internal/seed") {
    return handleSeed(env);
  }

  // DNS manual kick
  if (method === "POST" && path === "/internal/dns/kick") {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    const { todayJST } = await import("../types");
    const date = body.business_date ?? todayJST();
    const result = await kickDns(date, env);
    return json(200, result);
  }

  // DNS manual settle
  if (method === "POST" && path === "/internal/dns/settle") {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    if (!body.cycle_id) return jsonError(400, "MISSING_PARAM", "cycle_id required");
    await settleDns(body.cycle_id, env);
    return json(200, { result: "SETTLED", cycle_id: body.cycle_id });
  }

  // DNS intraday cutoff (24/365): close the current OPEN window (kick+settle) and
  // open the next intraday cycle. Enables multiple settlements/day → rolling.
  if (method === "POST" && path === "/internal/dns/intraday-cutoff") {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    const { todayJST } = await import("../types");
    const date = body.business_date ?? todayJST();
    const currency = body.currency ?? "JPY";
    const result = await runIntradayDnsCutoff(date, env, currency);
    return json(200, result);
  }

  // DNS hold recovery: ZC運営 triggers this after bridge liquidity has been
  // supplied for a held cycle (DNS_HOLD protocol, 10_requirements.md §2.5.2).
  // Re-checks the shortfall and, if cleared, completes the clearing.
  if (method === "POST" && path === "/internal/dns/resume") {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    if (!body.cycle_id) return jsonError(400, "MISSING_PARAM", "cycle_id required");
    const result = await resumeDns(body.cycle_id, env);
    return json(200, { cycle_id: body.cycle_id, ...result });
  }

  // Activate BCP_READONLY mode (vendor-outage portability and degradation, テーマ H)
  if (method === "POST" && path === "/internal/system-mode/bcp-activate") {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    if (!body.reason) return jsonError(400, "MISSING_PARAM", "reason required");
    const mode = await activateBcpReadOnly(env, body.reason);
    return json(200, mode);
  }

  // Deactivate BCP_READONLY mode, returning to NORMAL
  if (method === "POST" && path === "/internal/system-mode/bcp-deactivate") {
    const mode = await deactivateBcpReadOnly(env);
    return json(200, mode);
  }

  // Quorum health report (design principle 10). A deployment's health monitor
  // POSTs the set of consensus replicas it currently observes reachable; ZC
  // reconciles its mode — degrading to QUORUM_LOSS_READONLY on quorum loss and
  // restoring to NORMAL on recovery. `reachable` defaults to the full
  // membership (treated as healthy) when omitted.
  if (method === "POST" && path === "/internal/system-mode/quorum-report") {
    const body = (await req.json().catch(() => ({}))) as { reachable?: string[] };
    const reachable = Array.isArray(body.reachable) ? body.reachable : quorumMembership(env);
    const result = await reconcileQuorum(env, reachable);
    return json(200, result);
  }

  // Current system mode (read-only introspection for ops dashboards).
  if (method === "GET" && path === "/internal/system-mode") {
    const mode = await getSystemMode(env.DB);
    return json(200, mode);
  }

  // Mandatory co-sign policy per chain kind (TX/GTID/DNS). When a kind is set
  // mandatory, /api/.../verify reports finality_confirmed=false until the
  // required distinct participants have co-signed the chain's current tip.
  const cosignPolicyMatch = path.match(/^\/internal\/cosign-policy\/(TX|GTID|DNS)$/);
  if (cosignPolicyMatch) {
    const chainKind = cosignPolicyMatch[1] as "TX" | "GTID" | "DNS";
    const { setCosignPolicy, getCosignPolicy } = await import("../zc/finality/finality_anchor");
    if (method === "PUT") {
      const body = (await req.json().catch(() => ({}))) as {
        min_cosigners?: number;
        is_mandatory?: boolean;
      };
      await setCosignPolicy(env.DB, chainKind, {
        minCosigners: Number(body.min_cosigners ?? 1),
        isMandatory: body.is_mandatory === true,
      });
      return json(200, await getCosignPolicy(env.DB, chainKind));
    }
    if (method === "GET") {
      return json(
        200,
        (await getCosignPolicy(env.DB, chainKind)) ?? { chain_kind: chainKind, is_mandatory: 0 }
      );
    }
  }

  // Query each bank's BOJ deposit account (BOJ) balance
  if (method === "GET" && path === "/internal/boj-positions") {
    const positions = await getBojPositions(env.DB);
    return json(200, { positions });
  }

  if (method === "POST" && path === "/internal/sim/setup") {
    return handleSimSetup(req, env);
  }

  if (method === "POST" && path === "/internal/sim/setup-bank") {
    return handleSimSetupOneBank(req, env);
  }

  // POST /internal/transfers/:txid/resume-credit
  // After the customer approves the incoming credit, the bank notifies ZC to resume credit processing
  const resumeCreditMatch = path.match(/^\/internal\/transfers\/([^/]+)\/resume-credit$/);
  if (method === "POST" && resumeCreditMatch) {
    const txid = resumeCreditMatch[1]!;
    const txInfo = await env.DB.prepare(
      `SELECT payee_bank_id, payee_account_hash FROM Transactions WHERE txid=?`
    )
      .bind(txid)
      .first<{ payee_bank_id: string; payee_account_hash: string | null }>();
    if (!txInfo) return jsonError(404, "NOT_FOUND", `txid ${txid} not found`);
    await env.QUEUE.send({
      type: "ZC_RESUME_CREDIT",
      payload: {
        txid,
        payee_bank_id: txInfo.payee_bank_id,
        payee_account_hash: txInfo.payee_account_hash ?? undefined,
      },
      txid,
      attempt: 0,
      enqueued_at: new Date().toISOString(),
    });
    return json(200, { result: "QUEUED", txid });
  }

  return jsonError(404, "NOT_FOUND", `Internal ${path} not found`);
}
