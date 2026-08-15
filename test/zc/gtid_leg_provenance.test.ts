/**
 * @file gtid_leg_provenance.test.ts — registration-time leg normalization keeps
 *       the participant's own leg_id reachable.
 *
 * `normalizeGtidLegs` rewrites leg_ids (a 1×M fan-out is squared up, a general
 * N×M is waterfall-decomposed — `20_method_design.md` §2.2.5.1), and each leg_id
 * also seeds that leg's `TX-GT-{leg_id}`. Without provenance, a participant that
 * registered `L1` cannot answer "which of my legs settled here" except by
 * parsing a string format — and a format is not a contract.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { normalizeGtidLegs } from "../../src/zc/lanes/gtid";
import { registerGtid } from "../../src/zc/lanes/gtid";
import type { GtidLegInput } from "../../src/types";

let d1: MockD1Database;
let env: any;

const leg = (
  leg_id: string,
  role: "PAYER" | "PAYEE",
  bank_id: string,
  value: number,
  currency = "JPY"
): GtidLegInput => ({
  leg_id,
  role,
  bank_id,
  account_hash: `h:${bank_id}`,
  amount: { value, currency },
});

beforeEach(() => {
  ({ d1 } = createTestDb());
  env = { DB: d1, QUEUE: { send: async () => {} } };
});

describe("normalizeGtidLegs records where each rewritten leg came from", () => {
  it("fan-out sub-legs carry the single payer's registered leg_id", () => {
    const out = normalizeGtidLegs([
      leg("L1", "PAYER", "001", 3000),
      leg("L2", "PAYEE", "002", 1000),
      leg("L3", "PAYEE", "003", 2000),
    ]);
    const payers = out.filter((l) => l.role === "PAYER");
    expect(payers).toHaveLength(2); // squared up against the two payees
    expect(payers.every((p) => p.origin_leg_id === "L1")).toBe(true);
    // The payee legs were not rewritten, so they carry no provenance.
    expect(out.filter((l) => l.role === "PAYEE").every((q) => q.origin_leg_id === undefined)).toBe(
      true
    );
  });

  it("a general N×M decomposition carries provenance on both sides", () => {
    const out = normalizeGtidLegs([
      leg("P1", "PAYER", "001", 300),
      leg("P2", "PAYER", "002", 700),
      leg("Q1", "PAYEE", "003", 600),
      leg("Q2", "PAYEE", "004", 400),
    ]);
    expect(out.length).toBeGreaterThan(4); // waterfall-matched into 1:1 pairs
    expect(out.every((l) => !!l.origin_leg_id)).toBe(true);
    const origins = new Set(out.map((l) => l.origin_leg_id));
    expect([...origins].sort()).toEqual(["P1", "P2", "Q1", "Q2"]);
    // Provenance preserves each registered leg's total, which is the property a
    // participant actually cares about.
    const sumFor = (id: string) =>
      out.filter((l) => l.origin_leg_id === id).reduce((s, l) => s + l.amount.value, 0);
    expect(sumFor("P1")).toBe(300);
    expect(sumFor("P2")).toBe(700);
    expect(sumFor("Q1")).toBe(600);
    expect(sumFor("Q2")).toBe(400);
  });

  it("leaves an untouched shape without provenance — null means 'as registered'", () => {
    const out = normalizeGtidLegs([leg("L1", "PAYER", "001", 500), leg("L2", "PAYEE", "002", 500)]);
    expect(out.map((l) => l.leg_id)).toEqual(["L1", "L2"]);
    expect(out.every((l) => l.origin_leg_id === undefined)).toBe(true);
  });
});

describe("registerGtid persists provenance so the read path can return it", () => {
  it("stores origin_leg_id for rewritten legs and NULL for untouched ones", async () => {
    await registerGtid(
      {
        gtid: "GT-PROV-1",
        legs: [
          leg("L1", "PAYER", "001", 3000),
          leg("L2", "PAYEE", "002", 1000),
          leg("L3", "PAYEE", "003", 2000),
        ],
        expires_at: "2099-01-01T00:00:00.000Z",
        idempotency_key: "idem-prov-1",
      } as any,
      env
    );

    const rows = await d1
      .prepare(`SELECT leg_id, role, origin_leg_id FROM GtidLegs WHERE gtid = ? ORDER BY leg_id`)
      .bind("GT-PROV-1")
      .all<{ leg_id: string; role: string; origin_leg_id: string | null }>();

    const payers = rows.results.filter((r) => r.role === "PAYER");
    expect(payers).toHaveLength(2);
    expect(payers.every((p) => p.origin_leg_id === "L1")).toBe(true);
    // A participant can now go from its own leg to the settled sub-legs.
    expect(payers.map((p) => p.leg_id).every((id) => id.startsWith("L1~"))).toBe(true);

    const payees = rows.results.filter((r) => r.role === "PAYEE");
    expect(payees.every((q) => q.origin_leg_id === null)).toBe(true);
  });
});
