/**
 * @file api/iso20022.ts — ISO 20022 pacs.008 message types.
 * @module types/api/iso20022
 */
import type { Amount, FatfR16Data } from "../primitives";

export interface Pacs008Debtor {
  name: string;
  account_id: string;
  bank_id: string;
  bank_bic?: string;
}

export interface Pacs008Creditor {
  name: string;
  account_id: string;
  bank_id: string;
  bank_bic?: string;
}

export interface Pacs008Message {
  message_type: "pacs.008";
  message_id: string;
  creation_datetime: string;
  number_of_transactions: number;
  settlement_method: "CLRG" | "INDA";
  debtor: Pacs008Debtor;
  creditor: Pacs008Creditor;
  instructed_amount: Amount;
  purpose_code?: string;
  remittance_info?: {
    unstructured?: string;
    structured?: {
      creditor_ref?: string;
      invoice_number?: string;
      edi_ref?: string;
    };
  };
  regulatory_reporting?: FatfR16Data;
}
