/**
 * @file api/customer.ts — Bank customer-facing API types (balance, transfers,
 *       account verification, RTP response).
 * @module types/api/customer
 */
import type { Amount } from "../primitives";
import type { LaneType, PurposeType } from "../states";

export interface BalanceResponse {
  account_id: string;
  balance: number;
  currency: string;
  as_of: string;
}

export interface CustomerTransferRequest {
  amount: Amount;
  payee_bank_id?: string;
  payee_account_hash?: string;
  payee_account_id?: string;
  lane: LaneType;
  purpose: PurposeType;
  idempotency_key: string;
  pspr_ref?: string;
}

export interface SimpleTransferRequest {
  amount: Amount;
  payee_account_id: string;
  lane: LaneType;
  purpose: PurposeType;
  idempotency_key: string;
  payer_account_id?: string;
}

// Account Verification API (ZC-side)
export interface AccountVerifyRequest {
  verification_id: string;
  request_bank_id: string;
  target_bank_id: string;
  target_account_id: string;
  name_to_verify?: string;
  idempotency_key: string;
}

export interface AccountVerifyBatchRequest {
  batch_id: string;
  request_bank_id: string;
  items: Array<{
    target_bank_id: string;
    target_account_id: string;
    name_to_verify?: string;
  }>;
  idempotency_key: string;
}

// RTP API — payer response
export interface RtpRespondRequest {
  response: "ACCEPTED" | "REJECTED";
  payer_bank_id: string;
  payer_account_id: string;
  idempotency_key: string;
}
