/**
 * @file operator_quorum.test.ts — pure n-of-m quorum & equivocation policy.
 */
import { describe, it, expect } from "vitest";
import {
  distinctOperatorCount,
  meetsQuorum,
  detectEquivocation,
} from "../../src/shared/operator_quorum";

describe("operator_quorum — distinctOperatorCount", () => {
  it("counts distinct owner_ref, not rows", () => {
    expect(
      distinctOperatorCount([
        { owner_ref: "op-1" },
        { owner_ref: "op-1" }, // same operator, second key/vote
        { owner_ref: "op-2" },
      ])
    ).toBe(2);
    expect(distinctOperatorCount([])).toBe(0);
  });
});

describe("operator_quorum — meetsQuorum", () => {
  it("requires distinct >= required", () => {
    expect(meetsQuorum(2, 2)).toBe(true);
    expect(meetsQuorum(3, 2)).toBe(true);
    expect(meetsQuorum(1, 2)).toBe(false);
  });

  it("clamps required to a minimum of 1 (0 never means 'no observers needed')", () => {
    expect(meetsQuorum(0, 0)).toBe(false);
    expect(meetsQuorum(1, 0)).toBe(true);
    expect(meetsQuorum(0, -5)).toBe(false);
  });
});

describe("operator_quorum — detectEquivocation", () => {
  it("no conflict when all operators assert the same claim", () => {
    const r = detectEquivocation([
      { owner_ref: "op-1", claim: "PASS" },
      { owner_ref: "op-2", claim: "PASS" },
    ]);
    expect(r.conflict).toBe(false);
    expect(r.distinctClaims).toEqual(["PASS"]);
  });

  it("conflict when distinct operators disagree (PASS vs FAIL)", () => {
    const r = detectEquivocation([
      { owner_ref: "op-1", claim: "PASS" },
      { owner_ref: "op-2", claim: "FAIL" },
    ]);
    expect(r.conflict).toBe(true);
    expect(r.distinctClaims).toEqual(["FAIL", "PASS"]);
    expect(r.operatorsByClaim).toEqual({ PASS: ["op-1"], FAIL: ["op-2"] });
  });

  it("conflict when one operator asserts contradictory claims", () => {
    const r = detectEquivocation([
      { owner_ref: "op-1", claim: "PASS" },
      { owner_ref: "op-1", claim: "FAIL" },
    ]);
    expect(r.conflict).toBe(true);
  });

  it("empty set is not a conflict", () => {
    expect(detectEquivocation([]).conflict).toBe(false);
  });
});
