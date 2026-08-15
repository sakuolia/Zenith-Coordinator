/**
 * @file metrics.ts — Operational observability derived from authoritative state.
 *
 * Zenith's thesis is explainability: the FinalityLog and the derived state tables
 * ARE the system of record. So runtime *operational* observability is computed
 * the same way — by reading authoritative state — rather than by bolting a
 * parallel, drift-prone instrumentation path onto every write. `collectOperationalMetrics`
 * snapshots a handful of SLO-relevant gauges (open CASEs and their aging, stuck
 * cross-chain quorums, transactions by state, system mode, FinalityLog liveness)
 * and `renderPrometheus` emits them in the Prometheus text exposition format so a
 * standard scraper can alert on them.
 *
 * This is intentionally a read-only projection: it never writes, so it is safe to
 * scrape while the system is degraded to read-only (principle 10). The audit
 * trail of *why* a state is what it is still lives in the FinalityLog; these
 * gauges answer the operational "how much / how old / is it moving" questions
 * that an append-only log is awkward to poll for.
 *
 * @module zc/platform/metrics
 */
import { nowISO } from "../../types";
import { getSystemMode } from "./system_mode";
import { UNRESOLVED_CASE_STATES_SQL } from "../cases/case";

/** A single labelled gauge sample. */
export interface MetricSample {
  /** Prometheus metric name (snake_case, `zc_` prefixed). */
  name: string;
  /** Help text emitted as a `# HELP` line (once per metric name). */
  help: string;
  /** Label set; rendered as `{k="v",...}`. */
  labels: Record<string, string>;
  value: number;
}

export interface OperationalMetrics {
  collected_at: string;
  samples: MetricSample[];
}

/** Seconds between an RFC3339 timestamp and `now` (0 if in the future / unparseable). */
function ageSeconds(iso: string | null, nowMs: number): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

/**
 * Snapshot operational gauges from authoritative state. Pure read; never mutates.
 * Every query is a bounded aggregate so the cost is independent of FinalityLog size.
 */
export async function collectOperationalMetrics(db: D1Database): Promise<OperationalMetrics> {
  const collectedAt = nowISO();
  const nowMs = Date.parse(collectedAt);
  const samples: MetricSample[] = [];

  // ----- System mode (info gauge: value 1 on the active mode's label) ----------
  const mode = await getSystemMode(db);
  samples.push({
    name: "zc_system_mode",
    help: "Active SystemMode (1 on the current mode label). NORMAL|BCP_READONLY|QUORUM_LOSS_READONLY.",
    labels: { mode: mode.mode },
    value: 1,
  });
  samples.push({
    name: "zc_read_only",
    help: "1 when the system is degraded to read-only (BCP or quorum loss), else 0.",
    labels: {},
    value: mode.mode === "NORMAL" ? 0 : 1,
  });

  // ----- Open CASEs: total, by reason_code, and oldest age ---------------------
  const openByReason = await db
    .prepare(
      `SELECT reason_code, COUNT(*) AS n, MIN(created_at) AS oldest
         FROM Cases WHERE ${UNRESOLVED_CASE_STATES_SQL}
        GROUP BY reason_code`
    )
    .all<{ reason_code: string; n: number; oldest: string }>();
  let openTotal = 0;
  let oldestOpenAge = 0;
  for (const r of openByReason.results ?? []) {
    openTotal += r.n;
    oldestOpenAge = Math.max(oldestOpenAge, ageSeconds(r.oldest, nowMs));
    samples.push({
      name: "zc_cases_open_by_reason",
      help: "Open CASEs (OPEN|IN_PROGRESS|ESCALATED) grouped by reason_code.",
      labels: { reason_code: r.reason_code },
      value: r.n,
    });
  }
  samples.push({
    name: "zc_cases_open_total",
    help: "Total CASEs not yet RESOLVED — the unresolved-exception backlog (principle 4).",
    labels: {},
    value: openTotal,
  });
  samples.push({
    name: "zc_cases_open_age_seconds_max",
    help: "Age of the oldest unresolved CASE, in seconds — the CASE-aging SLO signal.",
    labels: {},
    value: oldestOpenAge,
  });

  // ----- Transactions by state (esp. SUSPENDED / in-flight) --------------------
  const byState = await db
    .prepare(`SELECT state, COUNT(*) AS n FROM Transactions GROUP BY state`)
    .all<{ state: string; n: number }>();
  for (const r of byState.results ?? []) {
    samples.push({
      name: "zc_transactions_by_state",
      help: "Transactions grouped by state. Watch SUSPENDED and the long-lived in-flight states.",
      labels: { state: r.state },
      value: r.n,
    });
  }

  // ----- Cross-chain HTLCs awaiting Watcher quorum (trust-minimization hold) ----
  const quorumPending = await db
    .prepare(`SELECT COUNT(*) AS n FROM HtlcContracts WHERE state = 'HTLC_ONCHAIN_PENDING'`)
    .first<{ n: number }>();
  samples.push({
    name: "zc_htlc_onchain_quorum_pending",
    help: "Cross-chain HTLCs held in HTLC_ONCHAIN_PENDING (awaiting Watcher quorum / confirmation depth).",
    labels: {},
    value: quorumPending?.n ?? 0,
  });

  // ----- FinalityLog liveness: event_seq high-water mark -----------------------
  const wm = await db
    .prepare(`SELECT COALESCE(MAX(event_seq), 0) AS seq FROM FinalityLog`)
    .first<{ seq: number }>();
  samples.push({
    name: "zc_finality_event_seq_high_watermark",
    help: "Current FinalityLog event_seq high-water mark — a monotonic liveness counter.",
    labels: {},
    value: wm?.seq ?? 0,
  });

  return { collected_at: collectedAt, samples };
}

/** Escape a Prometheus label value (backslash, double-quote, newline). */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Render metrics in the Prometheus text exposition format. `# HELP`/`# TYPE`
 * lines are emitted once per distinct metric name (all gauges), followed by one
 * sample line per label set.
 */
export function renderPrometheus(metrics: OperationalMetrics): string {
  const byName = new Map<string, MetricSample[]>();
  for (const s of metrics.samples) {
    const list = byName.get(s.name);
    if (list) list.push(s);
    else byName.set(s.name, [s]);
  }

  const lines: string[] = [];
  for (const [name, group] of byName) {
    lines.push(`# HELP ${name} ${group[0]!.help}`);
    lines.push(`# TYPE ${name} gauge`);
    for (const s of group) {
      const labelStr = Object.entries(s.labels)
        .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
        .join(",");
      lines.push(labelStr ? `${name}{${labelStr}} ${s.value}` : `${name} ${s.value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
