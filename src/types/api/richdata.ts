/**
 * @file api/richdata.ts — ZEDI (Zengin EDI), rich-data storage, and cross-border
 *       API types.
 * @module types/api/richdata
 */
import type { FatfR16Data } from "../primitives";
import type { RichDataType } from "../states";

export interface EdiLineItem {
  item_number: number;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
}

export interface EdiRegisterRequest {
  edi_ref: string;
  bank_id: string;
  invoice_number?: string;
  invoice_date?: string;
  payment_due_date?: string;
  tax_amount?: number;
  tax_rate?: number;
  discount_amount?: number;
  note?: string;
  sender_ref?: string;
  receiver_ref?: string;
  line_items?: EdiLineItem[];
  idempotency_key: string;
}

export interface EdiFilterCondition {
  field: "invoice_number" | "note" | "sender_ref" | "receiver_ref" | "amount_range";
  operator: "EQUALS" | "CONTAINS" | "REGEX" | "GT" | "LT";
  value: string;
}

export interface RichDataStoreRequest {
  data_type: RichDataType;
  bank_id: string;
  txid?: string;
  content: Record<string, unknown>;
}

export interface CrossBorderSendRequest {
  cb_txid: string;
  payer_bank_id: string;
  payer_account_id: string;
  foreign_fps_id: string;
  foreign_bank_bic: string;
  foreign_account_id: string;
  foreign_currency: string;
  foreign_amount: number;
  fatf_data: FatfR16Data;
  idempotency_key: string;
}
