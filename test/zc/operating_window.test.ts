/**
 * @file Tests for the participant operating-window primitive
 * (Theme E: 24/365 稼働).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { isWithinOperatingWindow, isBankOpenNow } from "../../src/zc/platform/operating_window";

/**
 * A UTC `Date` whose JST wall-clock is `hh:mm`. Operating windows are JST (the
 * system timezone), so tests express the intended local time via this helper
 * (e.g. 09:00 JST == 00:00Z). Only the time-of-day matters to the window check.
 */
function jst(hh: number, mm = 0): Date {
  return new Date(Date.UTC(2025, 5, 1, hh - 9, mm));
}

// ---------------------------------------------------------------------------
// isWithinOperatingWindow (pure)
// ---------------------------------------------------------------------------

describe("isWithinOperatingWindow", () => {
  it("returns true when start and end are both null (always open)", () => {
    expect(
      isWithinOperatingWindow({ operating_window_start: null, operating_window_end: null }, jst(12))
    ).toBe(true);
  });

  it("returns true when start === end (treated as 24h window)", () => {
    expect(
      isWithinOperatingWindow(
        { operating_window_start: "09:00", operating_window_end: "09:00" },
        jst(12)
      )
    ).toBe(true);
  });

  it("same-day window: returns true within [start, end) — JST", () => {
    const window = { operating_window_start: "09:00", operating_window_end: "17:00" };
    expect(isWithinOperatingWindow(window, jst(9, 0))).toBe(true);
    expect(isWithinOperatingWindow(window, jst(12, 0))).toBe(true);
    expect(isWithinOperatingWindow(window, jst(16, 59))).toBe(true);
  });

  it("same-day window: returns false outside [start, end) — JST", () => {
    const window = { operating_window_start: "09:00", operating_window_end: "17:00" };
    expect(isWithinOperatingWindow(window, jst(8, 59))).toBe(false);
    expect(isWithinOperatingWindow(window, jst(17, 0))).toBe(false);
    expect(isWithinOperatingWindow(window, jst(23, 0))).toBe(false);
  });

  it("overnight window (start > end): wraps past midnight — JST", () => {
    const window = { operating_window_start: "22:00", operating_window_end: "06:00" };
    expect(isWithinOperatingWindow(window, jst(23, 0))).toBe(true);
    expect(isWithinOperatingWindow(window, jst(1, 0))).toBe(true);
    expect(isWithinOperatingWindow(window, jst(5, 59))).toBe(true);
    expect(isWithinOperatingWindow(window, jst(6, 0))).toBe(false);
    expect(isWithinOperatingWindow(window, jst(12, 0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isBankOpenNow (D1-backed)
// ---------------------------------------------------------------------------

describe("isBankOpenNow", () => {
  let d1: MockD1Database;

  beforeEach(() => {
    const { d1: db } = createTestDb();
    d1 = db;
  });

  function seedParticipant(bankId: string, start: string | null, end: string | null) {
    d1.prepare(
      `INSERT OR REPLACE INTO Participants
       (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at,
        operating_window_start, operating_window_end)
       VALUES (?, 'Test Bank', '/bank/${bankId}', 1000000, 0, 1, '2025-01-01T00:00:00Z', ?, ?)`
    )
      .bind(bankId, start, end)
      ._runSync();
  }

  it("returns true when the bank has no row", async () => {
    expect(await isBankOpenNow("999", d1, jst(12))).toBe(true);
  });

  it("returns true when no window is configured (NULL/NULL)", async () => {
    seedParticipant("001", null, null);
    expect(await isBankOpenNow("001", d1, jst(12))).toBe(true);
  });

  it("returns true when now is within the configured window (JST)", async () => {
    seedParticipant("001", "09:00", "17:00");
    expect(await isBankOpenNow("001", d1, jst(12))).toBe(true);
  });

  it("returns false when now is outside the configured window (JST)", async () => {
    seedParticipant("001", "09:00", "17:00");
    expect(await isBankOpenNow("001", d1, jst(20))).toBe(false);
  });
});
