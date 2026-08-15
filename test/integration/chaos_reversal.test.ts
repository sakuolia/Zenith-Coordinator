/**
 * @file chaos_reversal.test.ts — Adversarial harness for the Reversal seam.
 *
 * Ladder target #1 ("Reversal completion idempotency under chaos"). A Reversal
 * is the one operation that moves money *against an already-settled tx*: it
 * mints a brand-new compensating STANDARD/REFUND transaction flowing
 * payee→payer. Two at-least-once seams matter here:
 *
 *   (a) the reversal *request* itself (requestReversal) — the queue/HTTP
 *       message that asks ZC to create the compensating tx can be redelivered;
 *   (b) the reversal *completion* callback (completeReversal, fired from
 *       onPayeeExecConfirmed when the compensating tx settles) — the settlement
 *       callback that flips ReversalRecords → COMPLETED can be redelivered.
 *
 * A duplicate on (a) is the dangerous one: a second compensating tx is a second
 * refund. The invariant to pin: a redelivered reversal request is a benign
 * idempotent replay — exactly one ReversalRecords row, one compensating tx, no
 * throw, and no reversal "headroom" silently consumed by a phantom row.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  requestReversal,
  completeReversal,
  submitCreditFailedProof,
} from "../../src/zc/cases/reversal";
import type { Env } from "../../src/types";

let d1: MockD1Database;

interface TestEnv {
  DB: MockD1Database;
  QUEUE: { _sink: any[]; send: (m: any) => Promise<void> };
  ZC_HMAC_SECRET: string;
}

function makeEnv(db: MockD1Database): TestEnv {
  const sink: any[] = [];
  return {
    DB: db,
    QUEUE: {
      _sink: sink,
      send: async (m: any) => {
        sink.push(m);
      },
    },
    ZC_HMAC_SECRET: "test-secret",
  };
}

/**
 * Seed a SETTLED transaction plus the payee-bank CREDIT_FAILED_PROOF that opens
 * the Reversal gate (layer 1 of docs/specs/10_requirements.md §4.3.0). These scenarios probe
 * at-least-once behaviour downstream of the gate, so the proof is fixture.
 */
async function seedSettledTx(txid: string, amount: number) {
  d1.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, version, created_at, updated_at)
     VALUES (?, 'STANDARD', 'SETTLED', ?, 'JPY',
             '001', '0010000001', '002', '0020000001',
             ?, '1.0', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
  )
    .bind(txid, amount, `IK-${txid}`)
    ._runSync();
  const r = await submitCreditFailedProof(d1 as unknown as D1Database, txid, {
    proof_ref: `PROOF-${txid}`,
    bank_id: "002",
  });
  expect(r.ok).toBe(true);
}

async function reversalRows(originalTxid: string) {
  const { results } = await d1
    .prepare(
      `SELECT reversal_id, reversal_txid, status, amount FROM ReversalRecords WHERE original_txid = ?`
    )
    .bind(originalTxid)
    .all<{ reversal_id: string; reversal_txid: string | null; status: string; amount: number }>();
  return results ?? [];
}

beforeEach(() => {
  ({ d1 } = createTestDb());
});

/**
 * Probe #10 — at-least-once delivery of the reversal *request*.
 *
 * requestReversal accepts an idempotency_key but historically only stamped it
 * onto the compensating tx's UNIQUE `Transactions.idempotency_key`. So the
 * reversal *ledger* (ReversalRecords) had no idempotency notion of its own, and
 * a redelivered request:
 *   - for a ≤50% partial: slipped past the amount-based over-reversal guard,
 *     committed a second REQUESTED ReversalRecords row, then threw on the
 *     compensating tx's UNIQUE idempotency_key — leaving a phantom REQUESTED
 *     row that permanently strands reversal headroom (the SUM-based guard now
 *     double-counts the same intent);
 *   - for a full / >50% reversal: was masked by the over-reversal guard and
 *     returned a misleading OVER_REVERSAL.
 *
 * The invariant: a duplicate request is an idempotent replay of the first.
 */
describe("chaos: duplicate reversal request (at-least-once on requestReversal)", () => {
  it("replays idempotently for a ≤50% partial — no throw, one record, headroom preserved", async () => {
    const env = makeEnv(d1);
    await seedSettledTx("TX-REVDUP-001", 100_000);

    const req = {
      original_txid: "TX-REVDUP-001",
      amount: 40_000, // ≤ 50% so the over-reversal guard does NOT mask the dup
      reason: "DUPLICATE_PAYMENT" as const,
      requested_by: "001",
      idempotency_key: "IK-REV-DUP-001",
    };

    const first = await requestReversal(req, env as unknown as Env);
    expect(first.result).toBe("REVERSAL_CREATED");

    // The redelivered request must not throw and must not mint a second refund.
    let threw: Error | null = null;
    let second: Awaited<ReturnType<typeof requestReversal>> | null = null;
    try {
      second = await requestReversal(req, env as unknown as Env);
    } catch (e) {
      threw = e as Error;
    }
    expect(threw, threw?.message).toBeNull();
    expect(second?.result).toBe("REVERSAL_CREATED");
    // Idempotent replay → same reversal id + same compensating tx.
    expect(second?.reversal_id).toBe(first.reversal_id);
    expect(second?.reversal_txid).toBe(first.reversal_txid);

    // Exactly one reversal record — no phantom REQUESTED leak.
    const rows = await reversalRows("TX-REVDUP-001");
    expect(rows.length).toBe(1);

    // Headroom preserved: the remaining 60k is still reversible.
    const rest = await requestReversal(
      { ...req, amount: 60_000, idempotency_key: "IK-REV-REST-001" },
      env as unknown as Env
    );
    expect(rest.result, JSON.stringify(rest)).toBe("REVERSAL_CREATED");
  });

  it("replays idempotently for a full reversal — second call returns the same reversal, not OVER_REVERSAL", async () => {
    const env = makeEnv(d1);
    await seedSettledTx("TX-REVDUP-002", 100_000);

    const req = {
      original_txid: "TX-REVDUP-002",
      reason: "OPERATIONAL_ERROR" as const,
      requested_by: "OPS",
      idempotency_key: "IK-REV-DUP-002",
    };

    const first = await requestReversal(req, env as unknown as Env);
    expect(first.result).toBe("REVERSAL_CREATED");

    const second = await requestReversal(req, env as unknown as Env);
    expect(second.result).toBe("REVERSAL_CREATED");
    expect(second.reversal_id).toBe(first.reversal_id);
    expect(second.reversal_txid).toBe(first.reversal_txid);

    const rows = await reversalRows("TX-REVDUP-002");
    expect(rows.length).toBe(1);
  });
});

/**
 * Probe #10b — at-least-once delivery of the reversal *completion* callback.
 *
 * completeReversal is fired from onPayeeExecConfirmed when the compensating tx
 * reaches SETTLED. That callback is at-least-once, so completeReversal must be
 * a CAS-idempotent no-op on the second delivery: ReversalRecords stays
 * COMPLETED with exactly one ReversalCompleted EntityStateLog fact (a second
 * fact would corrupt the append-only transition history). This is a resilience
 * characterization guard (the CAS UPDATE + changes()-gated log already holds).
 */
describe("chaos: duplicate reversal completion callback (at-least-once on completeReversal)", () => {
  it("flips ReversalRecords → COMPLETED exactly once and logs exactly one fact", async () => {
    const env = makeEnv(d1);
    await seedSettledTx("TX-REVCMP-001", 100_000);

    const created = await requestReversal(
      {
        original_txid: "TX-REVCMP-001",
        reason: "OPERATIONAL_ERROR",
        requested_by: "OPS",
        idempotency_key: "IK-REV-CMP-001",
      },
      env as unknown as Env
    );
    expect(created.result).toBe("REVERSAL_CREATED");
    const reversalTxid = created.reversal_txid!;

    // Settlement callback redelivered three times (at-least-once).
    await completeReversal(reversalTxid, d1 as unknown as D1Database);
    await completeReversal(reversalTxid, d1 as unknown as D1Database);
    await completeReversal(reversalTxid, d1 as unknown as D1Database);

    const rec = await d1
      .prepare(`SELECT status FROM ReversalRecords WHERE reversal_txid = ?`)
      .bind(reversalTxid)
      .first<{ status: string }>();
    expect(rec?.status).toBe("COMPLETED");

    const facts = await d1
      .prepare(
        `SELECT COUNT(*) AS c FROM EntityStateLog
         WHERE entity_type='REVERSAL' AND entity_id=? AND event_type='ReversalCompleted'`
      )
      .bind(created.reversal_id)
      .first<{ c: number }>();
    expect(facts?.c).toBe(1);
  });
});

/**
 * Probe #12 — atomic reversal creation + enqueue recovery.
 *
 * The reversal ledger row (ReversalRecords) and its compensating tx were once
 * created across separate awaits, so a crash between them left a phantom
 * ReversalRecords row with reversal_txid=NULL: the idempotent replay then
 * returned REVERSAL_CREATED with no reversal_txid and never minted the
 * compensating tx — a remedy that silently evaporated. The creation is now a
 * single db.batch(), and a crash-before-enqueue is recovered on replay.
 */
describe("chaos: reversal creation is atomic and crash-before-enqueue recovers", () => {
  it("creates the records row and compensating tx together (records row carries reversal_txid)", async () => {
    const env = makeEnv(d1);
    await seedSettledTx("TX-REVATOM-001", 80_000);

    const r = await requestReversal(
      {
        original_txid: "TX-REVATOM-001",
        reason: "OPERATIONAL_ERROR",
        requested_by: "OPS",
        idempotency_key: "IK-REV-ATOM-001",
      },
      env as unknown as Env
    );
    expect(r.result).toBe("REVERSAL_CREATED");
    expect(r.reversal_txid).toMatch(/^TX-REV-/);

    // The records row must be TX_CREATED with reversal_txid set — never a phantom
    // REQUESTED/NULL — and the compensating tx must exist, in lockstep.
    const rows = await reversalRows("TX-REVATOM-001");
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("TX_CREATED");
    expect(rows[0]!.reversal_txid).toBe(r.reversal_txid);

    const tx = await d1
      .prepare(`SELECT state, purpose FROM Transactions WHERE txid = ?`)
      .bind(r.reversal_txid!)
      .first<{ state: string; purpose: string }>();
    expect(tx?.purpose).toBe("REFUND");
  });

  it("re-enqueues the compensating tx on replay when the first enqueue was lost", async () => {
    const env = makeEnv(d1);
    await seedSettledTx("TX-REVATOM-002", 90_000);

    const first = await requestReversal(
      {
        original_txid: "TX-REVATOM-002",
        reason: "OPERATIONAL_ERROR",
        requested_by: "OPS",
        idempotency_key: "IK-REV-ATOM-002",
      },
      env as unknown as Env
    );
    expect(first.result).toBe("REVERSAL_CREATED");
    const reversalTxid = first.reversal_txid!;

    // Simulate a crash after the creation batch committed but before QUEUE.send
    // landed: drop the enqueued advance message. The compensating tx is left in
    // RECEIVED with nothing scheduled to drive it forward.
    env.QUEUE._sink.length = 0;
    const stuck = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid = ?`)
      .bind(reversalTxid)
      .first<{ state: string }>();
    expect(stuck?.state).toBe("RECEIVED");

    // The at-least-once replay must recover it: detect the RECEIVED compensating
    // tx and re-enqueue its ADVANCE_STANDARD, without minting a second tx.
    const replay = await requestReversal(
      {
        original_txid: "TX-REVATOM-002",
        reason: "OPERATIONAL_ERROR",
        requested_by: "OPS",
        idempotency_key: "IK-REV-ATOM-002",
      },
      env as unknown as Env
    );
    expect(replay.result).toBe("REVERSAL_CREATED");
    expect(replay.reversal_txid).toBe(reversalTxid);

    // Exactly one records row / one compensating tx (no double refund).
    expect((await reversalRows("TX-REVATOM-002")).length).toBe(1);

    // The replay re-enqueued the advance for the stranded compensating tx.
    const advanceMsgs = env.QUEUE._sink.filter(
      (m) => m.txid === reversalTxid && m.payload?.action === "ADVANCE_STANDARD"
    );
    expect(advanceMsgs.length).toBe(1);
  });
});
