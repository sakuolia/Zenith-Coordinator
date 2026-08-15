/**
 * @file rows/richdata.ts — rich/structured data row types (ZEDI, rich-data
 *       store, cross-border transactions).
 * @module types/rows/richdata
 */
import type { RichDataType, CrossBorderStatus } from "../states";

export interface EdiRecordRow {
  edi_ref: string;
  txid: string | null;
  format_version: string;
  invoice_number: string | null;
  invoice_date: string | null;
  payment_due_date: string | null;
  tax_amount: number | null;
  tax_rate: number | null;
  discount_amount: number | null;
  note: string | null;
  sender_ref: string | null;
  receiver_ref: string | null;
  line_items_json: string | null;
  created_by_bank_id: string;
  created_at: string;
}

export interface RichDataStoreRow {
  data_ref: string;
  data_type: RichDataType;
  txid: string | null;
  content_json: string;
  content_hash: string;
  r2_key: string | null;
  created_by_bank_id: string;
  retention_days: number;
  created_at: string;
  expires_at: string | null;
}

export interface CrossBorderTransactionRow {
  cb_txid: string;
  domestic_txid: string | null;
  direction: "OUTBOUND" | "INBOUND";
  foreign_fps_id: string;
  foreign_bank_bic: string;
  foreign_account_id: string;
  foreign_currency: string;
  foreign_amount: number;
  exchange_rate: number | null;
  domestic_amount: number;
  status: CrossBorderStatus;
  settlement_bank_id: string | null;
  nostro_account_ref: string | null;
  fatf_data_json: string;
  created_at: string;
  updated_at: string;
}
