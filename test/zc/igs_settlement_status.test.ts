/**
 * @file igs_settlement_status.test.ts — the query response distinguishes a
 *       central-bank HOLD from a FAILED.
 *
 * Both put the transaction in SUSPENDED with `reason_code='IGS_FAILED'`, and the
 * two demand opposite answers at the counter: HOLD may clear by waiting, FAILED
 * will not. Before `external_settlement` existed the only way to tell was
 * whether `public_message_id` happened to be present — an inference from an
 * unrelated fact (docs/specs/20_method_design.md §9.4.4.1).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { handleGetTransaction } from "../../src/zc/query/query";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";

let d1: MockD1Database;
let env: any;

function seedHighValueTx(txid: string) {
  d1.prepare(
    `INSERT INTO Transactions
       (txid, lane, state, amount_value, payer_bank_id, payer_account_hash,
        payee_bank_id, payee_account_hash, idempotency_key, reason_code,
        external_settlement_status, created_at, updated_at)
     VALUES (?, 'HIGH_VALUE', 'SUSPENDED', 500000000, '001', 'h:p', '002', 'h:q', ?,
             'IGS_FAILED', 'FAILED', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z')`
  )
    .bind(txid, `idem-${txid}`)
    ._runSync();
}

function seedIgs(txid: string, status: string) {
  d1.prepare(
    `INSERT INTO IgsRequests
       (ext_instruction_id, txid, payer_bank_id, payee_bank_id, amount_value, status, requested_at)
     VALUES (?, ?, '001', '002', 500000000, ?, '2026-07-30T00:00:00.000Z')`
  )
    .bind(`EXT-${txid}`, txid, status)
    ._runSync();
}

beforeEach(() => {
  ({ d1 } = createTestDb());
  env = { DB: d1 };
});

describe("GET /api/transactions/:txid — external_settlement", () => {
  it("reports a HOLD as retriable", async () => {
    seedHighValueTx("TX-IGS-HOLD");
    seedIgs("TX-IGS-HOLD", "HOLD");
    const body = await (await handleGetTransaction("TX-IGS-HOLD", env)).json();
    expect(body.reason_code).toBe("IGS_FAILED"); // unchanged: one label, two situations
    expect(body.external_settlement).toEqual({ status: "HOLD", retriable: true });
  });

  it("reports a FAILED as not retriable — same reason_code, opposite answer", async () => {
    seedHighValueTx("TX-IGS-FAILED");
    seedIgs("TX-IGS-FAILED", "FAILED");
    const body = await (await handleGetTransaction("TX-IGS-FAILED", env)).json();
    expect(body.reason_code).toBe("IGS_FAILED");
    expect(body.external_settlement).toEqual({ status: "FAILED", retriable: false });
  });

  it("treats a TIMEOUT as retriable", async () => {
    seedHighValueTx("TX-IGS-TO");
    seedIgs("TX-IGS-TO", "TIMEOUT");
    const body = await (await handleGetTransaction("TX-IGS-TO", env)).json();
    expect(body.external_settlement.retriable).toBe(true);
  });

  it("omits the field entirely for a transaction that never reached the central bank", async () => {
    d1.prepare(
      `INSERT INTO Transactions
         (txid, lane, state, amount_value, payer_bank_id, payer_account_hash,
          payee_bank_id, payee_account_hash, idempotency_key, created_at, updated_at)
       VALUES ('TX-PLAIN', 'STANDARD', 'SETTLED', 1000, '001', 'h:p', '002', 'h:q',
               'idem-plain', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z')`
    )._runSync();
    const body = await (await handleGetTransaction("TX-PLAIN", env)).json();
    expect(body.external_settlement).toBeUndefined();
  });

  it("does not carry the central bank's raw failure text", async () => {
    seedHighValueTx("TX-IGS-REASON");
    d1.prepare(
      `INSERT INTO IgsRequests
         (ext_instruction_id, txid, payer_bank_id, payee_bank_id, amount_value, status,
          failed_reason, requested_at)
       VALUES ('EXT-R', 'TX-IGS-REASON', '001', '002', 500000000, 'HOLD',
               'counterparty 004 short by 12,000,000,000', '2026-07-30T00:00:00.000Z')`
    )._runSync();
    const body = await (await handleGetTransaction("TX-IGS-REASON", env)).json();
    // §9.4.4 keeps a counterparty's shortfall in the closed domain; this response
    // is not the closed domain.
    expect(JSON.stringify(body)).not.toContain("12,000,000,000");
    expect(body.external_settlement.status).toBe("HOLD");
  });
});
