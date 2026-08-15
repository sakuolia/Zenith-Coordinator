/**
 * @file story.ts — Narrative + Mermaid sequence rendering for a transaction.
 *
 * `explainTransaction()` already returns a structured timeline with reasons.
 * This module is the next layer up: it takes the same FinalityLog data and
 * speaks it back as something a human actually wants to read — a flowing
 * Japanese paragraph, a copy-pasteable Mermaid sequenceDiagram, and a small
 * "health" verdict that flags transactions which look stuck.
 *
 * The shape is intentionally additive: callers who only want machine-readable
 * timeline data still use /explain. /story is for operators staring at one
 * specific txid and trying to understand what happened to it.
 */
import { explainTransaction, type ExplainResult, type TimelineItem } from "../query/explain";

/** What kind of arrow each FinalityLog event_type implies on the wire. */
type ArrowKind =
  | { kind: "note"; over: SeqActor[]; text: string }
  | { kind: "msg"; from: SeqActor; to: SeqActor; text: string; dashed?: boolean };

type SeqActor = "Customer" | "ZC" | "PayerBank" | "PayeeBank" | "IGS";

interface EventRender {
  arrows: (ctx: NarrativeCtx) => ArrowKind[];
  /** Short narrative fragment, e.g. "passed pre-validation". Joined with dates around it. */
  blurb: string;
}

/**
 * Static rendering table. Anything not in here falls back to a generic note
 * so the diagram never breaks on new event types — it just gets less detail.
 */
const EVENT_RENDER: Record<string, EventRender> = {
  PaymentInitiated: {
    arrows: () => [{ kind: "msg", from: "Customer", to: "ZC", text: "送金リクエスト" }],
    blurb: "送金リクエストを受付",
  },
  PreCheckPassed: {
    arrows: () => [{ kind: "note", over: ["ZC"], text: "事前検証 OK" }],
    blurb: "事前検証（金額・残高・宛先）を通過",
  },
  PreCheckFailed: {
    arrows: () => [{ kind: "note", over: ["ZC"], text: "事前検証 NG" }],
    blurb: "事前検証で弾かれ",
  },
  HReserved: {
    arrows: () => [
      { kind: "msg", from: "ZC", to: "PayerBank", text: "reserve_funds" },
      { kind: "msg", from: "PayerBank", to: "ZC", text: "RESERVED", dashed: true },
    ],
    blurb: "送金元銀行で資金を H 予約",
  },
  DecidedToSettle: {
    arrows: () => [{ kind: "note", over: ["ZC"], text: "決済確定を判断" }],
    blurb: "決済確定を判断",
  },
  DecidedCancel: {
    arrows: () => [{ kind: "note", over: ["ZC"], text: "中止を判断" }],
    blurb: "中止を判断",
  },
  PayerExecConfirmed: {
    arrows: () => [
      { kind: "msg", from: "PayerBank", to: "ZC", text: "出金完了 (proof a)", dashed: true },
    ],
    blurb: "送金元銀行の出金確認を取得",
  },
  PayeeExecConfirmed: {
    arrows: () => [
      { kind: "msg", from: "PayeeBank", to: "ZC", text: "入金完了 (proof b)", dashed: true },
    ],
    blurb: "受取銀行の入金確認を取得",
  },
  Settled: {
    arrows: () => [{ kind: "note", over: ["ZC", "PayeeBank"], text: "SETTLED" }],
    blurb: "送金は最終確定",
  },
  Cancelled: {
    arrows: () => [{ kind: "note", over: ["ZC"], text: "CANCELLED" }],
    blurb: "取引はキャンセル",
  },
  Suspended: {
    arrows: () => [{ kind: "note", over: ["ZC"], text: "⚠ SUSPENDED" }],
    blurb: "異常検知により保留",
  },
  FailedExecution: {
    arrows: () => [{ kind: "note", over: ["ZC"], text: "✗ FAILED" }],
    blurb: "実行エラーで失敗",
  },
  HtlcCreated: {
    arrows: () => [{ kind: "note", over: ["ZC"], text: "HTLC 作成" }],
    blurb: "HTLC を作成",
  },
  HtlcLocked: {
    arrows: () => [
      { kind: "msg", from: "ZC", to: "PayerBank", text: "lock_funds" },
      { kind: "msg", from: "PayerBank", to: "ZC", text: "LOCKED", dashed: true },
    ],
    blurb: "HTLC の資金をロック",
  },
  HtlcFulfillRequested: {
    arrows: () => [{ kind: "msg", from: "PayeeBank", to: "ZC", text: "preimage 提示" }],
    blurb: "受取側がプリイメージで HTLC を解錠要求",
  },
  HtlcCancelled: {
    arrows: () => [{ kind: "note", over: ["ZC"], text: "HTLC 取消" }],
    blurb: "HTLC をタイムアウト/取消",
  },
  FilterPending: {
    arrows: () => [{ kind: "msg", from: "ZC", to: "Customer", text: "着金承認待ち" }],
    blurb: "受取顧客の着金承認待ちで保留",
  },
  FilterRejected: {
    arrows: () => [
      { kind: "msg", from: "PayeeBank", to: "ZC", text: "filter REJECT", dashed: true },
    ],
    blurb: "受取銀行の着金フィルタで拒否",
  },
  ApprovalGranted: {
    arrows: () => [{ kind: "msg", from: "Customer", to: "PayeeBank", text: "承認" }],
    blurb: "受取顧客が着金を承認",
  },
  ApprovalDenied: {
    arrows: () => [{ kind: "msg", from: "Customer", to: "PayeeBank", text: "拒否" }],
    blurb: "受取顧客が着金を拒否",
  },
  CreditNotificationAttempted: {
    arrows: () => [{ kind: "note", over: ["ZC"], text: "通知配信試行" }],
    blurb: "クレジット通知の配信を試行",
  },
};

interface NarrativeCtx {
  payerBankId: string;
  payeeBankId: string;
}

/**
 * Static map: given a current state, what FinalityLog event_types are
 * the protocol-legal next steps. Used by the health verdict to suggest
 * what's missing when a transaction looks stuck.
 */
const NEXT_EXPECTED: Record<string, string[]> = {
  RECEIVED: ["PreCheckPassed", "PreCheckFailed", "HtlcLocked"],
  PRECHECKED: ["HReserved", "DecidedToSettle", "DecidedCancel"],
  PRECHECKED_SUSPENDED: ["PreCheckPassed", "DecidedCancel"],
  H_RESERVED: ["DecidedToSettle", "DecidedCancel"],
  DECIDED_TO_SETTLE: ["PayerExecConfirmed", "PayeeExecConfirmed", "Suspended"],
  DECIDED_CANCEL: ["Cancelled"],
  PAYER_EXEC_CONFIRMED: ["PayeeExecConfirmed", "Suspended"],
  PAYEE_EXEC_CONFIRMED: ["Settled"],
  SUSPENDED: ["PayerExecConfirmed", "PayeeExecConfirmed", "FailedExecution"],
  HTLC_LOCKED: ["HtlcFulfillRequested", "HtlcCancelled"],
  HTLC_ONCHAIN_PENDING: ["HtlcFulfillRequested", "HtlcCancelled"],
  HTLC_FULFILL_REQUESTED: ["DecidedToSettle", "FailedExecution"],
  SETTLED: [],
  CANCELLED: [],
  FAILED_EXECUTION: [],
};

const TERMINAL_STATES = new Set(["SETTLED", "CANCELLED", "FAILED_EXECUTION"]);

const STUCK_THRESHOLD_MS = 60_000;
const WATCH_THRESHOLD_MS = 10_000;

export interface StoryResult {
  txid: string;
  lane: string;
  current_state: string;
  parties: { payer_bank_id: string; payee_bank_id: string };
  timeline: TimelineItem[];
  headline: string;
  narrative: string;
  mermaid_sequence: string;
  pacing: {
    started_at: string | null;
    last_event_at: string | null;
    elapsed_ms: number | null;
    longest_gap: { from_event: string; to_event: string; gap_ms: number } | null;
  };
  health: {
    status: "OK" | "WATCH" | "STUCK" | "TERMINAL";
    message: string;
    next_expected: string[];
  };
  integrity: { chain_verified: boolean; entries_checked: number };
}

export async function narrateTransaction(
  db: D1Database,
  txid: string,
  now: Date = new Date()
): Promise<StoryResult | null> {
  const exp = await explainTransaction(db, txid);
  if (!exp) return null;

  const ctx: NarrativeCtx = {
    payerBankId: exp.parties.payer_bank_id,
    payeeBankId: exp.parties.payee_bank_id,
  };

  const headline = renderHeadline(exp);
  const narrative = renderNarrative(exp);
  const mermaid = renderMermaid(exp, ctx);
  const pacing = computePacing(exp);
  const health = computeHealth(exp, pacing.last_event_at, now);

  return {
    txid: exp.txid,
    lane: exp.lane,
    current_state: exp.current_state,
    parties: exp.parties,
    timeline: exp.timeline,
    headline,
    narrative,
    mermaid_sequence: mermaid,
    pacing,
    health,
    integrity: {
      chain_verified: exp.integrity.chain_verified,
      entries_checked: exp.integrity.entries_checked,
    },
  };
}

// ---------------------------------------------------------------------------
// Headline & narrative
// ---------------------------------------------------------------------------

function renderHeadline(exp: ExplainResult): string {
  const amount = formatAmount(exp.amount.value, exp.amount.currency);
  const verb = stateToVerb(exp.current_state);
  return `[${exp.lane}] ${exp.parties.payer_bank_id} → ${exp.parties.payee_bank_id} の ${amount} は${verb}`;
}

function stateToVerb(state: string): string {
  switch (state) {
    case "SETTLED":
      return "最終確定済み";
    case "CANCELLED":
      return "キャンセル済み";
    case "FAILED_EXECUTION":
      return "失敗";
    case "SUSPENDED":
      return "保留中";
    case "PRECHECKED_SUSPENDED":
      return "事前検証の途中で保留中";
    case "H_RESERVED":
      return "H 予約済み";
    case "DECIDED_TO_SETTLE":
      return "確定判断後の銀行処理中";
    case "PAYER_EXEC_CONFIRMED":
      return "出金確認済み・入金待ち";
    case "PAYEE_EXEC_CONFIRMED":
      return "入金確認済み・最終化待ち";
    case "HTLC_LOCKED":
      return "HTLC ロック中";
    case "HTLC_ONCHAIN_PENDING":
      return "クロスチェーン HTLC のオンチェーン観測待ち";
    case "HTLC_FULFILL_REQUESTED":
      return "HTLC 解錠要求中";
    default:
      return `${state} 状態`;
  }
}

/**
 * Build the flowing narrative paragraph. Each timeline entry contributes one
 * clause anchored to its timestamp; gaps over 5 seconds are made explicit so
 * the reader can feel the rhythm of the trade.
 */
function renderNarrative(exp: ExplainResult): string {
  if (exp.timeline.length === 0) {
    return `${exp.txid} は記録された遷移がまだありません。`;
  }

  const amount = formatAmount(exp.amount.value, exp.amount.currency);
  const first = exp.timeline[0]!;
  const opening = `${formatJST(first.at)} に ${exp.parties.payer_bank_id} から ${exp.parties.payee_bank_id} への ${amount} の取引（${exp.lane}）が動き出しました。`;

  const sentences: string[] = [opening];
  for (let i = 0; i < exp.timeline.length; i++) {
    const ev = exp.timeline[i]!;
    const render = EVENT_RENDER[ev.event];
    const blurb = render?.blurb ?? ev.reason;
    if (i === 0) {
      // Skip — already covered by the opening sentence.
      continue;
    }
    const prev = exp.timeline[i - 1]!;
    const gapMs = Date.parse(ev.at) - Date.parse(prev.at);
    const gapPhrase = gapMs >= 5_000 ? `${formatGap(gapMs)}後、` : "";
    sentences.push(`${gapPhrase}${blurb}しました。`);
  }

  // Closing sentence about current state.
  if (TERMINAL_STATES.has(exp.current_state)) {
    sentences.push(`現在は ${exp.current_state} で、${exp.summary}。`);
  } else {
    sentences.push(`現時点では ${exp.current_state}：${exp.summary}。`);
  }

  return sentences.join("");
}

// ---------------------------------------------------------------------------
// Mermaid sequenceDiagram rendering
// ---------------------------------------------------------------------------

function renderMermaid(exp: ExplainResult, ctx: NarrativeCtx): string {
  const lines: string[] = ["sequenceDiagram"];
  lines.push("  autonumber");
  lines.push("  actor Customer as 顧客");
  lines.push(`  participant PayerBank as 送金元銀行 ${ctx.payerBankId}`);
  lines.push("  participant ZC as Zenith Coordinator");
  lines.push(`  participant PayeeBank as 受取銀行 ${ctx.payeeBankId}`);

  for (const ev of exp.timeline) {
    const render = EVENT_RENDER[ev.event];
    const arrows = render
      ? render.arrows(ctx)
      : [{ kind: "note" as const, over: ["ZC" as SeqActor], text: ev.event }];

    for (const a of arrows) {
      if (a.kind === "note") {
        lines.push(`  Note over ${a.over.join(",")}: ${escapeMermaid(a.text)}`);
      } else {
        const arrow = a.dashed ? "-->>" : "->>";
        lines.push(`  ${a.from}${arrow}${a.to}: ${escapeMermaid(a.text)}`);
      }
    }
  }
  return lines.join("\n");
}

function escapeMermaid(s: string): string {
  // Mermaid breaks on stray semicolons and newlines inside labels.
  return s.replace(/[;\n\r]/g, " ").slice(0, 80);
}

// ---------------------------------------------------------------------------
// Pacing & health
// ---------------------------------------------------------------------------

function computePacing(exp: ExplainResult): StoryResult["pacing"] {
  if (exp.timeline.length === 0) {
    return { started_at: null, last_event_at: null, elapsed_ms: null, longest_gap: null };
  }
  const first = exp.timeline[0]!;
  const last = exp.timeline[exp.timeline.length - 1]!;
  let longest: StoryResult["pacing"]["longest_gap"] = null;
  for (let i = 1; i < exp.timeline.length; i++) {
    const gap = Date.parse(exp.timeline[i]!.at) - Date.parse(exp.timeline[i - 1]!.at);
    if (longest === null || gap > longest.gap_ms) {
      longest = {
        from_event: exp.timeline[i - 1]!.event,
        to_event: exp.timeline[i]!.event,
        gap_ms: gap,
      };
    }
  }
  return {
    started_at: first.at,
    last_event_at: last.at,
    elapsed_ms: Date.parse(last.at) - Date.parse(first.at),
    longest_gap: longest,
  };
}

function computeHealth(
  exp: ExplainResult,
  lastEventAt: string | null,
  now: Date
): StoryResult["health"] {
  const expected = NEXT_EXPECTED[exp.current_state] ?? [];
  if (TERMINAL_STATES.has(exp.current_state)) {
    return {
      status: "TERMINAL",
      message: `${exp.current_state}: ${exp.summary}。これ以上の遷移はありません。`,
      next_expected: [],
    };
  }
  if (lastEventAt === null) {
    return {
      status: "WATCH",
      message: "FinalityLog にイベントがまだありません。",
      next_expected: expected,
    };
  }
  const idleMs = now.getTime() - Date.parse(lastEventAt);
  if (idleMs >= STUCK_THRESHOLD_MS) {
    return {
      status: "STUCK",
      message: `最後のイベントから ${formatGap(idleMs)} 経過。${exp.current_state} で停滞しており、${expected.join(" / ") || "次の遷移"} のいずれかが期待されます。キュー再送やケース起票を検討してください。`,
      next_expected: expected,
    };
  }
  if (idleMs >= WATCH_THRESHOLD_MS) {
    return {
      status: "WATCH",
      message: `${formatGap(idleMs)} 待機中。間もなく ${expected.join(" / ") || "次の遷移"} が来る想定です。`,
      next_expected: expected,
    };
  }
  return {
    status: "OK",
    message: `直近の遷移は ${formatGap(idleMs)} 前。順調に進行中です。`,
    next_expected: expected,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatAmount(value: number, currency: string): string {
  if (currency === "JPY") return `¥${value.toLocaleString("ja-JP")}`;
  return `${value.toLocaleString("en-US")} ${currency}`;
}

function formatJST(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Force JST display regardless of host TZ — operator UX is calibrated to JST.
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");
  const ss = String(jst.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss} JST`;
}

function formatGap(ms: number): string {
  if (ms < 1_000) return `${ms} ミリ秒`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} 秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 6_000) / 10} 分`;
  return `${Math.round(ms / 360_000) / 10} 時間`;
}
