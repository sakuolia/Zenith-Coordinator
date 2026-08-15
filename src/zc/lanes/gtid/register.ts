/**
 * @file GTID registration — registerGtid (GT_RECEIVED + LEG_REGISTERED).
 * @module zc/lanes/gtid/register
 */
import type { Env, GtidRegisterRequest } from "../../../types";
import { nowISO } from "../../../types";
import { writeFinalityLog } from "../../orchestrator";
import { normalizeGtidLegs } from "./legs";

/**
 * GTID registration: GT_RECEIVED + legs = LEG_REGISTERED
 */
export async function registerGtid(
  req: GtidRegisterRequest,
  env: Env
): Promise<{
  result: "GTID_ACCEPTED";
  gtid: string;
  state: string;
}> {
  const db = env.DB;
  const now = nowISO();
  // Normalize the leg shape into one the payer-driven path settles faithfully:
  // a balanced 1×M fan-out is squared up, and a balanced single-currency general
  // N×M is decomposed into rank-aligned 1:1 sub-transfers (see normalizeGtidLegs).
  const legs = normalizeGtidLegs(req.legs);
  // total_amount is the sum of the PAYER legs (summing all legs would double it)
  const totalAmount = legs
    .filter((l) => l.role === "PAYER")
    .reduce((s, l) => s + l.amount.value, 0);

  const stmts = [
    db
      .prepare(
        `INSERT OR IGNORE INTO GtidTransactions
       (gtid, state, initiator_bank_id, total_amount, leg_count, legs_ready_count,
        legs_settled_count, expires_at, mandate_id, version, created_at, updated_at)
       VALUES (?, 'GT_RECEIVED', ?, ?, ?, 0, 0, ?, ?, 0, ?, ?)`
      )
      .bind(
        req.gtid,
        legs[0]?.bank_id ?? "",
        totalAmount,
        legs.length,
        req.expires_at ?? null,
        req.mandate_id ?? null,
        now,
        now
      ),
  ];

  for (const leg of legs) {
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO GtidLegs
       (leg_id, gtid, role, bank_id, account_hash, amount_value, leg_currency, state, version, created_at, updated_at, origin_leg_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'LEG_REGISTERED', 0, ?, ?, ?)`
        )
        .bind(
          leg.leg_id,
          req.gtid,
          leg.role,
          leg.bank_id,
          leg.account_hash,
          leg.amount.value,
          leg.amount.currency ?? "JPY",
          now,
          now,
          leg.origin_leg_id ?? null
        )
    );
  }

  await db.batch(stmts);

  // Detect whether normalization rewrote the leg set (it always changes leg_ids
  // when it transforms). A general N×M decomposition can keep the *count* the
  // same (e.g. a 2×2 multi-currency square → two 1:1 pairs = 4 legs) while
  // rewriting leg_ids, so compare the leg_id multisets, not just the lengths.
  const inputLegIds = req.legs
    .map((l) => l.leg_id)
    .sort()
    .join(",");
  const normLegIds = legs
    .map((l) => l.leg_id)
    .sort()
    .join(",");
  const transformed = inputLegIds !== normLegIds;
  const payerCount = req.legs.filter((l) => l.role === "PAYER").length;
  const payeeCount = req.legs.filter((l) => l.role === "PAYEE").length;

  await writeFinalityLog(db, {
    txid: null,
    event_type: "GtidRegistered",
    state_from: null,
    state_to: "GT_RECEIVED",
    payload_json: JSON.stringify({
      gtid: req.gtid,
      leg_count: legs.length,
      registered_leg_count: req.legs.length,
      // A single-payer fan-out squares up the PAYER side (count grows); a general
      // N×M decomposition rewrites both sides into rank-aligned 1:1 sub-transfers
      // (leg_ids change, count may stay equal — e.g. a multi-currency 2×2).
      fanout_normalized: payerCount === 1 && payeeCount > 1 && transformed,
      nm_decomposed: payerCount > 1 && payeeCount > 1 && transformed,
    }),
    txid_or_gtid: req.gtid,
  });

  // Run ready-check for all legs asynchronously
  await env.QUEUE.send({
    type: "ZC_BANK_LEG_READY",
    payload: { gtid: req.gtid },
    gtid: req.gtid,
    attempt: 0,
    enqueued_at: now,
  });

  return { result: "GTID_ACCEPTED", gtid: req.gtid, state: "GT_RECEIVED" };
}
