/**
 * @file state_machine.ts — Transaction state transition validator.
 *
 * Single source of truth for ALLOWED_TRANSITIONS. All state changes in the
 * system must pass through isValidTransition before being committed.
 */
import type { TxState } from "../../types";

/** Exhaustive map of allowed state transitions in the transaction lifecycle. */
export const ALLOWED_TRANSITIONS: Record<TxState, TxState[]> = {
  RECEIVED: ["PRECHECKED", "HTLC_LOCKED", "DECIDED_CANCEL"],
  PRECHECKED: ["PRECHECKED_SUSPENDED", "H_RESERVED", "DECIDED_CANCEL", "DECIDED_TO_SETTLE"], // HIGH_VALUE goes PRECHECKED → DECIDED_TO_SETTLE
  PRECHECKED_SUSPENDED: ["PRECHECKED", "DECIDED_CANCEL"],
  H_RESERVED: ["DECIDED_TO_SETTLE", "DECIDED_CANCEL"],
  DECIDED_TO_SETTLE: ["PAYER_EXEC_CONFIRMED", "PAYEE_EXEC_CONFIRMED", "SUSPENDED"], // PAYEE_EXEC_CONFIRMED: the GTID PAYEE leg requires no debit and confirms the credit directly
  DECIDED_CANCEL: ["CANCELLED"],
  PAYER_EXEC_CONFIRMED: ["PAYEE_EXEC_CONFIRMED", "SUSPENDED"],
  PAYEE_EXEC_CONFIRMED: ["SETTLED"],
  SUSPENDED: ["PAYER_EXEC_CONFIRMED", "PAYEE_EXEC_CONFIRMED", "FAILED_EXECUTION"],
  SETTLED: [],
  FAILED_EXECUTION: [],
  CANCELLED: [],
  HTLC_LOCKED: ["HTLC_FULFILL_REQUESTED", "HTLC_ONCHAIN_PENDING", "DECIDED_CANCEL"],
  // Cross-chain HTLC (docs/specs/20_method_design.md §7.7, docs/specs/30_internal_design.md §15.6):
  // HTLC_LOCKED -> HTLC_ONCHAIN_PENDING (CrossChainLocked,
  // Watcher observes the onchain escrow lock) -> HTLC_FULFILL_REQUESTED
  // (OnchainProofObserved, Watcher observes the onchain release).
  HTLC_ONCHAIN_PENDING: ["HTLC_FULFILL_REQUESTED", "DECIDED_CANCEL"],
  HTLC_FULFILL_REQUESTED: ["DECIDED_TO_SETTLE", "FAILED_EXECUTION"],
};

/**
 * Check whether a state transition is permitted by the state machine.
 *
 * @param from - Current transaction state
 * @param to   - Target transaction state
 * @returns true if the transition is allowed
 */
export function isValidTransition(from: TxState, to: TxState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
