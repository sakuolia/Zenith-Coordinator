/**
 * @file Suspense account and custody management. Handles fund reservation
 * (RESERVED), debit execution (EXECUTED), credit landing (LANDED/CUSTODY),
 * DNS settlement, and available balance calculation.
 * @module bank/suspense
 */
import type { BankAccountRow, SuspenseDirection } from "../types";
import { nowISO, businessDateJST, suspenseAccountId, nostroAccountId } from "../types";
import { newUUID } from "../shared/idempotency";
import { insertJournalGroup } from "./ledger";

export interface ReserveSuspenseInput {
  bankId: string;
  accountId: string;
  direction: SuspenseDirection;
  amount: number;
  txid: string | null;
  requestId?: string;
  isCustody?: boolean;
  custodyReason?: string;
  /** ISO 4217 currency of the reserved amount (default JPY). */
  currency?: string;
}

// ---------------------------------------------------------------------------
// Segregated deposit (payment side): ordinary account → segregated (RESERVED)
// ---------------------------------------------------------------------------
export async function reserveSuspense(
  db: D1Database,
  input: ReserveSuspenseInput
): Promise<string> {
  const now = nowISO();
  const suspenseId = `SUSP-${newUUID()}`;
  const suspAcctId = suspenseAccountId(input.bankId);

  // Journal entry: ordinary deposit (-) / segregated deposit (suspense) (+)  -> zero-sum
  await insertJournalGroup(db, {
    bankId: input.bankId,
    txGroupId: `RESERVE-${suspenseId}`,
    currency: input.currency,
    entries: [
      {
        accountId: input.accountId,
        amount: -input.amount,
        txType: "RESERVE",
        txid: input.txid ?? undefined,
        description: "Hard Reservation",
      },
      {
        accountId: suspAcctId,
        amount: input.amount,
        txType: "RESERVE",
        txid: input.txid ?? undefined,
        description: "Hard Reservation offset",
      },
    ],
    valueDate: businessDateJST(now),
  });

  await db
    .prepare(
      `INSERT INTO SuspenseDetails
     (suspense_id, bank_id, account_id, direction, status, amount, txid, request_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?, ?)`
    )
    .bind(
      suspenseId,
      input.bankId,
      input.accountId,
      input.direction,
      input.amount,
      input.txid,
      input.requestId ?? null,
      now,
      now
    )
    .run();

  return suspenseId;
}

// ---------------------------------------------------------------------------
// Segregated deposit (suspense) (payment leg): RESERVED -> EXECUTED
// ---------------------------------------------------------------------------
export async function executeSuspenseDebit(suspenseId: string, db: D1Database): Promise<void> {
  await db
    .prepare(
      `UPDATE SuspenseDetails SET status='EXECUTED', updated_at=? WHERE suspense_id=? AND status='RESERVED'`
    )
    .bind(nowISO(), suspenseId)
    .run();
}

// ---------------------------------------------------------------------------
// Segregated deposit (suspense) (receiving leg): Hard Landing
// ---------------------------------------------------------------------------
export interface LandSuspenseInput {
  bankId: string;
  accountId: string;
  direction: "RECEIVE";
  amount: number;
  txid: string;
  requestId?: string;
  isCustody: boolean;
  custodyReason?: string;
  /** ISO 4217 currency of the landed amount (default JPY). */
  currency?: string;
}

export async function landSuspense(db: D1Database, input: LandSuspenseInput): Promise<string> {
  const now = nowISO();
  const suspenseId = `SUSP-RCV-${newUUID()}`;
  const suspAcctId = suspenseAccountId(input.bankId);
  const status = input.isCustody ? "CUSTODY" : "LANDED";

  // Journal entry: segregated (suspense) (receiving leg) (+) / ZC settlement account (-)
  //   ZCS(-) = ZC incurred a payment obligation to this bank (moved toward a net-receiving position) <- zero-sum ✓
  //   Resolved by the subsequent executeSuspenseCredit into segregated (suspense) (-) / customer account (+)
  const zcsAccountId = nostroAccountId(input.bankId);
  await insertJournalGroup(db, {
    bankId: input.bankId,
    txGroupId: `LAND-${suspenseId}`,
    currency: input.currency,
    entries: [
      {
        accountId: suspAcctId,
        amount: input.amount,
        txType: "CREDIT",
        txid: input.txid,
        description: "Hard Landing 別段受取口(+)",
      },
      {
        accountId: zcsAccountId,
        amount: -input.amount,
        txType: "CREDIT",
        txid: input.txid,
        description: "Hard Landing ZC清算(−) ZCが当行へ支払義務",
      },
    ],
    valueDate: businessDateJST(now),
  });

  await db
    .prepare(
      `INSERT INTO SuspenseDetails
     (suspense_id, bank_id, account_id, direction, status, amount, txid, request_id, custody_reason, created_at, updated_at)
     VALUES (?, ?, ?, 'RECEIVE', ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      suspenseId,
      input.bankId,
      input.accountId,
      status,
      input.amount,
      input.txid,
      input.requestId ?? null,
      input.custodyReason ?? null,
      now,
      now
    )
    .run();

  return suspenseId;
}

// ---------------------------------------------------------------------------
// Available balance = book balance
// Because reserveSuspense has already created the customer(-amount)/suspense(+amount) journal entry
// -amount is already reflected in SUM(BankJournals). Subtracting SuspenseDetails again would cause a double deduction.
//
// Currency dimension: a funds check must be scoped to the currency being
// debited. A single account_id can carry entries in more than one currency
// once cross-currency FX credits land (e.g. a payee SAVINGS account credited in
// USD by the FXP-conduit leg), so summing across all currencies would let a
// balance held in currency X silently fund a debit in currency Y. When
// `currency` is supplied (every real funds-check caller knows the debit
// currency), only that currency's entries are summed. Omitting it preserves the
// legacy all-currency behaviour for single-currency callers.
// ---------------------------------------------------------------------------
export async function getAvailableBalance(
  accountId: string,
  db: D1Database,
  currency?: string
): Promise<number> {
  const balance = currency
    ? await db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ? AND amount_currency = ?`
        )
        .bind(accountId, currency)
        .first<{ b: number }>()
    : await db
        .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ?`)
        .bind(accountId)
        .first<{ b: number }>();

  return balance?.b ?? 0;
}

// ---------------------------------------------------------------------------
// Fetch BankAccount from account_hash/account_id
// Mock: account_hash is either "h:{account_id}" or account_id itself
// ---------------------------------------------------------------------------
export async function getAccountByHash(
  bankId: string,
  accountHash: string,
  db: D1Database
): Promise<BankAccountRow | null> {
  const accountId = accountHash.startsWith("h:") ? accountHash.slice(2) : accountHash;

  return db
    .prepare(`SELECT * FROM BankAccounts WHERE account_id=? AND bank_id=?`)
    .bind(accountId, bankId)
    .first<BankAccountRow>();
}

// ---------------------------------------------------------------------------
// Auto-release of recovered CUSTODY records.
// CUSTODY funds land when the payee account is frozen/closed/not found. The
// teller can resolve them manually (handleSuspenseResolve), but a frozen
// account that is later unfrozen previously left the funds in custody forever
// unless a teller noticed. This sweep credits CUSTODY records whose underlying
// account has returned to a creditable state (NORMAL + SAVINGS).
// NOT_FOUND / SYSTEM_ACCOUNT custody records point at the bank's own suspense
// account (account_type = SUSPENSE), so the join excludes them — those remain
// teller-resolution only.
// ---------------------------------------------------------------------------
export async function releaseRecoveredCustody(db: D1Database): Promise<number> {
  const now = nowISO();
  // Recover the currency the funds actually landed in from the original LAND
  // journal group (`LAND-{suspense_id}`): its positive entry is the suspense
  // credit in the landed currency. SuspenseDetails carries no currency column,
  // so without this the auto-release would post the reversal in the DEFAULT
  // 'JPY', crediting the customer in the wrong currency and stranding the real
  // (e.g. USD) balance in the suspense account forever. Falls back to 'JPY' for
  // legacy rows with no LAND journal recorded.
  const candidates = await db
    .prepare(
      `SELECT s.suspense_id, s.bank_id, s.account_id, s.amount, s.txid,
              COALESCE(j.amount_currency, 'JPY') AS currency
         FROM SuspenseDetails s
         JOIN BankAccounts a ON a.bank_id = s.bank_id AND a.account_id = s.account_id
         LEFT JOIN BankJournals j
                ON j.tx_group_id = 'LAND-' || s.suspense_id AND j.amount > 0
        WHERE s.status='CUSTODY' AND s.direction='RECEIVE'
          AND a.status='NORMAL' AND a.account_type='SAVINGS'`
    )
    .all<{
      suspense_id: string;
      bank_id: string;
      account_id: string;
      amount: number;
      txid: string | null;
      currency: string;
    }>();

  let released = 0;
  for (const c of candidates.results) {
    const suspAcctId = suspenseAccountId(c.bank_id);
    // Journal inserts are guarded by `WHERE EXISTS (... status='CUSTODY')` and
    // run in the same batch (= one transaction) as the CUSTODY→SETTLED CAS, so
    // a concurrent teller resolve / sweep can neither double-credit nor leave
    // the row SETTLED without the matching journal entries.
    const journalInsert = (accountId: string, amount: number, description: string) =>
      db
        .prepare(
          `INSERT INTO BankJournals
             (journal_id, bank_id, account_id, amount, amount_currency, tx_type, txid, tx_group_id, description, value_date, created_at)
           SELECT ?, ?, ?, ?, ?, 'CREDIT', ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM SuspenseDetails WHERE suspense_id=? AND status='CUSTODY')`
        )
        .bind(
          `JNL-${newUUID()}`,
          c.bank_id,
          accountId,
          amount,
          c.currency,
          c.txid,
          `SUSP-AUTORESOLVE-${c.suspense_id}`,
          description,
          businessDateJST(now),
          now,
          c.suspense_id
        );

    const results = await db.batch([
      journalInsert(suspAcctId, -c.amount, "CUSTODY auto-release 別段(-)"),
      journalInsert(c.account_id, c.amount, "CUSTODY auto-release 口座復旧入金(+)"),
      db
        .prepare(
          `UPDATE SuspenseDetails SET status='SETTLED', settled_at=?, updated_at=?
            WHERE suspense_id=? AND status='CUSTODY'`
        )
        .bind(now, now, c.suspense_id),
    ]);
    if ((results[2]?.meta.changes ?? 0) > 0) released++;
  }
  return released;
}

// ---------------------------------------------------------------------------
// Resolution of segregated (suspense) at DNS settlement
// ---------------------------------------------------------------------------
export async function settleSuspenseForDns(
  bankId: string,
  dnsCycleId: string,
  db: D1Database
): Promise<void> {
  const now = nowISO();
  // Restrict to the TX of this cycle only (do not mistakenly settle segregated (suspense) of other cycles)
  // PAY direction: RESERVED -> EXECUTED -> SETTLED (settlement of the payer-side segregated (suspense))
  await db
    .prepare(
      `UPDATE SuspenseDetails SET status='SETTLED', settled_at=?, dns_cycle_id=?, updated_at=?
     WHERE bank_id=? AND status='EXECUTED' AND direction='PAY'
       AND txid IN (SELECT txid FROM Transactions WHERE dns_cycle_id=?)`
    )
    .bind(now, dnsCycleId, now, bankId, dnsCycleId)
    .run();
  // RECEIVE direction: receiving-side records with CUSTODY status are also included in DNS settlement
  // CUSTODY is funds that could not be credited due to a frozen/closed account. Even after DNS settlement completes,
  // the funds themselves remain in custody, but the settlement status must still be recorded.
  // (Release paths: releaseRecoveredCustody in the per-minute sweep once the account
  // recovers, or manual teller resolution via handleSuspenseResolve.)
  await db
    .prepare(
      `UPDATE SuspenseDetails SET dns_cycle_id=?, updated_at=?
     WHERE bank_id=? AND status='CUSTODY' AND direction='RECEIVE'
       AND dns_cycle_id IS NULL
       AND txid IN (SELECT txid FROM Transactions WHERE dns_cycle_id=?)`
    )
    .bind(dnsCycleId, now, bankId, dnsCycleId)
    .run();
}
