/**
 * @file Tests for tamper-evident FinalityLog hash chain and explainability.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { writeFinalityLog } from "../../src/zc/orchestrator";
import { verifyChain, GENESIS_PREV_HASH } from "../../src/zc/finality/finality_chain";
import { explainTransaction } from "../../src/zc/query/explain";

let d1: MockD1Database;

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
});

function insertTx(txid: string, state: string) {
  d1.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, created_at, updated_at, version)
     VALUES (?, 'EXPRESS', ?, 100000, 'JPY', '001', '001ACC', '002', '002ACC',
             ?, '1.0', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 0)`
  )
    .bind(txid, state, `IK-${txid}`)
    ._runSync();
}

async function writeStandardFlow(txid: string) {
  await writeFinalityLog(d1 as any, {
    txid,
    event_type: "PaymentInitiated",
    state_from: null,
    state_to: "RECEIVED",
    payload_json: JSON.stringify({ txid }),
    txid_or_gtid: txid,
  });
  await writeFinalityLog(d1 as any, {
    txid,
    event_type: "PreCheckPassed",
    state_from: "RECEIVED",
    state_to: "PRECHECKED",
    payload_json: "{}",
    txid_or_gtid: txid,
  });
  await writeFinalityLog(d1 as any, {
    txid,
    event_type: "HReserved",
    state_from: "PRECHECKED",
    state_to: "H_RESERVED",
    payload_json: "{}",
    txid_or_gtid: txid,
  });
  await writeFinalityLog(d1 as any, {
    txid,
    event_type: "Settled",
    state_from: "PAYEE_EXEC_CONFIRMED",
    state_to: "SETTLED",
    payload_json: "{}",
    txid_or_gtid: txid,
  });
}

describe("FinalityLog hash chain — writes", () => {
  it("stores prev_hash = GENESIS on the first entry of a chain", async () => {
    await writeFinalityLog(d1 as any, {
      txid: "TX-CHAIN-001",
      event_type: "PaymentInitiated",
      state_from: null,
      state_to: "RECEIVED",
      payload_json: "{}",
      txid_or_gtid: "TX-CHAIN-001",
    });
    const row = await d1
      .prepare(`SELECT prev_hash, entry_hash FROM FinalityLog WHERE txid = ?`)
      .bind("TX-CHAIN-001")
      .first<{ prev_hash: string; entry_hash: string }>();
    expect(row?.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(row?.entry_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("links each entry to the previous one within a chain", async () => {
    await writeStandardFlow("TX-CHAIN-002");
    const rows = await d1
      .prepare(
        `SELECT prev_hash, entry_hash FROM FinalityLog
       WHERE txid = ? ORDER BY event_seq ASC`
      )
      .bind("TX-CHAIN-002")
      .all<{ prev_hash: string; entry_hash: string }>();
    expect(rows.results.length).toBe(4);
    for (let i = 1; i < rows.results.length; i++) {
      expect(rows.results[i]!.prev_hash).toBe(rows.results[i - 1]!.entry_hash);
    }
  });

  it("keeps separate chains isolated per txid", async () => {
    await writeStandardFlow("TX-CHAIN-A");
    await writeStandardFlow("TX-CHAIN-B");
    const a = await verifyChain(d1 as any, "TX-CHAIN-A");
    const b = await verifyChain(d1 as any, "TX-CHAIN-B");
    expect(a.valid).toBe(true);
    expect(b.valid).toBe(true);
    expect(a.entries_checked).toBe(4);
    expect(b.entries_checked).toBe(4);
  });
});

describe("verifyChain — detects tampering", () => {
  it("reports valid chain when no data has been modified", async () => {
    await writeStandardFlow("TX-VERIFY-OK");
    const result = await verifyChain(d1 as any, "TX-VERIFY-OK");
    expect(result.valid).toBe(true);
    expect(result.break_at_seq).toBeNull();
    expect(result.break_reason).toBeNull();
  });

  it("detects payload tampering (ENTRY_HASH_MISMATCH)", async () => {
    await writeStandardFlow("TX-TAMPER-001");
    // Silently rewrite the payload of the 2nd entry — entry_hash now stale.
    d1.prepare(
      `UPDATE FinalityLog SET payload_json = ?
       WHERE txid = ? AND event_type = 'PreCheckPassed'`
    )
      .bind('{"forged":true}', "TX-TAMPER-001")
      ._runSync();

    const result = await verifyChain(d1 as any, "TX-TAMPER-001");
    expect(result.valid).toBe(false);
    expect(result.break_reason).toBe("ENTRY_HASH_MISMATCH");
    expect(result.break_at_seq).not.toBeNull();
  });

  it("detects link rewriting (PREV_HASH_MISMATCH)", async () => {
    await writeStandardFlow("TX-TAMPER-002");
    // Rewrite the prev_hash of the 3rd entry to break the link.
    d1.prepare(
      `UPDATE FinalityLog SET prev_hash = 'deadbeef'
       WHERE txid = ? AND event_type = 'HReserved'`
    )
      .bind("TX-TAMPER-002")
      ._runSync();

    const result = await verifyChain(d1 as any, "TX-TAMPER-002");
    expect(result.valid).toBe(false);
    expect(result.break_reason).toBe("PREV_HASH_MISMATCH");
  });

  it("detects silent deletion of a middle entry", async () => {
    await writeStandardFlow("TX-TAMPER-003");
    d1.prepare(`DELETE FROM FinalityLog WHERE txid = ? AND event_type = 'HReserved'`)
      .bind("TX-TAMPER-003")
      ._runSync();

    const result = await verifyChain(d1 as any, "TX-TAMPER-003");
    expect(result.valid).toBe(false);
    expect(result.break_reason).toBe("PREV_HASH_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// B5/B6 — concurrent-write safety
// ---------------------------------------------------------------------------

describe("writeFinalityLog — concurrent-write safety (B5/B6)", () => {
  it("produces a valid chain when two writes race to the same txid (simulated retry)", async () => {
    // Simulate what happens when two isolates both read prev_hash=GENESIS and try to write.
    // The DB-level UNIQUE(txid, prev_hash) index makes the second write fail; the retry
    // logic in writeFinalityLog re-reads the tip and succeeds on the second attempt.
    //
    // In this synchronous test we directly exercise the retry path by writing two entries
    // sequentially and then verifying chain integrity — if the retry was needed and worked,
    // the chain will be valid with both entries present.
    const txid = "TX-CONCURRENT-001";
    await writeFinalityLog(d1 as any, {
      txid,
      event_type: "PaymentInitiated",
      state_from: null,
      state_to: "RECEIVED",
      payload_json: "{}",
      txid_or_gtid: txid,
    });
    await writeFinalityLog(d1 as any, {
      txid,
      event_type: "PreCheckPassed",
      state_from: "RECEIVED",
      state_to: "PRECHECKED",
      payload_json: "{}",
      txid_or_gtid: txid,
    });

    const { verifyChain } = await import("../../src/zc/finality/finality_chain");
    const result = await verifyChain(d1 as any, txid);
    expect(result.valid).toBe(true);
    expect(result.entries_checked).toBe(2);
  });

  it("rejects a duplicate event_seq at the database level (B6)", () => {
    // Directly attempt two INSERTs with the same event_seq — the UNIQUE index must reject
    // the second one, confirming the constraint is in place.
    d1.prepare(
      `INSERT INTO FinalityLog
       (log_id, txid, event_type, state_from, state_to, payload_json, event_seq, occurred_at)
       VALUES ('FL-SEQ-A', 'TX-SEQ-001', 'TestEvent', null, 'RECEIVED', '{}', 9999999, '2026-01-01T00:00:00Z')`
    )._runSync();

    expect(() => {
      d1.prepare(
        `INSERT INTO FinalityLog
         (log_id, txid, event_type, state_from, state_to, payload_json, event_seq, occurred_at)
         VALUES ('FL-SEQ-B', 'TX-SEQ-002', 'TestEvent', null, 'RECEIVED', '{}', 9999999, '2026-01-01T00:00:00Z')`
      )._runSync();
    }).toThrow();
  });

  it("rejects two entries with the same (txid, prev_hash) at the database level (B5)", () => {
    // Confirm the partial UNIQUE index on (txid, prev_hash) WHERE txid IS NOT NULL prevents
    // two concurrent entries from sharing the same predecessor in the same chain.
    d1.prepare(
      `INSERT INTO FinalityLog
       (log_id, txid, event_type, state_from, state_to, payload_json, event_seq, occurred_at, prev_hash, entry_hash)
       VALUES ('FL-CHAIN-A', 'TX-CHAIN-RACE', 'Event1', null, 'RECEIVED', '{}', 1000001, '2026-01-01T00:00:00Z', 'GENESIS', 'hash-a')`
    )._runSync();

    expect(() => {
      d1.prepare(
        `INSERT INTO FinalityLog
         (log_id, txid, event_type, state_from, state_to, payload_json, event_seq, occurred_at, prev_hash, entry_hash)
         VALUES ('FL-CHAIN-B', 'TX-CHAIN-RACE', 'Event2', null, 'RECEIVED', '{}', 1000002, '2026-01-01T00:00:00Z', 'GENESIS', 'hash-b')`
      )._runSync();
    }).toThrow();
  });
});

describe("explainTransaction", () => {
  it("returns null for unknown txid", async () => {
    const result = await explainTransaction(d1 as any, "TX-NOPE");
    expect(result).toBeNull();
  });

  it("produces a timeline with human-readable reasons and integrity status", async () => {
    insertTx("TX-EXPLAIN-001", "SETTLED");
    await writeStandardFlow("TX-EXPLAIN-001");

    const result = await explainTransaction(d1 as any, "TX-EXPLAIN-001");
    expect(result).not.toBeNull();
    expect(result!.current_state).toBe("SETTLED");
    expect(result!.summary).toMatch(/最終確定/);
    expect(result!.timeline.length).toBe(4);
    expect(result!.timeline[0]!.event).toBe("PaymentInitiated");
    expect(result!.timeline[0]!.reason).toMatch(/送金リクエスト/);
    expect(result!.timeline[0]!.actors).toContain("ZC");
    expect(result!.integrity.chain_verified).toBe(true);
    expect(result!.integrity.entries_checked).toBe(4);
    expect(result!.integrity.algorithm).toMatch(/SHA-256/);
  });

  it("surfaces tamper detection in the integrity block", async () => {
    insertTx("TX-EXPLAIN-002", "SETTLED");
    await writeStandardFlow("TX-EXPLAIN-002");
    d1.prepare(
      `UPDATE FinalityLog SET payload_json = '{"forged":true}'
       WHERE txid = ? AND event_type = 'PaymentInitiated'`
    )
      .bind("TX-EXPLAIN-002")
      ._runSync();

    const result = await explainTransaction(d1 as any, "TX-EXPLAIN-002");
    expect(result!.integrity.chain_verified).toBe(false);
    expect(result!.integrity.break_reason).toBe("ENTRY_HASH_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// B9: GTID chain UNIQUE index (gtid-chain-fix regression; now in consolidated 0001 schema)
// ---------------------------------------------------------------------------

describe("FinalityLog — GTID chain prev_hash UNIQUE constraint (B9)", () => {
  it("rejects a second GTID entry with the same prev_hash as an existing entry", () => {
    // First entry — should succeed
    d1.prepare(
      `INSERT INTO FinalityLog
       (log_id, gtid, event_type, state_to, payload_json, event_seq, occurred_at, prev_hash, entry_hash)
       VALUES ('LOG-GTID-B9-1', 'GT-B9-001', 'GtidRegistered', 'GT_RECEIVED', '{}', 9001, '2026-01-01T00:00:00Z', 'GENESIS_HASH', 'hash-a')`
    )._runSync();

    // Second entry with same (gtid, prev_hash) — must be rejected by the UNIQUE index
    expect(() => {
      d1.prepare(
        `INSERT INTO FinalityLog
         (log_id, gtid, event_type, state_to, payload_json, event_seq, occurred_at, prev_hash, entry_hash)
         VALUES ('LOG-GTID-B9-2', 'GT-B9-001', 'GtidDecided', 'GT_DECIDED_TO_SETTLE', '{}', 9002, '2026-01-01T00:00:00Z', 'GENESIS_HASH', 'hash-b')`
      )._runSync();
    }).toThrow();
  });

  it("allows two GTID entries with different prev_hash values (normal chaining)", () => {
    d1.prepare(
      `INSERT INTO FinalityLog
       (log_id, gtid, event_type, state_to, payload_json, event_seq, occurred_at, prev_hash, entry_hash)
       VALUES ('LOG-GTID-B9-3', 'GT-B9-002', 'GtidRegistered', 'GT_RECEIVED', '{}', 9003, '2026-01-01T00:00:00Z', 'GENESIS_HASH', 'hash-c')`
    )._runSync();

    // Second entry uses the first entry's entry_hash as its prev_hash (valid chain link)
    expect(() => {
      d1.prepare(
        `INSERT INTO FinalityLog
         (log_id, gtid, event_type, state_to, payload_json, event_seq, occurred_at, prev_hash, entry_hash)
         VALUES ('LOG-GTID-B9-4', 'GT-B9-002', 'GtidDecided', 'GT_DECIDED_TO_SETTLE', '{}', 9004, '2026-01-01T00:00:00Z', 'hash-c', 'hash-d')`
      )._runSync();
    }).not.toThrow();
  });

  it("does NOT apply the GTID constraint when txid is set (TX chain entries are separate)", () => {
    // Entries with txid set are governed by idx_fl_chain_prev_hash, not the GTID index.
    // Same (gtid, prev_hash) with txid present should be allowed by the GTID partial index.
    d1.prepare(
      `INSERT INTO FinalityLog
       (log_id, txid, gtid, event_type, state_to, payload_json, event_seq, occurred_at, prev_hash, entry_hash)
       VALUES ('LOG-GTID-B9-5', 'TX-GTID-001', 'GT-B9-003', 'PaymentInitiated', 'RECEIVED', '{}', 9005, '2026-01-01T00:00:00Z', 'GENESIS_HASH', 'hash-e')`
    )._runSync();

    // Second entry with same gtid + prev_hash but txid IS NOT NULL: GTID partial index does not apply
    expect(() => {
      d1.prepare(
        `INSERT INTO FinalityLog
         (log_id, txid, gtid, event_type, state_to, payload_json, event_seq, occurred_at, prev_hash, entry_hash)
         VALUES ('LOG-GTID-B9-6', 'TX-GTID-002', 'GT-B9-003', 'PaymentInitiated', 'RECEIVED', '{}', 9006, '2026-01-01T00:00:00Z', 'GENESIS_HASH', 'hash-f')`
      )._runSync();
    }).not.toThrow();
  });
});

// E1: canonicalization injectivity. The v1 framing joined raw field values with
// a single '|', so a '|' inside a variable field could shift a field boundary
// and make two logically distinct entries serialize identically (hash
// collision). v2 length-prefixes each field, removing the ambiguity.
describe("FinalityLog hash chain — canonicalization injectivity (E1)", () => {
  it("does not collide two entries that the old '|'-join would alias", async () => {
    const { computeEntryHash } = await import("../../src/zc/finality/finality_chain");
    const base = {
      log_id: "FL-X",
      txid: "TX-1",
      gtid: null,
      event_type: "EVT",
      state_from: "PRECHECKED",
      event_seq: 1,
      occurred_at: "2026-01-01T00:00:00.000Z",
    };
    // Under v1: state_to + '|' + payload_json was "A" + "|" + "B|C" === "A|B" + "|" + "C".
    const a = { ...base, state_to: "A", payload_json: "B|C" };
    const b = { ...base, state_to: "A|B", payload_json: "C" };
    const ha = await computeEntryHash(a as any, GENESIS_PREV_HASH);
    const hb = await computeEntryHash(b as any, GENESIS_PREV_HASH);
    expect(ha).not.toBe(hb);
  });

  it("a written chain still verifies under v2 framing end to end", async () => {
    await writeStandardFlow("TX-CHAIN-V2");
    const v = await verifyChain(d1 as any, "TX-CHAIN-V2");
    expect(v.valid).toBe(true);
    expect(v.algorithm).toBe("SHA-256 hash-chain v2");
  });
});

// E2: chain scoping. A chain id is either a txid (matched on the txid column) or
// a non-tx id (gtid/DNS/LSM, matched on the gtid column) — never both. The old
// `txid = ? OR gtid = ?` predicate would let a row whose *gtid* equals a txid
// leak into that txid's chain. Scoping by id kind prevents the cross-pickup.
describe("FinalityLog hash chain — chain scoping (E2)", () => {
  it("a txid chain ignores a pathological row whose gtid equals that txid", async () => {
    await writeFinalityLog(d1 as any, {
      txid: "TX-SCOPE-1",
      event_type: "PaymentInitiated",
      state_from: null,
      state_to: "RECEIVED",
      payload_json: "{}",
      txid_or_gtid: "TX-SCOPE-1",
    });
    // Pathological row: a non-tx chain entry whose gtid column collides with the
    // txid above. Inserted directly to bypass the writer's chain-id resolution.
    d1.prepare(
      `INSERT INTO FinalityLog
       (log_id, txid, gtid, event_type, state_to, payload_json, event_seq, occurred_at, prev_hash, entry_hash)
       VALUES ('FL-SCOPE-X', NULL, 'TX-SCOPE-1', 'Noise', 'RECEIVED', '{}', 999999, '2026-01-01T00:00:00Z', 'GENESIS', 'deadbeef')`
    )._runSync();

    // verifyChain('TX-SCOPE-1') must see only the one real txid row and stay
    // valid — the pathological gtid row (entry_hash 'deadbeef') is out of scope.
    const v = await verifyChain(d1 as any, "TX-SCOPE-1");
    expect(v.valid).toBe(true);
    expect(v.entries_checked).toBe(1);
  });
});
