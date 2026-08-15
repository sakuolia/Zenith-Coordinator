/**
 * @file Bank teller (staff) API handlers. Provides cash deposit/withdrawal,
 * account management (create, batch create, status update), journal queries,
 * suspense resolution, and batch status.
 * @module bank/teller_api
 */
import type { Env, BankAccountRow, SuspenseDetailRow } from "../types";
import {
  nowISO,
  businessDateJST,
  suspenseAccountId,
  cashAccountId,
  generateAccountId,
} from "../types";
import { json, jsonError } from "../zc/ingress";
import { calcBalance as calcBalanceLedger } from "./ledger";
import { insertJournalGroup } from "./ledger";
import { newUUID } from "../shared/idempotency";
import { transitionEntityWithLog } from "../shared/entity_state_log";
import { MAX_AMOUNT_VALUE } from "../shared/constants";

function getTellerHeaders(req: Request): { bankId: string; tellerId: string } | null {
  const bankId = req.headers.get("X-Bank-Id");
  const tellerId = req.headers.get("X-Teller-Id");
  if (!bankId || !tellerId) return null;
  return { bankId, tellerId };
}

// ---------------------------------------------------------------------------
// POST /bank/:bankId/v1/teller/cash/deposit  cash deposit
// ---------------------------------------------------------------------------
export async function handleCashDeposit(req: Request, bankId: string, env: Env): Promise<Response> {
  const headers = getTellerHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "teller headers required");

  let body: { account_id: string; amount: number; description?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "invalid json");
  }

  // Amount validation: allow only positive integers (prevents bypassing the balance check with a negative amount)
  if (
    typeof body.amount !== "number" ||
    !Number.isInteger(body.amount) ||
    body.amount <= 0 ||
    body.amount > MAX_AMOUNT_VALUE
  ) {
    return jsonError(
      400,
      "INVALID_AMOUNT",
      `amount must be a positive integer <= ${MAX_AMOUNT_VALUE}`
    );
  }

  const account = await env.DB.prepare(
    `SELECT * FROM BankAccounts WHERE account_id=? AND bank_id=? AND status='NORMAL'`
  )
    .bind(body.account_id, bankId)
    .first<BankAccountRow>();
  if (!account) return jsonError(404, "NOT_FOUND", "account not found");

  const txGroupId = `CASH-DEP-${newUUID()}`;
  // The counterpart of a cash deposit is the cash (Cash) account -- Cash(-) / Customer(+)
  await insertJournalGroup(env.DB, {
    bankId,
    txGroupId,
    entries: [
      {
        accountId: body.account_id,
        amount: body.amount,
        txType: "CASH",
        description: body.description ?? "現金入金",
      },
      {
        accountId: cashAccountId(bankId),
        amount: -body.amount,
        txType: "CASH",
        description: "現金入金 offset",
      },
    ],
    valueDate: businessDateJST(),
  });

  const balance = await calcBalanceLedger(body.account_id, env.DB);
  return json(200, {
    result: "OK",
    account_id: body.account_id,
    new_balance: balance,
    currency: "JPY",
  });
}

// ---------------------------------------------------------------------------
// POST /bank/:bankId/v1/teller/cash/withdrawal  cash withdrawal
// ---------------------------------------------------------------------------
export async function handleCashWithdrawal(
  req: Request,
  bankId: string,
  env: Env
): Promise<Response> {
  const headers = getTellerHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "teller headers required");

  let body: { account_id: string; amount: number; description?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "invalid json");
  }

  // Amount validation: only positive integers allowed
  if (
    typeof body.amount !== "number" ||
    !Number.isInteger(body.amount) ||
    body.amount <= 0 ||
    body.amount > MAX_AMOUNT_VALUE
  ) {
    return jsonError(
      400,
      "INVALID_AMOUNT",
      `amount must be a positive integer <= ${MAX_AMOUNT_VALUE}`
    );
  }

  const account = await env.DB.prepare(
    `SELECT * FROM BankAccounts WHERE account_id=? AND bank_id=? AND status='NORMAL'`
  )
    .bind(body.account_id, bankId)
    .first<BankAccountRow>();
  if (!account) return jsonError(404, "NOT_FOUND", "account not found");

  const balance = await calcBalanceLedger(body.account_id, env.DB);
  if (balance < body.amount) return jsonError(400, "INSUFFICIENT_FUNDS", "insufficient balance");

  const txGroupId = `CASH-WD-${newUUID()}`;
  // The counterpart of a cash withdrawal is the cash (Cash) account -- Cash(+) / Customer(-)
  await insertJournalGroup(env.DB, {
    bankId,
    txGroupId,
    entries: [
      {
        accountId: body.account_id,
        amount: -body.amount,
        txType: "CASH",
        description: body.description ?? "現金払い戻し",
      },
      {
        accountId: cashAccountId(bankId),
        amount: body.amount,
        txType: "CASH",
        description: "現金払戻 offset",
      },
    ],
    valueDate: businessDateJST(),
  });

  const newBalance = await calcBalanceLedger(body.account_id, env.DB);
  return json(200, {
    result: "OK",
    account_id: body.account_id,
    new_balance: newBalance,
    currency: "JPY",
  });
}

// ---------------------------------------------------------------------------
// GET /bank/:bankId/v1/teller/accounts/:accountId/journals  journal entry lookup
// ---------------------------------------------------------------------------
export async function handleGetJournals(
  req: Request,
  bankId: string,
  accountId: string,
  env: Env
): Promise<Response> {
  const headers = getTellerHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "teller headers required");

  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "2000-01-01";
  const to = url.searchParams.get("to") ?? "9999-12-31";
  const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);

  const journals = await env.DB.prepare(
    `SELECT * FROM BankJournals WHERE account_id=? AND bank_id=? AND value_date BETWEEN ? AND ? ORDER BY created_at DESC LIMIT ?`
  )
    .bind(accountId, bankId, from, to, limit)
    .all();

  return json(200, { journals: journals.results, count: journals.results.length });
}

// ---------------------------------------------------------------------------
// POST /bank/:bankId/v1/teller/suspense/:suspenseId/resolve  segregated deposit (suspense) resolution
// ---------------------------------------------------------------------------
export async function handleSuspenseResolve(
  req: Request,
  bankId: string,
  suspenseId: string,
  env: Env
): Promise<Response> {
  const headers = getTellerHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "teller headers required");

  let body: { action: "SETTLE" | "RETURN"; target_account_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "invalid json");
  }

  const suspense = await env.DB.prepare(
    `SELECT * FROM SuspenseDetails WHERE suspense_id=? AND bank_id=?`
  )
    .bind(suspenseId, bankId)
    .first<SuspenseDetailRow>();
  if (!suspense) return jsonError(404, "NOT_FOUND", "suspense not found");
  if (suspense.status !== "CUSTODY")
    return jsonError(400, "INVALID_STATE", "only CUSTODY can be resolved here");

  const now = nowISO();
  const targetAccountId = body.target_account_id ?? suspense.account_id;
  const txGroupId = `SUSP-RESOLVE-${suspenseId}`;
  const suspAcctId = suspenseAccountId(bankId);

  if (body.action === "SETTLE") {
    // Segregated (suspense) -> ordinary deposit
    await insertJournalGroup(env.DB, {
      bankId,
      txGroupId,
      entries: [
        {
          accountId: targetAccountId,
          amount: suspense.amount,
          txType: "CREDIT",
          txid: suspense.txid ?? undefined,
          description: "CUSTODY resolved",
        },
        {
          accountId: suspAcctId,
          amount: -suspense.amount,
          txType: "CREDIT",
          description: "CUSTODY resolved offset",
        },
      ],
      valueDate: businessDateJST(now),
    });
    await env.DB.prepare(
      `UPDATE SuspenseDetails SET status='SETTLED', settled_at=?, updated_at=? WHERE suspense_id=?`
    )
      .bind(now, now, suspenseId)
      .run();
    return json(200, { result: "SETTLED", suspense_id: suspenseId });
  } else {
    // On RETURN, create a journal entry that clears the segregated (suspense) balance
    await insertJournalGroup(env.DB, {
      bankId,
      txGroupId: `SUSP-RETURN-${suspenseId}`,
      entries: [
        {
          accountId: suspAcctId,
          amount: -suspense.amount,
          txType: "CREDIT",
          txid: suspense.txid ?? undefined,
          description: "CUSTODY returned 別段消去",
        },
        {
          accountId: suspense.account_id,
          amount: suspense.amount,
          txType: "CREDIT",
          txid: suspense.txid ?? undefined,
          description: "CUSTODY returned 残高戻し",
        },
      ],
      valueDate: businessDateJST(now),
    });
    await env.DB.prepare(
      `UPDATE SuspenseDetails SET status='RETURNED', updated_at=? WHERE suspense_id=?`
    )
      .bind(now, suspenseId)
      .run();
    return json(200, { result: "RETURNED", suspense_id: suspenseId });
  }
}

// ---------------------------------------------------------------------------
// GET /bank/:bankId/v1/teller/batch/status  batch processing status lookup
// ---------------------------------------------------------------------------
export async function handleBatchStatus(req: Request, bankId: string, env: Env): Promise<Response> {
  const headers = getTellerHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "teller headers required");

  const today = businessDateJST();
  const dnsCycle = await env.DB.prepare(`SELECT * FROM DnsCycles WHERE business_date = ?`)
    .bind(today)
    .first();

  const openSuspense = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM SuspenseDetails WHERE bank_id=? AND status NOT IN ('SETTLED','RETURNED')`
  )
    .bind(bankId)
    .first<{ cnt: number }>();

  return json(200, {
    business_date: today,
    dns_cycle: dnsCycle ?? { state: "NOT_STARTED" },
    open_suspense_count: openSuspense?.cnt ?? 0,
    as_of: nowISO(),
  });
}

// ---------------------------------------------------------------------------
// GET /bank/:bankId/v1/teller/accounts  list of all accounts for tellers
// ---------------------------------------------------------------------------
export async function handleTellerListAccounts(
  req: Request,
  bankId: string,
  env: Env
): Promise<Response> {
  const headers = getTellerHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "teller headers required");

  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status");

  const noBalance = url.searchParams.get("no_balance") === "1";

  let query = `SELECT * FROM BankAccounts WHERE bank_id=?`;
  const params: unknown[] = [bankId];
  if (statusFilter) {
    query += ` AND status=?`;
    params.push(statusFilter);
  }
  query += ` ORDER BY opened_at ASC`;

  if (noBalance) {
    const rows = await env.DB.prepare(query)
      .bind(...params)
      .all<BankAccountRow>();
    return json(200, { accounts: rows.results });
  }

  // Use LEFT JOIN to aggregate balances, avoiding the N+1 problem that causes D1 limits to crash the API
  let joinQuery = `
    SELECT a.*, COALESCE(SUM(j.amount), 0) AS balance
    FROM BankAccounts a
    LEFT JOIN BankJournals j ON a.account_id = j.account_id
    WHERE a.bank_id=?
  `;
  if (statusFilter) {
    joinQuery += ` AND a.status=?`;
  }
  joinQuery += ` GROUP BY a.account_id ORDER BY a.opened_at ASC`;

  const joinedRows = await env.DB.prepare(joinQuery)
    .bind(...params)
    .all();
  return json(200, { accounts: joinedRows.results });
}

// ---------------------------------------------------------------------------
// POST /bank/:bankId/v1/teller/accounts  create a new account (all-numeric account number)
// ---------------------------------------------------------------------------
export async function handleCreateAccount(
  req: Request,
  bankId: string,
  env: Env
): Promise<Response> {
  const headers = getTellerHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "teller headers required");

  let body: { customer_name: string; account_type?: string; initial_deposit?: number };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "invalid json");
  }
  if (!body.customer_name) return jsonError(400, "INVALID_INPUT", "customer_name is required");

  const accountType = body.account_type ?? "SAVINGS";
  const allowed = ["SAVINGS", "CURRENT"];
  if (!allowed.includes(accountType))
    return jsonError(400, "INVALID_TYPE", "account_type must be SAVINGS or CURRENT");

  if (body.initial_deposit !== undefined && body.initial_deposit !== null) {
    if (
      typeof body.initial_deposit !== "number" ||
      !Number.isInteger(body.initial_deposit) ||
      body.initial_deposit <= 0 ||
      body.initial_deposit > MAX_AMOUNT_VALUE
    ) {
      return jsonError(
        400,
        "INVALID_AMOUNT",
        `initial_deposit must be a positive integer <= ${MAX_AMOUNT_VALUE}`
      );
    }
  }

  const now = nowISO();

  // Compute the next account number: max account number for the same bank + 1
  // Restrict to IN ('SAVINGS','CURRENT') -- exclude system accounts such as '003-ZCS' and
  //           prevent the issue where parseInt('-ZCS') = NaN -> NaN+1 = NaN corrupts the account number
  const maxAcct = await env.DB.prepare(
    `SELECT account_id FROM BankAccounts WHERE bank_id=? AND account_type IN ('SAVINGS', 'CURRENT') ORDER BY CAST(SUBSTR(account_id, 4) AS INTEGER) DESC LIMIT 1`
  )
    .bind(bankId)
    .first<{ account_id: string }>();

  let nextSeq = 1;
  if (maxAcct) {
    const currentSeq = parseInt(maxAcct.account_id.slice(3), 10);
    nextSeq = Number.isNaN(currentSeq) ? 1 : currentSeq + 1;
  }
  const accountId = generateAccountId(bankId, nextSeq);

  // Auto-generate the customer ID
  const customerId = `C${newUUID().replace(/-/g, "").slice(0, 12)}`;

  await env.DB.prepare(
    `INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
     VALUES (?,?,?,?,?,'NORMAL',?)`
  )
    .bind(accountId, bankId, customerId, body.customer_name, accountType, now)
    .run();

  if (body.initial_deposit && body.initial_deposit > 0) {
    await insertJournalGroup(env.DB, {
      bankId,
      txGroupId: `INIT-${accountId}`,
      entries: [
        {
          accountId,
          amount: body.initial_deposit,
          txType: "CASH",
          description: "口座開設初期入金",
        },
        {
          accountId: cashAccountId(bankId),
          amount: -body.initial_deposit,
          txType: "CASH",
          description: "口座開設 現金offset",
        },
      ],
      valueDate: businessDateJST(now),
    });
  }

  return json(201, {
    result: "CREATED",
    account_id: accountId,
    bank_id: bankId,
    account_type: accountType,
    customer_name: body.customer_name,
  });
}

// ---------------------------------------------------------------------------
// PATCH /bank/:bankId/v1/teller/accounts/:accountId  change account status
// ---------------------------------------------------------------------------
export async function handleUpdateAccountStatus(
  req: Request,
  bankId: string,
  accountId: string,
  env: Env
): Promise<Response> {
  const headers = getTellerHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "teller headers required");

  let body: { status: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "invalid json");
  }

  const allowedStatuses = ["NORMAL", "FROZEN", "CLOSING_HOLD", "CLOSED"];
  if (!allowedStatuses.includes(body.status))
    return jsonError(400, "INVALID_STATUS", `status must be one of: ${allowedStatuses.join(", ")}`);

  const now = nowISO();
  const cur = await env.DB.prepare(
    `SELECT status FROM BankAccounts WHERE account_id=? AND bank_id=?`
  )
    .bind(accountId, bankId)
    .first<{ status: string }>();
  if (!cur) return jsonError(404, "NOT_FOUND", "account not found");

  // CAS guard (status != target) so re-applying the same status is a no-op and
  // does not append a spurious EntityStateLog fact.
  await transitionEntityWithLog(env.DB, {
    update: {
      sql: `UPDATE BankAccounts SET status=?, freeze_reason=?, closed_at=? WHERE account_id=? AND bank_id=? AND status!=?`,
      binds: [
        body.status,
        body.status === "NORMAL" ? null : (body.reason ?? null),
        body.status === "CLOSED" ? now : null,
        accountId,
        bankId,
        body.status,
      ],
    },
    transition: {
      entityType: "BANK_ACCOUNT",
      entityId: accountId,
      eventType: "AccountStatusChanged",
      stateFrom: cur.status,
      stateTo: body.status,
      reasonCode: body.reason ?? null,
      actor: `BANK_${bankId}`,
    },
  });

  return json(200, { result: "OK", account_id: accountId, status: body.status });
}

// ---------------------------------------------------------------------------
// GET /bank/:bankId/v1/teller/suspense  segregated deposit (suspense) list
// ---------------------------------------------------------------------------
export async function handleListSuspense(
  req: Request,
  bankId: string,
  env: Env
): Promise<Response> {
  const headers = getTellerHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "teller headers required");

  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status");
  const txidFilter = url.searchParams.get("txid");

  let query = `SELECT * FROM SuspenseDetails WHERE bank_id=?`;
  const params: unknown[] = [bankId];
  if (statusFilter) {
    query += ` AND status=?`;
    params.push(statusFilter);
  }
  if (txidFilter) {
    query += ` AND txid LIKE ?`;
    params.push(`%${txidFilter}%`);
  }
  query += ` ORDER BY created_at DESC LIMIT 200`;

  const rows = await env.DB.prepare(query)
    .bind(...params)
    .all<SuspenseDetailRow>();
  return json(200, { suspense: rows.results, count: rows.results.length });
}

// ---------------------------------------------------------------------------
// GET /bank/:bankId/v1/teller/journals  full journal ledger (account ID is a query parameter)
// ---------------------------------------------------------------------------
export async function handleGetAllJournals(
  req: Request,
  bankId: string,
  env: Env
): Promise<Response> {
  const headers = getTellerHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "teller headers required");

  const url = new URL(req.url);
  const accId = url.searchParams.get("account_id");
  const from = url.searchParams.get("from") ?? "2000-01-01";
  const to = url.searchParams.get("to") ?? "9999-12-31";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10), 500);

  let query = `SELECT * FROM BankJournals WHERE bank_id=? AND value_date BETWEEN ? AND ?`;
  const params: unknown[] = [bankId, from, to];
  if (accId) {
    query += ` AND account_id=?`;
    params.push(accId);
  }
  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const rows = await env.DB.prepare(query)
    .bind(...params)
    .all();
  return json(200, { journals: rows.results, count: rows.results.length });
}

// ---------------------------------------------------------------------------
// POST /bank/:bankId/v1/teller/accounts/batch  bulk account creation
// Max 200 accounts/request. With initial_deposit, journal entries are also generated at the same time.
// ---------------------------------------------------------------------------
export async function handleBatchCreateAccounts(
  req: Request,
  bankId: string,
  env: Env
): Promise<Response> {
  const headers = getTellerHeaders(req);
  if (!headers) return jsonError(401, "UNAUTHORIZED", "teller headers required");

  let body: {
    accounts: Array<{ customer_name: string; account_type?: string; initial_deposit?: number }>;
  };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "invalid json");
  }
  if (!Array.isArray(body.accounts) || body.accounts.length === 0)
    return jsonError(400, "INVALID_INPUT", "accounts array required");
  if (body.accounts.length > 200) return jsonError(400, "TOO_MANY", "max 200 accounts per batch");

  const now = nowISO();
  const today = businessDateJST(now);
  const allowed = ["SAVINGS", "CURRENT"];

  // Fetch the current max account number (shared with existing logic)
  // To prevent ID collisions from concurrent execution, make it unique with a UUID suffix
  const maxAcct = await env.DB.prepare(
    `SELECT account_id FROM BankAccounts WHERE bank_id=? AND account_type IN ('SAVINGS', 'CURRENT') ORDER BY CAST(SUBSTR(account_id, 4) AS INTEGER) DESC LIMIT 1`
  )
    .bind(bankId)
    .first<{ account_id: string }>();
  let nextSeq = 1;
  if (maxAcct) {
    const currentSeq = parseInt(maxAcct.account_id.slice(3), 10);
    nextSeq = Number.isNaN(currentSeq) ? 1 : currentSeq + 1;
  }
  // To avoid seq collisions from concurrent requests, add a random offset
  nextSeq += Math.floor(Math.random() * 1000000);

  const stmts: ReturnType<D1Database["prepare"]>[] = [];
  const created: Array<{
    account_id: string;
    bank_id: string;
    customer_name: string;
    initial_deposit?: number;
  }> = [];

  for (const spec of body.accounts) {
    if (!spec.customer_name?.trim()) continue;
    const accountType = allowed.includes(spec.account_type ?? "")
      ? (spec.account_type as string)
      : "SAVINGS";
    const customerId = `C${newUUID().replace(/-/g, "").slice(0, 12)}`;
    const accountId = generateAccountId(bankId, nextSeq);

    stmts.push(
      env.DB.prepare(
        `INSERT INTO BankAccounts (account_id,bank_id,customer_id,customer_name,account_type,status,opened_at)
       VALUES (?,?,?,?,?,'NORMAL',?)`
      ).bind(accountId, bankId, customerId, spec.customer_name.trim(), accountType, now)
    );

    if (spec.initial_deposit && spec.initial_deposit > 0) {
      const txGroupId = `INIT-${accountId}`;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,amount_currency,tx_type,tx_group_id,description,value_date,created_at)
         VALUES (?,?,?,?,'JPY','CASH',?,?,?,?)`
        ).bind(
          `JNL-B-${newUUID()}`,
          bankId,
          accountId,
          spec.initial_deposit,
          txGroupId,
          "一括開設初期入金",
          today,
          now
        )
      );
      stmts.push(
        env.DB.prepare(
          `INSERT INTO BankJournals (journal_id,bank_id,account_id,amount,amount_currency,tx_type,tx_group_id,description,value_date,created_at)
         VALUES (?,?,?,?,'JPY','CASH',?,?,?,?)`
        ).bind(
          `JNL-B-${newUUID()}`,
          bankId,
          cashAccountId(bankId),
          -spec.initial_deposit,
          txGroupId,
          "一括開設 現金offset",
          today,
          now
        )
      );
    }

    created.push({
      account_id: accountId,
      bank_id: bankId,
      customer_name: spec.customer_name.trim(),
      initial_deposit: spec.initial_deposit,
    });
    nextSeq++;
  }

  // D1 batch: 200 accounts x 3 statements = max 600 (within the limit)
  if (stmts.length > 0) await env.DB.batch(stmts);

  return json(201, { result: "BATCH_CREATED", count: created.length, created });
}
