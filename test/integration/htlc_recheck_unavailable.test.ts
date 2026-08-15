/**
 * @file htlc_recheck_unavailable.test.ts — an AML recheck that cannot reach the
 *       payer bank must not settle the claim.
 *
 * `settleAfterPreimage` re-screens the payer before releasing funds whenever the
 * timelock reaches past the end of the current business day. That step tested
 * `result === "NG"` and fell through on everything else, so a payer bank behind
 * an OPEN circuit produced the same outcome as a clean pass — money released
 * through a screening step that never ran. It is the same fail-open the
 * pre-decision path closed with T_auth, at the other end of the transaction.
 *
 * The fix has to be a *refusal*, not a cancel and not a wait: the claim path has
 * no wait state, and cancelling would destroy a legitimate transfer over a
 * transient outage. So the properties here are (1) nothing settles, (2) nothing
 * changes, (3) the refusal is on the record, and (4) it is genuinely a retry —
 * the same claim succeeds once the bank is reachable again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHtlc, claimHtlc } from "../../src/zc/lanes/htlc";
import { processQueueMessage } from "../../src/zc/orchestrator";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";

const BANK_A = "001";
const BANK_B = "002";
const ACC_A = "0010000001";
const ACC_B = "0020000001";
const SUSP_A = "0010000000";
const SEED_BAL = 1_000_000;
const AMOUNT = 40_000;

let d1: MockD1Database;

function makeEnv(db: MockD1Database) {
  const sink: any[] = [];
  return {
    DB: db,
    QUEUE: { _sink: sink, send: async (m: any) => void sink.push(m) },
    ZC_HMAC_SECRET: "test-secret",
  };
}

async function drain(env: any, max = 20): Promise<void> {
  let n = 0;
  while (env.QUEUE._sink.length > 0 && n < max) {
    await processQueueMessage(env.QUEUE._sink.shift()!, env);
    n++;
  }
  if (n >= max) throw new Error("drain: queue did not converge");
}

function seedParticipant(bankId: string) {
  d1.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 10000000, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId)
    ._runSync();
}

/** Trip the payer bank's circuit so authority-check fast-fails with CIRCUIT_OPEN. */
function tripCircuit(bankId: string) {
  const now = new Date().toISOString();
  d1.prepare(
    `INSERT OR REPLACE INTO CircuitBreakerState
       (bank_id, state, consecutive_failures, opened_at, updated_at)
     VALUES (?, 'OPEN', 5, ?, ?)`
  )
    .bind(bankId, now, now)
    ._runSync();
}

function healCircuit(bankId: string) {
  d1.prepare(`DELETE FROM CircuitBreakerState WHERE bank_id = ?`).bind(bankId)._runSync();
}

async function balanceOf(accountId: string): Promise<number> {
  const row = await d1
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS b FROM BankJournals WHERE account_id = ?`)
    .bind(accountId)
    .first<{ b: number }>();
  return row?.b ?? 0;
}

/**
 * A locked HTLC whose timelock is two days out — far enough that
 * `settleAfterPreimage` performs the AML recheck (it only does so when the
 * timelock reaches past the end of the current business day).
 */
async function lockedHtlc(env: any, id: string): Promise<{ preimage: string; txid: string }> {
  const created = await createHtlc(
    {
      htlc_id: id,
      idempotency_key: `IK-${id}`,
      amount: { value: AMOUNT, currency: "JPY" },
      payer_bank_id: BANK_A,
      payer_account_hash: ACC_A,
      payee_bank_id: BANK_B,
      payee_account_hash: ACC_B,
      timelock: new Date(Date.now() + 48 * 3600_000).toISOString(),
    } as any,
    env
  );
  expect(created.result).toBe("CREATED");
  await drain(env);
  const row = await d1
    .prepare(`SELECT state, txid FROM HtlcContracts WHERE htlc_id = ?`)
    .bind(id)
    .first<{ state: string; txid: string }>();
  expect(row?.state).toBe("HTLC_LOCKED");
  return { preimage: created.preimage!, txid: row!.txid };
}

beforeEach(() => {
  ({ d1 } = createTestDb());
  seedParticipant(BANK_A);
  seedParticipant(BANK_B);
});

describe("HTLC claim when the AML recheck gets no verdict", () => {
  it("refuses the claim instead of settling it", async () => {
    const env = makeEnv(d1);
    const { preimage } = await lockedHtlc(env, "HTLC-RECHECK-001");
    tripCircuit(BANK_A);

    const claimed = await claimHtlc(
      { htlc_id: "HTLC-RECHECK-001", preimage, idempotency_key: "IK-CLAIM-001" } as any,
      env
    );

    // The regression: this used to be ACCEPTED, and the payee was credited
    // without the payer ever being screened.
    expect(claimed.result).toBe("REJECTED");
    expect(claimed.reason_code).toBe("RECHECK_AUTHORITY_UNAVAILABLE");
  });

  it("leaves the HTLC and both balances exactly as they were", async () => {
    const env = makeEnv(d1);
    const { preimage } = await lockedHtlc(env, "HTLC-RECHECK-002");
    tripCircuit(BANK_A);

    await claimHtlc(
      { htlc_id: "HTLC-RECHECK-002", preimage, idempotency_key: "IK-CLAIM-002" } as any,
      env
    );
    await drain(env);

    // Still locked — not cancelled. A transient outage is not a verdict, and
    // cancelling here would destroy a legitimate transfer.
    const htlc = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id = ?`)
      .bind("HTLC-RECHECK-002")
      .first<{ state: string }>();
    expect(htlc?.state).toBe("HTLC_LOCKED");

    // The funds are where the lock left them: in the payer bank's suspense,
    // not with the payee.
    expect(await balanceOf(ACC_A)).toBe(SEED_BAL - AMOUNT);
    expect(await balanceOf(SUSP_A)).toBe(AMOUNT);
    expect(await balanceOf(ACC_B)).toBe(SEED_BAL);
  });

  it("records the refusal in the FinalityLog without advancing the state", async () => {
    const env = makeEnv(d1);
    const { preimage, txid } = await lockedHtlc(env, "HTLC-RECHECK-003");
    tripCircuit(BANK_A);

    await claimHtlc(
      { htlc_id: "HTLC-RECHECK-003", preimage, idempotency_key: "IK-CLAIM-003" } as any,
      env
    );

    const log = await d1
      .prepare(
        `SELECT event_type, state_from, state_to, payload_json FROM FinalityLog
          WHERE txid = ? ORDER BY event_seq`
      )
      .bind(txid)
      .all<{ event_type: string; state_from: string; state_to: string; payload_json: string }>();

    const refusal = log.results.find((r) => r.event_type === "HtlcClaimRejected");
    expect(refusal, "the refusal to settle is itself auditable").toBeDefined();
    expect(refusal!.state_from).toBe(refusal!.state_to); // evidence, not a transition
    expect(JSON.parse(refusal!.payload_json).reason_code).toBe("RECHECK_AUTHORITY_UNAVAILABLE");
  });

  it("is a retry, not a dead end — the same claim settles once the bank answers", async () => {
    // This is what makes refusal the right answer rather than a cancel: the
    // recheck only runs when the timelock is beyond today, so a refused claim
    // has the rest of the window to succeed.
    const env = makeEnv(d1);
    const { preimage } = await lockedHtlc(env, "HTLC-RECHECK-004");

    tripCircuit(BANK_A);
    const refused = await claimHtlc(
      { htlc_id: "HTLC-RECHECK-004", preimage, idempotency_key: "IK-CLAIM-004a" } as any,
      env
    );
    expect(refused.result).toBe("REJECTED");

    healCircuit(BANK_A);
    const accepted = await claimHtlc(
      { htlc_id: "HTLC-RECHECK-004", preimage, idempotency_key: "IK-CLAIM-004b" } as any,
      env
    );
    expect(accepted.result).toBe("ACCEPTED");

    await drain(env);
    expect(await balanceOf(ACC_B)).toBe(SEED_BAL + AMOUNT);
  });

  it("still cancels on an explicit NG — a verdict is not an outage", async () => {
    const env = makeEnv(d1);
    const { preimage } = await lockedHtlc(env, "HTLC-RECHECK-005");
    const verify = await import("../../src/bank/ingress/verify");
    const spy = vi
      .spyOn(verify, "bankAuthorityCheck")
      .mockResolvedValue({ result: "NG", reason_code: "SANCTIONS_MATCH" });

    const claimed = await claimHtlc(
      { htlc_id: "HTLC-RECHECK-005", preimage, idempotency_key: "IK-CLAIM-005" } as any,
      env
    );
    expect(claimed.result).toBe("REJECTED");
    expect(claimed.reason_code).toBe("RECHECK_AUTHORITY_NG");
    expect(claimed.state).toBe("DECIDED_CANCEL");
    spy.mockRestore();
  });
});
