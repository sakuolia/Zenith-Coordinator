/**
 * @file Continuous collection: notice, ladder, finality and additional auth.
 *
 * These pin the rules that are load-bearing rather than incidental:
 *
 *  - One charge item can reach CONFIRMED_OK at most once, and that single
 *    constraint is what both prevents double collection AND cancels the rest of
 *    the ladder. If someone later "helpfully" adds a separate cancellation
 *    mechanism, these tests should be the reason they stop.
 *  - Failure is not final until no further attempt can happen. A midnight
 *    shortfall on a SCHEDULED collection is not a failure; the same shortfall at
 *    the deadline is.
 *  - Silence on an additional-authorisation request is a refusal, and it ends
 *    the ladder. If that default ever inverts, the mechanism becomes an
 *    over-charging channel instead of a protection.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../helpers/d1-mock";
import { initBudget } from "../../src/zc/collection/budget";
import {
  amendFreezeFor,
  confirmDeadlineFor,
  normaliseChargeRef,
  validateChargeRef,
  amendNotice,
  withdrawNotice,
} from "../../src/zc/collection/notice";
import {
  allocationOrder,
  confirmCollection,
  recordAttempt,
  selectDueCollections,
  sweepConfirmDeadlines,
  type OrderableCollection,
} from "../../src/zc/collection/execute";
import { sweepUnansweredAuth } from "../../src/zc/collection/reauth";
import { settlementStatusOf } from "../../src/zc/collection/query";
import { classifyCapChange, resolveMode, supportedModes } from "../../src/zc/collection/mandate";
import type { DebitMandateRow, ScheduledCollectionRow } from "../../src/types";

const DDM = "DDM-LC-1";

// biome-ignore lint/suspicious/noExplicitAny: D1 mock
let db: any;
// biome-ignore lint/suspicious/noExplicitAny: better-sqlite3 handle for setup
let sqlite: any;

function insertContract(overrides: Partial<DebitMandateRow> = {}) {
  sqlite
    .prepare(
      `INSERT INTO Mandate (mandate_id, principal_participant_id, grantee_ref, parent_mandate_id,
         max_amount, allowed_purposes, allowed_lanes, valid_from, valid_to, principal_key_id,
         signature, nonce, occurred_at, revoked_at, created_at)
       VALUES ('MANDATE-LC-1','002','001:P',NULL,NULL,NULL,NULL,'2000-01-01T00:00:00.000Z',
               '9999-12-31T23:59:59.999Z','KEY-1','sig','n','2000-01-01T00:00:00.000Z',NULL,
               '2000-01-01T00:00:00.000Z')`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO DebitMandate (dd_mandate_id, mandate_id, payer_bank_id, payer_account_alias,
         payee_bank_id, payee_account_hash, product_ref, charge_mode, period_cycle,
         collection_mode, notice_days_min, amend_freeze_hours, ladder_max, nonbusiness_day_rule,
         per_collection_cap, month_amount_cap, month_count_cap, two_month_amount_cap,
         day_count_cap, lifetime_amount_cap, lifetime_count_cap, pending_amount_cap,
         pending_count_cap, latefee_month_cap, latefee_rate_max, realtime_month_count_cap,
         variance_ratio_max, eligibility_attestation_id, state, revoked_at,
         created_at, updated_at, version)
       VALUES (?, 'MANDATE-LC-1', '002', 'tel:+81-90', '001', 'h:payee', '◯◯カード ****1234',
               ?, 'MONTHLY', 'SCHEDULED', 0, 33, 3, 'NEXT_BUSINESS',
               NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
               NULL, 'ACTIVE', NULL, '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', 0)`
    )
    .run(DDM, overrides.charge_mode ?? "PERIODIC");
}

function insertCollection(
  id: string,
  seq: number,
  dueDate: string,
  overrides: Partial<ScheduledCollectionRow> = {}
) {
  sqlite
    .prepare(
      `INSERT INTO ScheduledCollection
         (collection_id, dd_mandate_id, charge_ref, ladder_seq, amount_value, latefee_value,
          amount_currency, due_date, confirm_deadline_at, amend_freeze_at, mode, requested_mode,
          state, result, reason_code, retriable_today, vault_ref, hashlock, extra_mandate_id,
          edi_ref, priority_hint, budget_reserved, txid, notified_at, frozen_at, fired_at,
          confirmed_at, idempotency_key, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, 'JPY', ?, ?, ?, 'SCHEDULED', 'SCHEDULED', ?, ?, NULL, 0,
               NULL, NULL, NULL, NULL, ?, 1, ?, NULL, NULL, NULL, NULL, ?, ?, ?, 0)`
    )
    .run(
      id,
      DDM,
      overrides.charge_ref ?? "2026年4月分",
      seq,
      overrides.amount_value ?? 9800,
      overrides.latefee_value ?? 0,
      dueDate,
      overrides.confirm_deadline_at ?? `${dueDate}T15:00:00.000Z`,
      overrides.amend_freeze_at ?? `${dueDate}T00:00:00.000Z`,
      overrides.state ?? "SCHEDULED",
      overrides.result ?? null,
      overrides.priority_hint ?? null,
      overrides.txid ?? null,
      `IDEM-${id}`,
      "2026-04-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z"
    );
}

beforeEach(async () => {
  const t = createTestDb();
  db = t.d1;
  sqlite = t.sqlite;
  insertContract();
  await initBudget(db, DDM, "2026-04-01T00:00:00.000Z");
});

describe("charge item", () => {
  it("normalises only enough to keep identity honest", () => {
    expect(normaliseChargeRef("  2026年4月分  ")).toBe("2026年4月分");
    expect(normaliseChargeRef("2026年4月分\t\t A")).toBe("2026年4月分 A");
  });

  it("PERIODIC contracts constrain the item to a period, ITEMIZED do not", async () => {
    const c = sqlite
      .prepare(`SELECT * FROM DebitMandate WHERE dd_mandate_id = ?`)
      .get(DDM) as DebitMandateRow;
    expect(validateChargeRef(c, "2026年4月分", "2026-04-01T00:00:00.000Z").ok).toBe(true);
    expect(validateChargeRef(c, "第12回総会 参加費", "2026-04-01T00:00:00.000Z").ok).toBe(false);

    const itemized = { ...c, charge_mode: "ITEMIZED" as const };
    expect(validateChargeRef(itemized, "第12回総会 参加費", "2026-04-01T00:00:00.000Z").ok).toBe(
      true
    );
  });

  it("rejects a period too far in the future", () => {
    const c = sqlite
      .prepare(`SELECT * FROM DebitMandate WHERE dd_mandate_id = ?`)
      .get(DDM) as DebitMandateRow;
    // PR-DD-PERIOD-AHEAD-MAX: without this a payee could pre-register years of
    // collections against a mandate the customer may revoke tomorrow.
    const r = validateChargeRef(c, "2027年4月分", "2026-04-01T00:00:00.000Z");
    expect(r.ok).toBe(false);
  });
});

describe("deadlines are data, not constants", () => {
  it("SCHEDULED confirms at 24:00 of the due date; REALTIME at the Decision", () => {
    const now = "2026-04-27T03:00:00.000Z";
    expect(confirmDeadlineFor("SCHEDULED", "2026-04-27", now)).toBe(
      "2026-04-28T00:00:00.000+09:00"
    );
    // Not because REALTIME is "synchronous" — b is asynchronous in every mode —
    // but because it has exactly one attempt, so nothing further can happen.
    expect(confirmDeadlineFor("REALTIME", "2026-04-27", now)).toBe(now);
  });

  it("REALTIME's amendment window has width zero rather than being absent", () => {
    const now = "2026-04-27T03:00:00.000Z";
    // Modelled as a zero-width window so freeze checks need no special case.
    expect(amendFreezeFor("REALTIME", "2026-04-27", 33, now)).toBe(now);
    expect(amendFreezeFor("SCHEDULED", "2026-04-27", 33, now)).not.toBe(now);
  });
});

describe("ladder exclusion", () => {
  it("a later rung does not fire while the earlier one is still open", async () => {
    insertCollection("COL-1", 1, "2026-04-27");
    insertCollection("COL-2", 2, "2026-04-28");

    // Rung 1 fired but has not confirmed: rung 2 must wait even though its own
    // date has arrived. Driving on the date alone double-collects whenever the
    // core's window runs late.
    sqlite
      .prepare(`UPDATE ScheduledCollection SET state='FIRED' WHERE collection_id='COL-1'`)
      .run();
    const due = await selectDueCollections(db, "2026-04-28");
    expect(due.map((r) => r.collection_id)).toEqual([]);
  });

  it("a later rung fires only once the earlier one confirmed as failed", async () => {
    insertCollection("COL-1", 1, "2026-04-27", { state: "FIRED", result: "CONFIRMED_NG" });
    insertCollection("COL-2", 2, "2026-04-28");

    const due = await selectDueCollections(db, "2026-04-28");
    expect(due.map((r) => r.collection_id)).toEqual(["COL-2"]);
  });

  it("confirming one rung supersedes the rest — recorded, not deleted", async () => {
    insertCollection("COL-1", 1, "2026-04-27", { state: "FIRED" });
    insertCollection("COL-2", 2, "2026-04-28");
    insertCollection("COL-3", 3, "2026-05-13");

    await confirmCollection(db, "COL-1", "CONFIRMED_OK", null, "2026-04-27T09:00:00.000Z");

    const rows = sqlite
      .prepare(
        `SELECT collection_id, state, reason_code FROM ScheduledCollection ORDER BY ladder_seq`
      )
      .all() as Array<{ collection_id: string; state: string; reason_code: string | null }>;
    // The customer must still be able to be told *why* the 13 May retry vanished.
    expect(rows[1]!.state).toBe("SUPERSEDED");
    expect(rows[1]!.reason_code).toBe("SUPERSEDED_BY_EARLIER_RUNG");
    expect(rows[2]!.state).toBe("SUPERSEDED");
  });

  it("the same charge item cannot be collected twice", () => {
    insertCollection("COL-1", 1, "2026-04-27", { result: "CONFIRMED_OK" });
    // The partial unique index is the single mechanism behind both
    // double-charge prevention and ladder exclusion — they are one invariant.
    expect(() => insertCollection("COL-9", 9, "2026-05-27", { result: "CONFIRMED_OK" })).toThrow(
      /UNIQUE constraint failed/
    );
  });
});

describe("finality is asymmetric", () => {
  it("a shortfall before the deadline is not a failure", async () => {
    insertCollection("COL-1", 1, "2026-04-27", {
      state: "FIRED",
      confirm_deadline_at: "2026-04-27T15:00:00.000Z",
    });

    const out = await recordAttempt(db, {
      collectionId: "COL-1",
      result: "NG",
      reasonCode: "INSUFFICIENT_FUNDS",
      observedAt: "2026-04-27T00:15:00.000Z",
    });
    expect(out).toMatchObject({ result: "RECORDED", confirmed: false });

    const row = sqlite
      .prepare(`SELECT * FROM ScheduledCollection WHERE collection_id='COL-1'`)
      .get() as ScheduledCollectionRow;
    expect(row.result).toBeNull();
    // Still open, and flagged as worth chasing: the customer can pay in and be
    // collected on a later pass the same day.
    expect(row.retriable_today).toBe(1);
    expect(settlementStatusOf(row)).toBe("ACCEPTED");
  });

  it("success confirms immediately — money moved", async () => {
    insertCollection("COL-1", 1, "2026-04-27", { state: "FIRED" });
    const out = await recordAttempt(db, {
      collectionId: "COL-1",
      result: "OK",
      observedAt: "2026-04-27T12:00:00.000Z",
    });
    expect(out).toMatchObject({ confirmed: true });
    const row = sqlite
      .prepare(`SELECT * FROM ScheduledCollection WHERE collection_id='COL-1'`)
      .get() as ScheduledCollectionRow;
    expect(row.result).toBe("CONFIRMED_OK");
  });

  it("the deadline turns an open shortfall into a failure", async () => {
    insertCollection("COL-1", 1, "2026-04-27", {
      state: "FIRED",
      confirm_deadline_at: "2026-04-27T15:00:00.000Z",
    });
    await recordAttempt(db, {
      collectionId: "COL-1",
      result: "NG",
      reasonCode: "INSUFFICIENT_FUNDS",
      observedAt: "2026-04-27T00:15:00.000Z",
    });

    const swept = await sweepConfirmDeadlines(db, "2026-04-27T15:00:01.000Z");
    expect(swept.confirmed_ng).toBe(1);
    // An ordinary shortfall is the expected terminal state, not an anomaly.
    expect(swept.cases_opened).toBe(0);

    const row = sqlite
      .prepare(`SELECT * FROM ScheduledCollection WHERE collection_id='COL-1'`)
      .get() as ScheduledCollectionRow;
    expect(row.result).toBe("CONFIRMED_NG");
    expect(row.reason_code).toBe("INSUFFICIENT_FUNDS");
  });

  it("a deadline reached with no attempt at all is a CASE — the outcome is unknown", async () => {
    insertCollection("COL-1", 1, "2026-04-27", {
      state: "FIRED",
      confirm_deadline_at: "2026-04-27T15:00:00.000Z",
    });
    const swept = await sweepConfirmDeadlines(db, "2026-04-27T15:00:01.000Z");
    expect(swept.cases_opened).toBe(1);
  });

  it("retriable_today is false for a reason today's money cannot fix", async () => {
    insertCollection("COL-1", 1, "2026-04-27", { state: "FIRED" });
    await recordAttempt(db, {
      collectionId: "COL-1",
      result: "NG",
      reasonCode: "ACCOUNT_NOT_FOUND",
      observedAt: "2026-04-27T00:15:00.000Z",
    });
    const row = sqlite
      .prepare(`SELECT * FROM ScheduledCollection WHERE collection_id='COL-1'`)
      .get() as ScheduledCollectionRow;
    // A payee chasing this would be spending on a reminder that cannot work.
    expect(row.retriable_today).toBe(0);
  });
});

describe("allocation order", () => {
  const mk = (o: Partial<OrderableCollection>): OrderableCollection => ({
    collection_id: "COL-X",
    priority_hint: null,
    original_due_date: "2026-04-27",
    amount_total: 1000,
    ...o,
  });

  it("smaller amounts first — more collections fit the same balance", () => {
    const sorted = [
      mk({ collection_id: "A", amount_total: 9000 }),
      mk({ collection_id: "B", amount_total: 1000 }),
    ].sort(allocationOrder);
    expect(sorted.map((s) => s.collection_id)).toEqual(["B", "A"]);
  });

  it("claim age outranks amount, so a ladder does not push the oldest debt back", () => {
    // The regression this prevents: a rung that already failed carries a late
    // fee, so it is larger, so pure amount ordering demotes it exactly when it
    // most needs to succeed.
    const older = mk({ collection_id: "OLD", original_due_date: "2026-03-27", amount_total: 9950 });
    const newer = mk({ collection_id: "NEW", original_due_date: "2026-04-27", amount_total: 1000 });
    expect([newer, older].sort(allocationOrder).map((s) => s.collection_id)).toEqual([
      "OLD",
      "NEW",
    ]);
  });

  it("the customer's own priority outranks everything", () => {
    const rent = mk({ collection_id: "RENT", priority_hint: 1, amount_total: 80000 });
    const sub = mk({ collection_id: "SUB", priority_hint: null, amount_total: 500 });
    expect([sub, rent].sort(allocationOrder).map((s) => s.collection_id)).toEqual(["RENT", "SUB"]);
  });

  it("ties break deterministically, never by insertion order", () => {
    const a = mk({ collection_id: "COL-a" });
    const b = mk({ collection_id: "COL-b" });
    expect([b, a].sort(allocationOrder).map((s) => s.collection_id)).toEqual(["COL-a", "COL-b"]);
  });
});

describe("amendment asymmetry", () => {
  it("after the freeze, reductions pass and increases do not", async () => {
    insertCollection("COL-1", 1, "2026-04-27", { amend_freeze_at: "2026-04-26T06:00:00.000Z" });

    const up = await amendNotice(db, "COL-1", { amount: 12000, now: "2026-04-26T12:00:00.000Z" });
    expect(up).toMatchObject({ result: "ERROR", reason_code: "FROZEN_UNFAVOURABLE_CHANGE" });

    const down = await amendNotice(db, "COL-1", { amount: 5000, now: "2026-04-26T12:00:00.000Z" });
    expect(down).toMatchObject({ result: "AMENDED", amount: 5000 });
  });

  it("withdrawal stays open after the freeze — it only ever helps the customer", async () => {
    insertCollection("COL-1", 1, "2026-04-27", { amend_freeze_at: "2026-04-26T06:00:00.000Z" });
    const out = await withdrawNotice(
      db,
      "COL-1",
      "PAID_BY_OTHER_CHANNEL",
      "2026-04-26T12:00:00.000Z"
    );
    expect(out.result).toBe("WITHDRAWN");
  });

  it("an amendment is appended, not just overwritten", async () => {
    insertCollection("COL-1", 1, "2026-04-27", { amend_freeze_at: "2026-04-26T06:00:00.000Z" });
    await amendNotice(db, "COL-1", { amount: 5000, now: "2026-04-20T00:00:00.000Z" });
    const logged = sqlite
      .prepare(`SELECT payload_json FROM FinalityLog WHERE event_type = 'CollectionAmended'`)
      .all() as Array<{ payload_json: string }>;
    // What the customer was told last month must survive the change.
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!.payload_json).from.amount).toBe(9800);
  });
});

describe("additional authorisation", () => {
  it("silence is refusal, and it ends the ladder", async () => {
    insertCollection("COL-1", 1, "2026-04-27", {
      state: "AWAITING_ADDITIONAL_AUTH",
      confirm_deadline_at: "2026-04-28T00:00:00.000Z",
    });
    insertCollection("COL-2", 2, "2026-04-28");

    const swept = await sweepUnansweredAuth(db, "2026-04-28T00:00:01.000Z");
    expect(swept.lapsed).toBe(1);
    // Charging a late fee for a collection the customer declined to authorise
    // is exactly the abuse this gate exists to prevent.
    expect(swept.rungs_lapsed).toBe(1);

    const rows = sqlite
      .prepare(
        `SELECT collection_id, state, reason_code FROM ScheduledCollection ORDER BY ladder_seq`
      )
      .all() as Array<{ state: string; reason_code: string | null }>;
    expect(rows[0]!.state).toBe("LAPSED");
    expect(rows[0]!.reason_code).toBe("ADDITIONAL_AUTH_UNANSWERED");
    expect(rows[1]!.state).toBe("LAPSED");
  });
});

describe("mode resolution", () => {
  it("a batch-window core cannot be the payer side of a realtime collection", () => {
    const batch = {
      bank_id: "002",
      role: "FULL" as const,
      reservation_mode: "NONE" as const,
      settlement_mode: "PREFUNDED_SHADOW" as const,
      notify_mode: "PULL" as const,
      sync_reserve: false,
      realtime_name_check: false,
      batch_ingest: true,
      window_open_hour: 8,
      window_close_hour: 21,
    };
    expect(supportedModes(batch)).not.toContain("REALTIME");
    const r = resolveMode("REALTIME", batch);
    // Demotion is reported: a payee that believed it had synchronous settlement
    // would otherwise clear receivables on a provisional answer.
    expect(r).toMatchObject({ mode: "SCHEDULED", demoted: true });
  });

  it("a payee-only bank cannot be the paying side at all", () => {
    const payeeOnly = {
      bank_id: "003",
      role: "PAYEE_ONLY" as const,
      reservation_mode: "NONE" as const,
      settlement_mode: "PREFUNDED_SHADOW" as const,
      notify_mode: "PULL" as const,
      sync_reserve: false,
      realtime_name_check: false,
      batch_ingest: true,
      window_open_hour: null,
      window_close_hour: null,
    };
    expect(supportedModes(payeeOnly)).toEqual([]);
  });
});

describe("cap change direction", () => {
  it("moving a cap to NULL is a raise, however the numbers compare", () => {
    // Getting this backwards would let a payee remove a ceiling with no
    // customer signature.
    expect(classifyCapChange(10000, null)).toBe("raise");
    expect(classifyCapChange(null, 10000)).toBe("lower");
    expect(classifyCapChange(10000, 20000)).toBe("raise");
    expect(classifyCapChange(10000, 5000)).toBe("lower");
    expect(classifyCapChange(10000, undefined)).toBe("same");
  });
});
