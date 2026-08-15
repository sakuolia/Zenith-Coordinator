/**
 * @module bank/ingress
 * @description ZC -> Bank Ingress API dispatcher (13 commands).
 *
 * This module is the bank-side ingress entry point that receives commands from
 * the Zenith Coordinator (ZC). Each command corresponds to a specific stage in
 * the payment lifecycle and is implemented in a focused submodule under
 * `bank/ingress/`:
 *
 *   1. reserve-funds     — Reserve payer funds in suspense (H_RESERVED)   [reserve]
 *   2. execute-debit     — Finalize payer debit (a-proof generation)      [execute]
 *   3. execute-credit    — Credit payee account (b-proof, hard landing)   [execute]
 *   4. release-reserve   — Release reserved funds on cancel/timeout       [reserve]
 *   5. leg-ready-check   — GTID pre-readiness check                       [reserve]
 *   6. authority-check   — AML/sanctions screening (mock: always OK)      [verify]
 *   7. name-check        — Payee name verification                        [verify]
 *   8. account-verify    — Account existence + name matching              [verify]
 *   9. credit-notify     — Post-settlement credit notification            [notify]
 *  10. rtp-notify        — Request-to-Pay notification                    [notify]
 *  11. debit-settled     — Settlement completion notification to payer    [execute]
 *  12. initialize-bank   — Bank-side account/journal initialization       [admin]
 *  13. cleanup-bank      — Bank-side account/journal teardown             [admin]
 *
 * All commands are idempotent via the ZcRequests table; every successful or
 * failed command is recorded to BankAuditLog (see `ingress/_shared.ts`).
 *
 * The module exposes two entry points:
 *   - {@link handleBankIngress} — direct in-process dispatch (used by orchestrator)
 *   - {@link handleBankIngressHttp} — HTTP wrapper for external calls
 */
import type { Env, BankIngressCommand, BankIngressRequestMap } from "../types";
import { bankReserveFunds, bankReleaseReserve, bankLegReadyCheck } from "./ingress/reserve";
import { bankExecuteDebit, bankExecuteCredit, bankDebitSettled } from "./ingress/execute";
import { bankAuthorityCheck, bankNameCheck, bankAccountVerify } from "./ingress/verify";
import { bankCreditNotify, bankRtpNotify } from "./ingress/notify";
import { bankInitialize, bankCleanup } from "./ingress/admin";

/**
 * The dispatch table, keyed by command and typed by {@link BankIngressRequestMap}.
 *
 * This replaced a thirteen-arm `switch` whose every arm cast an `unknown`
 * payload to a request type named at the call site. Such a cast asserts the two
 * ends agree; it does not check it, and `account-verify` shipped for months with
 * the caller sending `{account_id, name_to_verify}` into a handler reading
 * `{target_account_hash, target_account_name}` — type-correct on both sides of a
 * seam nothing spanned. Here each entry must satisfy the *mapped* request type,
 * so a handler that drifts from the shared declaration fails `tsc`, and a
 * command added to `BANK_INGRESS_COMMANDS` without an entry does too.
 *
 * The runtime cast survives at exactly one place (below), where it belongs: the
 * body genuinely is unknown until it is parsed off the wire.
 *
 * Entries are thunks rather than bare references on purpose: a stored reference
 * is captured once at module load, which would freeze the import binding and
 * make the handlers unspyable — `htlc_recheck_unavailable.test.ts` drives the
 * "bank answers NG" branch by replacing `bankAuthorityCheck` on its module.
 * Calling through an arrow reads the binding at dispatch time, exactly as the
 * `switch` this replaced did.
 */
const INGRESS_HANDLERS: {
  [C in BankIngressCommand]: (
    bankId: string,
    req: BankIngressRequestMap[C],
    env: Env
  ) => Promise<unknown>;
} = {
  "reserve-funds": (bankId, req, env) => bankReserveFunds(bankId, req, env),
  "execute-debit": (bankId, req, env) => bankExecuteDebit(bankId, req, env),
  "execute-credit": (bankId, req, env) => bankExecuteCredit(bankId, req, env),
  "release-reserve": (bankId, req, env) => bankReleaseReserve(bankId, req, env),
  "leg-ready-check": (bankId, req, env) => bankLegReadyCheck(bankId, req, env),
  "authority-check": (bankId, req, env) => bankAuthorityCheck(bankId, req, env),
  "name-check": (bankId, req, env) => bankNameCheck(bankId, req, env),
  "account-verify": (bankId, req, env) => bankAccountVerify(bankId, req, env),
  "credit-notify": (bankId, req, env) => bankCreditNotify(bankId, req, env),
  "rtp-notify": (bankId, req, env) => bankRtpNotify(bankId, req, env),
  "debit-settled": (bankId, req, env) => bankDebitSettled(bankId, req, env),
  "initialize-bank": (bankId, req, env) => bankInitialize(bankId, req, env),
  "cleanup-bank": (bankId, _req, env) => bankCleanup(bankId, env),
};

/**
 * Internal command router. Called directly by the ZC orchestrator within the
 * same Worker process (no HTTP overhead). Dispatches to the appropriate
 * command handler based on the command string.
 *
 * @param bankId  - Target bank identifier (e.g. "001")
 * @param command - Ingress command name (e.g. "reserve-funds", "execute-debit")
 * @param payload - Command-specific request body (type-cast per command)
 * @param env     - Cloudflare Worker environment bindings
 * @returns Command-specific response object
 */
export async function handleBankIngress(
  bankId: string,
  command: string,
  payload: unknown,
  env: Env
): Promise<unknown> {
  const handler = Object.hasOwn(INGRESS_HANDLERS, command)
    ? INGRESS_HANDLERS[command as BankIngressCommand]
    : undefined;
  if (!handler) return { result: "ERROR", reason_code: "UNKNOWN_COMMAND" };
  // The one honest cast: `payload` arrived as an unvalidated body. Every other
  // link in this seam is checked by the compiler via BankIngressRequestMap.
  return handler(bankId, payload as never, env);
}

/**
 * HTTP wrapper for external ingress calls. Parses the JSON body from the
 * incoming Request and delegates to {@link handleBankIngress}.
 *
 * @param req     - Incoming HTTP request with JSON body
 * @param bankId  - Target bank identifier extracted from URL path
 * @param command - Ingress command name extracted from URL path
 * @param env     - Cloudflare Worker environment bindings
 * @returns HTTP Response (always 200 with JSON body for successful dispatch)
 */
export async function handleBankIngressHttp(
  req: Request,
  bankId: string,
  command: string,
  env: Env
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResp(400, "INVALID_JSON");
  }

  // Signature validation. ZC signs egress either with its asymmetric key (verified
  // against the KeyRegistry public key, owner_type='ZC') or, legacy, with the
  // shared HMAC. Dual-accept during migration: the presence of an X-ZC-Key-Id
  // header selects the asymmetric path; otherwise fall back to HMAC. Internal
  // same-Worker routing calls handleBankIngress directly and skips this path.
  const { readZcSignatureHeaders, verifyZcSignature } = await import("../shared/zc_signature");
  const zcSig = readZcSignatureHeaders(req.headers);
  if (zcSig) {
    try {
      await verifyZcSignature(env.DB, body, zcSig);
    } catch {
      return errorResp(401, "INVALID_SIGNATURE");
    }
  } else if (env.ZC_HMAC_SECRET) {
    const signature = req.headers.get("X-ZC-Signature");
    if (!signature) return errorResp(401, "MISSING_SIGNATURE");
    // Dual-accept across a *bounded* rotation window: the retiring secret
    // verifies until its deadline, never after (src/shared/secret_rotation.ts).
    const { verifySignatureRotating } = await import("../shared/secret_rotation");
    const isValid = await verifySignatureRotating(body, signature, env);
    if (!isValid) return errorResp(401, "INVALID_SIGNATURE");
  }

  const result = await handleBankIngress(bankId, command, body, env);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResp(status: number, reason_code: string): Response {
  return new Response(JSON.stringify({ error: reason_code, reason_code }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
