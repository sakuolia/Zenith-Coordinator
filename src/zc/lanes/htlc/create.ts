/**
 * @file HTLC create/lock — createHtlc (RECEIVED) and lockHtlc (RECEIVED →
 *       HTLC_LOCKED), the contract setup half of the HTLC lane.
 * @module zc/lanes/htlc/create
 */

import { DomainError } from "../../../shared/errors";
import { sha256hex } from "../../../shared/hmac";
import { checkMandate } from "../../../shared/mandate";
import { makeRequestId, REQUEST_PREFIX } from "../../../shared/request-id";
import type { Env, HtlcContractRow, HtlcCreateRequest } from "../../../types";
import { nowISO } from "../../../types";
import {
  classifyQuantumRisk,
  type FinalityClass,
  requiredConfirmations,
} from "../../finality/onchain_finality";
import { reserveH } from "../../liquidity/h_model";
import { writeFinalityLog } from "../../orchestrator";
import { validateConditionExpr } from "../../platform/condition_expr";
import { insertTxWithLog, transitionWithLog } from "../_helpers";
import { cancelHtlc } from "./cancel";

/** Generate a random preimage (32-byte hex) */
async function generatePreimage(): Promise<string> {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create a new HTLC.
 * Inserts Transactions as RECEIVED and runs HtlcContracts in parallel as HTLC_RECEIVED.
 * The lockHtlc queue processing transitions RECEIVED → HTLC_LOCKED.
 */
export async function createHtlc(
  req: HtlcCreateRequest,
  env: Env
): Promise<{
  result: "CREATED" | "ERROR";
  htlc_id?: string;
  state?: string;
  reason_code?: string;
  hashlock?: string;
  preimage?: string;
}> {
  const db = env.DB;
  const now = nowISO();
  const txid = `TX-HTLC-${req.htlc_id}`;

  // Auto-generate the hash (when the user has not specified a hashlock)
  let hashlock = req.hashlock;
  let preimage: string | undefined;
  if (!hashlock || hashlock === "") {
    preimage = await generatePreimage();
    hashlock = await sha256hex(preimage);
  }

  // Cross-chain HTLC (テーマA): the same hashlock also locks an onchain
  // escrow observed via Watcher under `cross_chain.source`. Enforce the
  // invariant up front: the ZC-side outer timelock must expire strictly
  // after the onchain inner timelock (so a stuck onchain leg can never
  // outlive ZC's H reservation).
  const crossChainSource = req.cross_chain?.source ?? null;
  const onchainTimelock = req.cross_chain?.onchain_timelock ?? null;
  // Theme A confirmation depth: required confirmations before
  // a release observed at/after the inner timelock may settle. 0 = no gate.
  const onchainMinConfirmations = req.cross_chain?.min_confirmations ?? 0;
  // Watcher quorum: distinct Watcher operators required to attest the onchain
  // release before it settles. The default is finality-class aware: a PUBLIC
  // (probabilistic) chain settles by default only on a 2-of-m quorum, because a
  // single Watcher attesting a reorgable release is the weakest point in the
  // cross-chain trust model. PRIVATE/PERMISSIONED (deterministic) chains keep
  // the single-Watcher default. An explicit `min_watchers` always wins
  // (operator autonomy). A cross-chain leg with no classification is refused
  // below, so "unclassified" never reaches the default.
  const onchainMinWatchers =
    req.cross_chain?.min_watchers ?? (req.onchain_chain_class === "PUBLIC" ? 2 : 1);
  // Theme C: optional whitelisted ConditionTemplate this HTLC may also be
  // fulfilled against via claimHtlcByAttestation (in addition to preimage).
  const conditionTemplateId = req.condition_template_id ?? null;

  // Programmability generalization: optional AND/OR expression over templates.
  // Validate the structure up front so a malformed tree can never lock funds.
  let conditionExprJson: string | null = null;
  if (req.condition_expr_json != null) {
    const v = validateConditionExpr(req.condition_expr_json);
    if (!v.ok) {
      throw new DomainError("CONDITION_EXPR_INVALID", v.error, { htlc_id: req.htlc_id });
    }
    conditionExprJson = JSON.stringify(req.condition_expr_json);
  }

  // Cross-chain finality classification + quantum-risk metadata (B2). PUBLIC
  // chains have probabilistic finality (confirmation depth matters); PRIVATE /
  // PERMISSIONED chains are deterministic. Derived once at lock time so the
  // confirmation gate (recordOnchainFulfillment) and audit can read it back.
  const chainClass = req.onchain_chain_class ?? null;
  const finalityClass = chainClass
    ? chainClass === "PUBLIC"
      ? "PROBABILISTIC"
      : "DETERMINISTIC"
    : null;
  const cryptoSuite = req.onchain_crypto_suite ?? null;
  const quantumRisk =
    req.onchain_quantum_risk ?? (cryptoSuite ? classifyQuantumRisk(cryptoSuite) : null);

  if (crossChainSource) {
    // S-4: the Watcher quorum default is derived from the finality class, so a
    // leg that declares no class silently takes the weakest one (a single
    // Watcher attesting a possibly-reorgable release). Refuse instead of
    // defaulting — the classification is what makes the quorum meaningful, and
    // it is cheap for the caller to state. An explicit `min_watchers` does not
    // substitute: it sets the count, not whether confirmation depth applies.
    if (!chainClass) {
      throw new DomainError(
        "ONCHAIN_CHAIN_CLASS_REQUIRED",
        "onchain_chain_class is required for a cross-chain leg (PUBLIC | PRIVATE | PERMISSIONED)",
        { htlc_id: req.htlc_id, cross_chain_source: crossChainSource }
      );
    }
    if (!onchainTimelock || new Date(onchainTimelock) >= new Date(req.timelock)) {
      throw new DomainError(
        "ONCHAIN_TIMELOCK_INVALID",
        "cross_chain.onchain_timelock must be strictly before timelock (ZC-side outer timelock must expire last)",
        { htlc_id: req.htlc_id, timelock: req.timelock, onchain_timelock: onchainTimelock }
      );
    }
  }

  // Create Transactions at the canonical RECEIVED entry point. Combine the HtlcContracts INSERT and
  // FinalityLog INSERT into the same db.batch() to eliminate the "row exists but audit is missing" window.
  await insertTxWithLog(db, {
    txid,
    lane: "HTLC",
    initialState: "RECEIVED",
    amount: { value: req.amount.value, currency: "JPY" },
    payerBankId: req.payer_bank_id,
    payerAccountHash: req.payer_account_hash,
    payeeBankId: req.payee_bank_id,
    payeeAccountHash: req.payee_account_hash,
    idempotencyKey: req.idempotency_key,
    extraColumns: { mandate_id: req.mandate_id ?? null },
    eventType: "HtlcCreated",
    payload: {
      htlc_id: req.htlc_id,
      hashlock,
      timelock: req.timelock,
      cross_chain_source: crossChainSource,
    },
    sideUpdates: [
      {
        sql: `INSERT OR IGNORE INTO HtlcContracts
            (htlc_id, txid, state, hashlock, timelock, amount_value,
             payer_bank_id, payee_bank_id, secret_verified, authority_recheck_required,
             cross_chain_source, onchain_timelock, condition_template_id,
             onchain_min_confirmations, onchain_min_watchers, condition_expr_json,
             onchain_chain_class, onchain_crypto_suite, onchain_quantum_risk, onchain_finality_class,
             version, created_at, updated_at)
            VALUES (?, ?, 'HTLC_RECEIVED', ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        binds: [
          req.htlc_id,
          txid,
          hashlock,
          req.timelock,
          req.amount.value,
          req.payer_bank_id,
          req.payee_bank_id,
          crossChainSource,
          onchainTimelock,
          conditionTemplateId,
          onchainMinConfirmations,
          onchainMinWatchers,
          conditionExprJson,
          chainClass,
          cryptoSuite,
          quantumRisk,
          finalityClass,
          now,
          now,
        ],
      },
    ],
  });

  // Cross-chain finality classification audit (B2): record how this onchain leg
  // will be treated (probabilistic vs deterministic) and its quantum-risk
  // metadata, so the settlement decision is explainable after the fact.
  if (chainClass) {
    await writeFinalityLog(db, {
      txid,
      event_type: "OnchainFinalityClassified",
      state_from: "HTLC_RECEIVED",
      state_to: "HTLC_RECEIVED",
      payload_json: JSON.stringify({
        htlc_id: req.htlc_id,
        chain_class: chainClass,
        finality_class: finalityClass,
        crypto_suite: cryptoSuite,
        quantum_risk: quantumRisk,
        configured_min_confirmations: onchainMinConfirmations,
        effective_required_confirmations: requiredConfirmations(
          finalityClass as FinalityClass | null,
          onchainMinConfirmations
        ),
      }),
      txid_or_gtid: txid,
    });
  }

  // Asynchronously H-reserve & Lock
  await env.QUEUE.send({
    type: "ZC_BANK_RESERVE",
    payload: { htlc_id: req.htlc_id, txid },
    txid,
    attempt: 0,
    enqueued_at: now,
  });

  return { result: "CREATED", htlc_id: req.htlc_id, state: "HTLC_RECEIVED", hashlock, preimage };
}

/**
 * HTLC Lock processing (called from the QueueConsumer)
 * Transactions: RECEIVED → HTLC_LOCKED
 * HtlcContracts: HTLC_RECEIVED → HTLC_LOCKED (synced via side update within the batch)
 */
export async function lockHtlc(htlcId: string, env: Env): Promise<void> {
  const db = env.DB;
  const now = nowISO();

  const htlc = await db
    .prepare(`SELECT * FROM HtlcContracts WHERE htlc_id = ?`)
    .bind(htlcId)
    .first<HtlcContractRow>();
  if (!htlc || htlc.state !== "HTLC_RECEIVED") return;

  // Cancel immediately if the timelock is in the past (bank suspense not yet created, so env is not needed)
  if (new Date(htlc.timelock) < new Date(now)) {
    await cancelHtlc(htlcId, htlc.txid, "TIMELOCK_EXPIRED", db);
    return;
  }

  // Mandate scope check (Theme B): a delegated HTLC must stay within its
  // mandate's amount/purpose/lane scope. HTLC has no PRECHECKED_SUSPENDED review
  // state, so a breach (or expired/revoked/missing mandate) cancels the contract
  // here — before any H/bank funds are reserved, so the payer is never committed.
  const txMandate = await db
    .prepare(`SELECT mandate_id, purpose FROM Transactions WHERE txid = ?`)
    .bind(htlc.txid)
    .first<{ mandate_id: string | null; purpose: string | null }>();
  if (txMandate?.mandate_id) {
    const mandateResult = await checkMandate(db, txMandate.mandate_id, {
      amount: htlc.amount_value,
      purpose: txMandate.purpose ?? undefined,
      lane: "HTLC",
    });
    if (!mandateResult.ok) {
      await cancelHtlc(htlcId, htlc.txid, mandateResult.reason_code ?? "MANDATE_BREACH", db);
      return;
    }
  }

  // H reservation (ZC side)
  const hResult = await reserveH(htlc.payer_bank_id, htlc.txid, htlc.amount_value, db);
  if (!hResult.ok) {
    await cancelHtlc(htlcId, htlc.txid, hResult.reason, db);
    return;
  }
  const reservationId = hResult.reservation_id;

  // Bank-side reserve-funds
  const txForPayer = await db
    .prepare(`SELECT payer_account_hash FROM Transactions WHERE txid = ?`)
    .bind(htlc.txid)
    .first<{ payer_account_hash: string | null }>();
  const { callBankReserveFunds } = await import("../../orchestrator");
  const reserveResult = await callBankReserveFunds(
    htlc.payer_bank_id,
    {
      request_id: makeRequestId(REQUEST_PREFIX.RESERVE_FUNDS, htlc.txid),
      txid: htlc.txid,
      amount: { value: htlc.amount_value, currency: "JPY" },
      account_hash: txForPayer?.payer_account_hash ?? "",
    },
    env
  );
  if (reserveResult.result === "ERROR") {
    await cancelHtlc(htlcId, htlc.txid, reserveResult.reason_code ?? "RESERVE_FAILED", db);
    return;
  }

  // Transactions: RECEIVED → HTLC_LOCKED via transitionWithLog (validates + atomic log).
  // HtlcContracts UPDATE rides in the same db.batch() via sideUpdates so the
  // two state rows commit-or-rollback together — eliminating the window where
  // Transactions = HTLC_LOCKED but HtlcContracts is still HTLC_RECEIVED.
  await transitionWithLog(db, {
    txid: htlc.txid,
    fromState: "RECEIVED",
    toState: "HTLC_LOCKED",
    eventType: "HtlcLocked",
    payload: { htlc_id: htlcId, reservation_id: reservationId },
    setColumns: { h_reservation_id: reservationId },
    sideUpdates: [
      {
        sql: `UPDATE HtlcContracts SET state='HTLC_LOCKED', version=version+1, updated_at=? WHERE htlc_id=? AND state='HTLC_RECEIVED'`,
        binds: [now, htlcId],
      },
    ],
  });
}
