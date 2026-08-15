/**
 * @file explain.ts — Operational explainability for a transaction.
 *
 * Renders the FinalityLog chain plus current transaction state as a single
 * human-oriented structure: each state transition is paired with a plain-
 * language reason, and the response carries the tamper-evidence verification
 * so callers can trust what they read.
 */
import type { TxState } from "../../types";
import { verifyChain, CHAIN_ALGORITHM } from "../finality/finality_chain";

interface TransactionSnapshot {
  txid: string;
  lane: string;
  state: string;
  amount_value: number;
  amount_currency: string;
  payer_bank_id: string;
  payee_bank_id: string;
  reason_code: string | null;
  decision_proof_ref: string | null;
  finality_log_ref: string | null;
  payer_bank_proof_ref: string | null;
  payee_bank_proof_ref: string | null;
  case_id: string | null;
  created_at: string;
  updated_at: string;
}

interface FinalityRow {
  log_id: string;
  event_type: string;
  state_from: string | null;
  state_to: string;
  event_seq: number;
  occurred_at: string;
  payload_json: string;
  prev_hash: string | null;
  entry_hash: string | null;
}

export interface TimelineItem {
  seq: number;
  at: string;
  event: string;
  state_from: string | null;
  state_to: string;
  reason: string;
  actors: string[];
  payload: unknown;
}

/**
 * Event-type → Japanese reason. Keys match FinalityEventType. Unknown events fall
 * back to a generic label so new event types do not break the endpoint.
 */
const EVENT_REASONS: Record<string, { reason: string; actors: string[] }> = {
  PaymentInitiated: { reason: "送金リクエストを受け付けました", actors: ["ZC"] },
  PreCheckPassed: { reason: "事前検証（金額・残高・宛先）に合格しました", actors: ["ZC"] },
  PreCheckFailed: { reason: "事前検証に失敗しました", actors: ["ZC"] },
  HReserved: { reason: "送金元銀行で資金を確保しました（H予約）", actors: ["ZC", "PAYER_BANK"] },
  DecidedToSettle: { reason: "決済確定を判断しました", actors: ["ZC"] },
  DecidedCancel: { reason: "決済の中止を判断しました", actors: ["ZC"] },
  PayerExecConfirmed: { reason: "送金元銀行での引き落としを確認しました", actors: ["PAYER_BANK"] },
  PayeeExecConfirmed: { reason: "受取銀行での入金を確認しました", actors: ["PAYEE_BANK"] },
  Settled: { reason: "送金が最終確定しました", actors: ["ZC"] },
  Suspended: { reason: "異常を検知し取引を保留しました（要調査）", actors: ["ZC"] },
  FailedExecution: { reason: "実行中にエラーが発生しました", actors: ["ZC"] },
  Cancelled: { reason: "取引は取り消されました", actors: ["ZC"] },
  HtlcCreated: { reason: "条件付き決済（HTLC）が作成されました", actors: ["ZC"] },
  HtlcLocked: { reason: "HTLC の資金がロックされました", actors: ["PAYER_BANK"] },
  HtlcFulfillRequested: {
    reason: "HTLC の解錠（プリイメージ提示）が行われました",
    actors: ["PAYEE_BANK"],
  },
  HtlcCancelled: { reason: "HTLC がタイムアウトまたはキャンセルされました", actors: ["ZC"] },
  GtidRegistered: { reason: "多脚協調取引（GTID）を登録しました", actors: ["ZC"] },
  GtidDecided: { reason: "全脚の準備完了によりGTIDを確定しました", actors: ["ZC"] },
  GtidSettled: { reason: "GTID の全脚が決済完了しました", actors: ["ZC"] },
  RtpRequested: { reason: "受取側から支払依頼（RTP）を発行しました", actors: ["PAYEE_BANK"] },
  DnsKicked: { reason: "DNS サイクルを起動しました", actors: ["ZC"] },
  DnsSettled: { reason: "DNS ネット清算が完了しました", actors: ["ZC"] },
  DnsHoldActivated: { reason: "DNS サイクルをホールドしました", actors: ["ZC"] },
  FilterRejected: { reason: "受取銀行の着金フィルタで拒否されました", actors: ["PAYEE_BANK"] },
  FilterPending: {
    reason: "受取側の承認待ちで保留されています",
    actors: ["PAYEE_BANK", "CUSTOMER"],
  },
  ApprovalGranted: { reason: "受取顧客が着金を承認しました", actors: ["CUSTOMER"] },
  ApprovalDenied: { reason: "受取顧客が着金を拒否しました", actors: ["CUSTOMER"] },
  HtlcAuthRequested: {
    reason: "HTLC オーソリ（受取側起点）を要求しました",
    actors: ["PAYEE_BANK"],
  },
  HtlcAuthApproved: { reason: "送金側が HTLC オーソリを承認しました", actors: ["PAYER_BANK"] },
  HtlcAuthDeclined: { reason: "送金側が HTLC オーソリを拒否しました", actors: ["PAYER_BANK"] },
  HtlcCaptured: { reason: "HTLC オーソリをキャプチャしました", actors: ["PAYEE_BANK"] },
  HtlcVoided: { reason: "HTLC オーソリを無効化しました", actors: ["ZC"] },
};

/**
 * Top-level summary derived from the current transaction state.
 *
 * Keys MUST cover every `TxState` value — an unmapped state falls back to the
 * raw `状態: ${state}` label, which defeats the explainability contract for that
 * state. `test/zc/explain.test.ts` pins exhaustiveness so a new state cannot be
 * added without a human-readable summary. (A prior version keyed the terminal
 * failure state as "FAILED", which never matched the real `FAILED_EXECUTION`.)
 */
const STATE_SUMMARIES: Record<TxState, string> = {
  RECEIVED: "取引を受け付けた直後です",
  PRECHECKED: "事前検証を通過し、次の処理を待っています",
  PRECHECKED_SUSPENDED: "事前検証の途中で保留中です（受取側の窓口時間外・名義確認待ちなど）",
  H_RESERVED: "送金元で資金を確保済みです",
  HTLC_LOCKED: "条件付き決済（HTLC）の資金をロック済みで、解錠（条件成立）を待っています",
  HTLC_ONCHAIN_PENDING: "クロスチェーン HTLC のオンチェーン・エスクロー観測を待っています",
  HTLC_FULFILL_REQUESTED: "HTLC の解錠（プリイメージ／条件成立）が提示され、決済確定処理中です",
  DECIDED_TO_SETTLE: "決済確定を判断済みで、銀行での入出金処理中です",
  DECIDED_CANCEL: "決済中止を判断済みで、後処理中です",
  PAYER_EXEC_CONFIRMED: "送金元での出金を確認済みで、受取銀行の入金確認を待っています",
  PAYEE_EXEC_CONFIRMED: "受取銀行での入金を確認済みで、最終確定を待っています",
  SETTLED: "送金は正常に最終確定しました",
  CANCELLED: "取引はキャンセルされました",
  SUSPENDED: "異常検知により保留中です。担当者の調査が必要です",
  FAILED_EXECUTION: "実行エラーにより失敗しました",
};

export interface ExplainResult {
  txid: string;
  lane: string;
  current_state: string;
  summary: string;
  reason_code: string | null;
  case_id: string | null;
  amount: { value: number; currency: string };
  parties: { payer_bank_id: string; payee_bank_id: string };
  timeline: TimelineItem[];
  integrity: {
    chain_verified: boolean;
    entries_checked: number;
    break_at_seq: number | null;
    break_reason: string | null;
    algorithm: string;
  };
  proofs: {
    decision_proof_ref: string | null;
    finality_log_ref: string | null;
    payer_bank_proof_ref: string | null;
    payee_bank_proof_ref: string | null;
  };
  timestamps: { created_at: string; updated_at: string };
}

export async function explainTransaction(
  db: D1Database,
  txid: string
): Promise<ExplainResult | null> {
  const tx = await db
    .prepare(
      `SELECT txid, lane, state, amount_value, amount_currency,
              payer_bank_id, payee_bank_id, reason_code,
              decision_proof_ref, finality_log_ref,
              payer_bank_proof_ref, payee_bank_proof_ref, case_id,
              created_at, updated_at
       FROM Transactions WHERE txid = ?`
    )
    .bind(txid)
    .first<TransactionSnapshot>();
  if (!tx) return null;

  const flRows = await db
    .prepare(
      `SELECT log_id, event_type, state_from, state_to, event_seq,
              occurred_at, payload_json, prev_hash, entry_hash
       FROM FinalityLog WHERE txid = ?
       ORDER BY event_seq ASC`
    )
    .bind(txid)
    .all<FinalityRow>();

  const timeline: TimelineItem[] = flRows.results.map((row) => {
    const meta = EVENT_REASONS[row.event_type] ?? { reason: row.event_type, actors: ["ZC"] };
    let payload: unknown = null;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = row.payload_json;
    }
    return {
      seq: row.event_seq,
      at: row.occurred_at,
      event: row.event_type,
      state_from: row.state_from,
      state_to: row.state_to,
      reason: meta.reason,
      actors: meta.actors,
      payload,
    };
  });

  const integrity = await verifyChain(db, txid);
  const summary = STATE_SUMMARIES[tx.state as TxState] ?? `状態: ${tx.state}`;

  return {
    txid: tx.txid,
    lane: tx.lane,
    current_state: tx.state,
    summary,
    reason_code: tx.reason_code,
    case_id: tx.case_id,
    amount: { value: tx.amount_value, currency: tx.amount_currency },
    parties: { payer_bank_id: tx.payer_bank_id, payee_bank_id: tx.payee_bank_id },
    timeline,
    integrity: {
      chain_verified: integrity.valid,
      entries_checked: integrity.entries_checked,
      break_at_seq: integrity.break_at_seq,
      break_reason: integrity.break_reason,
      algorithm: CHAIN_ALGORITHM,
    },
    proofs: {
      decision_proof_ref: tx.decision_proof_ref,
      finality_log_ref: tx.finality_log_ref,
      payer_bank_proof_ref: tx.payer_bank_proof_ref,
      payee_bank_proof_ref: tx.payee_bank_proof_ref,
    },
    timestamps: { created_at: tx.created_at, updated_at: tx.updated_at },
  };
}
