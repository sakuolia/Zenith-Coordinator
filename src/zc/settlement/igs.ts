/**
 * @file IGS (Interbank Gross Settlement) / BOJ-Net integration for HIGH_VALUE
 *       lane. Manages RTGS-like settlement requests and callbacks.
 * @module zc/igs
 */
import type { Env, IgsRequestRow, IgsCallbackInput } from "../../types";
import { nowISO, businessDateJST, nostroAccountId } from "../../types";
import { settlementAccountId } from "../../shared/central_bank";
import { newUUID } from "../../shared/idempotency";
import { writeFinalityLog } from "../orchestrator";
import { transitionWithLog, transferOwnership, OWNER_VENUE_BOJ } from "../lanes/_helpers";
import { insertJournalGroup } from "../../bank/ledger";

// ---------------------------------------------------------------------------
// initiateIgsSettlement
// ---------------------------------------------------------------------------
/**
 * Creates an IgsRequests record and sends a settlement request to the BOJ (mock).
 * In the mock, it sends a ZC_IGS_CALLBACK message to the Queue equivalent to 2 seconds later for automatic confirmation.
 * If the Queue is unavailable, it falls back to attempting asynchronous confirmation via a Promise.
 *
 * @returns ext_instruction_id
 */
export async function initiateIgsSettlement(
  db: D1Database,
  txid: string,
  amount: { value: number; currency: string },
  payerBankId: string,
  payeeBankId: string,
  env: Env
): Promise<string> {
  const extId = `IGS-${newUUID()}`;
  const now = nowISO();

  await db
    .prepare(
      `INSERT OR IGNORE INTO IgsRequests
     (ext_instruction_id, txid, payer_bank_id, payee_bank_id,
      amount_value, amount_currency, status, retry_count, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, 'REQUESTED', 0, ?)`
    )
    .bind(extId, txid, payerBankId, payeeBankId, amount.value, amount.currency, now)
    .run();

  // Mock: auto-fire BOJ confirmation via Queue after 2 seconds
  const callbackMsg = {
    type: "ZC_IGS_CALLBACK" as const,
    payload: {
      ext_instruction_id: extId,
      result: "SETTLED",
      boj_settle_ref: `BOJ-${newUUID()}`,
    } satisfies IgsCallbackInput,
    txid,
    attempt: 0,
    enqueued_at: now,
  };

  try {
    // Cloudflare Queues: send directly since delaySeconds is for future support
    await env.QUEUE.send(callbackMsg);
  } catch (err) {
    // In environments without a Queue configured, process asynchronously via Promise (test fallback)
    console.error("[IGS] Queue send failed, running inline fallback:", err);
    // Attempt the callback as long as the Worker's execution context persists
    Promise.resolve().then(async () => {
      try {
        await handleIgsCallback(db, callbackMsg.payload, env);
      } catch (e) {
        console.error("[IGS] inline fallback callback failed:", e);
      }
    });
  }

  return extId;
}

// ---------------------------------------------------------------------------
// handleIgsCallback
// ---------------------------------------------------------------------------
/**
 * Process the callback from BOJ and advance the transaction state.
 * SETTLED → payee execute-credit → Transactions.state = SETTLED
 * FAILED / HOLD → Transactions.state = SUSPENDED
 */
export async function handleIgsCallback(
  db: D1Database,
  input: IgsCallbackInput,
  env: Env
): Promise<void> {
  const { ext_instruction_id, result, boj_settle_ref, reason } = input;
  const now = nowISO();

  // Fetch IgsRequests
  const igsRow = await db
    .prepare(`SELECT * FROM IgsRequests WHERE ext_instruction_id = ?`)
    .bind(ext_instruction_id)
    .first<IgsRequestRow>();

  if (!igsRow) {
    console.error("[IGS] callback: IgsRequests row not found:", ext_instruction_id);
    return;
  }
  if (igsRow.status !== "REQUESTED") {
    // Idempotent: ignore if already processed
    return;
  }

  if (result === "SETTLED") {
    // Update IgsRequests to SETTLED
    await db
      .prepare(
        `UPDATE IgsRequests
       SET status = 'SETTLED', boj_settle_ref = ?, settled_at = ?
       WHERE ext_instruction_id = ? AND status = 'REQUESTED'`
      )
      .bind(boj_settle_ref ?? null, now, ext_instruction_id)
      .run();

    // 単一所有者則 (§5.2 handoff #3, return leg): the venue's settled fact and
    // the ownership return commit as ONE batch — `external_settlement_status`
    // flips to SETTLED and `owner` returns to 'ZC', so the subsequent
    // ZC-issued credit/settle transitions pass the ownership guard.
    await transferOwnership(db, {
      txid: igsRow.txid,
      fromOwner: OWNER_VENUE_BOJ,
      toOwner: "ZC",
      payload: {
        reason: "IGS_SETTLED",
        ext_instruction_id,
        boj_settle_ref: boj_settle_ref ?? null,
      },
      setColumns: { external_settlement_status: "SETTLED" },
    });

    // Fetch Transactions
    const tx = await db
      .prepare(
        `SELECT state, payee_bank_id, amount_value, decision_proof_ref,
                payee_account_hash, version
         FROM Transactions WHERE txid = ?`
      )
      .bind(igsRow.txid)
      .first<{
        state: string;
        payee_bank_id: string;
        amount_value: number;
        decision_proof_ref: string | null;
        payee_account_hash: string | null;
        version: number;
      }>();

    if (!tx) {
      console.error("[IGS] callback: Transactions row not found:", igsRow.txid);
      return;
    }

    // Check state with optimistic locking (state equivalent to PAYER_EXEC_CONFIRMED or A_EXEC_OK)
    // In the HIGH_VALUE lane, the state becomes PAYER_EXEC_CONFIRMED after ZC_BANK_DEBIT completes
    if (tx.state !== "PAYER_EXEC_CONFIRMED") {
      console.error("[IGS] callback: unexpected state:", tx.state, "for txid:", igsRow.txid);
      return;
    }

    // ---------------------------------------------------------------------------
    // BOJ settlement journal entry (prefunded RTGS: immediate gross settlement)
    // Transfer BOJ current account directly at IGS finalization, bypassing DNS settlement
    //
    // Payer bank: ZCS(-amount) / BOJ(+amount)  [resolves ZCS funding obligation, consumes BOJ prefunding balance (|balance|↓)]
    // Payee bank: ZCS(+amount) / BOJ(-amount)  [records ZCS receivable, restores BOJ current balance (|balance|↑)]
    //
    // Note: BOJ account sign convention: prefunding balance is managed as a negative value.
    //   Payer bank BOJ(+amount) → negative balance approaches 0 → consumes prefunding capacity.
    //   Payee bank BOJ(-amount) → negative balance grows     → current account balance recovers.
    //
    // Each group is zero-sum ✓ and bank_id corresponds to each row
    // ---------------------------------------------------------------------------
    const valueDate = businessDateJST(now);
    const amount = igsRow.amount_value;

    // Payer bank (payer) BOJ settlement journal entry
    await insertJournalGroup(db, {
      bankId: igsRow.payer_bank_id,
      txGroupId: `IGS-BOJ-PAY-${igsRow.txid}`,
      currency: igsRow.amount_currency,
      entries: [
        {
          accountId: nostroAccountId(igsRow.payer_bank_id),
          amount: -amount,
          txType: "TRANSFER",
          txid: igsRow.txid,
          description: `HV RTGS IGS決済 支払行ZCS解消`,
        },
        {
          accountId: settlementAccountId(igsRow.payer_bank_id, igsRow.amount_currency),
          amount: amount,
          txType: "TRANSFER",
          txid: igsRow.txid,
          description: `HV RTGS IGS決済 支払行中銀事前拠出残消費`,
        },
      ],
      valueDate,
    });

    // Payee bank (payee) BOJ settlement journal entry
    await insertJournalGroup(db, {
      bankId: igsRow.payee_bank_id,
      txGroupId: `IGS-BOJ-RCV-${igsRow.txid}`,
      currency: igsRow.amount_currency,
      entries: [
        {
          accountId: nostroAccountId(igsRow.payee_bank_id),
          amount: amount,
          txType: "TRANSFER",
          txid: igsRow.txid,
          description: `HV RTGS IGS決済 受取行ZCS計上`,
        },
        {
          accountId: settlementAccountId(igsRow.payee_bank_id, igsRow.amount_currency),
          amount: -amount,
          txType: "TRANSFER",
          txid: igsRow.txid,
          description: `HV RTGS IGS決済 受取行中銀当座残回復`,
        },
      ],
      valueDate,
    });

    await writeFinalityLog(db, {
      txid: igsRow.txid,
      event_type: "IgsConfirmed",
      state_from: "PAYER_EXEC_CONFIRMED",
      state_to: "PAYER_EXEC_CONFIRMED",
      payload_json: JSON.stringify({ ext_instruction_id, boj_settle_ref: boj_settle_ref ?? null }),
      txid_or_gtid: igsRow.txid,
    });

    // Send payee execute-credit to the queue
    await env.QUEUE.send({
      type: "ZC_BANK_CREDIT",
      payload: {
        txid: igsRow.txid,
        payee_bank_id: tx.payee_bank_id,
        amount: { value: tx.amount_value, currency: "JPY" },
        decision_proof_ref: tx.decision_proof_ref ?? "",
        payee_account_hash: tx.payee_account_hash ?? undefined,
      },
      txid: igsRow.txid,
      attempt: 0,
      enqueued_at: now,
    });
  } else {
    // FAILED / HOLD
    // HOLD: temporary hold (e.g. BOJ-NET liquidity shortage) → retryFailedIgs retries
    // FAILED: permanent failure → retryFailedIgs retries (up to the retry_count limit)
    const newStatus = result === "HOLD" ? "HOLD" : "FAILED";
    await db
      .prepare(
        `UPDATE IgsRequests
       SET status = ?, failed_reason = ?
       WHERE ext_instruction_id = ? AND status = 'REQUESTED'`
      )
      .bind(newStatus, reason ?? result, ext_instruction_id)
      .run();

    // 単一所有者則 (§5.2 handoff #3, fail leg): the venue itself issues the
    // suspending transition (issuer='VENUE:BOJ') and returns ownership in the
    // same batch — the failed fact, the suspend, and the custody return are
    // one atomic commit (previously three separate raw UPDATEs).
    const suspended = await transitionWithLog(db, {
      txid: igsRow.txid,
      fromState: "PAYER_EXEC_CONFIRMED",
      toState: "SUSPENDED",
      eventType: "Suspended",
      issuer: OWNER_VENUE_BOJ,
      payload: { reason: "IGS_FAILED", ext_instruction_id, boj_reason: reason },
      setColumns: {
        reason_code: "IGS_FAILED",
        external_settlement_status: newStatus,
        owner: "ZC",
      },
    });
    if (!suspended.applied) {
      console.error(
        `[IGS] callback: ${result} for ${igsRow.txid} did not apply (state=${suspended.previousState})`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// retryFailedIgs
// ---------------------------------------------------------------------------
/**
 * Called from cron. Retries IgsRequests that are FAILED or REQUESTED (equivalent to timeout)
 * and have retry_count < 3.
 */
export async function retryFailedIgs(db: D1Database, env: Env): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT * FROM IgsRequests
       WHERE status IN ('FAILED', 'HOLD') AND retry_count < 3`
    )
    .all<IgsRequestRow>();

  for (const row of rows.results ?? []) {
    const now = nowISO();
    // Increment retry_count and reset status back to REQUESTED
    const upd = await db
      .prepare(
        `UPDATE IgsRequests
       SET status = 'REQUESTED', retry_count = retry_count + 1,
           failed_reason = NULL, requested_at = ?
       WHERE ext_instruction_id = ? AND retry_count < 3`
      )
      .bind(now, row.ext_instruction_id)
      .run();

    if ((upd.meta.changes ?? 0) === 0) continue;

    console.log("[IGS] retrying:", row.ext_instruction_id, "attempt:", row.retry_count + 1);

    // Bug B fix: if the TX has fallen to SUSPENDED, restore it to PAYER_EXEC_CONFIRMED before
    // enqueuing the callback. handleIgsCallback only accepts PAYER_EXEC_CONFIRMED.
    const txState = await db
      .prepare(`SELECT state, owner FROM Transactions WHERE txid = ?`)
      .bind(row.txid)
      .first<{ state: string; owner: string }>();
    if (txState?.state === "SUSPENDED") {
      // Re-submission is a new handoff: the recovery transition re-stamps
      // REQUESTED and hands ownership back to the venue in the same batch —
      // symmetric to the initial submission stamp in the ZC_BANK_DEBIT path.
      const recovered = await transitionWithLog(db, {
        txid: row.txid,
        fromState: "SUSPENDED",
        toState: "PAYER_EXEC_CONFIRMED",
        eventType: "IgsRetryRecovered",
        payload: { ext_instruction_id: row.ext_instruction_id, retry_count: row.retry_count + 1 },
        setColumns: {
          reason_code: null,
          external_settlement_status: "REQUESTED",
          owner: OWNER_VENUE_BOJ,
        },
      });
      if (!recovered.applied) {
        console.warn("[IGS] retry recovery CAS failed for txid:", row.txid, "- skipping retry");
        continue;
      }
    } else if (txState?.state === "PAYER_EXEC_CONFIRMED") {
      // The fail callback returned ownership to ZC without a suspend having
      // stuck (or a redelivered fail raced the suspend) — hand the row back to
      // the venue before replaying the callback, so the settled leg's
      // ownership return finds the owner it expects.
      if (txState.owner !== OWNER_VENUE_BOJ) {
        const rehandoff = await transferOwnership(db, {
          txid: row.txid,
          fromOwner: "ZC",
          toOwner: OWNER_VENUE_BOJ,
          payload: { reason: "IGS_RETRY", ext_instruction_id: row.ext_instruction_id },
          setColumns: { external_settlement_status: "REQUESTED" },
        });
        if (!rehandoff.applied) {
          console.warn("[IGS] retry re-handoff failed for txid:", row.txid, "- skipping retry");
          continue;
        }
      }
    } else {
      console.warn(
        "[IGS] retry: unexpected TX state",
        txState?.state,
        "for txid:",
        row.txid,
        "- skipping"
      );
      continue;
    }

    const callbackPayload: IgsCallbackInput = {
      ext_instruction_id: row.ext_instruction_id,
      result: "SETTLED",
      boj_settle_ref: `BOJ-RETRY-${newUUID()}`,
    };

    try {
      await env.QUEUE.send({
        type: "ZC_IGS_CALLBACK",
        payload: callbackPayload,
        txid: row.txid,
        attempt: row.retry_count + 1,
        enqueued_at: now,
      });
    } catch (err) {
      console.error("[IGS] retry queue send failed:", err);
      // Fallback: reprocess inline
      try {
        await handleIgsCallback(db, callbackPayload, env);
      } catch (e) {
        console.error("[IGS] retry inline fallback failed:", e);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// getIgsStatus
// ---------------------------------------------------------------------------
/** Returns the latest IgsRequests record associated with txid. Null if none exists. */
export async function getIgsStatus(db: D1Database, txid: string): Promise<IgsRequestRow | null> {
  return db
    .prepare(`SELECT * FROM IgsRequests WHERE txid = ? ORDER BY requested_at DESC LIMIT 1`)
    .bind(txid)
    .first<IgsRequestRow>();
}
