/**
 * @file ledger_predicate.test.ts — ZC-internal condition predicates resolved
 *       against committed FinalityLog state.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  validateLedgerPredicate,
  evaluateLedgerPredicate,
  MAX_PREDICATE_STATES,
} from "../../src/zc/platform/ledger_predicate";

/** Fixed clock read for *_REACHED_STATE tests (those predicates ignore `now`). */
const NOW = "2026-07-01T00:00:00Z";

describe("ledger_predicate — validation", () => {
  it("accepts a well-formed TX_REACHED_STATE predicate", () => {
    expect(
      validateLedgerPredicate({ kind: "TX_REACHED_STATE", txid: "TX-1", states: ["SETTLED"] }).ok
    ).toBe(true);
  });

  it("rejects unknown kinds, empty txid, empty/oversized/invalid states", () => {
    expect(validateLedgerPredicate(null).ok).toBe(false);
    expect(validateLedgerPredicate({ kind: "NOPE", txid: "TX-1", states: ["SETTLED"] }).ok).toBe(
      false
    );
    expect(
      validateLedgerPredicate({ kind: "TX_REACHED_STATE", txid: "", states: ["SETTLED"] }).ok
    ).toBe(false);
    expect(validateLedgerPredicate({ kind: "TX_REACHED_STATE", txid: "TX-1", states: [] }).ok).toBe(
      false
    );
    expect(
      validateLedgerPredicate({ kind: "TX_REACHED_STATE", txid: "TX-1", states: ["NOT_A_STATE"] })
        .ok
    ).toBe(false);
    const tooMany = Array.from({ length: MAX_PREDICATE_STATES + 1 }, () => "SETTLED");
    expect(
      validateLedgerPredicate({ kind: "TX_REACHED_STATE", txid: "TX-1", states: tooMany }).ok
    ).toBe(false);
  });

  it("validates GTID_REACHED_STATE against known GtidState", () => {
    expect(
      validateLedgerPredicate({ kind: "GTID_REACHED_STATE", gtid: "G-1", states: ["GT_SETTLED"] })
        .ok
    ).toBe(true);
    expect(
      validateLedgerPredicate({ kind: "GTID_REACHED_STATE", gtid: "", states: ["GT_SETTLED"] }).ok
    ).toBe(false);
    expect(
      validateLedgerPredicate({ kind: "GTID_REACHED_STATE", gtid: "G-1", states: ["NOPE"] }).ok
    ).toBe(false);
  });

  it("validates TIME_AFTER/TIME_BEFORE `at` (RFC3339; offset-less allowed = JST)", () => {
    expect(
      validateLedgerPredicate({ kind: "TIME_AFTER", at: "2026-07-01T09:00:00+09:00" }).ok
    ).toBe(true);
    expect(validateLedgerPredicate({ kind: "TIME_BEFORE", at: "2026-07-01T09:00:00" }).ok).toBe(
      true
    ); // offset-less = JST
    expect(validateLedgerPredicate({ kind: "TIME_AFTER", at: "not-a-time" }).ok).toBe(false);
    expect(validateLedgerPredicate({ kind: "TIME_AFTER" }).ok).toBe(false);
  });
});

describe("ledger_predicate — TIME_* evaluation (JST-aware)", () => {
  const noDb = null as unknown as import("../helpers/d1-mock").MockD1Database;

  it("TIME_AFTER holds once now >= at; TIME_BEFORE holds while now < at", async () => {
    const at = "2026-07-01T00:00:00Z";
    const before = "2026-06-30T23:59:59Z";
    const after = "2026-07-01T00:00:01Z";
    expect(await evaluateLedgerPredicate(noDb, { kind: "TIME_AFTER", at }, before)).toBe(false);
    expect(await evaluateLedgerPredicate(noDb, { kind: "TIME_AFTER", at }, after)).toBe(true);
    expect(await evaluateLedgerPredicate(noDb, { kind: "TIME_BEFORE", at }, before)).toBe(true);
    expect(await evaluateLedgerPredicate(noDb, { kind: "TIME_BEFORE", at }, after)).toBe(false);
  });

  it("interprets an offset-less `at` as JST (+09:00), not UTC", async () => {
    // 09:00 JST == 00:00Z. At now=00:00:30Z we are AFTER 09:00 JST.
    const p = { kind: "TIME_AFTER" as const, at: "2026-07-01T09:00:00" };
    expect(await evaluateLedgerPredicate(noDb, p, "2026-07-01T00:00:30Z")).toBe(true);
    // ...but BEFORE 09:00 interpreted (wrongly) as UTC would be false at the same now.
    expect(await evaluateLedgerPredicate(noDb, p, "2026-06-30T23:00:00Z")).toBe(false);
  });
});

describe("ledger_predicate — evaluation against committed FinalityLog", () => {
  let d1: MockD1Database;
  beforeEach(() => {
    ({ d1 } = createTestDb());
  });

  async function appendLog(txid: string, stateTo: string, seq: number) {
    await d1
      .prepare(
        `INSERT INTO FinalityLog (log_id, txid, gtid, event_type, state_from, state_to, payload_json, event_seq, occurred_at)
         VALUES (?, ?, NULL, 'Test', NULL, ?, '{}', ?, ?)`
      )
      .bind(`LOG-${txid}-${seq}`, txid, stateTo, seq, new Date().toISOString())
      .run();
  }

  it("is false until the txid reaches a target state, then true (monotonic)", async () => {
    const pred = {
      kind: "TX_REACHED_STATE" as const,
      txid: "TX-DEP",
      states: ["PAYEE_EXEC_CONFIRMED", "SETTLED"],
    };
    expect(await evaluateLedgerPredicate(d1, pred, NOW)).toBe(false);

    await appendLog("TX-DEP", "PRECHECKED", 1);
    expect(await evaluateLedgerPredicate(d1, pred, NOW)).toBe(false);

    await appendLog("TX-DEP", "PAYEE_EXEC_CONFIRMED", 2);
    expect(await evaluateLedgerPredicate(d1, pred, NOW)).toBe(true);

    // Stays true after further transitions (append-only history).
    await appendLog("TX-DEP", "SETTLED", 3);
    expect(await evaluateLedgerPredicate(d1, pred, NOW)).toBe(true);
  });

  it("does not match a different txid", async () => {
    await appendLog("TX-OTHER", "SETTLED", 1);
    expect(
      await evaluateLedgerPredicate(
        d1,
        { kind: "TX_REACHED_STATE", txid: "TX-DEP", states: ["SETTLED"] },
        NOW
      )
    ).toBe(false);
  });
});
