/**
 * @file rows/directory.ts — directory/resolution row types (PSPR, proxy, QR,
 *       account verification).
 * @module types/rows/directory
 */
import type { ProxyType, QrType, VerificationStatus } from "../states";

export interface PsprRegistryRow {
  pspr_ref: string;
  payee_bank_id: string;
  account_hash: string;
  capability_state: "ACTIVE" | "SUSPENDED" | "REVOKED";
  digest: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
}

export interface AccountVerificationRow {
  verification_id: string;
  request_bank_id: string;
  target_bank_id: string;
  target_account_hash: string;
  target_account_name: string | null;
  status: VerificationStatus;
  name_provided: string | null;
  match_score: number | null;
  fraud_warning: number;
  cached_until: string | null;
  idempotency_key: string | null;
  created_at: string;
  responded_at: string | null;
}

export interface ProxyDirectoryRow {
  proxy_id: string;
  proxy_type: ProxyType;
  proxy_value: string;
  bank_id: string;
  account_id: string;
  account_holder_name: string;
  is_active: number;
  registered_at: string;
  updated_at: string;
}

export interface QrCodeRow {
  qr_ref: string;
  qr_type: QrType;
  payee_bank_id: string;
  payee_account_id: string;
  payee_name: string;
  amount_value: number | null;
  amount_currency: string;
  purpose: string | null;
  edi_ref: string | null;
  signature: string;
  is_used: number;
  expires_at: string | null;
  created_at: string;
}
