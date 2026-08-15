/**
 * @file pending_since.test.ts — the timeout clocks must not be resettable by
 *       writes that say nothing about progress.
 *
 * The defect this file pins down: every timer in the sweep used to measure from
 * `Transactions.updated_at`, and `updated_at` moves on ANY write to the row.
 * Two writers move it without touching `state` and without a state guard:
 *
 *   - `src/zc/cases/case.ts` — `UPDATE Transactions SET case_id=?, updated_at=?`
 *     when a CASE is opened against the transaction.
 *   - `src/zc/richdata/edi.ts` — `UPDATE Transactions SET edi_ref=?, updated_at=?`
 *     when remittance data is linked.
 *
 * So opening a CASE against a stalled transfer — the exact operator response to
 * a stalled transfer — pushed that transfer's own deadline back, and doing it
 * repeatedly pushed it back without bound. The row most in need of the timer is
 * the one most likely to be touched for another reason while it waits, which
 * inverts the guarantee the timer exists to provide: 有界時間内の検出
 * (docs/disclosure/CORE_DISCLOSURE.md【0013】(a)、【0124】4、請求項36).
 *
 * The fix is a column the incidental writers cannot reach: `pending_since`,
 * written only by the lane helpers and the Authority Check marker. These tests
 * age `pending_since` to make a row due, then have an incidental writer bump
 * `updated_at`, and require the row to expire anyway. Against the old code
 * every one of them fails.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { runTimeoutSweep } from "../../src/cron/timeout_sweep";
import { openCase } from "../../src/zc/cases/case";
import { insertTxWithLog, transitionWithLog } from "../../src/zc/lanes/_helpers";
import { linkEdiToTransaction } from "../../src/zc/richdata/edi";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";

let d1: MockD1Database;
let env: any;

const OLD = "2020-01-01T00:00:00.000Z";
const NOW = new Date().toISOString();

/**
 * Seed a row whose wait began at `pendingSince` but which was last written at
 * `NOW` — i.e. a row that is genuinely overdue while looking freshly touched.
 * That split is the whole point: the two columns must not be interchangeable.
 */
function seed(txid: string, state: string, pendingSince: string, reasonCode: string | null = null) {
  d1.prepare(
    `INSERT INTO Transactions
       (txid, lane, state, amount_value, payer_bank_id, payer_account_hash,
        payee_bank_id, payee_account_hash, idempotency_key, reason_code, owner,
        created_at, updated_at, pending_since)
     VALUES (?, 'STANDARD', ?, 1000, '001', 'h:p', '002', 'h:q', ?, ?, 'ZC', ?, ?, ?)`
  )
    .bind(txid, state, `idem-${txid}`, reasonCode, pendingSince, NOW, pendingSince)
    ._runSync();
}

const stateOf = async (txid: string) =>
  (
    await d1
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind(txid)
      .first<{ state: string }>()
  )?.state;

const updatedAtOf = async (txid: string) =>
  (
    await d1
      .prepare(`SELECT updated_at FROM Transactions WHERE txid = ?`)
      .bind(txid)
      .first<{ updated_at: string }>()
  )?.updated_at;

beforeEach(() => {
  ({ d1 } = createTestDb());
  env = { DB: d1, QUEUE: { send: async () => {} } };
});

describe("an incidental write cannot postpone a deadline", () => {
  it("T_auth still fires after a CASE is opened against the waiting row", async () => {
    seed("TX-AUTH-CASE", "PRECHECKED", OLD, "SUSPEND_AUTHORITY_PENDING");

    // An operator notices the stuck transfer and opens a CASE for it. This
    // writes `updated_at` and nothing else that matters here.
    await openCase(d1 as any, {
      reason_code: "SUSPEND_AUTHORITY_PENDING",
      related_txid: "TX-AUTH-CASE",
      opened_by: "OPS",
    });
    expect(await updatedAtOf("TX-AUTH-CASE")).not.toBe(OLD);

    await runTimeoutSweep(env);
    expect(await stateOf("TX-AUTH-CASE")).toBe("PRECHECKED_SUSPENDED");
  });

  it("T_auth still fires after repeated incidental writes", async () => {
    // The unbounded form of the defect: each touch bought another full window,
    // so a row under active operator attention could never expire.
    seed("TX-AUTH-REPEAT", "PRECHECKED", OLD, "SUSPEND_AUTHORITY_PENDING");
    for (let i = 0; i < 3; i++) {
      await linkEdiToTransaction(d1 as any, "TX-AUTH-REPEAT", `EDI-${i}`);
      await runTimeoutSweep(env);
    }
    expect(await stateOf("TX-AUTH-REPEAT")).toBe("PRECHECKED_SUSPENDED");
  });

  it("T_precheck still fires after a CASE is opened against the waiting row", async () => {
    seed("TX-PRE-CASE", "RECEIVED", OLD);
    await openCase(d1 as any, {
      reason_code: "CANCEL_PRECHECK_TIMEOUT",
      related_txid: "TX-PRE-CASE",
      opened_by: "OPS",
    });
    await runTimeoutSweep(env);
    expect(await stateOf("TX-PRE-CASE")).toBe("CANCELLED");
  });

  it("T2_exec still fires after remittance data is linked to the waiting row", async () => {
    seed("TX-T2-EDI", "DECIDED_TO_SETTLE", OLD);
    await linkEdiToTransaction(d1 as any, "TX-T2-EDI", "EDI-T2");
    await runTimeoutSweep(env);
    expect(await stateOf("TX-T2-EDI")).toBe("SUSPENDED");
  });

  it("T3_payee_proof still fires after a CASE is opened against the waiting row", async () => {
    seed("TX-T3-CASE", "PAYER_EXEC_CONFIRMED", OLD);
    await openCase(d1 as any, {
      reason_code: "SUSPEND_PAYEE_PROOF_TIMEOUT",
      related_txid: "TX-T3-CASE",
      opened_by: "OPS",
    });
    await runTimeoutSweep(env);
    expect(await stateOf("TX-T3-CASE")).toBe("SUSPENDED");
  });
});

describe("pending_since tracks the wait, not the row", () => {
  it("a row still inside its window is left alone even if it was written long ago", async () => {
    // The mirror image: an old `updated_at` must not make a fresh wait expire.
    d1.prepare(
      `INSERT INTO Transactions
         (txid, lane, state, amount_value, payer_bank_id, payer_account_hash,
          payee_bank_id, payee_account_hash, idempotency_key, reason_code, owner,
          created_at, updated_at, pending_since)
       VALUES ('TX-FRESH-WAIT', 'STANDARD', 'PRECHECKED', 1000, '001', 'h:p', '002', 'h:q',
               'idem-fresh-wait', 'SUSPEND_AUTHORITY_PENDING', 'ZC', ?, ?, ?)`
    )
      .bind(OLD, OLD, NOW)
      ._runSync();

    await runTimeoutSweep(env);
    expect(await stateOf("TX-FRESH-WAIT")).toBe("PRECHECKED");
  });

  it("the row-creating helper stamps the column, so the fallback is never the norm", async () => {
    // The COALESCE fallback exists for rows written before the column did. It
    // must not quietly become the normal path: every row minted through the
    // helpers carries its own clock from the first instant.
    await insertTxWithLog(d1 as any, {
      txid: "TX-HELPER-INS",
      lane: "STANDARD",
      initialState: "RECEIVED",
      amount: { value: 1000, currency: "JPY" },
      payerBankId: "001",
      payerAccountHash: "h:p",
      payeeBankId: "002",
      payeeAccountHash: "h:q",
      idempotencyKey: "idem-helper-ins",
      eventType: "PaymentInitiated",
    });

    const row = await d1
      .prepare(`SELECT pending_since FROM Transactions WHERE txid='TX-HELPER-INS'`)
      .first<{ pending_since: string | null }>();
    expect(row?.pending_since).toBeTruthy();
  });

  it("a transition restarts the clock, so each state gets its own full window", async () => {
    // Entering a state begins the wait that state's timer measures. Without
    // this, a row that spent most of T2 in an earlier state would arrive at the
    // next one already overdue.
    seed("TX-HELPER-TRANS", "RECEIVED", OLD);
    await transitionWithLog(d1 as any, {
      txid: "TX-HELPER-TRANS",
      fromState: "RECEIVED",
      toState: "PRECHECKED",
      eventType: "PreChecked",
    });

    const row = await d1
      .prepare(`SELECT pending_since FROM Transactions WHERE txid='TX-HELPER-TRANS'`)
      .first<{ pending_since: string | null }>();
    expect(row?.pending_since).not.toBe(OLD);

    // …and the freshly-entered state is therefore not swept.
    await runTimeoutSweep(env);
    expect(await stateOf("TX-HELPER-TRANS")).toBe("PRECHECKED");
  });

  it("rows predating the column still expire, via the COALESCE fallback", async () => {
    // Rows written before `pending_since` existed carry NULL. They must not
    // become immortal; the sweep falls back to `updated_at` for them.
    d1.prepare(
      `INSERT INTO Transactions
         (txid, lane, state, amount_value, payer_bank_id, payer_account_hash,
          payee_bank_id, payee_account_hash, idempotency_key, reason_code, owner,
          created_at, updated_at, pending_since)
       VALUES ('TX-LEGACY', 'STANDARD', 'PRECHECKED', 1000, '001', 'h:p', '002', 'h:q',
               'idem-legacy', 'SUSPEND_AUTHORITY_PENDING', 'ZC', ?, ?, NULL)`
    )
      .bind(OLD, OLD)
      ._runSync();

    await runTimeoutSweep(env);
    expect(await stateOf("TX-LEGACY")).toBe("PRECHECKED_SUSPENDED");
  });
});
