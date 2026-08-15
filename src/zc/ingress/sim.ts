/**
 * @file ZC ingress — large-scale simulator setup handlers (20 banks × 200 accounts).
 * @module zc/ingress/sim
 */
import type { Env } from "../../types";
import { nowISO, businessDateJST } from "../../types";
import { newUUID } from "../../shared/idempotency";
import { handleSeed } from "./admin";
import { json } from "./_shared";

// ---------------------------------------------------------------------------
// POST /internal/sim/setup  large-scale simulator initialization (server-side bulk processing)
// ---------------------------------------------------------------------------
export async function handleSimSetup(req: Request, env: Env): Promise<Response> {
  const t0 = Date.now();
  let params: { bank_count?: number; accounts_per_bank?: number; personal_ratio?: number } = {};
  try {
    params = await req.json();
  } catch {
    /* use defaults */
  }

  const bankCount = Math.min(params.bank_count ?? 18, 50); // 003–020 (max 50)
  const accountsPerBank = Math.min(params.accounts_per_bank ?? 200, 500); // max 500
  const personalRatio = Math.max(0, Math.min(params.personal_ratio ?? 0.9, 1));
  const db = env.DB;
  const now = nowISO();
  const today = businessDateJST(now);

  // Step 1: seed reset (initialize 001/002)
  const seedReq = new Request("http://internal/internal/seed", { method: "POST" });
  await handleSeed(env); // Ignore the return value (the goal is DB initialization)

  // Step 2: add banks 003–(002+bankCount)
  // handleAddBank assigns numbers as "existing maximum + 1", so run sequentially
  const bankIds: string[] = [];
  for (let i = 0; i < bankCount; i++) {
    const maxBank = await db
      .prepare(`SELECT bank_id FROM Participants ORDER BY bank_id DESC LIMIT 1`)
      .first<{ bank_id: string }>();
    const nextCode = String(parseInt(maxBank?.bank_id ?? "000", 10) + 1).padStart(3, "0");
    const bankName = `テスト銀行${nextCode}`;
    await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
         VALUES (?, ?, ?, ?, 0, 1, ?)`
        )
        .bind(nextCode, bankName, `/bank/${nextCode}`, 100_000_000, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
         VALUES (?, ?, 'SYSTEM', '別段預金', 'SUSPENSE', 'NORMAL', ?)`
        )
        .bind(`${nextCode}0000000`, nextCode, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
         VALUES (?, ?, 'SYSTEM', 'ZC清算勘定', 'SETTLEMENT', 'NORMAL', ?)`
        )
        .bind(`${nextCode}-ZCS`, nextCode, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
         VALUES (?, ?, 'SYSTEM', '現金', 'ASSET', 'NORMAL', ?)`
        )
        .bind(`${nextCode}-CASH`, nextCode, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
         VALUES (?, ?, 'BOJ', '日本銀行（預け金勘定）', 'BOJ', 'NORMAL', ?)`
        )
        .bind(`${nextCode}-BOJ`, nextCode, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO InterestRates (rate_id, bank_id, account_type, annual_rate, effective_from)
         VALUES (?, ?, 'SAVINGS', 0.001, ?)`
        )
        .bind(`RATE-${nextCode}-SAVINGS`, nextCode, today),
      // BOJ initial prefunding (for HIGH_VALUE RTGS: 100 billion yen)
      db
        .prepare(
          `INSERT OR IGNORE INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
         VALUES (?, ?, ?, -100000000000, 'CASH', ?, 'BOJ初期プレファンド', ?, ?)`
        )
        .bind(
          `JNL-INIT-${nextCode}-BOJ`,
          nextCode,
          `${nextCode}-BOJ`,
          `INIT-${nextCode}-BOJ`,
          today,
          now
        ),
      db
        .prepare(
          `INSERT OR IGNORE INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
         VALUES (?, ?, ?, 100000000000, 'CASH', ?, 'BOJ初期ZCS対当', ?, ?)`
        )
        .bind(
          `JNL-INIT-${nextCode}-BOJZCS`,
          nextCode,
          `${nextCode}-ZCS`,
          `INIT-${nextCode}-BOJ`,
          today,
          now
        ),
    ]);
    bankIds.push(nextCode);
  }

  // Step 3: bulk-create accountsPerBank accounts for each bank (+ initial deposit)
  // D1 batch handles ~1000 statements per call, so 200 accounts = max 400 stmt → fits in one batch
  let totalAccounts = 0;
  const personalCount = Math.round(accountsPerBank * personalRatio);
  const corporateCount = accountsPerBank - personalCount;

  const personalNames = [
    "田中太郎",
    "鈴木花子",
    "佐藤健",
    "高橋美咲",
    "伊藤誠",
    "渡辺直子",
    "山本浩二",
    "中村愛",
    "小林剛",
    "加藤由美",
  ];
  const corpNames = ["株式会社A", "有限会社B", "合同会社C", "一般社団法人D", "合資会社E"];

  for (const bankId of bankIds) {
    const stmts: ReturnType<D1Database["prepare"]>[] = [];
    // Get the maximum sequence number of existing accounts (shared with existing logic)
    const maxAcct = await db
      .prepare(
        `SELECT account_id FROM BankAccounts WHERE bank_id=? AND account_type IN ('SAVINGS','CURRENT') ORDER BY CAST(SUBSTR(account_id, 4) AS INTEGER) DESC LIMIT 1`
      )
      .bind(bankId)
      .first<{ account_id: string }>();
    let seq = 1;
    if (maxAcct) {
      const n = parseInt(maxAcct.account_id.slice(3), 10);
      seq = Number.isNaN(n) ? 1 : n + 1;
    }

    for (let j = 0; j < accountsPerBank; j++) {
      const isPersonal = j < personalCount;
      const accountType = isPersonal ? "SAVINGS" : "CURRENT";
      const nameBase = isPersonal
        ? personalNames[j % personalNames.length]
        : corpNames[j % corpNames.length];
      const customerName = `${nameBase}${(j + 1).toString().padStart(3, "0")}`;
      const customerId = `C${bankId}${seq.toString().padStart(6, "0")}`;
      const accountId = `${bankId}${seq.toString().padStart(7, "0")}`;
      const deposit = isPersonal ? 1_000_000 : 5_000_000; // Individual 1,000,000 / Corporate 5,000,000

      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
         VALUES (?, ?, ?, ?, ?, 'NORMAL', ?)`
          )
          .bind(accountId, bankId, customerId, customerName, accountType, now)
      );

      const txGroupId = `INIT-${accountId}`;
      const cashAcct = `${bankId}-CASH`;
      stmts.push(
        db
          .prepare(
            `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, description, value_date, created_at)
         VALUES (?, ?, ?, ?, 'CASH', ?, ?, ?, ?)`
          )
          .bind(
            `JNL-${newUUID()}`,
            bankId,
            accountId,
            deposit,
            txGroupId,
            "一括開設初期入金",
            today,
            now
          )
      );
      stmts.push(
        db
          .prepare(
            `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, description, value_date, created_at)
         VALUES (?, ?, ?, ?, 'CASH', ?, ?, ?, ?)`
          )
          .bind(
            `JNL-${newUUID()}`,
            bankId,
            cashAcct,
            -deposit,
            txGroupId,
            "一括開設 現金offset",
            today,
            now
          )
      );

      seq++;
    }
    // Split into chunks of 300 stmt to avoid the D1 batch limit
    for (let k = 0; k < stmts.length; k += 300) {
      await db.batch(stmts.slice(k, k + 300));
    }
    totalAccounts += accountsPerBank;
  }

  return json(200, {
    result: "SIM_SETUP_COMPLETE",
    banks_created: bankIds.length,
    accounts_created: totalAccounts,
    elapsed_ms: Date.now() - t0,
  });
}

// ---------------------------------------------------------------------------
// POST /internal/sim/setup-bank  Simulator: bulk-create accounts for one bank
// The frontend controls progress by calling bank_index=0..N-1 in sequence
// ---------------------------------------------------------------------------
export async function handleSimSetupOneBank(req: Request, env: Env): Promise<Response> {
  const t0 = Date.now();
  let params: { bank_index?: number; accounts_per_bank?: number; personal_ratio?: number } = {};
  try {
    params = await req.json();
  } catch {
    /* use defaults */
  }

  const bankIndex = params.bank_index ?? 0;
  const accountsPerBank = Math.min(params.accounts_per_bank ?? 200, 500);
  const personalRatio = Math.max(0, Math.min(params.personal_ratio ?? 0.9, 1));
  const db = env.DB;
  const now = nowISO();
  const today = businessDateJST(now);

  // bank_index=0 → bank 003, bank_index=1 → bank 004 …
  // Compute directly from index rather than max existing bank_id + 1 (after seeding, only 001/002 exist)
  const nextCode = String(3 + bankIndex).padStart(3, "0");
  // Same bank name mapping as the frontend's SIM_BANKS
  const BANK_NAMES: Record<string, string> = {
    "003": "加賀銀行",
    "004": "肥前銀行",
    "005": "薩摩銀行",
    "006": "越後銀行",
    "007": "讃岐銀行",
    "008": "備後銀行",
    "009": "淡路銀行",
    "010": "日向銀行",
    "011": "紀伊銀行",
    "012": "相模銀行",
    "013": "駿河銀行",
    "014": "甲斐銀行",
    "015": "信濃銀行",
    "016": "近江銀行",
    "017": "丹波銀行",
    "018": "大隅銀行",
    "019": "播磨銀行",
    "020": "美作銀行",
  };
  const bankName = BANK_NAMES[nextCode] || `テスト銀行${nextCode}`;

  // Create Participant + system accounts
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
       VALUES (?, ?, ?, ?, 0, 1, ?)`
      )
      .bind(nextCode, bankName, `/bank/${nextCode}`, 100_000_000, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'SYSTEM', '別段預金', 'SUSPENSE', 'NORMAL', ?)`
      )
      .bind(`${nextCode}0000000`, nextCode, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'SYSTEM', 'ZC清算勘定', 'SETTLEMENT', 'NORMAL', ?)`
      )
      .bind(`${nextCode}-ZCS`, nextCode, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'SYSTEM', '現金', 'ASSET', 'NORMAL', ?)`
      )
      .bind(`${nextCode}-CASH`, nextCode, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'BOJ', '日本銀行（預け金勘定）', 'BOJ', 'NORMAL', ?)`
      )
      .bind(`${nextCode}-BOJ`, nextCode, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO InterestRates (rate_id, bank_id, account_type, annual_rate, effective_from)
       VALUES (?, ?, 'SAVINGS', 0.001, ?)`
      )
      .bind(`RATE-${nextCode}-SAVINGS`, nextCode, today),
    // BOJ initial prefunding (for HIGH_VALUE RTGS: 100 billion yen)
    db
      .prepare(
        `INSERT OR IGNORE INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
       VALUES (?, ?, ?, -100000000000, 'CASH', ?, 'BOJ初期プレファンド', ?, ?)`
      )
      .bind(
        `JNL-INIT-${nextCode}-BOJ`,
        nextCode,
        `${nextCode}-BOJ`,
        `INIT-${nextCode}-BOJ`,
        today,
        now
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO BankJournals (journal_id,bank_id,account_id,amount,tx_type,tx_group_id,description,value_date,created_at)
       VALUES (?, ?, ?, 100000000000, 'CASH', ?, 'BOJ初期ZCS対当', ?, ?)`
      )
      .bind(
        `JNL-INIT-${nextCode}-BOJZCS`,
        nextCode,
        `${nextCode}-ZCS`,
        `INIT-${nextCode}-BOJ`,
        today,
        now
      ),
  ]);

  // Batch-create customer accounts in chunks of 300 stmt
  const personalCount = Math.round(accountsPerBank * personalRatio);
  const corporateCount = accountsPerBank - personalCount;
  const personalNames = [
    "田中太郎",
    "鈴木花子",
    "佐藤健",
    "高橋美咲",
    "伊藤誠",
    "渡辺直子",
    "山本浩二",
    "中村愛",
    "小林剛",
    "加藤由美",
  ];
  const corpNames = ["株式会社A", "有限会社B", "合同会社C", "一般社団法人D", "合資会社E"];

  const stmts: ReturnType<D1Database["prepare"]>[] = [];
  const cashAcct = `${nextCode}-CASH`;
  for (let j = 0; j < accountsPerBank; j++) {
    const isPersonal = j < personalCount;
    const accountType = isPersonal ? "SAVINGS" : "CURRENT";
    const nameBase = isPersonal
      ? personalNames[j % personalNames.length]
      : corpNames[j % corpNames.length];
    const customerName = `${nameBase}${(j + 1).toString().padStart(3, "0")}`;
    const seq = j + 1;
    const customerId = `C${nextCode}${seq.toString().padStart(6, "0")}`;
    const accountId = `${nextCode}${seq.toString().padStart(7, "0")}`;
    const deposit = isPersonal ? 1_000_000 : 5_000_000;

    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO BankAccounts (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, ?, ?, ?, 'NORMAL', ?)`
        )
        .bind(accountId, nextCode, customerId, customerName, accountType, now)
    );

    const txGroupId = `INIT-${accountId}`;
    stmts.push(
      db
        .prepare(
          `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, description, value_date, created_at)
       VALUES (?, ?, ?, ?, 'CASH', ?, ?, ?, ?)`
        )
        .bind(
          `JNL-${newUUID()}`,
          nextCode,
          accountId,
          deposit,
          txGroupId,
          "一括開設初期入金",
          today,
          now
        )
    );
    stmts.push(
      db
        .prepare(
          `INSERT INTO BankJournals (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, description, value_date, created_at)
       VALUES (?, ?, ?, ?, 'CASH', ?, ?, ?, ?)`
        )
        .bind(
          `JNL-${newUUID()}`,
          nextCode,
          cashAcct,
          -deposit,
          txGroupId,
          "一括開設 現金offset",
          today,
          now
        )
    );
  }

  // Execute the batch + verify the actual number created
  let actualCreated = 0;
  for (let k = 0; k < stmts.length; k += 300) {
    await db.batch(stmts.slice(k, k + 300));
  }

  // Verify the actual number of accounts created
  const checkResult = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM BankAccounts WHERE bank_id = ? AND account_type IN ('SAVINGS', 'CURRENT')`
    )
    .bind(nextCode)
    .first<{ cnt: number }>();
  actualCreated = checkResult?.cnt ?? 0;

  return json(200, {
    result: "BANK_SETUP_DONE",
    bank_id: nextCode,
    bank_name: bankName,
    accounts_created: actualCreated,
    elapsed_ms: Date.now() - t0,
  });
}
