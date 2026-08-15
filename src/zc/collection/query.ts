/**
 * @file query.ts — contract-scoped views and the published core profile.
 *
 * Two views exist that the existing rails do not offer:
 *
 *  - A contract view that includes the *future* — what will be collected, when,
 *    for how much, including every ladder rung. Today a customer learns the
 *    retry date by telephoning the biller.
 *  - "Everything I have authorised", so a customer can see the whole set of
 *    standing debits against their account in one place and stop any of them.
 *
 * The bank profile is published because it is the one input a payee genuinely
 * cannot derive: they know their own customers, but not when a given paying
 * bank's core runs its passes. It is not secret — operating hours are published
 * in bank terms — so exposing it costs nothing and lets a payee work out for
 * themselves how long a customer has to pay in.
 *
 * @module zc/collection/query
 */
import type { LegacyProfile } from "../../bank/legacy/adapter";
import type {
  CollectionAttemptRow,
  DebitMandateRow,
  MandateBudgetRow,
  ScheduledCollectionRow,
} from "../../types";
import { supportedModes } from "./mandate";

/**
 * Settlement status as seen from outside.
 *
 * `ACCEPTED` means received and checked — NOT collected. A payee that clears a
 * receivable on this value and later sees the collection fail has lost the
 * payment, which is why `confirmed` is always sent alongside it rather than
 * left to be inferred from the name.
 */
export type SettlementStatus = "ACCEPTED" | "CONFIRMED_OK" | "CONFIRMED_NG";

export function settlementStatusOf(row: ScheduledCollectionRow): SettlementStatus {
  if (row.result === "CONFIRMED_OK") return "CONFIRMED_OK";
  if (row.result === "CONFIRMED_NG") return "CONFIRMED_NG";
  return "ACCEPTED";
}

export interface CollectionView {
  collection_id: string;
  charge_ref: string;
  ladder_seq: number;
  state: string;
  settlement_status: SettlementStatus;
  result: string | null;
  /** Always present: `ACCEPTED` alone must never be read as success. */
  confirmed: boolean;
  confirm_deadline_at: string;
  amend_freeze_at: string;
  due_date: string;
  amount: number;
  latefee: number;
  retriable_today: boolean;
  reason_code: string | null;
  txid: string | null;
  attempts: Array<{
    attempt_no: number;
    observed_at: string;
    result: string;
    reason_code: string | null;
    retriable_today: boolean;
  }>;
}

export async function getCollection(
  db: D1Database,
  collectionId: string
): Promise<CollectionView | null> {
  const row = await db
    .prepare(`SELECT * FROM ScheduledCollection WHERE collection_id = ?`)
    .bind(collectionId)
    .first<ScheduledCollectionRow>();
  if (!row) return null;
  const attempts = await db
    .prepare(`SELECT * FROM CollectionAttempt WHERE collection_id = ? ORDER BY attempt_no`)
    .bind(collectionId)
    .all<CollectionAttemptRow>();
  return toView(row, attempts.results);
}

function toView(row: ScheduledCollectionRow, attempts: CollectionAttemptRow[]): CollectionView {
  return {
    collection_id: row.collection_id,
    charge_ref: row.charge_ref,
    ladder_seq: row.ladder_seq,
    state: row.state,
    settlement_status: settlementStatusOf(row),
    result: row.result,
    confirmed: row.result !== null,
    confirm_deadline_at: row.confirm_deadline_at,
    amend_freeze_at: row.amend_freeze_at,
    due_date: row.due_date,
    amount: row.amount_value,
    latefee: row.latefee_value,
    retriable_today: row.retriable_today === 1,
    reason_code: row.reason_code,
    txid: row.txid,
    attempts: attempts.map((a) => ({
      attempt_no: a.attempt_no,
      observed_at: a.observed_at,
      result: a.result,
      reason_code: a.reason_code,
      retriable_today: a.retriable_today === 1,
    })),
  };
}

export interface DebitMandateView {
  dd_mandate_id: string;
  mandate_id: string;
  product_ref: string;
  payer_bank_id: string;
  payee_bank_id: string;
  charge_mode: string;
  period_cycle: string | null;
  collection_mode: string;
  state: string;
  caps: Record<string, number | null>;
  /** Consumption and what remains, so a customer can see their own headroom. */
  budget: Record<string, number | null> | null;
  /** Not yet collected — the part existing rails cannot show. */
  upcoming: CollectionView[];
  history: CollectionView[];
}

const CAP_FIELDS: Array<keyof DebitMandateRow> = [
  "per_collection_cap",
  "month_amount_cap",
  "month_count_cap",
  "two_month_amount_cap",
  "day_count_cap",
  "lifetime_amount_cap",
  "lifetime_count_cap",
  "pending_amount_cap",
  "pending_count_cap",
  "latefee_month_cap",
  "realtime_month_count_cap",
];

export async function getDebitMandate(
  db: D1Database,
  ddMandateId: string
): Promise<DebitMandateView | null> {
  const m = await db
    .prepare(`SELECT * FROM DebitMandate WHERE dd_mandate_id = ?`)
    .bind(ddMandateId)
    .first<DebitMandateRow>();
  if (!m) return null;

  const b = await db
    .prepare(`SELECT * FROM MandateBudget WHERE dd_mandate_id = ?`)
    .bind(ddMandateId)
    .first<MandateBudgetRow>();
  const rows = await db
    .prepare(
      `SELECT * FROM ScheduledCollection WHERE dd_mandate_id = ?
        ORDER BY due_date, ladder_seq`
    )
    .bind(ddMandateId)
    .all<ScheduledCollectionRow>();

  const upcoming: CollectionView[] = [];
  const history: CollectionView[] = [];
  for (const row of rows.results) {
    const attempts = await db
      .prepare(`SELECT * FROM CollectionAttempt WHERE collection_id = ? ORDER BY attempt_no`)
      .bind(row.collection_id)
      .all<CollectionAttemptRow>();
    const view = toView(row, attempts.results);
    (row.result === null ? upcoming : history).push(view);
  }

  const caps: Record<string, number | null> = {};
  for (const f of CAP_FIELDS) caps[f] = m[f] as number | null;

  return {
    dd_mandate_id: m.dd_mandate_id,
    mandate_id: m.mandate_id,
    product_ref: m.product_ref,
    payer_bank_id: m.payer_bank_id,
    payee_bank_id: m.payee_bank_id,
    charge_mode: m.charge_mode,
    period_cycle: m.period_cycle,
    collection_mode: m.collection_mode,
    state: m.state,
    caps,
    budget: b
      ? {
          month_amount: b.month_amount,
          month_count: b.month_count,
          lifetime_amount: b.lifetime_amount,
          lifetime_count: b.lifetime_count,
          pending_amount: b.pending_amount,
          pending_count: b.pending_count,
          month_amount_remaining:
            m.month_amount_cap === null ? null : m.month_amount_cap - b.month_amount,
          lifetime_count_remaining:
            m.lifetime_count_cap === null ? null : m.lifetime_count_cap - b.lifetime_count,
        }
      : null,
    upcoming,
    history,
  };
}

export interface AuthorisedDebitSummary {
  dd_mandate_id: string;
  /** Customer-meaningful: "◯◯ card ****1234", not just the company name. */
  product_ref: string;
  payee_bank_id: string;
  state: string;
  collection_mode: string;
  next_due_date: string | null;
  next_amount: number | null;
}

/**
 * "Everything I have authorised", for one customer account.
 *
 * Listed by `product_ref` rather than by payee, because a customer holding two
 * cards from the same issuer needs to tell them apart — and because the scope
 * they actually consented to was the product, not the company.
 */
export async function listAuthorisedDebits(
  db: D1Database,
  payerAccountAlias: string
): Promise<AuthorisedDebitSummary[]> {
  const rows = await db
    .prepare(`SELECT * FROM DebitMandate WHERE payer_account_alias = ? ORDER BY created_at DESC`)
    .bind(payerAccountAlias)
    .all<DebitMandateRow>();

  const out: AuthorisedDebitSummary[] = [];
  for (const m of rows.results) {
    const next = await db
      .prepare(
        `SELECT due_date, amount_value, latefee_value FROM ScheduledCollection
          WHERE dd_mandate_id = ? AND result IS NULL
            AND state IN ('SCHEDULED','FROZEN','AWAITING_ADDITIONAL_AUTH')
          ORDER BY due_date LIMIT 1`
      )
      .bind(m.dd_mandate_id)
      .first<{ due_date: string; amount_value: number; latefee_value: number }>();
    out.push({
      dd_mandate_id: m.dd_mandate_id,
      product_ref: m.product_ref,
      payee_bank_id: m.payee_bank_id,
      state: m.state,
      collection_mode: m.collection_mode,
      next_due_date: next?.due_date ?? null,
      next_amount: next ? next.amount_value + next.latefee_value : null,
    });
  }
  return out;
}

export interface CollectionProfileView {
  bank_id: string;
  supported_modes: string[];
  center_cut_schedule: string[];
  realtime_name_check: boolean;
  /** Latest useful pay-in time; null when the core is always online. */
  last_attempt_guidance: string | null;
}

/**
 * Publish a paying bank's core profile.
 *
 * Static reference data, not per-collection state: a payee reads it once and
 * computes "a customer at 002 has until 20:00" themselves. Deriving the
 * schedule from the declared window means it stays honest as the profile
 * changes.
 */
export function collectionProfileOf(
  bankId: string,
  profile: LegacyProfile | null
): CollectionProfileView {
  const modes = supportedModes(profile);
  if (!profile || profile.window_open_hour === null || profile.window_close_hour === null) {
    return {
      bank_id: bankId,
      supported_modes: modes,
      center_cut_schedule: [],
      realtime_name_check: profile?.realtime_name_check ?? false,
      last_attempt_guidance: null,
    };
  }
  const open = profile.window_open_hour;
  const close = profile.window_close_hour;
  const hours: number[] = [];
  for (let h = open; h !== close; h = (h + 1) % 24) {
    if ((h - open) % 6 === 0) hours.push(h);
  }
  const fmt = (h: number) => `${String(h).padStart(2, "0")}:00`;
  const last = hours.length > 0 ? hours[hours.length - 1]! : open;
  return {
    bank_id: bankId,
    supported_modes: modes,
    center_cut_schedule: hours.map(fmt),
    realtime_name_check: profile.realtime_name_check,
    last_attempt_guidance: fmt(last),
  };
}
