/**
 * @file rows/cases.ts — exception/compliance handling row types (Case, Vault,
 *       payment filters, approval requests).
 * @module types/rows/cases
 */
import type { CaseState, FilterScope, FilterType, FilterAction, ApprovalStatus } from "../states";

export interface CaseRow {
  case_id: string;
  related_txid: string | null;
  related_gtid: string | null;
  state: CaseState;
  reason_code: string;
  description: string | null;
  opened_by: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VaultRow {
  vault_ref: string;
  txid: string | null;
  data_type: "AML_EVAL" | "PII" | "RISK_HINT";
  payload_json: string;
  expires_at: string;
  is_evicted: number;
  created_at: string;
}

export interface PaymentFilterRow {
  filter_id: string;
  bank_id: string;
  scope: FilterScope;
  account_id: string | null;
  filter_type: FilterType;
  condition_json: string;
  action: FilterAction;
  description: string | null;
  is_active: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PaymentApprovalRequestRow {
  approval_id: string;
  bank_id: string;
  account_id: string;
  txid: string;
  filter_id: string;
  status: ApprovalStatus;
  sender_bank_id: string;
  sender_account_hash: string | null;
  amount_value: number;
  edi_data: string | null;
  expires_at: string;
  responded_at: string | null;
  created_at: string;
  updated_at: string;
}
