/**
 * @file reauth.ts — additional authorisation for an out-of-scope collection.
 *
 * A collection that exceeds the standing mandate is not rejected outright while
 * a notice window remains: it waits in AWAITING_ADDITIONAL_AUTH and the window
 * is spent asking the customer. That possibility is the second thing a notice
 * period buys (the first being the chance to stop the collection), and it is
 * the reason REALTIME — which has no window — cannot be rescued at all.
 *
 * Two rules here are the difference between a consumer protection and an
 * over-charging channel:
 *
 *  - **Silence is refusal.** If timeout meant approval, a payee could submit an
 *    over-cap collection and rely on the customer not noticing.
 *  - **The grant is one-shot by default.** "Fifteen thousand is fine this once"
 *    and "collect up to fifteen thousand from now on" are different statements,
 *    and the second one needs asking for separately (`updateCaps`).
 *
 * The one-shot grant cannot be a child of the standing mandate: delegation only
 * ever narrows, so a child can never exceed its parent. It is registered as its
 * own signed mandate scoped to this charge item and this amount.
 *
 * docs/specs/10_requirements.md §3.2.8.7, docs/specs/20_method_design.md §2.2.7.6.
 *
 * @module zc/collection/reauth
 */
import type { DebitMandateRow, Env, ScheduledCollectionRow } from "../../types";
import { nowISO } from "../../types";
import { sha256hex } from "../../shared/hmac";
import { registerMandate } from "../../shared/mandate";
import type { RegisterMandateParams } from "../../shared/mandate";
import { writeFinalityLog } from "../orchestrator";
import { storeVault } from "../platform/vault";

export interface AdditionalAuthParams {
  collectionId: string;
  decision: "APPROVE" | "DECLINE";
  /** Required to approve: the customer's signature over the one-shot grant. */
  mandate?: RegisterMandateParams;
  now?: string;
}

export type AdditionalAuthResult =
  | {
      result: "APPROVED";
      collection_id: string;
      state: string;
      extra_mandate_id: string;
    }
  | { result: "DECLINED"; collection_id: string; state: string }
  | { result: "ERROR"; reason_code: string; message: string };

export async function decideAdditionalAuth(
  env: Env,
  params: AdditionalAuthParams
): Promise<AdditionalAuthResult> {
  const db = env.DB;
  const now = params.now ?? nowISO();

  const row = await db
    .prepare(`SELECT * FROM ScheduledCollection WHERE collection_id = ?`)
    .bind(params.collectionId)
    .first<ScheduledCollectionRow>();
  if (!row) {
    return {
      result: "ERROR",
      reason_code: "COLLECTION_NOT_FOUND",
      message: `no such collection: ${params.collectionId}`,
    };
  }
  if (row.state !== "AWAITING_ADDITIONAL_AUTH") {
    return {
      result: "ERROR",
      reason_code: "STATE_GUARD",
      message: `collection is ${row.state}, not awaiting additional authorisation`,
    };
  }

  if (params.decision === "DECLINE") {
    await db
      .prepare(
        `UPDATE ScheduledCollection
            SET state = 'DECLINED_BY_PAYER', reason_code = 'DECLINED_BY_PAYER',
                updated_at = ?, version = version + 1
          WHERE collection_id = ? AND state = 'AWAITING_ADDITIONAL_AUTH'`
      )
      .bind(now, params.collectionId)
      .run();
    await lapseRemainingRungs(db, row, "DECLINED_BY_PAYER", now);
    await writeFinalityLog(db, {
      txid: null,
      event_type: "CollectionAuthDeclined",
      state_from: row.state,
      state_to: "DECLINED_BY_PAYER",
      payload_json: JSON.stringify({ collection_id: params.collectionId }),
      txid_or_gtid: params.collectionId,
    });
    return { result: "DECLINED", collection_id: params.collectionId, state: "DECLINED_BY_PAYER" };
  }

  if (!params.mandate) {
    return {
      result: "ERROR",
      reason_code: "SIGNATURE_REQUIRED_FOR_RAISE",
      message: "approving an out-of-scope collection needs the customer's signature",
    };
  }

  const contract = await db
    .prepare(`SELECT * FROM DebitMandate WHERE dd_mandate_id = ?`)
    .bind(row.dd_mandate_id)
    .first<DebitMandateRow>();
  if (!contract) {
    return {
      result: "ERROR",
      reason_code: "DD_MANDATE_NOT_FOUND",
      message: `contract missing for ${params.collectionId}`,
    };
  }

  // Registered as a root mandate, not a child: `assertMandateValid` walks the
  // chain narrowing at every link, so a child could never widen what the
  // standing mandate allows.
  const extra = await registerMandate(db, {
    ...params.mandate,
    principalParticipantId: contract.payer_bank_id,
    granteeRef: `${contract.payee_bank_id}:${contract.product_ref}:${row.charge_ref}`,
    parentMandateId: null,
    maxAmount: row.amount_value + row.latefee_value,
    allowedLanes: ["DIRECT_DEBIT"],
  });

  // The scope check now passes, so the authorisation proof is minted exactly as
  // it would have been at notice time.
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  const preimage = Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const hashlock = await sha256hex(preimage);
  const vaultRef = await storeVault(
    db,
    null,
    "HTLC_PREIMAGE",
    { preimage, collection_id: params.collectionId },
    {
      refPrefix: "VLT-COL",
      expiresAt: new Date(Date.parse(row.confirm_deadline_at) + 60 * 60 * 1000).toISOString(),
    }
  );

  const nextState = row.mode === "REALTIME" ? "FROZEN" : "SCHEDULED";
  await db
    .prepare(
      `UPDATE ScheduledCollection
          SET state = ?, reason_code = NULL, extra_mandate_id = ?, vault_ref = ?, hashlock = ?,
              updated_at = ?, version = version + 1
        WHERE collection_id = ? AND state = 'AWAITING_ADDITIONAL_AUTH'`
    )
    .bind(nextState, extra.mandate_id, vaultRef, hashlock, now, params.collectionId)
    .run();

  await writeFinalityLog(db, {
    txid: null,
    event_type: "CollectionAdditionalAuthGranted",
    state_from: "AWAITING_ADDITIONAL_AUTH",
    state_to: nextState,
    payload_json: JSON.stringify({
      collection_id: params.collectionId,
      extra_mandate_id: extra.mandate_id,
      // One-shot: scoped to this charge item and this amount only.
      scope: { charge_ref: row.charge_ref, max_amount: row.amount_value + row.latefee_value },
      hashlock_prefix: hashlock.slice(0, 8),
    }),
    txid_or_gtid: params.collectionId,
  });

  return {
    result: "APPROVED",
    collection_id: params.collectionId,
    state: nextState,
    extra_mandate_id: extra.mandate_id,
  };
}

/**
 * Retire the rest of the ladder.
 *
 * A customer who refused, or never answered, has not agreed to the retries
 * either — and charging a late fee for a collection they declined to authorise
 * would be exactly the abuse the additional-authorisation gate exists to
 * prevent.
 */
async function lapseRemainingRungs(
  db: D1Database,
  row: ScheduledCollectionRow,
  reason: string,
  now: string
): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE ScheduledCollection
          SET state = 'LAPSED', reason_code = ?, updated_at = ?, version = version + 1
        WHERE dd_mandate_id = ? AND charge_ref = ? AND ladder_seq > ?
          AND result IS NULL AND state IN ('SCHEDULED','FROZEN','AWAITING_ADDITIONAL_AUTH')`
    )
    .bind(reason, now, row.dd_mandate_id, row.charge_ref, row.ladder_seq)
    .run();
  return res.meta.changes ?? 0;
}

/**
 * Time out unanswered requests: silence is refusal.
 *
 * Reversing this default would turn the mechanism into an over-charging
 * channel — submit above the cap, wait for the customer not to notice.
 */
export async function sweepUnansweredAuth(
  db: D1Database,
  now: string = nowISO()
): Promise<{ lapsed: number; rungs_lapsed: number }> {
  const rows = await db
    .prepare(
      `SELECT * FROM ScheduledCollection
        WHERE state = 'AWAITING_ADDITIONAL_AUTH' AND confirm_deadline_at <= ?`
    )
    .bind(now)
    .all<ScheduledCollectionRow>();

  let rungsLapsed = 0;
  for (const row of rows.results) {
    await db
      .prepare(
        `UPDATE ScheduledCollection
            SET state = 'LAPSED', reason_code = 'ADDITIONAL_AUTH_UNANSWERED',
                updated_at = ?, version = version + 1
          WHERE collection_id = ? AND state = 'AWAITING_ADDITIONAL_AUTH'`
      )
      .bind(now, row.collection_id)
      .run();
    rungsLapsed += await lapseRemainingRungs(db, row, "ADDITIONAL_AUTH_UNANSWERED", now);
    await writeFinalityLog(db, {
      txid: null,
      event_type: "CollectionAuthLapsed",
      state_from: "AWAITING_ADDITIONAL_AUTH",
      state_to: "LAPSED",
      payload_json: JSON.stringify({
        collection_id: row.collection_id,
        // Recorded explicitly so the default is visible in the audit trail
        // rather than inferred from an absence.
        rule: "silence is refusal",
      }),
      txid_or_gtid: row.collection_id,
    });
  }
  return { lapsed: rows.results.length, rungs_lapsed: rungsLapsed };
}
