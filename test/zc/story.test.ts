/**
 * @file Tests for narrateTransaction (story.ts) — narrative + Mermaid + health.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { writeFinalityLog } from "../../src/zc/orchestrator";
import { narrateTransaction } from "../../src/zc/query/story";
import { ALLOWED_TRANSITIONS } from "../../src/zc/orchestrator/state_machine";

let d1: MockD1Database;

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
});

function insertTx(
  txid: string,
  state: string,
  opts: Partial<{
    payerBank: string;
    payeeBank: string;
    amount: number;
    lane: string;
  }> = {}
) {
  const payer = opts.payerBank ?? "001";
  const payee = opts.payeeBank ?? "002";
  const amt = opts.amount ?? 50_000;
  const lane = opts.lane ?? "EXPRESS";
  d1.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, 'JPY', ?, ?, ?, ?, ?, '1.0',
             '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 0)`
  )
    .bind(txid, lane, state, amt, payer, `${payer}ACC`, payee, `${payee}ACC`, `IK-${txid}`)
    ._runSync();
}

/**
 * Backfill occurred_at on the most-recent FinalityLog row for a txid so we can
 * simulate timestamp gaps. This deliberately desyncs the chain hash (prev_hash
 * was computed against the original timestamp), which is fine — story.ts
 * surfaces chain status via integrity but the narrative/pacing logic does not
 * depend on the chain being valid.
 */
function backdateLastEvent(txid: string, eventType: string, occurredAt: string) {
  d1.prepare(
    `UPDATE FinalityLog SET occurred_at = ?
     WHERE txid = ? AND event_type = ?`
  )
    .bind(occurredAt, txid, eventType)
    ._runSync();
}

describe("narrateTransaction", () => {
  it("returns null for unknown txid", async () => {
    const result = await narrateTransaction(d1 as any, "TX-NONEXISTENT");
    expect(result).toBeNull();
  });

  it("produces a headline naming both banks and the amount in JPY", async () => {
    insertTx("TX-STORY-001", "SETTLED", { payerBank: "011", payeeBank: "022", amount: 75_000 });
    await writeFinalityLog(d1 as any, {
      txid: "TX-STORY-001",
      event_type: "PaymentInitiated",
      state_from: null,
      state_to: "RECEIVED",
      payload_json: "{}",
      txid_or_gtid: "TX-STORY-001",
    });
    const r = (await narrateTransaction(d1 as any, "TX-STORY-001"))!;
    expect(r.headline).toContain("011");
    expect(r.headline).toContain("022");
    expect(r.headline).toContain("¥75,000");
    expect(r.headline).toContain("EXPRESS");
    expect(r.parties.payer_bank_id).toBe("011");
    expect(r.parties.payee_bank_id).toBe("022");
    expect(r.timeline).toHaveLength(1);
    expect(r.timeline[0]!.event).toBe("PaymentInitiated");
  });

  it("renders a Mermaid sequenceDiagram with all four actors and per-event arrows", async () => {
    insertTx("TX-STORY-002", "SETTLED");
    for (const ev of [
      { event_type: "PaymentInitiated", state_from: null, state_to: "RECEIVED" },
      { event_type: "PreCheckPassed", state_from: "RECEIVED", state_to: "PRECHECKED" },
      { event_type: "HReserved", state_from: "PRECHECKED", state_to: "H_RESERVED" },
      { event_type: "DecidedToSettle", state_from: "H_RESERVED", state_to: "DECIDED_TO_SETTLE" },
      {
        event_type: "PayerExecConfirmed",
        state_from: "DECIDED_TO_SETTLE",
        state_to: "PAYER_EXEC_CONFIRMED",
      },
      {
        event_type: "PayeeExecConfirmed",
        state_from: "PAYER_EXEC_CONFIRMED",
        state_to: "PAYEE_EXEC_CONFIRMED",
      },
      { event_type: "Settled", state_from: "PAYEE_EXEC_CONFIRMED", state_to: "SETTLED" },
    ]) {
      await writeFinalityLog(d1 as any, {
        txid: "TX-STORY-002",
        event_type: ev.event_type,
        state_from: ev.state_from,
        state_to: ev.state_to,
        payload_json: "{}",
        txid_or_gtid: "TX-STORY-002",
      });
    }

    const r = (await narrateTransaction(d1 as any, "TX-STORY-002"))!;
    const m = r.mermaid_sequence;
    expect(m.startsWith("sequenceDiagram")).toBe(true);
    expect(m).toContain("actor Customer");
    expect(m).toContain("participant PayerBank");
    expect(m).toContain("participant ZC");
    expect(m).toContain("participant PayeeBank");
    // PaymentInitiated → Customer ->> ZC
    expect(m).toContain("Customer->>ZC");
    // HReserved → ZC ->> PayerBank request, then dashed PayerBank -->> ZC ack
    expect(m).toContain("ZC->>PayerBank");
    expect(m).toContain("PayerBank-->>ZC");
    // PayeeExecConfirmed → dashed PayeeBank -->> ZC
    expect(m).toContain("PayeeBank-->>ZC");
    // Settled → Note over ZC,PayeeBank
    expect(m).toContain("Note over ZC,PayeeBank");
  });

  it("TERMINAL health for SETTLED with no next_expected", async () => {
    insertTx("TX-STORY-003", "SETTLED");
    await writeFinalityLog(d1 as any, {
      txid: "TX-STORY-003",
      event_type: "PaymentInitiated",
      state_from: null,
      state_to: "RECEIVED",
      payload_json: "{}",
      txid_or_gtid: "TX-STORY-003",
    });
    await writeFinalityLog(d1 as any, {
      txid: "TX-STORY-003",
      event_type: "Settled",
      state_from: "PAYEE_EXEC_CONFIRMED",
      state_to: "SETTLED",
      payload_json: "{}",
      txid_or_gtid: "TX-STORY-003",
    });
    const r = (await narrateTransaction(d1 as any, "TX-STORY-003"))!;
    expect(r.health.status).toBe("TERMINAL");
    expect(r.health.next_expected).toEqual([]);
    expect(r.narrative).toContain("最終確定");
  });

  it("STUCK health when last event is older than the stuck threshold", async () => {
    insertTx("TX-STORY-004", "H_RESERVED");
    await writeFinalityLog(d1 as any, {
      txid: "TX-STORY-004",
      event_type: "PaymentInitiated",
      state_from: null,
      state_to: "RECEIVED",
      payload_json: "{}",
      txid_or_gtid: "TX-STORY-004",
    });
    await writeFinalityLog(d1 as any, {
      txid: "TX-STORY-004",
      event_type: "HReserved",
      state_from: "PRECHECKED",
      state_to: "H_RESERVED",
      payload_json: "{}",
      txid_or_gtid: "TX-STORY-004",
    });
    // Backdate the last event to 5 minutes ago.
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    backdateLastEvent("TX-STORY-004", "HReserved", fiveMinAgo);

    const r = (await narrateTransaction(d1 as any, "TX-STORY-004"))!;
    expect(r.health.status).toBe("STUCK");
    expect(r.health.next_expected).toContain("DecidedToSettle");
    expect(r.health.next_expected).toContain("DecidedCancel");
    expect(r.health.message).toMatch(/停滞|経過/);
  });

  it("OK health for fresh in-flight transactions, with a recent last_event_at", async () => {
    insertTx("TX-STORY-005", "PRECHECKED");
    await writeFinalityLog(d1 as any, {
      txid: "TX-STORY-005",
      event_type: "PaymentInitiated",
      state_from: null,
      state_to: "RECEIVED",
      payload_json: "{}",
      txid_or_gtid: "TX-STORY-005",
    });
    await writeFinalityLog(d1 as any, {
      txid: "TX-STORY-005",
      event_type: "PreCheckPassed",
      state_from: "RECEIVED",
      state_to: "PRECHECKED",
      payload_json: "{}",
      txid_or_gtid: "TX-STORY-005",
    });
    const r = (await narrateTransaction(d1 as any, "TX-STORY-005"))!;
    expect(r.health.status).toBe("OK");
    expect(r.health.next_expected).toContain("HReserved");
    expect(r.pacing.last_event_at).not.toBeNull();
    expect(r.pacing.elapsed_ms).not.toBeNull();
  });

  it("detects the longest gap between consecutive events", async () => {
    insertTx("TX-STORY-006", "H_RESERVED");
    await writeFinalityLog(d1 as any, {
      txid: "TX-STORY-006",
      event_type: "PaymentInitiated",
      state_from: null,
      state_to: "RECEIVED",
      payload_json: "{}",
      txid_or_gtid: "TX-STORY-006",
    });
    await writeFinalityLog(d1 as any, {
      txid: "TX-STORY-006",
      event_type: "PreCheckPassed",
      state_from: "RECEIVED",
      state_to: "PRECHECKED",
      payload_json: "{}",
      txid_or_gtid: "TX-STORY-006",
    });
    await writeFinalityLog(d1 as any, {
      txid: "TX-STORY-006",
      event_type: "HReserved",
      state_from: "PRECHECKED",
      state_to: "H_RESERVED",
      payload_json: "{}",
      txid_or_gtid: "TX-STORY-006",
    });
    // Backdate the earlier two events so the second gap (PreCheckPassed →
    // HReserved) is unambiguously the longest. HReserved keeps its (recent)
    // timestamp.
    //   gap1 = PreCheckPassed - PaymentInitiated = 25s
    //   gap2 = HReserved      - PreCheckPassed   = 35s  ← winner
    const t0 = new Date(Date.now() - 60_000).toISOString();
    const t1 = new Date(Date.now() - 35_000).toISOString();
    backdateLastEvent("TX-STORY-006", "PaymentInitiated", t0);
    backdateLastEvent("TX-STORY-006", "PreCheckPassed", t1);

    const r = (await narrateTransaction(d1 as any, "TX-STORY-006"))!;
    expect(r.pacing.longest_gap).not.toBeNull();
    expect(r.pacing.longest_gap!.from_event).toBe("PreCheckPassed");
    expect(r.pacing.longest_gap!.to_event).toBe("HReserved");
    expect(r.pacing.longest_gap!.gap_ms).toBeGreaterThanOrEqual(25_000);
  });

  it('honors an injected "now" so health verdicts are deterministic', async () => {
    insertTx("TX-STORY-007", "H_RESERVED");
    await writeFinalityLog(d1 as any, {
      txid: "TX-STORY-007",
      event_type: "HReserved",
      state_from: "PRECHECKED",
      state_to: "H_RESERVED",
      payload_json: "{}",
      txid_or_gtid: "TX-STORY-007",
    });
    // Fix occurred_at deterministically.
    const eventTime = "2026-05-06T01:00:00.000Z";
    backdateLastEvent("TX-STORY-007", "HReserved", eventTime);

    // 5 seconds later → OK
    const ok = (await narrateTransaction(
      d1 as any,
      "TX-STORY-007",
      new Date("2026-05-06T01:00:05.000Z")
    ))!;
    expect(ok.health.status).toBe("OK");

    // 30 seconds later → WATCH
    const watch = (await narrateTransaction(
      d1 as any,
      "TX-STORY-007",
      new Date("2026-05-06T01:00:30.000Z")
    ))!;
    expect(watch.health.status).toBe("WATCH");

    // 5 minutes later → STUCK
    const stuck = (await narrateTransaction(
      d1 as any,
      "TX-STORY-007",
      new Date("2026-05-06T01:05:00.000Z")
    ))!;
    expect(stuck.health.status).toBe("STUCK");
  });

  it("escapes problematic characters inside Mermaid labels", async () => {
    insertTx("TX-STORY-008", "RECEIVED");
    // Fall-through to the generic note path with a payload-like event_type.
    await writeFinalityLog(d1 as any, {
      txid: "TX-STORY-008",
      event_type: "CustomEvent;with\nbreaks",
      state_from: null,
      state_to: "RECEIVED",
      payload_json: "{}",
      txid_or_gtid: "TX-STORY-008",
    });
    const r = (await narrateTransaction(d1 as any, "TX-STORY-008"))!;
    // Sanitized: no literal ';', '\n', or '\r' should leak into the diagram.
    expect(r.mermaid_sequence).not.toMatch(/;[^\n]*$/m);
    expect(r.mermaid_sequence.split("\n").every((l) => !l.includes("\r"))).toBe(true);
  });

  it("knows the next expected events for HTLC_ONCHAIN_PENDING and PRECHECKED_SUSPENDED", async () => {
    // Regression: these two states were missing from NEXT_EXPECTED / stateToVerb,
    // so the health verdict offered no "next step" prediction (基本コンセプト：
    // 次段階の予測可能化) and the headline fell back to the raw "<STATE> 状態" label.
    insertTx("TX-STORY-ONCHAIN", "HTLC_ONCHAIN_PENDING", { lane: "HTLC" });
    const onchain = (await narrateTransaction(d1 as any, "TX-STORY-ONCHAIN"))!;
    expect(onchain.health.next_expected).toEqual(["HtlcFulfillRequested", "HtlcCancelled"]);
    // Headline must use a human verb, not the "<STATE> 状態" fallback.
    expect(onchain.headline).not.toContain("HTLC_ONCHAIN_PENDING 状態");

    insertTx("TX-STORY-PRESUSP", "PRECHECKED_SUSPENDED");
    const presusp = (await narrateTransaction(d1 as any, "TX-STORY-PRESUSP"))!;
    expect(presusp.health.next_expected).toEqual(["PreCheckPassed", "DecidedCancel"]);
    expect(presusp.headline).not.toContain("PRECHECKED_SUSPENDED 状態");
  });

  it("offers a next-step prediction for every non-terminal state", async () => {
    // Exhaustiveness guard for the health prediction (基本コンセプト：次段階の
    // 予測可能化): a new non-terminal state must not silently lose its
    // NEXT_EXPECTED entry. This is the regression net for the missing
    // HTLC_ONCHAIN_PENDING case.
    const TERMINAL = new Set(["SETTLED", "CANCELLED", "FAILED_EXECUTION"]);
    for (const state of Object.keys(ALLOWED_TRANSITIONS)) {
      if (TERMINAL.has(state)) continue;
      const txid = `TX-STORY-EXH-${state}`;
      insertTx(txid, state);
      const r = (await narrateTransaction(d1 as any, txid))!;
      expect(
        r.health.next_expected.length,
        `state ${state} has no NEXT_EXPECTED prediction`
      ).toBeGreaterThan(0);
    }
  });
});
