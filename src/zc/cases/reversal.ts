/**
 * @file Reversal — post-settlement compensation transactions.
 *
 * Implements the spec's Reversal requirement:
 *   "Cancellation after b (receiving side complete) is prohibited. Remedy is performed via Reversal (a separate transaction)."
 *
 * A Reversal is a NEW transaction that compensates a previously settled
 * transaction. It does NOT modify the original transaction's state (which
 * is terminal at SETTLED). Instead, it creates a mirror-image payment
 * flowing in the opposite direction (payee → payer) and links back to the
 * original via `original_txid`.
 *
 * Reversal lifecycle:
 *   1. Caller requests reversal of a SETTLED transaction
 *   2. ZC validates: original must be SETTLED, reversal amount ≤ original
 *   3. A new TX is created with lane=STANDARD, purpose=REFUND
 *   4. The reversal TX follows the normal state machine (Decision→Execution)
 *   5. ReversalRecords table links original ↔ reversal for audit trail
 *
 * Terminology alignment with the spec:
 *   - Cancel: cancellation before Decision → DECIDED_CANCEL → CANCELLED
 *   - Failure: terminal after Decision but unexecuted → FAILED_EXECUTION
 *   - Reversal: compensation after b → created anew as a separate transaction
 *
 * @module zc/reversal
 */
import type { BankProofRef, Env, TransactionRow } from "../../types";
import { nowISO } from "../../types";
import { newUUID } from "../../shared/idempotency";
import { buildFinalityLogConditionalInsert, prepareFinalityLogRow } from "../orchestrator/finality";
import {
  buildEntityStateLogConditionalInsert,
  transitionEntityWithLog,
} from "../../shared/entity_state_log";
import { openCase } from "./case";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReversalReason =
  | "CUSTOMER_DISPUTE"
  | "DUPLICATE_PAYMENT"
  | "INCORRECT_AMOUNT"
  | "INCORRECT_PAYEE"
  | "FRAUD"
  | "OPERATIONAL_ERROR";

export type ReversalStatus = "REQUESTED" | "APPROVED" | "TX_CREATED" | "COMPLETED" | "REJECTED";

/**
 * Reasons that require an explicit approval reference per spec §2.2:
 *   (a) payee consent — payee consent ref
 *   (b) legal/court order — legal/court order ref
 *   (c) authority request — authority request ref
 *
 * DUPLICATE_PAYMENT and OPERATIONAL_ERROR may be self-certified by the
 * requesting bank (no external approval needed).
 */
export const APPROVAL_REQUIRED_REASONS: ReversalReason[] = [
  "CUSTOMER_DISPUTE",
  "INCORRECT_AMOUNT",
  "INCORRECT_PAYEE",
  "FRAUD",
];

export interface ReversalRequest {
  original_txid: string;
  amount?: number; // partial reversal; omit for full reversal
  reason: ReversalReason;
  requested_by: string; // bank_id or 'OPS'
  idempotency_key: string;
  description?: string;
  /**
   * Reference to the approval basis required by spec §2.2 for certain reasons.
   * Must be provided for: CUSTOMER_DISPUTE, INCORRECT_AMOUNT, INCORRECT_PAYEE, FRAUD.
   * Format: "<type>:<ref_id>" e.g. "PAYEE_CONSENT:CONS-xxx", "COURT_ORDER:ORD-yyy",
   * "AUTHORITY_REQUEST:AUTH-zzz".
   */
  approval_ref?: string;
}

export interface ReversalRecord {
  reversal_id: string;
  original_txid: string;
  reversal_txid: string | null;
  amount: number;
  reason: ReversalReason;
  status: ReversalStatus;
  requested_by: string;
  description: string | null;
  approval_ref: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Request a reversal of a SETTLED transaction.
 *
 * Validates the original transaction, creates a ReversalRecords entry,
 * and (if auto-approved) creates the compensating transaction.
 *
 * @returns reversal_id and the created reversal TX (if approved)
 */
export async function requestReversal(
  req: ReversalRequest,
  env: Env
): Promise<{
  result: "REVERSAL_CREATED" | "REJECTED";
  reversal_id: string;
  reversal_txid?: string;
  reason_code?: string;
  /** Set when the request was refused but received as a CASE instead of dropped. */
  case_id?: string;
}> {
  const db = env.DB;
  const now = nowISO();

  // 0. Idempotent replay. The reversal request (queue / retried HTTP) is
  //    at-least-once: a redelivery with the same idempotency_key must return
  //    the original outcome, never mint a second compensating tx (a double
  //    refund) or throw on that tx's UNIQUE Transactions.idempotency_key.
  //    Rejections create no ReversalRecords row, so they are naturally
  //    idempotent (a redelivery re-evaluates to the same rejection) and are
  //    not cached here.
  const prior = await db
    .prepare(`SELECT reversal_id, reversal_txid FROM ReversalRecords WHERE idempotency_key = ?`)
    .bind(req.idempotency_key)
    .first<{ reversal_id: string; reversal_txid: string | null }>();
  if (prior) {
    // Recovery: if a crash landed between the creation batch commit and the
    // QUEUE.send below, the compensating tx exists but was never enqueued and
    // would stall in RECEIVED forever. Re-enqueue it here (ADVANCE_STANDARD is
    // CAS-idempotent, so re-sending for an already-advanced tx is a safe no-op).
    if (prior.reversal_txid) {
      const revTx = await db
        .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
        .bind(prior.reversal_txid)
        .first<{ state: string }>();
      if (revTx?.state === "RECEIVED") {
        await env.QUEUE.send({
          type: "ZC_STATE_ADVANCE",
          payload: { txid: prior.reversal_txid, action: "ADVANCE_STANDARD" },
          txid: prior.reversal_txid,
          attempt: 0,
          enqueued_at: now,
        });
      }
    }
    return {
      result: "REVERSAL_CREATED",
      reversal_id: prior.reversal_id,
      reversal_txid: prior.reversal_txid ?? undefined,
    };
  }

  // 1. Validate original transaction
  const original = await db
    .prepare(`SELECT * FROM Transactions WHERE txid = ?`)
    .bind(req.original_txid)
    .first<TransactionRow>();

  if (!original) {
    return { result: "REJECTED", reversal_id: "", reason_code: "ORIGINAL_NOT_FOUND" };
  }

  if (original.state !== "SETTLED") {
    return { result: "REJECTED", reversal_id: "", reason_code: "ORIGINAL_NOT_SETTLED" };
  }

  // 1b. Approval policy check (spec §2.2)
  // Post-settlement reversals require documented consent/order for certain reasons.
  if (APPROVAL_REQUIRED_REASONS.includes(req.reason) && !req.approval_ref) {
    return { result: "REJECTED", reversal_id: "", reason_code: "APPROVAL_REF_REQUIRED" };
  }

  // 2. Validate amount
  const reversalAmount = req.amount ?? original.amount_value;
  if (reversalAmount <= 0 || reversalAmount > original.amount_value) {
    return { result: "REJECTED", reversal_id: "", reason_code: "INVALID_REVERSAL_AMOUNT" };
  }

  // 3. Check for existing reversals (prevent over-reversal)
  const existingReversals = await db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total_reversed
       FROM ReversalRecords
       WHERE original_txid = ? AND status IN ('REQUESTED', 'APPROVED', 'TX_CREATED', 'COMPLETED')`
    )
    .bind(req.original_txid)
    .first<{ total_reversed: number }>();

  const totalReversed = existingReversals?.total_reversed ?? 0;
  if (totalReversed + reversalAmount > original.amount_value) {
    return { result: "REJECTED", reversal_id: "", reason_code: "OVER_REVERSAL" };
  }

  // 3b. Cause-of-action gate — layer 1 of the three-layer Reversal gate
  //     (docs/specs/10_requirements.md §4.3.0).
  //
  //     A settled payment is only reversible when moving the funds onward is
  //     *physically* impossible, attested by the payee bank as a
  //     CREDIT_FAILED_PROOF. Account-side conditions (frozen, closed, unknown
  //     account) are deliberately NOT causes: they are absorbed as Custody, and
  //     reversing on them would unwind a settlement that actually completed —
  //     the exact class of "we took it back afterwards" that the rulebook bans.
  //
  //     A request that fails this gate is not dropped: §4.3.0-1 requires it to
  //     be *received as a CASE* and routed to inter-party resolution. A customer
  //     dispute is a real event; it just is not, by itself, grounds to reverse.
  const causeProof = await db
    .prepare(
      `SELECT 1 AS x FROM FinalityLog
       WHERE txid = ? AND event_type = 'CreditFailedProofSubmitted' LIMIT 1`
    )
    .bind(req.original_txid)
    .first<{ x: number }>();
  if (!causeProof) {
    const caseId = await openCase(db, {
      related_txid: req.original_txid,
      reason_code: "CREDIT_FAILED_PROOF_REQUIRED",
      description: `reversal requested by ${req.requested_by} (${req.reason}) without a CREDIT_FAILED_PROOF; routed to inter-party resolution`,
      opened_by: req.requested_by === "OPS" ? "OPS" : "BANK",
    });
    return {
      result: "REJECTED",
      reversal_id: "",
      reason_code: "CREDIT_FAILED_PROOF_REQUIRED",
      case_id: caseId,
    };
  }

  // 4. Create the ReversalRecords ledger row AND the compensating transaction
  //    atomically, in a single db.batch().
  //
  //    Crash-safety: the records row, the compensating tx, both EntityStateLog
  //    facts, and both FinalityLog rows commit-or-roll-back as a unit. The old
  //    flow staged these across four separate awaits, so a crash between the
  //    ReversalRecords INSERT and the compensating-tx INSERT left a phantom
  //    REQUESTED record with reversal_txid=NULL: the idempotent replay (step 0)
  //    then returned REVERSAL_CREATED with no reversal_txid, and the
  //    compensating tx was never minted — a remedy that silently evaporated.
  //
  //    The records row is created directly at TX_CREATED (with reversal_txid
  //    set) rather than REQUESTED→TX_CREATED, since both rows are born together;
  //    the two EntityStateLog facts still record the logical REQUESTED→TX_CREATED
  //    lifecycle for the audit trail.
  const reversalId = `REV-${newUUID()}`;

  // 5. Auto-approve and create compensating transaction
  //    (In production, some reasons would require manual approval)
  const reversalTxid = `TX-REV-${newUUID()}`;

  // Pre-compute both FinalityLog rows (event_seq + hash) so their INSERTs can
  // ride inside the same atomic batch (same machinery as transitionWithLog).
  const requestedLogRow = await prepareFinalityLogRow(db, {
    txid: req.original_txid,
    event_type: "ReversalRequested",
    state_from: "SETTLED",
    state_to: "SETTLED", // original stays SETTLED
    payload_json: JSON.stringify({
      reversal_id: reversalId,
      amount: reversalAmount,
      reason: req.reason,
      approval_ref: req.approval_ref ?? null,
    }),
    txid_or_gtid: req.original_txid,
  });
  const txCreatedLogRow = await prepareFinalityLogRow(db, {
    txid: reversalTxid,
    event_type: "ReversalTxCreated",
    state_from: null,
    state_to: "RECEIVED",
    payload_json: JSON.stringify({
      reversal_id: reversalId,
      original_txid: req.original_txid,
      amount: reversalAmount,
    }),
    txid_or_gtid: reversalTxid,
  });

  //    Over-reversal race: the SUM pre-check (step 3) and this INSERT are two
  //    statements, so two concurrent reversal requests for the same original can
  //    both pass the check and both mint a compensating tx — a double refund that
  //    exceeds the original amount. The pre-check above is kept as a fast clean
  //    rejection, but the AUTHORITATIVE guard is here: the ReversalRecords INSERT
  //    is conditional on re-evaluating the committed reversed-sum in the SAME
  //    statement (`INSERT ... SELECT ... WHERE sum + amount <= original`). SQLite
  //    evaluates the subquery and the insert atomically, so only one of two
  //    racing requests can cross the cap. Every following statement in the batch
  //    is gated on `changes() > 0` of this insert, so the compensating tx and all
  //    audit rows appear iff the records row did — no half-created reversal.
  const batchResults = await db.batch([
    db
      .prepare(
        `INSERT INTO ReversalRecords
     (reversal_id, original_txid, reversal_txid, amount, reason, status,
      requested_by, description, approval_ref, idempotency_key, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, 'TX_CREATED', ?, ?, ?, ?, ?, ?
     WHERE (
       SELECT COALESCE(SUM(amount), 0) FROM ReversalRecords
        WHERE original_txid = ?
          AND status IN ('REQUESTED', 'APPROVED', 'TX_CREATED', 'COMPLETED')
     ) + ? <= ?`
      )
      .bind(
        reversalId,
        req.original_txid,
        reversalTxid,
        reversalAmount,
        req.reason,
        req.requested_by,
        req.description ?? null,
        req.approval_ref ?? null,
        req.idempotency_key,
        now,
        now,
        req.original_txid,
        reversalAmount,
        original.amount_value
      ),
    // Compensating TX: payee→payer (reversed direction). The compensating tx
    // MUST mirror the original's currency — a refund of a USD/EUR settlement is
    // denominated in that same currency, not JPY. Hardcoding 'JPY' here created
    // a cross-currency mint/burn for any non-JPY original (the reversal amount
    // is expressed in the original's minor units).
    // Gated on `changes() > 0` of the ReversalRecords insert above: if the
    // over-reversal guard rejected that insert, the compensating tx is not
    // minted. INSERT...SELECT...WHERE changes()>0 mirrors the FinalityLog
    // conditional-insert idiom; this statement must immediately follow the
    // ReversalRecords insert so `changes()` reflects it.
    db
      .prepare(
        `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      purpose, idempotency_key, schema_version, version, created_at, updated_at,
      pending_since)
     SELECT ?, 'STANDARD', 'RECEIVED', ?, ?, ?, ?, ?, ?, 'REFUND', ?, '1.0', 0, ?, ?, ?
     WHERE changes() > 0`
      )
      .bind(
        reversalTxid,
        reversalAmount,
        original.amount_currency,
        original.payee_bank_id, // original payee becomes payer
        original.payee_account_hash ?? "",
        original.payer_bank_id, // original payer becomes payee
        original.payer_account_hash,
        req.idempotency_key,
        now,
        now,
        // The compensating tx enters at RECEIVED, so T_precheck applies to it
        // from this instant (see timeout_sweep.ts on why not `updated_at`).
        now
      ),
    buildEntityStateLogConditionalInsert(db, {
      entityType: "REVERSAL",
      entityId: reversalId,
      eventType: "ReversalRequested",
      stateFrom: null,
      stateTo: "REQUESTED",
      reasonCode: req.reason,
      actor: req.requested_by,
      payload: { original_txid: req.original_txid, amount: reversalAmount },
    }),
    buildEntityStateLogConditionalInsert(db, {
      entityType: "REVERSAL",
      entityId: reversalId,
      eventType: "ReversalTxCreated",
      stateFrom: "REQUESTED",
      stateTo: "TX_CREATED",
      payload: { reversal_txid: reversalTxid },
    }),
    buildFinalityLogConditionalInsert(db, requestedLogRow),
    buildFinalityLogConditionalInsert(db, txCreatedLogRow),
  ]);

  // If the over-reversal guard rejected the ReversalRecords insert (0 rows), the
  // whole gated chain inserted nothing — surface OVER_REVERSAL and do NOT enqueue
  // a phantom compensating tx. (The fast-path pre-check above usually catches
  // this; here it closes the concurrent race between two reversal requests.)
  if ((batchResults[0]?.meta.changes ?? 0) === 0) {
    return { result: "REJECTED", reversal_id: "", reason_code: "OVER_REVERSAL" };
  }

  // Enqueue the reversal TX for standard processing. A crash after the batch
  // commit but before this send leaves the compensating tx in RECEIVED; the
  // idempotent-replay path (step 0) re-enqueues any such RECEIVED reversal tx.
  await env.QUEUE.send({
    type: "ZC_STATE_ADVANCE",
    payload: { txid: reversalTxid, action: "ADVANCE_STANDARD" },
    txid: reversalTxid,
    attempt: 0,
    enqueued_at: now,
  });

  return {
    result: "REVERSAL_CREATED",
    reversal_id: reversalId,
    reversal_txid: reversalTxid,
  };
}

/**
 * Mark a reversal as COMPLETED when the reversal TX reaches SETTLED.
 * Called from onPayeeExecConfirmed when txid starts with "TX-REV-".
 */
export async function completeReversal(reversalTxid: string, db: D1Database): Promise<void> {
  const now = nowISO();
  const cur = await db
    .prepare(
      `SELECT reversal_id FROM ReversalRecords WHERE reversal_txid = ? AND status = 'TX_CREATED'`
    )
    .bind(reversalTxid)
    .first<{ reversal_id: string }>();
  if (!cur) return;

  await transitionEntityWithLog(db, {
    update: {
      sql: `UPDATE ReversalRecords
     SET status = 'COMPLETED', updated_at = ?
     WHERE reversal_txid = ? AND status = 'TX_CREATED'`,
      binds: [now, reversalTxid],
    },
    transition: {
      entityType: "REVERSAL",
      entityId: cur.reversal_id,
      eventType: "ReversalCompleted",
      stateFrom: "TX_CREATED",
      stateTo: "COMPLETED",
      payload: { reversal_txid: reversalTxid },
    },
  });
}

/**
 * Get reversal records for an original transaction.
 */
export async function getReversals(
  originalTxid: string,
  db: D1Database
): Promise<ReversalRecord[]> {
  const { results } = await db
    .prepare(`SELECT * FROM ReversalRecords WHERE original_txid = ? ORDER BY created_at DESC`)
    .bind(originalTxid)
    .all<ReversalRecord>();
  return results ?? [];
}

/**
 * Get a single reversal record by ID.
 */
export async function getReversalById(
  reversalId: string,
  db: D1Database
): Promise<ReversalRecord | null> {
  return db
    .prepare(`SELECT * FROM ReversalRecords WHERE reversal_id = ?`)
    .bind(reversalId)
    .first<ReversalRecord>();
}

// ---------------------------------------------------------------------------
// Cause-of-action proof (layer 1 of the three-layer Reversal gate)
// ---------------------------------------------------------------------------

export type CreditFailedProofResult =
  | { ok: true; result: "CREDIT_FAILED_PROOF_RECORDED"; txid: string; already: boolean }
  | { ok: false; reason: string; message: string };

/**
 * Record a payee-bank proof that the credit is physically impossible.
 *
 * This is the only thing that opens the Reversal gate
 * (docs/specs/10_requirements.md §4.3.0 第1層, `proof_type=CREDIT_FAILED_PROOF`).
 * The three guards below are all institutional rather than defensive:
 *
 *  - **b must have happened.** Before b there is nothing to reverse; a failure
 *    there converges through cancel or CASE, not Reversal (§4.3.0-4).
 *  - **only the payee bank may attest.** The proof asserts a fact about the
 *    receiving side's ability to deliver funds onward; no other party can know
 *    it, and letting the payer bank assert it would make Reversal self-service.
 *  - **account-side reasons are refused.** Frozen / closed / unknown accounts
 *    are absorbed as Custody by design (§4.3, `20_method_design.md` §6.3.1). Accepting
 *    them here would reintroduce, through the proof, exactly the account-driven
 *    reversal the rulebook forbids.
 *
 * Idempotent: a redelivery returns `already: true` without a second log entry.
 */
export async function submitCreditFailedProof(
  db: D1Database,
  txid: string,
  input: { proof_ref: string; bank_id: string; reason_code?: string }
): Promise<CreditFailedProofResult> {
  if (!input.proof_ref) {
    return { ok: false, reason: "PROOF_REF_REQUIRED", message: "proof_ref is required" };
  }

  const tx = await db
    .prepare(`SELECT state, payee_bank_id FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: string; payee_bank_id: string }>();
  if (!tx) return { ok: false, reason: "TX_NOT_FOUND", message: `transaction ${txid} not found` };

  if (tx.state !== "SETTLED") {
    return {
      ok: false,
      reason: "B_NOT_CONFIRMED",
      message: `${txid} is ${tx.state}; before b there is nothing to reverse — converge via cancel or CASE`,
    };
  }

  if (input.bank_id !== tx.payee_bank_id) {
    return {
      ok: false,
      reason: "PROOF_ISSUER_MISMATCH",
      message: `only the payee bank (${tx.payee_bank_id}) can attest that the credit is impossible`,
    };
  }

  if (input.reason_code && ACCOUNT_SIDE_REASON_CODES.has(input.reason_code)) {
    return {
      ok: false,
      reason: "ACCOUNT_CONDITION_NOT_A_CAUSE",
      message: `${input.reason_code} is an account condition; absorb it as Custody, not as a Reversal cause`,
    };
  }

  const existing = await db
    .prepare(
      `SELECT 1 AS x FROM FinalityLog
       WHERE txid = ? AND event_type = 'CreditFailedProofSubmitted' LIMIT 1`
    )
    .bind(txid)
    .first<{ x: number }>();
  if (existing) {
    return { ok: true, result: "CREDIT_FAILED_PROOF_RECORDED", txid, already: true };
  }

  const proof: BankProofRef = {
    issuer_bank_id: input.bank_id,
    proof_type: "CREDIT_FAILED_PROOF",
    proof_id: input.proof_ref,
    recorded_at: nowISO(),
  };

  const { writeFinalityLog } = await import("../orchestrator");
  await writeFinalityLog(db, {
    txid,
    event_type: "CreditFailedProofSubmitted",
    state_from: tx.state,
    // The proof is evidence about the transaction, not a transition of it: the
    // original stays SETTLED and its history is never rewritten (§4.3).
    state_to: tx.state,
    payload_json: JSON.stringify({
      bank_proof_ref: proof,
      reason_code: input.reason_code ?? null,
    }),
    txid_or_gtid: txid,
  });

  return { ok: true, result: "CREDIT_FAILED_PROOF_RECORDED", txid, already: false };
}

/**
 * Account conditions that must NOT be dressed up as a cause of action. They are
 * exactly the cases Custody exists to absorb (docs/specs/10_requirements.md §4.3).
 */
const ACCOUNT_SIDE_REASON_CODES = new Set([
  "ACCOUNT_FROZEN",
  "ACCOUNT_CLOSED",
  "ACCOUNT_NOT_FOUND",
  "INSUFFICIENT_FUNDS",
  "CLOSING_HOLD",
]);
