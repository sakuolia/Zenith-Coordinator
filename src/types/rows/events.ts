/**
 * @file rows/events.ts — event-delivery and entity-state-history row types.
 * @module types/rows/events
 */
import type { StreamEventType } from "../states";

export interface EventStreamRow {
  event_id: string;
  target_bank_id: string;
  event_type: StreamEventType;
  payload_json: string;
  is_delivered: number;
  created_at: string;
}

/**
 * EntityStateLog table: append-only history of status transitions for entities
 * outside the Transactions money-path state machine (Cases, PSPR capabilities,
 * bank account status, reversals). INSERT-ONLY — never updated.
 */
export interface EntityStateLogRow {
  log_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  state_from: string | null;
  state_to: string;
  reason_code: string | null;
  actor: string | null;
  payload_json: string | null;
  occurred_at: string;
}
