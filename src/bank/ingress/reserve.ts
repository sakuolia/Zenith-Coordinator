/**
 * @module bank/ingress/reserve
 * @description Reservation-lifecycle ingress commands: reserve-funds (1),
 * release-reserve (4), leg-ready-check (5). Each segregates / returns payer
 * funds via the suspense ledger.
 */
import type {
  Env,
  ReserveFundsRequest,
  ReserveFundsResponse,
  ReleaseReserveRequest,
  ReleaseReserveResponse,
  LegReadyCheckRequest,
  LegReadyCheckResponse,
} from "../../types";
import { nowISO, businessDateJST, suspenseAccountId } from "../../types";
import { reserveSuspense, getAvailableBalance, getAccountByHash } from "../suspense";
import { insertJournalGroup } from "../ledger";
import { auditLog, checkIdempotency, saveResponse } from "./_shared";

/**
 * **Command 1: reserve-funds** — Reserve payer funds (H_RESERVED).
 *
 * Isolates the transfer amount from the payer's savings account into a
 * suspense account via double-entry journals:
 *   - Customer account: -(amount)
 *   - Suspense account: +(amount)
 *
 * The reservation prevents the payer from double-spending while the
 * transfer is in flight. Released by either execute-debit (success path)
 * or release-reserve (cancel/timeout path).
 *
 * @param bankId - Payer bank identifier
 * @param req    - Contains txid, account_hash, amount, request_id
 * @param env    - Worker environment bindings
 * @returns ReserveFundsResponse with result RESERVED or ERROR
 */
export async function bankReserveFunds(
  bankId: string,
  req: ReserveFundsRequest,
  env: Env
): Promise<ReserveFundsResponse> {
  const db = env.DB;
  const idempResult = await checkIdempotency(req.request_id, bankId, req.txid, "reserve-funds", db);
  if (idempResult.existing) return idempResult.response as ReserveFundsResponse;

  // Account lookup
  const account = await getAccountByHash(bankId, req.account_hash, db);
  if (!account || account.status !== "NORMAL") {
    const resp: ReserveFundsResponse = { result: "ERROR", reason_code: "ACCOUNT_NOT_FOUND" };
    await saveResponse(req.request_id, resp, db);
    await auditLog(db, {
      bank_id: bankId,
      txid: req.txid,
      request_id: req.request_id,
      command: "reserve-funds",
      status: "NG",
      reason_code: "ACCOUNT_NOT_FOUND",
      amount: req.amount.value,
      details: { account_hash: req.account_hash },
    });
    return resp;
  }

  // Available balance check (scoped to the debit currency — see getAvailableBalance)
  const available = await getAvailableBalance(account.account_id, db, req.amount.currency);
  if (available < req.amount.value) {
    const resp: ReserveFundsResponse = { result: "ERROR", reason_code: "INSUFFICIENT_FUNDS" };
    await saveResponse(req.request_id, resp, db);
    await auditLog(db, {
      bank_id: bankId,
      txid: req.txid,
      request_id: req.request_id,
      command: "reserve-funds",
      status: "NG",
      reason_code: "INSUFFICIENT_FUNDS",
      amount: req.amount.value,
      account_id: account.account_id,
      details: { available, requested: req.amount.value },
    });
    return resp;
  }

  // Segregate into the segregated deposit (payment account) + journal entry
  const suspenseId = await reserveSuspense(db, {
    bankId,
    accountId: account.account_id,
    direction: "PAY",
    amount: req.amount.value,
    txid: req.txid,
    requestId: req.request_id,
    currency: req.amount.currency,
  });

  const resp: ReserveFundsResponse = { result: "RESERVED", reservation_ref: suspenseId };
  await saveResponse(req.request_id, resp, db);
  await auditLog(db, {
    bank_id: bankId,
    txid: req.txid,
    request_id: req.request_id,
    command: "reserve-funds",
    status: "OK",
    amount: req.amount.value,
    account_id: account.account_id,
    details: { reservation_ref: suspenseId },
  });
  return resp;
}

/**
 * **Command 4: release-reserve** — Release previously reserved funds.
 *
 * Called on transaction cancel or timeout. Reverses the reserve-funds
 * journals by moving funds back from suspense to the customer account:
 *   - Suspense: -(amount)
 *   - Customer: +(amount)
 *
 * Sets the SuspenseDetails status to RETURNED (not SETTLED, since no
 * settlement occurred).
 *
 * @param bankId - Bank identifier holding the reservation
 * @param req    - Contains txid, reservation_ref, request_id
 * @param env    - Worker environment bindings
 * @returns ReleaseReserveResponse with result RELEASED
 */
export async function bankReleaseReserve(
  bankId: string,
  req: ReleaseReserveRequest,
  env: Env
): Promise<ReleaseReserveResponse> {
  const db = env.DB;
  const idempResult = await checkIdempotency(
    req.request_id,
    bankId,
    req.txid,
    "release-reserve",
    db
  );
  if (idempResult.existing) return idempResult.response as ReleaseReserveResponse;

  // Return the segregated deposit to the original account
  const suspense = await db
    .prepare(
      `SELECT * FROM SuspenseDetails WHERE suspense_id=? OR (txid=? AND bank_id=? AND status='RESERVED') LIMIT 1`
    )
    .bind(req.reservation_ref, req.txid, bankId)
    .first<{ suspense_id: string; account_id: string; amount: number }>();

  if (suspense) {
    // Cancellation release is 'RETURNED' (not 'SETTLED')
    await db
      .prepare(
        `UPDATE SuspenseDetails SET status='RETURNED', settled_at=?, updated_at=? WHERE suspense_id=?`
      )
      .bind(nowISO(), nowISO(), suspense.suspense_id)
      .run();
    // The release reverses the original reservation, so it must be booked in the
    // same currency. ReleaseReserveRequest carries no amount, so recover the
    // currency from the RESERVE journal group written by reserveSuspense.
    const reserveCcy = await db
      .prepare(`SELECT amount_currency FROM BankJournals WHERE tx_group_id=? LIMIT 1`)
      .bind(`RESERVE-${suspense.suspense_id}`)
      .first<{ amount_currency: string }>();
    // Journal entry to return to the ordinary account: segregated deposit(-) / ordinary account(+)
    await insertJournalGroup(db, {
      bankId,
      txGroupId: `RELEASE-${req.txid}`,
      currency: reserveCcy?.amount_currency,
      entries: [
        {
          accountId: suspenseAccountId(bankId),
          amount: -suspense.amount,
          txType: "RESERVE",
          txid: req.txid,
          description: "予約解放 別段(-）",
        },
        {
          accountId: suspense.account_id,
          amount: suspense.amount,
          txType: "RESERVE",
          txid: req.txid,
          description: "予約解放 普通預金(+)",
        },
      ],
      valueDate: businessDateJST(),
    });
  }

  const resp: ReleaseReserveResponse = { result: "RELEASED", reservation_ref: req.reservation_ref };
  await saveResponse(req.request_id, resp, db);
  return resp;
}

/**
 * **Command 5: leg-ready-check** — GTID multi-leg pre-readiness verification.
 *
 * Validates that a bank participant in a coordinated (GTID) transaction can
 * fulfill its role. For PAYER legs, checks available balance and pre-reserves
 * funds in suspense (equivalent to reserve-funds). For PAYEE legs, only
 * verifies account existence and status.
 *
 * @param bankId - Bank identifier for this leg
 * @param req    - Contains leg_id, account_hash, role (PAYER|PAYEE), amount
 * @param env    - Worker environment bindings
 * @returns LegReadyCheckResponse with result OK or NG
 */
export async function bankLegReadyCheck(
  bankId: string,
  req: LegReadyCheckRequest,
  env: Env
): Promise<LegReadyCheckResponse> {
  const db = env.DB;
  const account = await getAccountByHash(bankId, req.account_hash, db);
  if (!account || account.status !== "NORMAL") {
    return { result: "NG", reason_code: "ACCOUNT_NOT_FOUND" };
  }
  if (req.role === "PAYER") {
    // Funds check and suspense reservation must both be scoped to the leg's
    // currency. A GTID/FX PAYER leg can be non-JPY (e.g. an FXP-conduit leg
    // paying USD); without the currency the funds check would sum across
    // currencies and reserveSuspense would book the segregated-deposit journal
    // in the DEFAULT 'JPY', mislabelling a USD outflow as JPY on the bank's
    // ledger (and breaking per-currency reconciliation at DNS settlement).
    const legCurrency = req.amount.currency;
    const available = await getAvailableBalance(account.account_id, db, legCurrency);
    if (available < req.amount.value) {
      return { result: "NG", reason_code: "INSUFFICIENT_FUNDS" };
    }
    // PAYER segregates funds into the segregated deposit (equivalent to reserve-funds)
    // The txid uses the predicted TX-GT-{leg_id} that will be created later
    const predictedTxid = `TX-GT-${req.leg_id}`;
    const suspenseId = await reserveSuspense(db, {
      bankId,
      accountId: account.account_id,
      direction: "PAY",
      amount: req.amount.value,
      txid: predictedTxid,
      requestId: req.request_id,
      currency: legCurrency,
    });
    return { result: "OK", reservation_ref: suspenseId };
  }
  return { result: "OK" };
}
