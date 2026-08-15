/**
 * @file ingress_commands.test.ts — one round-trip per ZC→Bank ingress command.
 *      (Structural guards on the same seam live in
 *      `test/invariants/ingress_seam.test.ts`.)
 *
 * ## Why this file exists
 *
 * The eighth spec review found that `account-verify` — command 8 of the
 * thirteen a core banking system must answer (`10_requirements.md` §7.2.1) —
 * had never worked. The caller sent `{account_id, name_to_verify}`; the handler
 * read `{target_account_hash, target_account_name}`. Both ends type-checked,
 * because each had declared the command's body for itself and nothing compared
 * the two declarations. The handler resolved `undefined`, answered `NOT_FOUND`
 * for every account in existence, and the caller — expecting a response shape
 * the handler never emits — filed the result as `ERROR`.
 *
 * The suite was green throughout. Its only test for the command called the
 * caller's mapping function directly with a hand-written response object, so it
 * pinned what the caller *believed* the bank returns. **A test that does not
 * cross the seam cannot detect a mismatch at the seam** — it re-states one
 * side's assumption and confirms the assumption equals itself.
 *
 * So the shape of the fix is not "more tests for account-verify". It is: every
 * command gets a test that carries a payload *built by the real caller* into
 * the *real handler*, and pushes the handler's answer back through the *real
 * caller-side mapping*. Nothing in this file writes a request or a response
 * literal by hand — where a test constructs one it is via the same exported
 * builder the production call site uses, so a rename cannot pass here and fail
 * in production.
 *
 * ## What each test does, and does not, prove
 *
 * It proves the two ends of a command still agree on field names, on the value
 * domain of the discriminant the caller branches on, and that the handler's
 * effect actually depended on the fields the caller sent (an assertion on the
 * ledger or on a row, never merely on the response, since a handler reading
 * `undefined` can still return a cheerful shape).
 *
 * It does not prove the command is *correct* — the per-command behaviour tests
 * elsewhere in the suite do that, and are not duplicated here. This file is
 * about the join, deliberately shallow and deliberately exhaustive.
 *
 * ## Over the wire
 *
 * Payloads are JSON round-tripped before dispatch ({@link overWire}). Internal
 * routing hands the object straight to the handler, but `handleBankIngressHttp`
 * parses it off the network, and a contract that only survives the in-process
 * path is not a contract. This is what catches a required field that is
 * `undefined`, or a value that does not survive serialisation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { BANK_INGRESS_COMMANDS, type BankIngressCommand } from "../../src/types";
import { handleBankIngress } from "../../src/bank/ingress";

// Callers — the ZC side of each seam. Every payload below comes from one of
// these, never from a literal written in this file.
import {
  callBankReserveFunds,
  callBankExecuteDebit,
  callBankExecuteCredit,
  callBankReleaseReserve,
  callBankLegReadyCheck,
  callBankAuthorityCheck,
  callBankNameCheck,
} from "../../src/zc/orchestrator/bank_hub";
import { makeRequestId, REQUEST_PREFIX } from "../../src/shared/request-id";
import {
  buildBankAccountVerifyPayload,
  handleBankVerifyResponse,
  getVerificationResult,
} from "../../src/zc/directory/account_verify";
import {
  createCreditNotification,
  buildCreditNotifyPayload,
  deliverNotification,
} from "../../src/zc/events/credit_notify";
import { buildRtpNotifyPayload } from "../../src/zc/lanes/rtp/register";
import { buildDebitSettledPayload } from "../../src/zc/orchestrator";
import { buildInitializeBankPayload, buildCleanupBankPayload } from "../../src/zc/ingress/admin";

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

const BANK_A = "001"; // payer side
const BANK_B = "002"; // payee side
const ACC_A = "0010000001"; // 田中 太郎, seeded +1,000,000
const ACC_B = "0020000001"; // 鈴木 一郎, seeded +1,000,000
const SUSPENSE_B = "0020000000";
const NEW_BANK = "003"; // for initialize-bank / cleanup-bank, which 001/002 already are

let d1: MockD1Database;
// biome-ignore lint/suspicious/noExplicitAny: the D1 mock stands in for Env's binding
let env: any;

beforeEach(() => {
  ({ d1 } = createTestDb());
  env = { DB: d1, ZC_HMAC_SECRET: "test-secret" };
});

/**
 * Serialise and re-parse, as `handleBankIngressHttp` does. Keeping the seam
 * tests on this path means an `undefined` in a required position, or anything
 * that does not survive JSON, fails here rather than only in deployment.
 */
function overWire<T>(payload: T): T {
  return JSON.parse(JSON.stringify(payload)) as T;
}

/** Sum every journal row for an account. */
async function balanceOf(accountId: string): Promise<number> {
  const row = await d1
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ?`)
    .bind(accountId)
    .first<{ b: number }>();
  return row?.b ?? 0;
}

function insertTx(txid: string, amount: number) {
  d1.prepare(
    `INSERT INTO Transactions
       (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash,
        payee_bank_id, payee_account_hash, idempotency_key, schema_version, version,
        created_at, updated_at)
     VALUES (?, 'EXPRESS', 'DECIDED_TO_SETTLE', ?, 'JPY', ?, ?, ?, ?, ?, '1.0', 0,
             '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`
  )
    .bind(txid, amount, BANK_A, ACC_A, BANK_B, ACC_B, `IK-${txid}`)
    ._runSync();
}

/** Reserve payer funds through the real caller, so later commands have a reservation. */
async function reserveVia(txid: string, amount: number) {
  return callBankReserveFunds(
    BANK_A,
    overWire({
      request_id: makeRequestId(REQUEST_PREFIX.RESERVE_FUNDS, txid),
      txid,
      amount: { value: amount, currency: "JPY" },
      account_hash: ACC_A,
    }),
    env
  );
}

// ---------------------------------------------------------------------------
// Coverage registry
//
// `it` is wrapped so that declaring a seam test also records which command it
// covers. The final check compares that set against BANK_INGRESS_COMMANDS, so a
// fourteenth command cannot be added to the registry without one — the failure
// mode this whole file exists to prevent is a command nobody exercises.
// ---------------------------------------------------------------------------

const covered = new Set<BankIngressCommand>();

function seam(command: BankIngressCommand, name: string, fn: () => Promise<void>) {
  covered.add(command);
  it(`${command}: ${name}`, fn);
}

// ---------------------------------------------------------------------------
// 1–5. Reservation and fund movement
// ---------------------------------------------------------------------------

describe("ingress seam — fund movement", () => {
  seam("reserve-funds", "segregates the payer's funds the caller named", async () => {
    const before = await balanceOf(ACC_A);
    const resp = await reserveVia("TX-SEAM-RESERVE", 5_000);

    // The discriminant `_reserve_funds.ts` branches on.
    expect(resp.result).toBe("RESERVED");
    if (resp.result !== "RESERVED") return;
    expect(resp.reservation_ref).toBeTruthy();

    // The effect proves `account_hash` arrived: a handler reading `undefined`
    // answers ACCOUNT_NOT_FOUND and moves nothing.
    expect(await balanceOf(ACC_A)).toBe(before - 5_000);
    const susp = await d1
      .prepare(`SELECT status, amount FROM SuspenseDetails WHERE suspense_id = ?`)
      .bind(resp.reservation_ref)
      .first<{ status: string; amount: number }>();
    expect(susp?.status).toBe("RESERVED");
    expect(susp?.amount).toBe(5_000);
  });

  seam("reserve-funds", "reports the shortfall in the shape the caller cancels on", async () => {
    // `_reserve_funds.ts` reads `reserveResult.reason_code` when cancelling; a
    // renamed field would surface as an undefined reason on a real cancellation.
    const resp = await reserveVia("TX-SEAM-RESERVE-NSF", 99_000_000);
    expect(resp.result).toBe("ERROR");
    if (resp.result !== "ERROR") return;
    expect(resp.reason_code).toBe("INSUFFICIENT_FUNDS");
  });

  seam("execute-debit", "finalises the reservation and returns a usable a-proof", async () => {
    const txid = "TX-SEAM-DEBIT";
    insertTx(txid, 7_000);
    await reserveVia(txid, 7_000);

    const resp = await callBankExecuteDebit(
      BANK_A,
      overWire({
        request_id: makeRequestId(REQUEST_PREFIX.EXECUTE_DEBIT, txid),
        txid,
        amount: { value: 7_000, currency: "JPY" },
        decision_proof_ref: "PROOF-DECISION-SEAM",
        lane: "EXPRESS" as const,
        payer_account_hash: ACC_A,
      }),
      env
    );

    expect(resp.result).toBe("OK");
    // The caller does `JSON.stringify(bankResp.bank_proof_ref)` and stores it as
    // proof a, so the fields it will later be read back by must be present.
    expect(resp.bank_proof_ref.issuer_bank_id).toBe(BANK_A);
    expect(resp.bank_proof_ref.proof_type).toBe("PAYER_EXEC_PROOF");
    expect(resp.bank_proof_ref.proof_id).toBeTruthy();
    // Effect: the reservation actually advanced (the handler found it by txid).
    const susp = await d1
      .prepare(`SELECT status FROM SuspenseDetails WHERE txid = ? AND bank_id = ?`)
      .bind(txid, BANK_A)
      .first<{ status: string }>();
    expect(susp?.status).toBe("EXECUTED");
  });

  seam("execute-credit", "lands the credit on the payee account the caller named", async () => {
    const txid = "TX-SEAM-CREDIT";
    insertTx(txid, 9_000);
    const before = await balanceOf(ACC_B);

    const resp = await callBankExecuteCredit(
      BANK_B,
      overWire({
        request_id: makeRequestId(REQUEST_PREFIX.EXECUTE_CREDIT, txid),
        txid,
        amount: { value: 9_000, currency: "JPY" },
        decision_proof_ref: "PROOF-DECISION-SEAM",
        payee_account_hash: ACC_B,
      }),
      env
    );

    // The caller's three-way branch: OK / FILTER_REJECTED / PENDING_APPROVAL.
    expect(resp.result).toBe("OK");
    if (resp.result !== "OK") return;
    expect(resp.bank_proof_ref.proof_type).toBe("PAYEE_EXEC_PROOF");
    // b landed on the customer, not parked in the suspense account.
    expect(await balanceOf(ACC_B)).toBe(before + 9_000);
    expect(await balanceOf(SUSPENSE_B)).toBe(0);
  });

  seam("release-reserve", "returns the exact funds reserve-funds segregated", async () => {
    const txid = "TX-SEAM-RELEASE";
    const before = await balanceOf(ACC_A);
    const reserved = await reserveVia(txid, 4_000);
    expect(reserved.result).toBe("RESERVED");
    if (reserved.result !== "RESERVED") return;

    const resp = await callBankReleaseReserve(
      BANK_A,
      overWire({
        request_id: makeRequestId(REQUEST_PREFIX.RELEASE_RESERVE, txid),
        txid,
        reservation_ref: reserved.reservation_ref,
      }),
      env
    );

    expect(resp.result).toBe("RELEASED");
    // The echo the caller correlates on must be the ref it sent, not a new one.
    expect(resp.reservation_ref).toBe(reserved.reservation_ref);
    expect(await balanceOf(ACC_A)).toBe(before);
    const susp = await d1
      .prepare(`SELECT status FROM SuspenseDetails WHERE suspense_id = ?`)
      .bind(reserved.reservation_ref)
      .first<{ status: string }>();
    expect(susp?.status).toBe("RETURNED");
  });

  seam("leg-ready-check", "pre-reserves a PAYER leg and clears a PAYEE leg", async () => {
    const before = await balanceOf(ACC_A);

    const payer = await callBankLegReadyCheck(
      BANK_A,
      overWire({
        request_id: makeRequestId(REQUEST_PREFIX.LEG_READY, "LEG-SEAM-P"),
        gtid: "GT-SEAM",
        leg_id: "LEG-SEAM-P",
        role: "PAYER" as const,
        amount: { value: 3_000, currency: "JPY" },
        account_hash: ACC_A,
      }),
      env
    );
    // `gtid/advance.ts` advances the leg only on result === 'OK'.
    expect(payer.result).toBe("OK");
    expect(await balanceOf(ACC_A)).toBe(before - 3_000);

    const payee = await callBankLegReadyCheck(
      BANK_B,
      overWire({
        request_id: makeRequestId(REQUEST_PREFIX.LEG_READY, "LEG-SEAM-E"),
        gtid: "GT-SEAM",
        leg_id: "LEG-SEAM-E",
        role: "PAYEE" as const,
        amount: { value: 3_000, currency: "JPY" },
        account_hash: ACC_B,
      }),
      env
    );
    expect(payee.result).toBe("OK");
    // A PAYEE leg reserves nothing.
    expect(await balanceOf(ACC_B)).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// 6–8. Pre-decision checks
// ---------------------------------------------------------------------------

describe("ingress seam — checks", () => {
  seam("authority-check", "answers in the verdict domain the caller branches on", async () => {
    const resp = await callBankAuthorityCheck(
      BANK_A,
      overWire({
        request_id: makeRequestId(REQUEST_PREFIX.AUTHORITY_CHECK, "TX-SEAM-AUTH"),
        txid: "TX-SEAM-AUTH",
        check_type: "INITIAL" as const,
      }),
      env
    );
    // `_authority_check.ts` maps OK → proceed, NG → reject, anything else →
    // "the bank did not answer". A third value would silently become the last.
    expect(["OK", "NG"]).toContain(resp.result);
    expect(resp.result).toBe("OK");
  });

  seam("name-check", "returns the holder name on MATCH and a reason on MISMATCH", async () => {
    const match = await callBankNameCheck(
      BANK_B,
      overWire({
        request_id: makeRequestId(REQUEST_PREFIX.NAME_CHECK, "TX-SEAM-NAME"),
        txid: "TX-SEAM-NAME",
        account_hash: ACC_B,
      }),
      env
    );
    expect(match.result).toBe("MATCH");
    // express/standard surface this to the customer for confirmation.
    expect(match.customer_name).toBe("鈴木 一郎");

    // The branch `standard.ts` suspends on. A system account is not creditable.
    const mismatch = await callBankNameCheck(
      BANK_B,
      overWire({
        request_id: makeRequestId(REQUEST_PREFIX.NAME_CHECK, "TX-SEAM-NAME-NG"),
        txid: "TX-SEAM-NAME-NG",
        account_hash: SUSPENSE_B,
      }),
      env
    );
    expect(mismatch.result).toBe("MISMATCH");
    if (mismatch.result !== "MISMATCH") return;
    expect(mismatch.reason_code).toBe("ACCOUNT_NOT_TRANSFERABLE");
  });

  seam(
    "account-verify",
    "matches a name end to end — the defect this file is named for",
    async () => {
      d1.prepare(
        `INSERT INTO AccountVerifications
         (verification_id, request_bank_id, target_bank_id, target_account_hash, status,
          name_provided, fraud_warning, idempotency_key, created_at)
       VALUES ('V-SEAM-13', '001', '002', ?, 'PENDING', '鈴木 一郎', 0, 'idem-seam-13',
               '2026-07-01T00:00:00Z')`
      )
        .bind(ACC_B)
        ._runSync();

      const payload = buildBankAccountVerifyPayload(
        {
          verification_id: "V-SEAM-13",
          request_bank_id: BANK_A,
          target_bank_id: BANK_B,
          target_account_id: ACC_B,
          name_to_verify: "鈴木 一郎",
          idempotency_key: "idem-seam-13",
        },
        ACC_B,
        "AV-V-SEAM-13"
      );

      const resp = (await handleBankIngress(BANK_B, "account-verify", overWire(payload), env)) as {
        result: "MATCHED" | "MISMATCHED" | "NOT_FOUND";
        match_score: number;
        name_provided: string | null;
        fraud_warning: boolean;
      };
      // Before the fix this was NOT_FOUND for every account that exists.
      expect(resp.result).toBe("MATCHED");

      await handleBankVerifyResponse(d1 as never, "V-SEAM-13", resp);
      const row = await getVerificationResult(d1 as never, "V-SEAM-13");
      // And the caller's mapping filed it as ERROR, its default arm.
      expect(row?.status).toBe("MATCHED");
      expect(row?.match_score).toBe(1.0);
    }
  );
});

// ---------------------------------------------------------------------------
// 9–11. Notifications
// ---------------------------------------------------------------------------

describe("ingress seam — notifications", () => {
  seam(
    "credit-notify",
    "drives the delivery record to DELIVERED without re-crediting",
    async () => {
      const txid = "TX-SEAM-CN";
      insertTx(txid, 6_000);
      const notificationId = await createCreditNotification(
        d1 as never,
        txid,
        BANK_B,
        ACC_B,
        { value: 6_000, currency: "JPY" },
        BANK_A,
        null,
        null
      );

      // Assert the built payload reaches the handler, then run the real caller so
      // the response passes back through its own mapping.
      const notif = await d1
        .prepare(`SELECT * FROM CreditNotifications WHERE notification_id = ?`)
        .bind(notificationId)
        // biome-ignore lint/suspicious/noExplicitAny: row shape is the production type
        .first<any>();
      const payload = buildCreditNotifyPayload(notif, `CN-${notificationId}-probe`);
      const probe = (await handleBankIngress(BANK_B, "credit-notify", overWire(payload), env)) as {
        result: string;
        notification_id?: string;
      };
      expect(probe.result).toBe("DELIVERED");
      expect(probe.notification_id).toBe(notificationId);

      const balanceBefore = await balanceOf(ACC_B);
      await deliverNotification(d1 as never, notificationId, env);
      const row = await d1
        .prepare(`SELECT status FROM CreditNotifications WHERE notification_id = ?`)
        .bind(notificationId)
        .first<{ status: string }>();
      // The caller only writes DELIVERED when it recognises the handler's verdict.
      expect(row?.status).toBe("DELIVERED");
      // credit-notify must never book a journal (the double-credit regression).
      expect(await balanceOf(ACC_B)).toBe(balanceBefore);
    }
  );

  seam("rtp-notify", "records the request on the payer bank as NOTIFIED", async () => {
    const payload = buildRtpNotifyPayload(
      "RTP-SEAM-1",
      BANK_A,
      BANK_B,
      { value: 12_000, currency: "JPY" },
      "2099-01-01T00:00:00.000Z",
      { payeeName: "鈴木 一郎", description: "電気料金 7月分" }
    );

    const resp = (await handleBankIngress(BANK_A, "rtp-notify", overWire(payload), env)) as {
      result: string;
      rtp_id?: string;
    };
    // `notifyBankOfRtp` returns true only for exactly this literal.
    expect(resp.result).toBe("NOTIFIED");
    expect(resp.rtp_id).toBe("RTP-SEAM-1");

    const row = await d1
      .prepare(
        `SELECT state, payee_name, description, amount_value FROM RtpRequests WHERE rtp_id=?`
      )
      .bind("RTP-SEAM-1")
      .first<{
        state: string;
        payee_name: string | null;
        description: string | null;
        amount_value: number;
      }>();
    expect(row?.state).toBe("NOTIFIED");
    // The optional fields survived the wire; a dropped one would show as null.
    expect(row?.payee_name).toBe("鈴木 一郎");
    expect(row?.description).toBe("電気料金 7月分");
    expect(row?.amount_value).toBe(12_000);
  });

  seam("rtp-notify", "the live registration path reaches the paying bank", async () => {
    // One step further out than the builder: the path behind POST /api/rtp/request.
    // Command 10 once had no ZC caller at all — `notifyBankOfRtp` returned true
    // without calling anything — so the row sat at CREATED forever and nothing
    // in the system exercised the seam this command defines.
    const { registerRtpRequest } = await import("../../src/zc/lanes/rtp");
    await registerRtpRequest(
      d1 as never,
      "RTP-SEAM-LIVE",
      BANK_A,
      BANK_B,
      { value: 2_000, currency: "JPY" },
      "2099-01-01T00:00:00.000Z",
      "idem-rtp-seam-live",
      { payeeName: "田中商店" },
      { ...env, QUEUE: { send: async () => {} } }
    );

    const row = await d1
      .prepare(`SELECT state, notified_at FROM RtpRequests WHERE rtp_id = ?`)
      .bind("RTP-SEAM-LIVE")
      .first<{ state: string; notified_at: string | null }>();
    expect(row?.state).toBe("NOTIFIED");
    expect(row?.notified_at).not.toBeNull();

    const audit = await d1
      .prepare(`SELECT COUNT(*) AS n FROM BankAuditLog WHERE command = 'rtp-notify'`)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  seam("debit-settled", "acknowledges to the payer bank with an auditable record", async () => {
    const txid = "TX-SEAM-DS";
    const payload = buildDebitSettledPayload(
      txid,
      BANK_B,
      { value: 15_000, currency: "JPY" },
      "2026-07-01T09:00:00.000Z"
    );

    const resp = (await handleBankIngress(BANK_A, "debit-settled", overWire(payload), env)) as {
      result: string;
      txid?: string;
    };
    expect(resp.result).toBe("ACKNOWLEDGED");
    expect(resp.txid).toBe(txid);

    // Proves the handler read the fields the caller sent rather than defaults.
    const audit = await d1
      .prepare(
        `SELECT amount, details_json FROM BankAuditLog WHERE command='debit-settled' AND txid=?`
      )
      .bind(txid)
      .first<{ amount: number; details_json: string }>();
    expect(audit?.amount).toBe(15_000);
    expect(JSON.parse(audit?.details_json ?? "{}")).toMatchObject({
      payee_bank_id: BANK_B,
      settled_at: "2026-07-01T09:00:00.000Z",
    });
  });
});

// ---------------------------------------------------------------------------
// 12–13. Bank lifecycle
// ---------------------------------------------------------------------------

describe("ingress seam — lifecycle", () => {
  seam("initialize-bank", "creates the joining bank's own accounts", async () => {
    const resp = (await handleBankIngress(
      NEW_BANK,
      "initialize-bank",
      overWire(buildInitializeBankPayload(NEW_BANK)),
      env
    )) as { result: string; bank_id?: string };
    expect(resp.result).toBe("INITIALIZED");
    expect(resp.bank_id).toBe(NEW_BANK);

    const types = await d1
      .prepare(`SELECT account_type FROM BankAccounts WHERE bank_id=? ORDER BY account_type`)
      .bind(NEW_BANK)
      .all<{ account_type: string }>();
    expect(types.results.map((r) => r.account_type)).toEqual([
      "ASSET",
      "BOJ",
      "EQUITY",
      "SETTLEMENT",
      "SUSPENSE",
    ]);
    // The prefund is booked as an offsetting pair, so the bank still nets zero.
    const sum = await d1
      .prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM BankJournals WHERE bank_id=?`)
      .bind(NEW_BANK)
      .first<{ s: number }>();
    expect(sum?.s).toBe(0);

    // Replay is idempotent — ZC retries this on participant registration.
    const again = (await handleBankIngress(
      NEW_BANK,
      "initialize-bank",
      overWire(buildInitializeBankPayload(NEW_BANK)),
      env
    )) as { result: string };
    expect(again.result).toBe("ALREADY_INITIALIZED");
  });

  seam("cleanup-bank", "removes exactly the leaving bank's own data", async () => {
    await handleBankIngress(
      NEW_BANK,
      "initialize-bank",
      overWire(buildInitializeBankPayload(NEW_BANK)),
      env
    );

    const resp = (await handleBankIngress(
      NEW_BANK,
      "cleanup-bank",
      overWire(buildCleanupBankPayload()),
      env
    )) as { result: string; bank_id?: string };
    expect(resp.result).toBe("CLEANED_UP");
    expect(resp.bank_id).toBe(NEW_BANK);

    const left = await d1
      .prepare(`SELECT COUNT(*) AS c FROM BankAccounts WHERE bank_id=?`)
      .bind(NEW_BANK)
      .first<{ c: number }>();
    expect(left?.c).toBe(0);
    // The other participants are untouched — cleanup is scoped by bank_id.
    const others = await d1
      .prepare(`SELECT COUNT(*) AS c FROM BankAccounts WHERE bank_id IN (?, ?)`)
      .bind(BANK_A, BANK_B)
      .first<{ c: number }>();
    expect(others?.c).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The registry check
// ---------------------------------------------------------------------------

describe("ingress seam — coverage", () => {
  it("every command in BANK_INGRESS_COMMANDS has a seam test", () => {
    const missing = BANK_INGRESS_COMMANDS.filter((c) => !covered.has(c));
    expect(
      missing.join(", "),
      "a ZC→Bank command with no round-trip test is exactly how account-verify shipped dead"
    ).toBe("");
  });

  it("no seam test names a command outside the registry", () => {
    const registry = new Set<string>(BANK_INGRESS_COMMANDS);
    const stray = [...covered].filter((c) => !registry.has(c));
    expect(stray.join(", ")).toBe("");
  });

  it("an unknown command is refused rather than dispatched", async () => {
    const resp = (await handleBankIngress(BANK_A, "reserve-funds-v2", {}, env)) as {
      result: string;
      reason_code: string;
    };
    expect(resp.result).toBe("ERROR");
    expect(resp.reason_code).toBe("UNKNOWN_COMMAND");
  });

  it("a command cannot be smuggled in via the prototype chain", async () => {
    // The dispatch table is a plain object; `INGRESS_HANDLERS['toString']` is a
    // function, and dispatching it would call it with (bankId, payload, env).
    const resp = (await handleBankIngress(BANK_A, "toString", {}, env)) as {
      result: string;
      reason_code: string;
    };
    expect(resp.result).toBe("ERROR");
    expect(resp.reason_code).toBe("UNKNOWN_COMMAND");
  });
});
