/**
 * @file gtid.ts — GTID multi-leg finalization.
 *
 * Checks whether all legs of a Global Transaction have settled (or failed)
 * and drives the GT toward its terminal state.
 */
import { nowISO } from "../../types";
import { writeFinalityLog } from "./finality";
import { assertValidGtidTransition } from "./gtid_state_machine";
import { autoResolveCaseForGtid } from "../cases/case";

/**
 * Check whether all legs of a GTID collaborative transaction have settled.
 * Exported for use by timeout_sweep to recover stuck GTIDs.
 */
export async function checkAndFinalizeGtid(gtid: string, db: D1Database): Promise<void> {
  const now = nowISO();
  const gt = await db
    .prepare(`SELECT state, version, leg_count FROM GtidTransactions WHERE gtid = ?`)
    .bind(gtid)
    .first<{ state: string; version: number; leg_count: number }>();
  if (!gt || gt.state !== "GT_DECIDED_TO_SETTLE") return;

  const legs = await db
    .prepare(
      `SELECT gl.txid, t.state AS tx_state
     FROM GtidLegs gl
     LEFT JOIN Transactions t ON gl.txid = t.txid
     WHERE gl.gtid = ?`
    )
    .bind(gtid)
    .all<{ txid: string; tx_state: string | null }>();

  // Transition to GT_SUSPENDED only on a TERMINAL leg failure. A SUSPENDED leg
  // is transient — e.g. AWAITING_PAYEE_APPROVAL resumes to SETTLED once
  // approved — so suspending the GTID on it would terminally strand an
  // otherwise-completable coordinated transfer (the GTID could never re-reach
  // GT_DECIDED_TO_SETTLE to finalize). A permanently-stuck SUSPENDED leg is
  // converted to FAILED_EXECUTION by the timeout sweep, which then suspends the
  // GTID here. A SUSPENDED leg meanwhile fails the allSettled check below, so
  // finalization simply waits.
  const anyFailed = legs.results.some((l) => l.tx_state === "FAILED_EXECUTION");
  if (anyFailed) {
    // Defense-in-depth: gt.state is read from the DB, so validate the advance
    // against the declared graph before the CAS (the `state !== 'GT_DECIDED_TO_SETTLE'`
    // guard above already constrains it, but this catches a future loosening).
    assertValidGtidTransition(gt.state, "GT_SUSPENDED");
    const failUpdated = await db
      .prepare(
        `UPDATE GtidTransactions SET state='GT_SUSPENDED', updated_at=?, version=version+1
       WHERE gtid=? AND state='GT_DECIDED_TO_SETTLE' AND version=?`
      )
      .bind(now, gtid, gt.version)
      .run();
    if ((failUpdated.meta.changes ?? 0) > 0) {
      await writeFinalityLog(db, {
        txid: null,
        event_type: "GtidSuspended",
        state_from: "GT_DECIDED_TO_SETTLE",
        state_to: "GT_SUSPENDED",
        payload_json: JSON.stringify({ gtid, reason: "LEG_EXECUTION_FAILED" }),
        txid_or_gtid: gtid,
      });
    }
    return;
  }

  // A null-txid leg is considered effectively complete via the PAYER Transaction credit flow
  const allSettled = legs.results.every((l) => l.tx_state === "SETTLED" || l.txid === null);
  if (!allSettled) return;

  // Defense-in-depth: validate the terminal money-moving advance before the CAS.
  assertValidGtidTransition(gt.state, "GT_SETTLED");
  const updated = await db
    .prepare(
      `UPDATE GtidTransactions SET state='GT_SETTLED', legs_settled_count=?, updated_at=?, version=version+1
     WHERE gtid=? AND state='GT_DECIDED_TO_SETTLE' AND version=?`
    )
    .bind(gt.leg_count, now, gtid, gt.version)
    .run();

  if ((updated.meta.changes ?? 0) > 0) {
    await db
      .prepare(
        `UPDATE GtidLegs SET state='LEG_SETTLED', updated_at=?, version=version+1 WHERE gtid=?`
      )
      .bind(now, gtid)
      .run();

    await writeFinalityLog(db, {
      txid: null,
      event_type: "GtidSettled",
      state_from: "GT_DECIDED_TO_SETTLE",
      state_to: "GT_SETTLED",
      payload_json: JSON.stringify({ gtid }),
      txid_or_gtid: gtid,
    });

    // FX linkage: if this GTID is the conduit for a cross-currency FX transfer
    // (docs/specs/20_method_design.md), mark the FxTransfers record SETTLED so its status tracks
    // the actual settlement. No-op for non-FX GTIDs.
    await db
      .prepare(
        `UPDATE FxTransfers SET status='SETTLED', updated_at=? WHERE gtid=? AND status!='SETTLED'`
      )
      .bind(now, gtid)
      .run();

    await autoResolveCaseForGtid(db, gtid);
  }
}
