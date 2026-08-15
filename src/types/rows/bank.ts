/**
 * @file rows/bank.ts — participant-bank-side row types (accounts, journals,
 *       ZC request log, suspense, tx/audit logs, credit notifications).
 * @module types/rows/bank
 */
import type {
  AccountType,
  AccountStatus,
  ZcRequestStatus,
  SuspenseDirection,
  SuspenseStatus,
  TxEventStatus,
  NotificationStatus,
} from "../states";

export interface BankAccountRow {
  account_id: string;
  bank_id: string;
  customer_id: string;
  customer_name: string;
  account_type: AccountType;
  status: AccountStatus;
  freeze_reason: string | null;
  opened_at: string;
  closed_at: string | null;
}

export interface BankJournalRow {
  journal_id: string;
  bank_id: string;
  account_id: string;
  amount: number;
  tx_type: string;
  txid: string | null;
  tx_group_id: string;
  description: string | null;
  value_date: string;
  created_at: string;
}

export interface ZcRequestRow {
  request_id: string;
  bank_id: string;
  txid: string | null;
  command_type: string;
  status: ZcRequestStatus;
  response_body: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface SuspenseDetailRow {
  suspense_id: string;
  bank_id: string;
  account_id: string;
  direction: SuspenseDirection;
  status: SuspenseStatus;
  amount: number;
  txid: string | null;
  request_id: string | null;
  dns_cycle_id: string | null;
  expires_at: string | null;
  custody_reason: string | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TxEventLogRow {
  log_id: string;
  txid: string | null;
  correlation_id: string | null;
  actor: string;
  action: string;
  status: TxEventStatus;
  reason_code: string | null;
  amount: number | null;
  bank_id: string | null;
  account_id: string | null;
  details_json: string | null;
  duration_ms: number | null;
  occurred_at: string;
}

export interface BankAuditLogRow {
  log_id: string;
  bank_id: string;
  txid: string | null;
  request_id: string | null;
  command: string;
  status: "OK" | "NG";
  reason_code: string | null;
  amount: number | null;
  account_id: string | null;
  details_json: string | null;
  occurred_at: string;
}

export interface CreditNotificationRow {
  notification_id: string;
  txid: string;
  payee_bank_id: string;
  payee_account_hash: string;
  amount_value: number;
  amount_currency: string;
  payer_bank_id: string;
  payer_name_masked: string | null;
  purpose: string | null;
  edi_summary: string | null;
  status: NotificationStatus;
  delivery_attempts: number;
  max_attempts: number;
  created_at: string;
  delivered_at: string | null;
  next_retry_at: string | null;
}
