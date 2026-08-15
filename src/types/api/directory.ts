/**
 * @file api/directory.ts — Proxy directory and QR payment API types.
 * @module types/api/directory
 */
import type { ProxyType, QrType } from "../states";

export interface ProxyRegisterRequest {
  proxy_type: ProxyType;
  proxy_value: string;
  bank_id: string;
  account_id: string;
  account_holder_name: string;
  idempotency_key: string;
}

export interface ProxyResolveResponse {
  proxy_type: ProxyType;
  proxy_value: string;
  bank_id: string;
  account_id: string;
  account_holder_name: string;
  resolved: boolean;
}

export interface QrGenerateRequest {
  type: QrType;
  payee_bank_id: string;
  payee_account_id: string;
  payee_name?: string;
  amount?: number;
  purpose?: string;
  edi_ref?: string;
  expires_at?: string;
}

export interface QrPayRequest {
  qr_ref: string;
  payer_bank_id: string;
  payer_account_id: string;
  amount?: number;
  idempotency_key: string;
}
