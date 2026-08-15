/**
 * @file bank_hub.ts — ZC → Bank internal call hub (same-Worker routing).
 *
 * All ZC-to-Bank commands route through callBankIngress, which applies the
 * circuit breaker gate and dispatches to the Bank Ingress handler directly
 * (no HTTP overhead since both sides live in the same Worker).
 */
import type {
  Env,
  ReserveFundsRequest,
  ReserveFundsResponse,
  ExecuteDebitRequest,
  ExecuteDebitResponse,
  ExecuteCreditRequest,
  ExecuteCreditResult,
  ReleaseReserveRequest,
  ReleaseReserveResponse,
  LegReadyCheckRequest,
  LegReadyCheckResponse,
  AuthorityCheckRequest,
  AuthorityCheckResponse,
  NameCheckRequest,
  NameCheckResponse,
} from "../../types";

export async function callBankReserveFunds(
  bankId: string,
  req: ReserveFundsRequest,
  env: Env
): Promise<ReserveFundsResponse> {
  return callBankIngress(bankId, "reserve-funds", req, env);
}

export async function callBankExecuteDebit(
  bankId: string,
  req: ExecuteDebitRequest,
  env: Env
): Promise<ExecuteDebitResponse> {
  return callBankIngress(bankId, "execute-debit", req, env);
}

export async function callBankExecuteCredit(
  bankId: string,
  req: ExecuteCreditRequest,
  env: Env
): Promise<ExecuteCreditResult> {
  return callBankIngress(bankId, "execute-credit", req, env);
}

export async function callBankReleaseReserve(
  bankId: string,
  req: ReleaseReserveRequest,
  env: Env
): Promise<ReleaseReserveResponse> {
  return callBankIngress(bankId, "release-reserve", req, env);
}

export async function callBankLegReadyCheck(
  bankId: string,
  req: LegReadyCheckRequest,
  env: Env
): Promise<LegReadyCheckResponse> {
  return callBankIngress(bankId, "leg-ready-check", req, env);
}

export async function callBankAuthorityCheck(
  bankId: string,
  req: AuthorityCheckRequest,
  env: Env
): Promise<AuthorityCheckResponse> {
  return callBankIngress(bankId, "authority-check", req, env);
}

export async function callBankNameCheck(
  bankId: string,
  req: NameCheckRequest,
  env: Env
): Promise<NameCheckResponse & { customer_name?: string }> {
  return callBankIngress(bankId, "name-check", req, env);
}

/**
 * Internal routing hub: dispatches bank commands to the Bank Ingress handler
 * within the same Worker (no external HTTP call needed).
 */
async function callBankIngress<T>(
  bankId: string,
  command: string,
  payload: unknown,
  env: Env
): Promise<T> {
  const { allowRequest, recordSuccess, recordFailure } = await import(
    "../platform/circuit_breaker"
  );

  const allowed = await allowRequest(bankId, env.DB);
  if (!allowed) {
    console.warn(`[orchestrator] Circuit OPEN for bank ${bankId}, fast-failing ${command}`);
    return { result: "ERROR", reason_code: "CIRCUIT_OPEN" } as unknown as T;
  }

  const { handleBankIngress } = await import("../../bank/ingress");
  try {
    const result = (await handleBankIngress(bankId, command, payload, env)) as T;
    await recordSuccess(bankId, env.DB);
    return result;
  } catch (err) {
    await recordFailure(bankId, env.DB);
    throw err;
  }
}
