/**
 * @file Cumulative-budget reservation for continuous collection.
 *
 * What these tests are actually protecting:
 *
 *  1. The check and the consumption are one statement. The interesting failure
 *     is not "a cap rejects an over-limit request" — that is easy — but two
 *     concurrent requests that each pass a separate SELECT and then both
 *     INSERT. `concurrent overlapping reservations` drives that interleaving.
 *  2. Reset-type and consuming-type breaches report different reason codes.
 *     Telling a customer to wait for a window that will never reopen is a
 *     different (worse) failure than throttling them.
 *  3. Window rollover happens inside the reserving statement, so a month
 *     boundary cannot be crossed by a reservation that raced a reset job.
 *  4. Caps are read from DebitMandate at reservation time, so changing a cap
 *     mid-contract takes effect without touching the counter row — and does
 *     NOT launder already-consumed budget.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../helpers/d1-mock";
import {
  initBudget,
  reserveBudget,
  releaseBudget,
  isExhausted,
} from "../../src/zc/collection/budget";

const DDM = "DDM-TEST-1";

// biome-ignore lint/suspicious/noExplicitAny: D1 mock
let db: any;
// biome-ignore lint/suspicious/noExplicitAny: better-sqlite3 handle for setup/assertions
let sqlite: any;

function insertContract(overrides: Record<string, unknown> = {}) {
  const caps = {
    per_collection_cap: null,
    month_amount_cap: null,
    month_count_cap: null,
    two_month_amount_cap: null,
    day_count_cap: null,
    lifetime_amount_cap: null,
    lifetime_count_cap: null,
    pending_amount_cap: null,
    pending_count_cap: null,
    latefee_month_cap: null,
    latefee_rate_max: null,
    realtime_month_count_cap: null,
    variance_ratio_max: null,
    ...overrides,
  };
  sqlite
    .prepare(
      `INSERT INTO Mandate (mandate_id, principal_participant_id, grantee_ref, parent_mandate_id,
         max_amount, allowed_purposes, allowed_lanes, valid_from, valid_to, principal_key_id,
         signature, nonce, occurred_at, revoked_at, created_at)
       VALUES ('MANDATE-DD-1','CUST','PAYEE',NULL,NULL,NULL,NULL,'2000-01-01T00:00:00.000Z',
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
       VALUES (?, 'MANDATE-DD-1', '002', 'tel:+81-90', '001', 'h:payee', 'PRODUCT-1',
               'PERIODIC', 'MONTHLY', 'SCHEDULED', 14, 33, 3, 'NEXT_BUSINESS',
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'ACTIVE', NULL,
               '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', 0)`
    )
    .run(
      DDM,
      caps.per_collection_cap,
      caps.month_amount_cap,
      caps.month_count_cap,
      caps.two_month_amount_cap,
      caps.day_count_cap,
      caps.lifetime_amount_cap,
      caps.lifetime_count_cap,
      caps.pending_amount_cap,
      caps.pending_count_cap,
      caps.latefee_month_cap,
      caps.latefee_rate_max,
      caps.realtime_month_count_cap,
      caps.variance_ratio_max
    );
}

function budgetRow() {
  return sqlite.prepare(`SELECT * FROM MandateBudget WHERE dd_mandate_id = ?`).get(DDM);
}

beforeEach(() => {
  const t = createTestDb();
  db = t.d1;
  sqlite = t.sqlite;
});

describe("collection budget: single-row CAS", () => {
  it("reserves within caps and consumes every applicable counter", async () => {
    insertContract({ month_amount_cap: 30000, month_count_cap: 3, lifetime_count_cap: 12 });
    await initBudget(db, DDM, "2026-04-10T00:00:00.000Z");

    const r = await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 9800,
      latefee: 0,
      mode: "SCHEDULED",
      at: "2026-04-10T00:00:00.000Z",
    });

    expect(r.ok).toBe(true);
    const b = budgetRow();
    expect(b.month_amount).toBe(9800);
    expect(b.month_count).toBe(1);
    expect(b.lifetime_count).toBe(1);
    expect(b.pending_amount).toBe(9800);
    expect(b.pending_count).toBe(1);
  });

  it("rejects when a reset-type cap would be breached, and names it", async () => {
    insertContract({ month_amount_cap: 10000 });
    await initBudget(db, DDM, "2026-04-10T00:00:00.000Z");

    const first = await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 9800,
      mode: "SCHEDULED",
      at: "2026-04-10T00:00:00.000Z",
    });
    expect(first.ok).toBe(true);

    const second = await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 9800,
      mode: "SCHEDULED",
      at: "2026-04-11T00:00:00.000Z",
    });
    expect(second.ok).toBe(false);
    expect(second.reason_code).toBe("BUDGET_RATE_EXCEEDED");
    expect(second.breached).toBe("month_amount_cap");

    // The rejected attempt consumed nothing.
    expect(budgetRow().month_amount).toBe(9800);
    expect(budgetRow().month_count).toBe(1);
  });

  it("distinguishes exhaustion from throttling", async () => {
    // A 2-instalment contract: the SECOND rejection is the contract ending,
    // not a rate limit. Reporting RATE here would tell the customer to wait
    // for a window that never reopens.
    insertContract({ lifetime_count_cap: 2 });
    await initBudget(db, DDM, "2026-04-10T00:00:00.000Z");

    for (const at of ["2026-04-10T00:00:00.000Z", "2026-05-10T00:00:00.000Z"]) {
      const ok = await reserveBudget(db, { ddMandateId: DDM, amount: 1000, mode: "SCHEDULED", at });
      expect(ok.ok).toBe(true);
    }
    expect(await isExhausted(db, DDM)).toBe(true);

    const third = await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 1000,
      mode: "SCHEDULED",
      at: "2026-06-10T00:00:00.000Z",
    });
    expect(third.ok).toBe(false);
    expect(third.reason_code).toBe("BUDGET_EXHAUSTED");
    expect(third.breached).toBe("lifetime_count_cap");
  });

  it("rolls the monthly window over inside the reserving statement", async () => {
    insertContract({ month_amount_cap: 10000 });
    await initBudget(db, DDM, "2026-04-10T00:00:00.000Z");

    await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 9800,
      mode: "SCHEDULED",
      at: "2026-04-30T00:00:00.000Z",
    });
    // New calendar month: the monthly counter resets as part of the same UPDATE,
    // with no separate reset job to race.
    const may = await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 9800,
      mode: "SCHEDULED",
      at: "2026-05-01T00:00:00.000Z",
    });

    expect(may.ok).toBe(true);
    const b = budgetRow();
    expect(b.month_key).toBe("2026-05");
    expect(b.month_amount).toBe(9800);
    expect(b.prev_month_key).toBe("2026-04");
    expect(b.prev_month_amount).toBe(9800);
    // Lifetime is a consuming budget: it does not roll over.
    expect(b.lifetime_amount).toBe(19600);
  });

  it("two_month_amount_cap closes the month-boundary hole", async () => {
    // Without a two-month ceiling, a 10,000/month contract yields 20,000 across
    // 30 April and 1 May.
    insertContract({ month_amount_cap: 10000, two_month_amount_cap: 15000 });
    await initBudget(db, DDM, "2026-04-10T00:00:00.000Z");

    await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 9800,
      mode: "SCHEDULED",
      at: "2026-04-30T00:00:00.000Z",
    });
    const may = await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 9800,
      mode: "SCHEDULED",
      at: "2026-05-01T00:00:00.000Z",
    });

    expect(may.ok).toBe(false);
    expect(may.breached).toBe("two_month_amount_cap");
  });

  it("budgets late fees separately so they cannot hide inside principal", async () => {
    insertContract({ latefee_month_cap: 100 });
    await initBudget(db, DDM, "2026-04-10T00:00:00.000Z");

    const ok = await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 9800,
      latefee: 50,
      mode: "SCHEDULED",
      at: "2026-04-27T00:00:00.000Z",
    });
    expect(ok.ok).toBe(true);

    const tooMuchFee = await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 100,
      latefee: 60,
      mode: "SCHEDULED",
      at: "2026-04-28T00:00:00.000Z",
    });
    expect(tooMuchFee.ok).toBe(false);
    expect(tooMuchFee.breached).toBe("latefee_month_cap");
  });

  it("realtime_month_count_cap constrains only REALTIME collections", async () => {
    // The risk gradient expressed as a budget: the highest-risk mode gets the
    // narrowest allowance.
    insertContract({ realtime_month_count_cap: 1 });
    await initBudget(db, DDM, "2026-04-10T00:00:00.000Z");

    for (let i = 0; i < 3; i++) {
      const r = await reserveBudget(db, {
        ddMandateId: DDM,
        amount: 100,
        mode: "SCHEDULED",
        at: "2026-04-10T00:00:00.000Z",
      });
      expect(r.ok).toBe(true);
    }
    const rt1 = await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 100,
      mode: "REALTIME",
      at: "2026-04-10T00:00:00.000Z",
    });
    expect(rt1.ok).toBe(true);

    const rt2 = await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 100,
      mode: "REALTIME",
      at: "2026-04-10T00:00:00.000Z",
    });
    expect(rt2.ok).toBe(false);
    expect(rt2.breached).toBe("realtime_month_count_cap");
  });
});

describe("collection budget: concurrency", () => {
  it("concurrent overlapping reservations cannot both pass one remaining slot", async () => {
    // The bug this guards: SELECT SUM(...) → decide → INSERT. Both callers read
    // "1 slot free" and both write. Here the check and the consumption are the
    // same statement, so exactly one wins.
    insertContract({ month_count_cap: 1 });
    await initBudget(db, DDM, "2026-04-10T00:00:00.000Z");

    const [a, b] = await Promise.all([
      reserveBudget(db, {
        ddMandateId: DDM,
        amount: 1000,
        mode: "SCHEDULED",
        at: "2026-04-10T00:00:00.000Z",
      }),
      reserveBudget(db, {
        ddMandateId: DDM,
        amount: 1000,
        mode: "SCHEDULED",
        at: "2026-04-10T00:00:00.000Z",
      }),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(budgetRow().month_count).toBe(1);
  });

  it("many concurrent reservations never exceed the amount ceiling", async () => {
    insertContract({ month_amount_cap: 5000 });
    await initBudget(db, DDM, "2026-04-10T00:00:00.000Z");

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        reserveBudget(db, {
          ddMandateId: DDM,
          amount: 1000,
          mode: "SCHEDULED",
          at: "2026-04-10T00:00:00.000Z",
        })
      )
    );

    const granted = results.filter((r) => r.ok).length;
    expect(granted).toBe(5);
    expect(budgetRow().month_amount).toBe(5000);
  });
});

describe("collection budget: release", () => {
  it("a failed collection restores reset-type budgets — nothing was collected", async () => {
    insertContract({ month_amount_cap: 10000, lifetime_count_cap: 12 });
    await initBudget(db, DDM, "2026-04-10T00:00:00.000Z");
    await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 9800,
      mode: "SCHEDULED",
      at: "2026-04-27T00:00:00.000Z",
    });

    await releaseBudget(db, DDM, 9800, 0, "FAILED", "2026-04-28T00:00:00.000Z");

    const b = budgetRow();
    expect(b.month_amount).toBe(0);
    expect(b.month_count).toBe(0);
    expect(b.lifetime_count).toBe(0);
    expect(b.pending_amount).toBe(0);
    expect(b.pending_count).toBe(0);
  });

  it("a settled collection clears only the pending hold — the consumption is real", async () => {
    insertContract({ lifetime_count_cap: 12 });
    await initBudget(db, DDM, "2026-04-10T00:00:00.000Z");
    await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 9800,
      mode: "SCHEDULED",
      at: "2026-04-27T00:00:00.000Z",
    });

    await releaseBudget(db, DDM, 9800, 0, "SETTLED", "2026-04-27T09:00:00.000Z");

    const b = budgetRow();
    expect(b.pending_amount).toBe(0);
    expect(b.pending_count).toBe(0);
    // The instalment was used up. This is what makes "12 instalments" a
    // completion condition rather than a rate limit.
    expect(b.lifetime_count).toBe(1);
    expect(b.month_amount).toBe(9800);
    expect(b.last_amount).toBe(9800);
  });
});

describe("collection budget: caps change mid-contract", () => {
  it("a raised cap takes effect without touching the counter row", async () => {
    insertContract({ month_amount_cap: 10000 });
    await initBudget(db, DDM, "2026-04-10T00:00:00.000Z");
    await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 9800,
      mode: "SCHEDULED",
      at: "2026-04-10T00:00:00.000Z",
    });

    const blocked = await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 5000,
      mode: "SCHEDULED",
      at: "2026-04-11T00:00:00.000Z",
    });
    expect(blocked.ok).toBe(false);

    sqlite
      .prepare(`UPDATE DebitMandate SET month_amount_cap = 20000 WHERE dd_mandate_id = ?`)
      .run(DDM);

    const allowed = await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 5000,
      mode: "SCHEDULED",
      at: "2026-04-11T00:00:00.000Z",
    });
    expect(allowed.ok).toBe(true);
  });

  it("raising then lowering a cap does not launder already-consumed budget", async () => {
    // Otherwise a payee could raise the ceiling, collect, and lower it back to
    // present a clean-looking contract.
    insertContract({ month_amount_cap: 10000 });
    await initBudget(db, DDM, "2026-04-10T00:00:00.000Z");
    sqlite
      .prepare(`UPDATE DebitMandate SET month_amount_cap = 30000 WHERE dd_mandate_id = ?`)
      .run(DDM);
    await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 25000,
      mode: "SCHEDULED",
      at: "2026-04-10T00:00:00.000Z",
    });
    sqlite
      .prepare(`UPDATE DebitMandate SET month_amount_cap = 10000 WHERE dd_mandate_id = ?`)
      .run(DDM);

    // Consumption stands at 25,000 against a 10,000 ceiling: nothing more fits.
    expect(budgetRow().month_amount).toBe(25000);
    const more = await reserveBudget(db, {
      ddMandateId: DDM,
      amount: 1,
      mode: "SCHEDULED",
      at: "2026-04-11T00:00:00.000Z",
    });
    expect(more.ok).toBe(false);
    expect(more.breached).toBe("month_amount_cap");
  });
});
