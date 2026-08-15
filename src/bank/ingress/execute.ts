/**
 * @module bank/ingress/execute
 * @description Fund-movement ingress commands: execute-debit (2),
 * execute-credit (3), debit-settled (11). These finalize the payer debit
 * (a-proof), land the payee credit (b-proof), and acknowledge end-to-end
 * settlement back to the payer bank.
 */
import type {
  Env,
  ExecuteDebitRequest,
  ExecuteDebitResponse,
  ExecuteCreditRequest,
  ExecuteCreditResponse,
  ExecuteCreditResult,
  BankAccountRow,
  BankDebitSettledRequest,
} from "../../types";
import { nowISO, businessDateJST, suspenseAccountId, nostroAccountId } from "../../types";
import { createProof } from "../../shared/proof";
import {
  executeSuspenseDebit,
  landSuspense,
  getAvailableBalance,
  getAccountByHash,
} from "../suspense";
import { insertJournalGroup } from "../ledger";
import { evaluatePaymentFilters } from "../filter";
import { auditLog, checkIdempotency, saveResponse } from "./_shared";

export type { BankDebitSettledRequest };

/**
 * **Command 2: execute-debit** — Finalize the payer-side debit (a-proof).
 *
 * Two paths depending on the lane:
 *
 * - **HIGH_VALUE (RTGS):** Bypasses suspense entirely. Debits the customer
 *   account directly and credits the ZCS nostro account in a single journal
 *   group: Customer(-) / ZCS(+). This avoids the SuspenseDetails leak
 *   that occurred with the old HV_TRANSIT approach (BUG-3 fix).
 *
 * - **Standard/Express/Bulk:** Transitions the existing SuspenseDetails
 *   record from RESERVED to EXECUTED via {@link executeSuspenseDebit}.
 *
 * Generates a bank_proof_ref (a-proof) upon success for ZC verification.
 *
 * @param bankId - Payer bank identifier
 * @param req    - Contains txid, amount, request_id, lane, payer_account_hash
 * @param env    - Worker environment bindings
 * @returns ExecuteDebitResponse with bank_proof_ref, or ERROR
 */
export async function bankExecuteDebit(
  bankId: string,
  req: ExecuteDebitRequest,
  env: Env
): Promise<ExecuteDebitResponse | { result: "ERROR"; reason_code: string }> {
  const db = env.DB;
  const idempResult = await checkIdempotency(req.request_id, bankId, req.txid, "execute-debit", db);
  if (idempResult.existing) return idempResult.response as ExecuteDebitResponse;

  const isHV = req.lane === "HIGH_VALUE";
  let accountId: string;

  if (isHV) {
    // HV lane: identify the account by account_hash (passed directly since it does not go through reserve-funds)
    const account = req.payer_account_hash
      ? await getAccountByHash(bankId, req.payer_account_hash, db)
      : await db
          .prepare(
            `SELECT * FROM BankAccounts WHERE bank_id=? AND status='NORMAL' AND account_type='SAVINGS' LIMIT 1`
          )
          .bind(bankId)
          .first<BankAccountRow>();
    if (!account || account.status !== "NORMAL") {
      const resp = { result: "ERROR" as const, reason_code: "ACCOUNT_NOT_FOUND" };
      await saveResponse(req.request_id, resp, db);
      return resp;
    }
    accountId = account.account_id;
    const available = await getAvailableBalance(accountId, db, req.amount.currency);
    if (available < req.amount.value) {
      const resp = { result: "ERROR" as const, reason_code: "INSUFFICIENT_FUNDS" };
      await saveResponse(req.request_id, resp, db);
      return resp;
    }
    // HV is immediate RTGS settlement, so it books Customer(-) / ZCS(+) directly without going through the segregated deposit
    await insertJournalGroup(db, {
      bankId,
      txGroupId: `HV-DEBIT-${req.txid}`,
      currency: req.amount.currency,
      entries: [
        {
          accountId,
          amount: -req.amount.value,
          txType: "TRANSFER",
          txid: req.txid,
          description: "HV即時引落 普通預金(-)",
        },
        {
          accountId: nostroAccountId(bankId),
          amount: req.amount.value,
          txType: "TRANSFER",
          txid: req.txid,
          description: "HV ZCS清算義務(+)",
        },
      ],
      valueDate: businessDateJST(),
    });
  } else {
    // Standard: change state from RESERVED → EXECUTED
    const suspense = await db
      .prepare(
        `SELECT suspense_id, account_id FROM SuspenseDetails WHERE txid=? AND bank_id=? AND status='RESERVED' LIMIT 1`
      )
      .bind(req.txid, bankId)
      .first<{ suspense_id: string; account_id: string }>();
    if (!suspense) {
      const resp = { result: "ERROR" as const, reason_code: "RESERVATION_NOT_FOUND" };
      await saveResponse(req.request_id, resp, db);
      return resp;
    }
    await executeSuspenseDebit(suspense.suspense_id, db);
    accountId = suspense.account_id;
  }

  // Generate proof a
  const proofType = isHV ? ("PAYER_HV_ISOLATION_PROOF" as const) : ("PAYER_EXEC_PROOF" as const);
  const proof = await createProof(bankId, proofType, req.txid, req.amount.value);
  const resp: ExecuteDebitResponse = { result: "OK", bank_proof_ref: proof };
  await saveResponse(req.request_id, resp, db);
  await auditLog(db, {
    bank_id: bankId,
    txid: req.txid,
    request_id: req.request_id,
    command: "execute-debit",
    status: "OK",
    amount: req.amount.value,
    account_id: accountId,
    details: { lane: req.lane ?? "STANDARD", proof_type: proofType },
  });
  return resp;
}

/**
 * **Command 3: execute-credit** — Credit the payee account (b-proof, hard landing).
 *
 * Processing flow:
 *   1. Resolve payee account by account_hash (with fallback chain)
 *   2. If account is abnormal (frozen/closed/system), route to custody
 *   3. Evaluate payment filters ({@link evaluatePaymentFilters}):
 *      - REJECT -> return FILTER_REJECTED immediately
 *      - HOLD_CONFIRM/HOLD_MANUAL -> create approval request, return PENDING_APPROVAL
 *   4. Hard-land funds into suspense: Suspense(+) / ZCS(-) journals
 *   5. For normal accounts, immediately settle: Suspense(-) / Customer(+)
 *   6. Generate b-proof (PAYEE_EXEC_PROOF) with optional custody metadata
 *
 * Custody accounts hold funds until a teller manually resolves them via
 * the suspense-resolve endpoint.
 *
 * @param bankId - Payee bank identifier
 * @param req    - Contains txid, amount, request_id, payee_account_hash
 * @param env    - Worker environment bindings
 * @returns ExecuteCreditResult (OK | FILTER_REJECTED | PENDING_APPROVAL)
 */
export async function bankExecuteCredit(
  bankId: string,
  req: ExecuteCreditRequest,
  env: Env
): Promise<ExecuteCreditResult> {
  const db = env.DB;
  const idempResult = await checkIdempotency(
    req.request_id,
    bankId,
    req.txid,
    "execute-credit",
    db
  );
  if (idempResult.existing) return idempResult.response as ExecuteCreditResult;

  // Payee account: prefer the request's payee_account_hash (eliminates direct references to Transactions)
  let account: BankAccountRow | null = null;
  const payeeHash = req.payee_account_hash;
  if (payeeHash) {
    account = await getAccountByHash(bankId, payeeHash, db);
  }
  if (!account) {
    // Fallback: retrieve from txid (allowed only for the single-Worker mock)
    const tx = await db
      .prepare(`SELECT payee_account_hash FROM Transactions WHERE txid=?`)
      .bind(req.txid)
      .first<{ payee_account_hash: string | null }>();
    if (tx?.payee_account_hash) {
      account = await getAccountByHash(bankId, tx.payee_account_hash, db);
    }
  }

  let isCustody = false;
  let custodyReason = "";

  if (!account || account.status !== "NORMAL" || account.account_type !== "SAVINGS") {
    isCustody = true;
    custodyReason = !account
      ? "NOT_FOUND"
      : account.status === "FROZEN"
        ? "ACCOUNT_FROZEN"
        : account.status === "CLOSED"
          ? "ACCOUNT_CLOSED"
          : account.account_type !== "SAVINGS"
            ? "SYSTEM_ACCOUNT"
            : "NOT_FOUND";
    if (!account) {
      account = {
        account_id: suspenseAccountId(bankId),
        bank_id: bankId,
        customer_id: "SYSTEM",
        customer_name: "別段預金",
        account_type: "SUSPENSE",
        status: "NORMAL",
        freeze_reason: null,
        opened_at: nowISO(),
        closed_at: null,
      };
    } else if (account.account_type !== "SAVINGS") {
      account = {
        account_id: suspenseAccountId(bankId),
        bank_id: bankId,
        customer_id: "SYSTEM",
        customer_name: "別段預金",
        account_type: "SUSPENSE",
        status: "NORMAL",
        freeze_reason: null,
        opened_at: nowISO(),
        closed_at: null,
      };
    }
  }

  // --- Incoming credit filter evaluation (only for normal accounts) ---
  // Retrieve sender info from the Transactions table
  if (!isCustody) {
    const txInfo = await db
      .prepare(`SELECT payer_bank_id, payer_account_hash, purpose FROM Transactions WHERE txid=?`)
      .bind(req.txid)
      .first<{ payer_bank_id: string; payer_account_hash: string; purpose: string | null }>();

    if (txInfo) {
      const filterResult = await evaluatePaymentFilters(
        bankId,
        account.account_id,
        txInfo.payer_bank_id,
        txInfo.payer_account_hash,
        req.amount.value,
        txInfo.purpose ?? null, // Use purpose as the EDI equivalent
        req.txid,
        db
      );

      if (filterResult.matched) {
        if (filterResult.action === "REJECT") {
          const resp = {
            result: "FILTER_REJECTED" as const,
            reason_code: filterResult.reason_code,
            filter_id: filterResult.filter_id,
          };
          await saveResponse(req.request_id, resp, db);
          await auditLog(db, {
            bank_id: bankId,
            txid: req.txid,
            request_id: req.request_id,
            command: "execute-credit",
            status: "NG",
            reason_code: "PAYMENT_FILTER_REJECTED",
            amount: req.amount.value,
            account_id: account.account_id,
            details: { filter_id: filterResult.filter_id, payer_bank_id: txInfo.payer_bank_id },
          });
          return resp;
        }
        // HOLD_CONFIRM / HOLD_MANUAL
        const resp = { result: "PENDING_APPROVAL" as const, approval_id: filterResult.approval_id };
        await saveResponse(req.request_id, resp, db);
        await auditLog(db, {
          bank_id: bankId,
          txid: req.txid,
          request_id: req.request_id,
          command: "execute-credit",
          status: "NG",
          reason_code: "AWAITING_APPROVAL",
          amount: req.amount.value,
          account_id: account.account_id,
          details: {
            filter_id: filterResult.filter_id,
            approval_id: filterResult.approval_id,
            action: filterResult.action,
          },
        });
        return resp;
      }
    }
  }

  // Hard Landing: credit into the segregated deposit (receiving account)
  const suspId = await landSuspense(db, {
    bankId,
    accountId: account.account_id,
    direction: "RECEIVE",
    amount: req.amount.value,
    txid: req.txid,
    requestId: req.request_id,
    isCustody,
    custodyReason,
    currency: req.amount.currency,
  });

  // Generate proof b
  const custodyDetail = isCustody
    ? { is_custody: true as const, reason_code: custodyReason, custody_account_ref: suspId }
    : undefined;
  const proof = await createProof(
    bankId,
    "PAYEE_EXEC_PROOF",
    req.txid,
    req.amount.value,
    custodyDetail
  );

  // For RTP transactions, use the requester's description as the memo
  const rtpRow = await db
    .prepare(`SELECT description FROM RtpRequests WHERE linked_txid_new = ? LIMIT 1`)
    .bind(req.txid)
    .first<{ description: string | null }>();
  const creditDescription = rtpRow?.description
    ? `振込入金 ${rtpRow.description}`
    : "ZC着金 普通預金(+)";

  // For a normal account, credit immediately (segregated deposit → ordinary account)
  if (!isCustody) {
    await insertJournalGroup(db, {
      bankId,
      txGroupId: `SETTLE-${req.txid}`,
      currency: req.amount.currency,
      entries: [
        {
          accountId: suspenseAccountId(bankId),
          amount: -req.amount.value,
          txType: "CREDIT",
          txid: req.txid,
          description: "ZC着金 別段(-)",
        },
        {
          accountId: account.account_id,
          amount: req.amount.value,
          txType: "CREDIT",
          txid: req.txid,
          description: creditDescription,
        },
      ],
      valueDate: businessDateJST(),
    });
    // Target the specific suspense_id generated by landSuspense rather than the entire txid
    await db
      .prepare(
        `UPDATE SuspenseDetails SET status='SETTLED', settled_at=?, updated_at=? WHERE suspense_id=?`
      )
      .bind(nowISO(), nowISO(), suspId)
      .run();
  }

  const resp: ExecuteCreditResponse = { result: "OK", bank_proof_ref: proof };
  await saveResponse(req.request_id, resp, db);
  await auditLog(db, {
    bank_id: bankId,
    txid: req.txid,
    request_id: req.request_id,
    command: "execute-credit",
    status: "OK",
    amount: req.amount.value,
    account_id: account.account_id,
    details: { is_custody: isCustody, custody_reason: isCustody ? custodyReason : null },
  });
  return resp;
}

/**
 * **Command 11: debit-settled** — Settlement completion notification to payer bank.
 *
 * Called by ZC after the full transaction reaches SETTLED state. Confirms to
 * the payer (originating bank) that the payee credit has been delivered and the
 * end-to-end settlement is final. Records an audit entry for traceability.
 *
 * This implements the "credit result notification" from the
 * payer side perspective, completing the bidirectional settlement confirmation
 * loop required by the Zengin Future Vision report (Topic 2: credit result notification feature).
 */
export async function bankDebitSettled(
  bankId: string,
  req: BankDebitSettledRequest,
  env: Env
): Promise<{ result: "ACKNOWLEDGED"; txid: string } | { result: "ERROR"; reason_code: string }> {
  const db = env.DB;
  const idempResult = await checkIdempotency(req.request_id, bankId, req.txid, "debit-settled", db);
  if (idempResult.existing) return idempResult.response as { result: "ACKNOWLEDGED"; txid: string };

  const resp = { result: "ACKNOWLEDGED" as const, txid: req.txid };
  await saveResponse(req.request_id, resp, db);
  await auditLog(db, {
    bank_id: bankId,
    txid: req.txid,
    request_id: req.request_id,
    command: "debit-settled",
    status: "OK",
    amount: req.amount.value,
    details: { payee_bank_id: req.payee_bank_id, settled_at: req.settled_at },
  });
  return resp;
}
