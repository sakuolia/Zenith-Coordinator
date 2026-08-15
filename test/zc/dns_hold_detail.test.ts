/**
 * @file dns_hold_detail.test.ts — the closed-domain hold detail and the
 *       official-disclosure id.
 *
 * `GET /api/dns/:business_date/hold_detail` is the query a defaulting bank needs
 * most, on the worst day it will ever have. Two things about it are
 * institutional rather than technical, and both are pinned here:
 *
 *   - **every refusal is 404.** A 403 would confirm to an outsider that a hold
 *     exists; "is bank X short today?" is the question that starts a run. Four
 *     different refusals must be indistinguishable from the outside.
 *   - **no purpose code, no data** — blocked in real time and raised as
 *     `DataAccessViolationDetected`, not filed for a later review
 *     (docs/specs/10_requirements.md §3.3.2.2.1.1-2).
 *
 * Also covers `public_message_id`: the join key between ZC's official status and
 * the wording a participant may show customers. Without it, "customer messaging
 * must match the official disclosure" is unverifiable after the fact.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { handleGetDnsHoldDetail, handleGetDnsStatus } from "../../src/zc/query/query";
import { dnsHoldMessageId } from "../../src/zc/settlement/dns";
import type { Env } from "../../src/types";

let d1: MockD1Database;

const BUSINESS_DATE = "2026-06-30";
const CYCLE_ID = "DNS-JPY-20260630-01";
const CRON_SECRET = "cron-secret-under-test";

beforeEach(() => {
  ({ d1 } = createTestDb());
});

function makeEnv(): Env {
  return {
    DB: d1 as unknown as D1Database,
    CRON_SECRET,
  } as unknown as Env;
}

/** A held cycle whose shortfall breakdown names 002 as the sole defaulter. */
function seedHeldCycle() {
  d1.prepare(
    `INSERT INTO DnsCycles
     (cycle_id, business_date, state, igs_mode, hold_reason, hold_causing_participants,
      currency, intraday_seq, public_message_id, created_at)
     VALUES (?, ?, 'HOLD_ACTIVE', 'RINGFENCED', ?, ?, 'JPY', 1, ?, '2026-06-30T07:00:00Z')`
  )
    .bind(
      CYCLE_ID,
      BUSINESS_DATE,
      JSON.stringify({
        reason: "BOJ_INSUFFICIENT_FUNDS",
        shortfalls: [
          { bank_id: "002", shortfall: 1_200_000_000 },
          { bank_id: "003", shortfall: 300_000_000 },
        ],
      }),
      JSON.stringify(["002", "003"]),
      dnsHoldMessageId(BUSINESS_DATE)
    )
    ._runSync();
}

function request(headers: Record<string, string>): Request {
  return new Request(`https://zc.test/api/dns/${BUSINESS_DATE}/hold_detail`, { headers });
}

const call = (headers: Record<string, string>) =>
  handleGetDnsHoldDetail(request(headers), BUSINESS_DATE, makeEnv());

async function violations(): Promise<number> {
  const row = await (d1 as unknown as D1Database)
    .prepare(`SELECT COUNT(*) AS n FROM FinalityLog WHERE event_type='DataAccessViolationDetected'`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("GET /api/dns/:business_date/hold_detail — closed-domain authorization", () => {
  it("serves the defaulting participant its own shortfall only", async () => {
    seedHeldCycle();
    const res = await call({ "X-Purpose-Code": "P01", "X-Bank-Id": "002" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      business_date: BUSINESS_DATE,
      cycle_id: CYCLE_ID,
      shortfall_amount: 1_200_000_000, // 002's own, not the 1.5bn cycle total
      collateral_call_amount: 1_320_000_000, // +10% buffer, same rate as the recovery reserve
      contact_channel: "ZC-OPS-CRISIS-DESK",
    });
    expect(body.recommended_actions).toEqual([
      "MARKET_FUNDING",
      "LENDING_REQUEST",
      "COLLATERAL_PLEDGE",
    ]);
  });

  it("serves the operator the cycle-wide total", async () => {
    seedHeldCycle();
    const res = await call({ "X-Purpose-Code": "P05", "X-Cron-Secret": CRON_SECRET });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      shortfall_amount: 1_500_000_000,
    });
  });

  it("returns an indistinguishable 404 for every refusal", async () => {
    seedHeldCycle();
    const refusals = await Promise.all([
      call({ "X-Bank-Id": "002" }), // no purpose code
      call({ "X-Purpose-Code": "P01" }), // unidentified caller
      call({ "X-Purpose-Code": "P01", "X-Bank-Id": "004" }), // not a defaulter
      call({ "X-Purpose-Code": "P99", "X-Bank-Id": "002" }), // unknown purpose code
    ]);
    const bodies = await Promise.all(refusals.map((r) => r.text()));
    for (const r of refusals) expect(r.status).toBe(404);
    // The bodies must be byte-identical apart from the per-request trace id:
    // a difference here is an oracle for "does a hold exist / am I a defaulter".
    const scrub = (b: string) => b.replace(/"request_id":"[^"]*"/, '"request_id":"*"');
    expect(new Set(bodies.map(scrub)).size).toBe(1);
  });

  it("404s when there is no hold at all — same shape as an unauthorized refusal", async () => {
    const res = await call({ "X-Purpose-Code": "P01", "X-Bank-Id": "002" });
    expect(res.status).toBe(404);
  });

  it("discloses nothing when the hold has no shortfall breakdown (manual holdDns)", async () => {
    // A manual hold writes free text, not the settleDns payload. Guessing a
    // per-bank figure would be worse than disclosing nothing.
    d1.prepare(
      `INSERT INTO DnsCycles
       (cycle_id, business_date, state, igs_mode, hold_reason, currency, intraday_seq, created_at)
       VALUES (?, ?, 'HOLD_ACTIVE', 'STOP', 'operator declared', 'JPY', 1, 't')`
    )
      .bind(CYCLE_ID, BUSINESS_DATE)
      ._runSync();
    const res = await call({ "X-Purpose-Code": "P06", "X-Cron-Secret": CRON_SECRET });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Access audit
// ---------------------------------------------------------------------------

describe("hold_detail — access audit", () => {
  it("blocks a purpose-less read in real time and raises DataAccessViolationDetected", async () => {
    seedHeldCycle();
    expect(await violations()).toBe(0);
    await call({ "X-Bank-Id": "002" });
    expect(await violations()).toBe(1);

    const row = await (d1 as unknown as D1Database)
      .prepare(
        `SELECT payload_json, state_to FROM FinalityLog
         WHERE event_type='DataAccessViolationDetected' LIMIT 1`
      )
      .first<{ payload_json: string; state_to: string }>();
    expect(row?.state_to).toBe("BLOCKED");
    expect(JSON.parse(row!.payload_json)).toMatchObject({
      resource: `dns/${BUSINESS_DATE}/hold_detail`,
      subject: "002",
      reason: "PURPOSE_CODE_MISSING",
    });
  });

  it("audits a permitted read too — who saw the defaulter's shortfall, and why", async () => {
    seedHeldCycle();
    await call({ "X-Purpose-Code": "P02", "X-Bank-Id": "002" });
    const row = await (d1 as unknown as D1Database)
      .prepare(
        `SELECT payload_json FROM FinalityLog WHERE event_type='ClosedDomainAccessGranted' LIMIT 1`
      )
      .first<{ payload_json: string }>();
    expect(JSON.parse(row!.payload_json)).toMatchObject({
      subject: "002",
      purpose_code: "P02",
      scope: "PARTICIPANT",
    });
  });

  it("does not treat a legitimate non-defaulter as a violation", async () => {
    seedHeldCycle();
    await call({ "X-Purpose-Code": "P01", "X-Bank-Id": "004" });
    // 004 asked properly; it simply has no data. Logging that as a violation
    // would bury the real ones.
    expect(await violations()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// public_message_id
// ---------------------------------------------------------------------------

describe("public_message_id — the official-disclosure join key", () => {
  it("is published on the cycle status while held, and only while held", async () => {
    seedHeldCycle();
    const held = (await (await handleGetDnsStatus(BUSINESS_DATE, makeEnv())).json()) as Record<
      string,
      unknown
    >;
    expect(held).toMatchObject({
      state: "HOLD_ACTIVE",
      public_message_id: `DNS_HOLD_${BUSINESS_DATE}`,
    });

    await (d1 as unknown as D1Database)
      .prepare(`UPDATE DnsCycles SET state='SETTLED', public_message_id=NULL WHERE cycle_id=?`)
      .bind(CYCLE_ID)
      .run();
    const settled = (await (await handleGetDnsStatus(BUSINESS_DATE, makeEnv())).json()) as Record<
      string,
      unknown
    >;
    expect(settled).toMatchObject({ state: "SETTLED", public_message_id: null });
  });

  it("carries the cycle-level status but never the cause or the amount", async () => {
    seedHeldCycle();
    const body = await (await handleGetDnsStatus(BUSINESS_DATE, makeEnv())).text();
    // The all-participants status must match the official announcement exactly:
    // no shortfall figures, no naming of the defaulting bank.
    expect(body).not.toContain("1200000000");
    expect(body).not.toContain("hold_causing_participants");
    expect(body).not.toContain("BOJ_INSUFFICIENT_FUNDS");
  });
});
