/**
 * @file ISO 20022 pacs.008 message builder.
 *
 * Builds the pacs.008 (FIToFICustomerCreditTransfer) outbound payment
 * instruction used by the cross-border (FATF R.16) path. ZC carries payments
 * natively end-to-end; pacs.008 is emitted only where an ISO 20022 wire
 * representation is needed for an external counterparty.
 *
 * @module shared/iso20022
 */

import type { Pacs008Message, FatfR16Data, Pacs008Debtor, Pacs008Creditor } from "../types";
import { bicToBankId } from "./routing";

/**
 * Build a pacs.008 (FIToFICustomerCreditTransfer) message.
 *
 * @param params - Transfer parameters (amounts, parties, optional FATF/EDI data)
 * @returns Populated Pacs008Message
 */
export function buildPacs008(params: {
  msgId: string;
  txid: string;
  amount: number;
  currency: string;
  payerBankBic: string;
  payerAccount: string;
  payerName: string;
  payeeBankBic: string;
  payeeAccount: string;
  payeeName: string;
  purpose?: string;
  fatf?: FatfR16Data;
  ediRef?: string;
}): Pacs008Message {
  const now = new Date().toISOString();

  const debtor: Pacs008Debtor = {
    name: params.payerName,
    account_id: params.payerAccount,
    bank_id: bicToBankId(params.payerBankBic) ?? params.payerBankBic,
    bank_bic: params.payerBankBic,
  };

  const creditor: Pacs008Creditor = {
    name: params.payeeName,
    account_id: params.payeeAccount,
    bank_id: bicToBankId(params.payeeBankBic) ?? params.payeeBankBic,
    bank_bic: params.payeeBankBic,
  };

  const msg: Pacs008Message = {
    message_type: "pacs.008",
    message_id: params.msgId,
    creation_datetime: now,
    number_of_transactions: 1,
    settlement_method: "CLRG",
    debtor,
    creditor,
    instructed_amount: { value: params.amount, currency: params.currency },
  };

  if (params.purpose) {
    msg.purpose_code = params.purpose;
  }

  if (params.ediRef || params.txid) {
    msg.remittance_info = {
      structured: {
        creditor_ref: params.txid,
        edi_ref: params.ediRef,
      },
    };
  }

  if (params.fatf) {
    msg.regulatory_reporting = params.fatf;
  }

  return msg;
}
