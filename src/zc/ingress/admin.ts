/**
 * @file ZC ingress — bank/participant management + seed-data handlers.
 * @module zc/ingress/admin
 */
import type { Env, BankInitializeRequest, BankCleanupRequest } from "../../types";
import { nowISO } from "../../types";
import { parseBody } from "../../shared/validator";
import { json, jsonError } from "./_shared";

/**
 * Build the `initialize-bank` ingress body (command 12). Exported for the seam
 * test, and typed so the caller and the handler share one declaration rather
 * than two that only agree by inspection (`test/integration/ingress_commands.test.ts`).
 */
export function buildInitializeBankPayload(bankId: string): BankInitializeRequest {
  return { request_id: `INIT-BANK-${bankId}` };
}

/** Build the `cleanup-bank` ingress body (command 13) — addressed by bank id alone. */
export function buildCleanupBankPayload(): BankCleanupRequest {
  return {};
}

// ---------------------------------------------------------------------------
// POST /api/participants/register
// ---------------------------------------------------------------------------
export async function handlePostParticipantRegister(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<{
    bank_id: string;
    bank_name: string;
    ingress_base_url: string;
    h_limit: number;
  }>(req);
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");

  const now = nowISO();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, ?, ?, ?, 0, 1, ?)`
  )
    .bind(body.bank_id, body.bank_name, body.ingress_base_url, body.h_limit, now)
    .run();

  return json(201, { result: "REGISTERED", bank_id: body.bank_id });
}

// ---------------------------------------------------------------------------
// POST /internal/seed  reset all data → load initial data
// ---------------------------------------------------------------------------
export async function handleSeed(env: Env): Promise<Response> {
  const db = env.DB;
  const now = nowISO();

  // 1) Drop all tables (in ZC → Bank dependency order)
  // Execute individually so it can continue even if a table does not exist
  const deleteTargets = [
    "TxEventLog",
    "BankAuditLog",
    "PaymentApprovalRequests",
    "PaymentFilters",
    "HtlcAuthRequests",
    "HtlcAuthWhitelist",
    "FinalityLog",
    "IdempotencyKeys",
    "Cases",
    "Vault",
    "PsprRegistry",
    "RtpRequests",
    "GtidLegs",
    "GtidTransactions",
    "HtlcContracts",
    "DnsNetPositions",
    "DnsCycles",
    "HReservations",
    "Transactions",
    "Participants",
    "ZcRequests",
    "SuspenseDetails",
    "DailyBalances",
    "BankJournals",
    "BankAccounts",
    "InterestRates",
    "AccountVerifications",
    "CreditNotifications",
    "CrossBorderTransactions",
    "EdiRecords",
    "EventStream",
    "IgsRequests",
    "ProxyDirectory",
    "QrCodes",
    "RichDataStore",
  ];
  // Only table names from the hardcoded list are allowed (to prevent SQL identifier injection)
  const ALLOWED_TABLES = new Set(deleteTargets);
  for (const t of deleteTargets) {
    if (!ALLOWED_TABLES.has(t) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) continue;
    try {
      await db.prepare(`DELETE FROM "${t}"`).run();
    } catch (e) {
      console.error(`[seed] DELETE FROM ${t} failed (table may not exist):`, e);
    }
  }

  // 2) Load initial data (all-numeric account number scheme: BBBAAAAAAA)
  await db.batch([
    // Participants (ZC participating banks)
    db
      .prepare(`INSERT INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
      VALUES ('001','長岡銀行','/bank/001',100000000,0,1,?)`)
      .bind(now),
    db
      .prepare(`INSERT INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
      VALUES ('002','尾張銀行','/bank/002',100000000,0,1,?)`)
      .bind(now),

    // BankAccounts (account number: 3-digit bank code + 7-digit sequence, segregated=BBB0000000, ZCS=BBB-ZCS)
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('0010000001','001','C001','田中 太郎','SAVINGS','NORMAL','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('0010000002','001','C002','佐藤 花子','SAVINGS','NORMAL','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('0010000000','001','SYSTEM','別段預金','SUSPENSE','NORMAL','2025-01-01T00:00:00Z')`),
    // ZC settlement account (equivalent to a BOJ current account): negative balance = ZC owes this bank (this bank's settlement asset)
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('001-ZCS','001','SYSTEM','ZC清算勘定','SETTLEMENT','NORMAL','2025-01-01T00:00:00Z')`),
    // Cash account
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('001-CASH','001','SYSTEM','現金','ASSET','NORMAL','2025-01-01T00:00:00Z')`),
    // BOJ deposit account 001
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('001-BOJ','001','BOJ','日本銀行（預け金勘定）','BOJ','NORMAL','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('0020000001','002','C003','鈴木 一郎','SAVINGS','NORMAL','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('0020000002','002','C004','山田 美咲','SAVINGS','NORMAL','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('0020000000','002','SYSTEM','別段預金','SUSPENSE','NORMAL','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('002-ZCS','002','SYSTEM','ZC清算勘定','SETTLEMENT','NORMAL','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('002-CASH','002','SYSTEM','現金','ASSET','NORMAL','2025-01-01T00:00:00Z')`),
    // BOJ deposit account 002
    db.prepare(`INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
      VALUES ('002-BOJ','002','BOJ','日本銀行（預け金勘定）','BOJ','NORMAL','2025-01-01T00:00:00Z')`),

    // BankJournals (initial balance 1 million yen each)
    // Zero-sum: customer account (+) / ZC settlement account (−) pair
    //   ZCS(−) = "ZC owes this bank 2M" = this bank's initial settlement asset (equivalent to a BOJ current account)
    //   Suspense starts at 0 (an intermediate account whose balance only moves during a transfer)
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-001-1','001','0010000001',1000000,'CASH','INIT-001','初期残高','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-001-1X','001','001-ZCS',-1000000,'CASH','INIT-001','初期ZC清算残高 offset','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-001-2','001','0010000002',1000000,'CASH','INIT-001','初期残高','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-001-2X','001','001-ZCS',-1000000,'CASH','INIT-001','初期ZC清算残高 offset','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-002-1','002','0020000001',1000000,'CASH','INIT-002','初期残高','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-002-1X','002','002-ZCS',-1000000,'CASH','INIT-002','初期ZC清算残高 offset','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-002-2','002','0020000002',1000000,'CASH','INIT-002','初期残高','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-002-2X','002','002-ZCS',-1000000,'CASH','INIT-002','初期ZC清算残高 offset','2025-01-01','2025-01-01T00:00:00Z')`),

    // BOJ initial prefunding (for HIGH_VALUE RTGS: 100 billion yen per bank)
    // Zero-sum: BOJ(-1000B) / ZCS(+1000B) offsetting
    // calcBalance('BBB-BOJ') negative = funded balance exists. If it becomes positive, BOJ_INSUFFICIENT_FUNDS
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-001-BOJ','001','001-BOJ',-100000000000,'CASH','INIT-001-BOJ','BOJ初期プレファンド','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-001-BOJZCS','001','001-ZCS',100000000000,'CASH','INIT-001-BOJ','BOJ初期ZCS対当','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-002-BOJ','002','002-BOJ',-100000000000,'CASH','INIT-002-BOJ','BOJ初期プレファンド','2025-01-01','2025-01-01T00:00:00Z')`),
    db.prepare(`INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
      VALUES ('JNL-INIT-002-BOJZCS','002','002-ZCS',100000000000,'CASH','INIT-002-BOJ','BOJ初期ZCS対当','2025-01-01','2025-01-01T00:00:00Z')`),

    // InterestRates
    db.prepare(`INSERT INTO InterestRates (rate_id,bank_id,account_type,annual_rate,effective_from)
      VALUES ('RATE-001-SAVINGS','001','SAVINGS',0.001,'2025-01-01')`),
    db.prepare(`INSERT INTO InterestRates (rate_id,bank_id,account_type,annual_rate,effective_from)
      VALUES ('RATE-002-SAVINGS','002','SAVINGS',0.001,'2025-01-01')`),
  ]);

  return json(200, {
    result: "RESET_AND_SEEDED",
    reset_at: now,
    initial_balance_per_account: 1000000,
  });
}

// ---------------------------------------------------------------------------
// POST /api/banks/add  add a new bank
// ---------------------------------------------------------------------------
export async function handleAddBank(req: Request, env: Env): Promise<Response> {
  const body = await parseBody<{ bank_name: string; h_limit?: number; participant_type?: string }>(
    req
  );
  if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
  if (!body.bank_name) return jsonError(400, "INVALID_INPUT", "bank_name required");
  if (
    body.participant_type !== undefined &&
    !["BANK", "GOVERNMENT"].includes(body.participant_type)
  ) {
    return jsonError(400, "INVALID_INPUT", "participant_type must be BANK or GOVERNMENT");
  }

  const db = env.DB;
  const now = nowISO();

  // Auto-assign the next bank code: existing maximum bank_id + 1
  const maxBank = await db
    .prepare(`SELECT bank_id FROM Participants ORDER BY bank_id DESC LIMIT 1`)
    .first<{ bank_id: string }>();
  const nextCode = String(parseInt(maxBank?.bank_id ?? "000", 10) + 1).padStart(3, "0");

  // ZC side: register the participating bank only (account management is the bank's responsibility)
  // Theme F: participant_type='GOVERNMENT'
  // marks a benefit-issuing administrative agency (給付発起参加者). Purely a
  // classification label; account management remains the participant's own
  // responsibility (run via bank ingress below, same as a regular bank).
  await db
    .prepare(
      `INSERT INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at, participant_type)
     VALUES (?, ?, ?, ?, 0, 1, ?, ?)`
    )
    .bind(
      nextCode,
      body.bank_name,
      `/bank/${nextCode}`,
      body.h_limit ?? 100000000,
      now,
      body.participant_type ?? "BANK"
    )
    .run();

  // Bank side: request account and journal entry initialization via the bank ingress (core principle: each financial institution is responsible for managing its own accounts)
  const { handleBankIngress } = await import("../../bank/ingress");
  await handleBankIngress(nextCode, "initialize-bank", buildInitializeBankPayload(nextCode), env);

  return json(201, { result: "BANK_CREATED", bank_id: nextCode, bank_name: body.bank_name });
}

// ---------------------------------------------------------------------------
// DELETE /api/banks/:bankId  delete a bank
// ---------------------------------------------------------------------------
export async function handleDeleteBank(bankId: string, env: Env): Promise<Response> {
  const db = env.DB;

  // Check whether there are any active transactions
  const activeTx = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM Transactions WHERE (payer_bank_id=? OR payee_bank_id=?) AND state NOT IN ('SETTLED','CANCELLED','FAILED_EXECUTION')`
    )
    .bind(bankId, bankId)
    .first<{ cnt: number }>();
  if (activeTx && activeTx.cnt > 0) {
    return jsonError(
      409,
      "ACTIVE_TRANSACTIONS",
      `Bank ${bankId} has ${activeTx.cnt} active transactions`
    );
  }

  // Bank side: request account and journal entry deletion via the bank ingress (core principle: each financial institution is responsible for managing its own accounts)
  const { handleBankIngress } = await import("../../bank/ingress");
  await handleBankIngress(bankId, "cleanup-bank", buildCleanupBankPayload(), env);

  // ZC side: delete the participating bank data only
  await db.batch([
    db.prepare("DELETE FROM SuspenseDetails WHERE bank_id=?").bind(bankId),
    db.prepare("DELETE FROM ZcRequests WHERE bank_id=?").bind(bankId),
    db.prepare("DELETE FROM Participants WHERE bank_id=?").bind(bankId),
  ]);

  return json(200, { result: "BANK_DELETED", bank_id: bankId });
}

// ---------------------------------------------------------------------------
// GET /api/banks  bank list
// ---------------------------------------------------------------------------
export async function handleListBanks(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT * FROM Participants ORDER BY bank_id ASC`).all();
  return json(200, { banks: rows.results });
}

// ---------------------------------------------------------------------------
// GET /api/banks/:bankId/accounts  all accounts of a bank (for account holder name verification)
// ---------------------------------------------------------------------------
export async function handleBankAccounts(bankId: string, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT account_id, customer_name, account_type, status FROM BankAccounts WHERE bank_id=? AND account_type != 'SUSPENSE' ORDER BY account_id`
  )
    .bind(bankId)
    .all();
  return json(200, { accounts: rows.results });
}

// ---------------------------------------------------------------------------
// GET /api/accounts/:accountId/name  account holder name lookup (account number → holder name)
// ---------------------------------------------------------------------------
export async function handleAccountNameLookup(accountId: string, env: Env): Promise<Response> {
  const { bankCodeFromAccount } = await import("../../types");
  const bankCode = bankCodeFromAccount(accountId);
  const account = await env.DB.prepare(
    `SELECT account_id, customer_name, bank_id, status, account_type FROM BankAccounts WHERE account_id=? AND bank_id=?`
  )
    .bind(accountId, bankCode)
    .first<{
      account_id: string;
      customer_name: string;
      bank_id: string;
      status: string;
      account_type: string;
    }>();
  if (!account) return jsonError(404, "NOT_FOUND", "account not found");
  // System accounts (segregated deposit, settlement account, etc.) cannot be used as transfer destinations
  if (account.account_type !== "SAVINGS") {
    return jsonError(422, "ACCOUNT_NOT_TRANSFERABLE", "this account cannot receive transfers");
  }
  // Also fetch the bank name
  const bank = await env.DB.prepare(`SELECT bank_name FROM Participants WHERE bank_id=?`)
    .bind(bankCode)
    .first<{ bank_name: string }>();
  return json(200, {
    account_id: account.account_id,
    customer_name: account.customer_name,
    bank_id: account.bank_id,
    bank_name: bank?.bank_name ?? "",
    status: account.status,
  });
}
