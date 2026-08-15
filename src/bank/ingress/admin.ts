/**
 * @module bank/ingress/admin
 * @description Bank lifecycle ingress commands: initialize-bank (12),
 * cleanup-bank (13). Create / tear down the bank's own internal accounts and
 * journals (a financial institution's own responsibility; ZC only registers
 * participants).
 */
import type { Env, BankInitializeRequest } from "../../types";
import { nowISO, businessDateJST } from "../../types";
import { auditLog } from "./_shared";

export type { BankInitializeRequest };

/**
 * **Command 12: initialize-bank** — Bank-side account and journal initialization.
 *
 * ZC only performs participant bank registration (Participants); the bank itself is responsible for
 * initializing internal bank accounts (BankAccounts) and journal entries (BankJournals) (core principle: financial institutions retain their existing responsibilities).
 * This handler is the endpoint that accepts that "bank-side initialization".
 *
 * Accounts created:
 *   - Segregated deposit (SUSPENSE): temporarily holds funds in transit
 *   - ZC settlement account (SETTLEMENT): settlement with ZC
 *   - Cash account (ASSET): the bank's own cash
 *   - BOJ deposit account (BOJ): prefunding for RTGS/HIGH_VALUE
 */
export async function bankInitialize(
  bankId: string,
  req: BankInitializeRequest,
  env: Env
): Promise<{ result: "INITIALIZED" | "ALREADY_INITIALIZED"; bank_id: string }> {
  const db = env.DB;
  const now = nowISO();
  const today = businessDateJST(now);
  const bojPrefund = req.boj_prefund ?? 100_000_000_000; // Default 100 billion yen

  // Idempotency check: skip if the account already exists
  const existing = await db
    .prepare(
      `SELECT account_id FROM BankAccounts WHERE bank_id = ? AND account_type = 'SUSPENSE' LIMIT 1`
    )
    .bind(bankId)
    .first<{ account_id: string }>();
  if (existing) {
    return { result: "ALREADY_INITIALIZED", bank_id: bankId };
  }

  // Create internal bank accounts (the bank's responsibility: ZC has no knowledge of the account structure)
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'SYSTEM', '別段預金', 'SUSPENSE', 'NORMAL', ?)`
      )
      .bind(`${bankId}0000000`, bankId, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'SYSTEM', 'ZC清算勘定', 'SETTLEMENT', 'NORMAL', ?)`
      )
      .bind(`${bankId}-ZCS`, bankId, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'SYSTEM', '現金', 'ASSET', 'NORMAL', ?)`
      )
      .bind(`${bankId}-CASH`, bankId, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'INTERNAL', '利益剰余金', 'EQUITY', 'NORMAL', ?)`
      )
      .bind(`${bankId}-RE`, bankId, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'BOJ', '日本銀行（預け金勘定）', 'BOJ', 'NORMAL', ?)`
      )
      .bind(`${bankId}-BOJ`, bankId, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO InterestRates (rate_id, bank_id, account_type, annual_rate, effective_from)
       VALUES (?, ?, 'SAVINGS', 0.001, ?)`
      )
      .bind(`RATE-${bankId}-SAVINGS`, bankId, today),
    // BOJ initial prefunding (for HIGH_VALUE RTGS)
    // Zero-sum: BOJ(-) / ZCS(+) offsetting pair
    db
      .prepare(
        `INSERT OR IGNORE INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, description, value_date, created_at)
       VALUES (?, ?, ?, ?, 'CASH', ?, 'BOJ初期プレファンド', ?, ?)`
      )
      .bind(
        `JNL-INIT-${bankId}-BOJ`,
        bankId,
        `${bankId}-BOJ`,
        -bojPrefund,
        `INIT-${bankId}-BOJ`,
        today,
        now
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, description, value_date, created_at)
       VALUES (?, ?, ?, ?, 'CASH', ?, 'BOJ初期ZCS対当', ?, ?)`
      )
      .bind(
        `JNL-INIT-${bankId}-BOJZCS`,
        bankId,
        `${bankId}-ZCS`,
        bojPrefund,
        `INIT-${bankId}-BOJ`,
        today,
        now
      ),
  ]);

  await auditLog(db, {
    bank_id: bankId,
    command: "initialize-bank",
    status: "OK",
    details: { boj_prefund: bojPrefund },
  });
  return { result: "INITIALIZED", bank_id: bankId };
}

/**
 * **Command 13: cleanup-bank** — Bank-side account and journal teardown.
 *
 * On bank deregistration, delete internal bank data (accounts, journal entries, interest rate settings).
 * ZC-side data (Participants, ZcRequests, SuspenseDetails) is deleted separately by ZC.
 */
export async function bankCleanup(
  bankId: string,
  env: Env
): Promise<{ result: "CLEANED_UP"; bank_id: string }> {
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM InterestRates WHERE bank_id=?").bind(bankId),
    db.prepare("DELETE FROM DailyBalances WHERE account_id LIKE ?").bind(`${bankId}%`),
    db.prepare("DELETE FROM BankJournals WHERE bank_id=?").bind(bankId),
    db.prepare("DELETE FROM BankAccounts WHERE bank_id=?").bind(bankId),
  ]);
  await auditLog(db, { bank_id: bankId, command: "cleanup-bank", status: "OK" });
  return { result: "CLEANED_UP", bank_id: bankId };
}
