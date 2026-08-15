/**
 * @file _mandate_precheck.ts — shared mandate (delegated-authority) precheck.
 *
 * Theme B (Agentic Commerce): when a transaction carries a `mandate_id`, ZC must
 * verify at acceptance time that its amount / purpose / lane fall within the
 * delegated scope (and the mandate is neither expired nor revoked) — walking the
 * full delegation chain. A breach does not hard-reject; it suspends the tx
 * (PRECHECKED → PRECHECKED_SUSPENDED + a Case) for ops review, matching the
 * inline check EXPRESS/STANDARD already perform.
 *
 * This used to live only in EXPRESS and STANDARD, so a mandate-scoped
 * instruction routed through HIGH_VALUE / BULK / (and other async lanes) settled
 * without ever checking the delegation — an authorization divergence: ZC moved
 * money outside the authority it was granted. Centralizing the check here lets
 * every async lane enforce it identically right after it reaches PRECHECKED.
 *
 * @module zc/lanes/_mandate_precheck
 */
import { checkMandate } from "../../shared/mandate";
import { openCase } from "../cases/case";
import { transitionWithLog } from "./_helpers";

export interface MandatePrecheckTx {
  txid: string;
  /** NULL when the instruction carries no delegated authority — check is skipped. */
  mandate_id: string | null;
  amount_value: number;
  purpose: string | null;
  /** Lane name checked against the mandate's `allowed_lanes`. */
  lane: string;
}

/**
 * If `tx` carries a mandate, verify it covers this instruction. On a breach
 * (or an expired/revoked/missing mandate) the tx is moved PRECHECKED →
 * PRECHECKED_SUSPENDED with the mandate `reason_code` and a Case is opened.
 *
 * MUST be called while the tx is in PRECHECKED (the CAS suspend transition is
 * gated on that state). Returns `{ suspended: true }` when the caller should
 * stop advancing the tx.
 */
export async function mandatePrecheckOrSuspend(
  db: D1Database,
  tx: MandatePrecheckTx
): Promise<{ suspended: boolean; reason_code?: string }> {
  if (!tx.mandate_id) return { suspended: false };

  const result = await checkMandate(db, tx.mandate_id, {
    amount: tx.amount_value,
    purpose: tx.purpose ?? undefined,
    lane: tx.lane,
  });
  if (result.ok) return { suspended: false };

  await transitionWithLog(db, {
    txid: tx.txid,
    fromState: "PRECHECKED",
    toState: "PRECHECKED_SUSPENDED",
    eventType: "PreCheckSuspended",
    payload: { reason_code: result.reason_code },
    setColumns: { reason_code: result.reason_code ?? null },
  });
  await openCase(db, {
    related_txid: tx.txid,
    reason_code: result.reason_code!,
    description: result.message,
    opened_by: "ZC",
  });
  return { suspended: true, reason_code: result.reason_code };
}
