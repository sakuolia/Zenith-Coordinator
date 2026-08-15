/**
 * @file HTLC cancel — cancelHtlc shared by the create, claim, and cross-chain
 *       submodules. Delegates the dual-table CAS (HtlcContracts + Transactions)
 *       and H release order to cancelInFlightTx.
 * @module zc/lanes/htlc/cancel
 */
import type { Env, ReleaseReserveRequest } from "../../../types";
import { nowISO } from "../../../types";
import { cancelInFlightTx } from "../_helpers";
import { callBankReleaseReserve } from "../../orchestrator";

/**
 * Cancel an HTLC contract and its linked transaction.
 *
 * The dual-table CAS (HtlcContracts + Transactions) and H release order are
 * delegated to `cancelInFlightTx` — the canonical Transactions UPDATE is the
 * primary commit, HtlcContracts is a side update inside the same batch.
 *
 * `issuer` (単一所有者則): defaults to 'ZC'. A cancel of an
 * HTLC_ONCHAIN_PENDING row is only valid either as the Watcher set
 * (issuer='CHAIN:default', a watcher-driven exit) or as ZC AFTER the
 * outer-timelock lease-expiry reclaim (期限切れ→回収, see the sweep step 4 and
 * recordOnchainFulfillment) — cancelInFlightTx enforces this.
 */
export async function cancelHtlc(
  htlcId: string,
  txid: string,
  reasonCode: string,
  db: D1Database,
  env?: Env,
  issuer?: string
): Promise<void> {
  const now = nowISO();
  const txForH = await db
    .prepare(`SELECT h_reservation_id FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ h_reservation_id: string | null }>();

  const cancelled = await cancelInFlightTx(db, {
    txid,
    reasonCode,
    fromStates: ["RECEIVED", "HTLC_LOCKED", "HTLC_ONCHAIN_PENDING", "HTLC_FULFILL_REQUESTED"],
    eventType: "HtlcCancelled",
    payloadExtra: { htlc_id: htlcId },
    issuer,
    sideUpdates: [
      {
        sql: `UPDATE HtlcContracts SET state='DECIDED_CANCEL', version=version+1, updated_at=?
            WHERE htlc_id=? AND state NOT IN ('DECIDED_TO_SETTLE','SETTLED')`,
        binds: [now, htlcId],
      },
    ],
  });

  if (!cancelled) {
    console.warn(
      `[cancelHtlc] state guard prevented cancel for htlc_id=${htlcId} (already settled or decided)`
    );
    return;
  }

  // Since reserve-funds is already done at HTLC_LOCKED, also release the bank-side segregated deposit (suspense).
  if (env) {
    const htlcRow = await db
      .prepare(`SELECT payer_bank_id FROM HtlcContracts WHERE htlc_id = ?`)
      .bind(htlcId)
      .first<{ payer_bank_id: string }>();
    if (htlcRow) {
      const suspense = await db
        .prepare(
          `SELECT suspense_id FROM SuspenseDetails WHERE txid=? AND bank_id=? AND status='RESERVED' AND direction='PAY' LIMIT 1`
        )
        .bind(txid, htlcRow.payer_bank_id)
        .first<{ suspense_id: string }>();
      await callBankReleaseReserve(
        htlcRow.payer_bank_id,
        {
          request_id: `HTLC-CANCEL-${htlcId}`,
          txid,
          reservation_ref: suspense?.suspense_id ?? txForH?.h_reservation_id ?? "",
        } as ReleaseReserveRequest,
        env
      ).catch((e) => console.error(`[cancelHtlc] bank release-reserve failed for ${htlcId}:`, e));
    }
  }
}
