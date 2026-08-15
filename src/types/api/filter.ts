/**
 * @file api/filter.ts — PaymentFilter (AML/sanctions hold) API types.
 * @module types/api/filter
 */
import type { FilterScope, FilterType, FilterAction } from "../states";
import type { ExecuteCreditResponse } from "./bank-ingress";

export type FilterEvalResult =
  | { matched: false }
  | { matched: true; action: "REJECT"; filter_id: string; reason_code: string }
  | { matched: true; action: "HOLD_CONFIRM"; filter_id: string; approval_id: string }
  | { matched: true; action: "HOLD_MANUAL"; filter_id: string; approval_id: string };

export type ExecuteCreditResult =
  | ExecuteCreditResponse
  | { result: "FILTER_REJECTED"; reason_code: string; filter_id: string }
  | { result: "PENDING_APPROVAL"; approval_id: string };

export interface CreatePaymentFilterRequest {
  scope: FilterScope;
  account_id?: string;
  filter_type: FilterType;
  condition: Record<string, unknown>;
  action: FilterAction;
  description?: string;
  created_by: string;
}

export interface RespondApprovalRequest {
  approved: boolean;
  reason?: string;
}
