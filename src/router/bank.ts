/**
 * @file Bank API router (/bank/:id/*).
 * @module router/bank
 */
import {
  handleGetAccountTransactions,
  handleGetAccounts,
  handleGetBalance,
  handleGetTransferStatus,
  handlePostCustomerTransfer,
} from "../bank/customer_api";
import {
  createFilter,
  deleteFilter,
  listApprovalRequests,
  listFilters,
  respondToApproval,
  setFilterActive,
} from "../bank/filter";
import { handleBankIngressHttp } from "../bank/ingress";
import {
  handleBatchCreateAccounts,
  handleBatchStatus,
  handleCashDeposit,
  handleCashWithdrawal,
  handleCreateAccount,
  handleGetAllJournals,
  handleGetJournals,
  handleListSuspense,
  handleSuspenseResolve,
  handleTellerListAccounts,
  handleUpdateAccountStatus,
} from "../bank/teller_api";
import type { CreatePaymentFilterRequest, Env, RespondApprovalRequest } from "../types";
import { json, jsonError } from "../zc/ingress";

// =========================================================================
// Bank routing  /bank/:bankId/...
// =========================================================================
export async function handleBankApi(
  req: Request,
  path: string,
  method: string,
  env: Env
): Promise<Response> {
  const bankMatch = path.match(/^\/bank\/([^/]+)(.*)$/);
  if (!bankMatch) return jsonError(404, "NOT_FOUND", "invalid bank path");
  const bankId = bankMatch[1]!;
  const sub = bankMatch[2] ?? "";

  // ZC→Bank Ingress API
  const ingressMatch = sub.match(/^\/zc-ingress\/([^/]+)$/);
  if (method === "POST" && ingressMatch)
    return handleBankIngressHttp(req, bankId, ingressMatch[1]!, env);

  // Customer API
  if (method === "GET" && sub === "/v1/me/accounts") return handleGetAccounts(req, bankId, env);

  const balanceMatch = sub.match(/^\/v1\/me\/accounts\/([^/]+)\/balance$/);
  if (method === "GET" && balanceMatch) return handleGetBalance(req, bankId, balanceMatch[1]!, env);

  const acctTxMatch = sub.match(/^\/v1\/me\/accounts\/([^/]+)\/transactions$/);
  if (method === "GET" && acctTxMatch)
    return handleGetAccountTransactions(req, bankId, acctTxMatch[1]!, env);

  if (method === "POST" && sub === "/v1/me/transfers")
    return handlePostCustomerTransfer(req, bankId, env);

  const txStatusMatch = sub.match(/^\/v1\/me\/transfers\/([^/]+)$/);
  if (method === "GET" && txStatusMatch)
    return handleGetTransferStatus(req, bankId, txStatusMatch[1]!, env);

  // Teller API
  if (method === "POST" && sub === "/v1/teller/cash/deposit")
    return handleCashDeposit(req, bankId, env);

  if (method === "POST" && sub === "/v1/teller/cash/withdrawal")
    return handleCashWithdrawal(req, bankId, env);

  if (method === "GET" && sub === "/v1/teller/accounts")
    return handleTellerListAccounts(req, bankId, env);
  if (method === "POST" && sub === "/v1/teller/accounts")
    return handleCreateAccount(req, bankId, env);
  if (method === "POST" && sub === "/v1/teller/accounts/batch")
    return handleBatchCreateAccounts(req, bankId, env);

  const acctStatusMatch = sub.match(/^\/v1\/teller\/accounts\/([^/]+)\/status$/);
  if (method === "PATCH" && acctStatusMatch)
    return handleUpdateAccountStatus(req, bankId, acctStatusMatch[1]!, env);

  if (method === "GET" && sub === "/v1/teller/journals")
    return handleGetAllJournals(req, bankId, env);
  const journalMatch = sub.match(/^\/v1\/teller\/accounts\/([^/]+)\/journals$/);
  if (method === "GET" && journalMatch)
    return handleGetJournals(req, bankId, journalMatch[1]!, env);

  if (method === "GET" && sub === "/v1/teller/suspense")
    return handleListSuspense(req, bankId, env);

  const suspResolveMatch = sub.match(/^\/v1\/teller\/suspense\/([^/]+)\/resolve$/);
  if (method === "POST" && suspResolveMatch)
    return handleSuspenseResolve(req, bankId, suspResolveMatch[1]!, env);

  if (method === "GET" && sub === "/v1/teller/batch/status")
    return handleBatchStatus(req, bankId, env);

  // Incoming credit filter management API
  if (sub === "/v1/filters") {
    if (method === "GET") {
      const url = new URL(req.url);
      const filters = await listFilters(bankId, url.searchParams.get("account_id"), env.DB);
      return json(200, { filters });
    }
    if (method === "POST") {
      const body = (await req.json().catch(() => null)) as CreatePaymentFilterRequest | null;
      if (!body) return jsonError(400, "INVALID_JSON", "invalid body");
      const filter = await createFilter(bankId, body, env.DB);
      return json(201, filter);
    }
  }
  const filterIdMatch = sub.match(/^\/v1\/filters\/([^/]+)$/);
  if (filterIdMatch) {
    const filterId = filterIdMatch[1]!;
    if (method === "DELETE") {
      const ok = await deleteFilter(bankId, filterId, env.DB);
      return ok
        ? json(200, { result: "DELETED", filter_id: filterId })
        : jsonError(404, "NOT_FOUND", `filter ${filterId} not found`);
    }
    if (method === "PATCH") {
      const body = (await req.json().catch(() => null)) as { is_active?: boolean } | null;
      const ok = await setFilterActive(bankId, filterId, body?.is_active !== false, env.DB);
      return ok
        ? json(200, { result: "UPDATED", filter_id: filterId })
        : jsonError(404, "NOT_FOUND", `filter ${filterId} not found`);
    }
  }

  // Incoming credit approval API (customer)
  if (method === "GET" && sub === "/v1/me/approvals") {
    const url = new URL(req.url);
    const approvals = await listApprovalRequests(
      bankId,
      url.searchParams.get("account_id"),
      url.searchParams.get("status") ?? "PENDING",
      env.DB
    );
    return json(200, { approvals });
  }
  const approvalRespondMatch = sub.match(/^\/v1\/me\/approvals\/([^/]+)\/respond$/);
  if (method === "POST" && approvalRespondMatch) {
    const body = (await req.json().catch(() => null)) as RespondApprovalRequest | null;
    if (body === null || typeof body.approved !== "boolean") {
      return jsonError(400, "INVALID_JSON", "approved (boolean) required");
    }
    const result = await respondToApproval(bankId, approvalRespondMatch[1]!, body, env.DB);
    if (!result.ok) return jsonError(400, result.reason ?? "ERROR", result.reason ?? "failed");

    // If approved: notify ZC of resume_credit (via Queue)
    if (body.approved && result.txid) {
      // Fetch the payee information for the target transaction
      const txInfo = await env.DB.prepare(
        `SELECT payee_bank_id, payee_account_hash FROM Transactions WHERE txid=?`
      )
        .bind(result.txid)
        .first<{ payee_bank_id: string; payee_account_hash: string | null }>();
      if (txInfo) {
        await env.QUEUE.send({
          type: "ZC_RESUME_CREDIT",
          payload: {
            txid: result.txid,
            payee_bank_id: txInfo.payee_bank_id,
            payee_account_hash: txInfo.payee_account_hash ?? undefined,
          },
          txid: result.txid,
          attempt: 0,
          enqueued_at: new Date().toISOString(),
        });
      }
    }
    return json(200, { result: body.approved ? "APPROVED" : "REJECTED", txid: result.txid });
  }

  // BankAuditLog lookup (teller)
  if (method === "GET" && sub === "/v1/teller/audit-log") {
    const url = new URL(req.url);
    const txid = url.searchParams.get("txid");
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    let sql = `SELECT * FROM BankAuditLog WHERE bank_id=?`;
    const binds: unknown[] = [bankId];
    if (txid) {
      sql += ` AND txid=?`;
      binds.push(txid);
    }
    sql += ` ORDER BY occurred_at DESC LIMIT ?`;
    binds.push(limit);
    const rows = await env.DB.prepare(sql)
      .bind(...binds)
      .all();
    return json(200, { audit_log: rows.results });
  }

  return jsonError(404, "NOT_FOUND", `Bank API ${method} ${path} not found`);
}
