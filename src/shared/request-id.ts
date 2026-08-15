// =============================================================================
// src/shared/request-id.ts  Deterministic request ID generation
// =============================================================================
// Centrally manages the request IDs used in ZC → Bank Ingress API calls.
// For idempotency control, the same ID must always be generated for the same command × same transaction.
//
// Naming convention: {COMMAND_PREFIX}-{primary_key}
//   - primary_key is usually txid, but for a GTID leg, leg_id is used
// =============================================================================

/**
 * Prefix constants for Bank Ingress commands.
 * Corresponds to the request_id column of the ZcRequests table.
 */
export const REQUEST_PREFIX = {
  /** AML/sanctions screening */
  AUTHORITY_CHECK: "AUTH",
  /** Account holder name verification */
  NAME_CHECK: "NAME",
  /** Fund reservation */
  RESERVE_FUNDS: "RESERVE",
  /** Originating execution (a) */
  EXECUTE_DEBIT: "DEBIT",
  /** Destination execution (b) */
  EXECUTE_CREDIT: "CREDIT",
  /** Fund reservation release */
  RELEASE_RESERVE: "RELEASE",
  /** HTLC recheck */
  RECHECK: "RECHECK",
  /** Transfer cancellation */
  CANCEL: "CANCEL",
  /** Reservation release on cancellation */
  CANCEL_RELEASE: "CANCEL-RELEASE",
  /** Credit resumption (after incoming credit approval) */
  CREDIT_RESUME: "CREDIT-RESUME",
  /** GTID leg readiness check */
  LEG_READY: "LEG-READY",
} as const;

export type RequestPrefix = (typeof REQUEST_PREFIX)[keyof typeof REQUEST_PREFIX];

/**
 * Generate a deterministic request ID.
 *
 * @param prefix - command type prefix ({@link REQUEST_PREFIX})
 * @param key    - primary key (txid, leg_id, etc.)
 * @returns a string in the form `{prefix}-{key}`
 *
 * @example
 * ```ts
 * makeRequestId(REQUEST_PREFIX.AUTHORITY_CHECK, 'TX-001')
 * // => 'AUTH-TX-001'
 *
 * makeRequestId(REQUEST_PREFIX.LEG_READY, 'LEG-abc')
 * // => 'LEG-READY-LEG-abc'
 * ```
 */
export function makeRequestId(prefix: RequestPrefix, key: string): string {
  return `${prefix}-${key}`;
}
