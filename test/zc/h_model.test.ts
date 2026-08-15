/**
 * @file Integration tests for src/zc/liquidity/h_model.ts
 *
 * Verifies that H-limit reserve / lock / release correctly maintain the
 * h_used counter on the Participants table.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { reserveH, lockH, releaseH, getHStatus } from "../../src/zc/liquidity/h_model";

const BANK_ID = "001";
const H_LIMIT = 1_000_000;

let d1: MockD1Database;

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  // Participants テーブルに行を挿入（統合スキーマの初期シードは銀行 001/002 のみなので、テスト固有の行は手動）
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/001', ?, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(BANK_ID, H_LIMIT)
    ._runSync();
});

describe("reserveH", () => {
  it("creates a reservation and increments h_used", async () => {
    const hResult = await reserveH(BANK_ID, "TX-001", 100_000, d1 as any);
    expect(hResult.ok).toBe(true);
    if (hResult.ok) expect(hResult.reservation_id.startsWith("H-")).toBe(true);

    const status = await getHStatus(BANK_ID, d1 as any);
    expect(status?.h_used).toBe(100_000);
  });

  it("returns ok=false with reason H_LIMIT_EXCEEDED when h_limit would be exceeded", async () => {
    const hResult = await reserveH(BANK_ID, "TX-001", H_LIMIT + 1, d1 as any);
    expect(hResult.ok).toBe(false);
    if (!hResult.ok) expect(hResult.reason).toBe("H_LIMIT_EXCEEDED");

    const status = await getHStatus(BANK_ID, d1 as any);
    expect(status?.h_used).toBe(0);
  });

  it("returns ok=false with reason BANK_NOT_FOUND for unknown bank", async () => {
    const hResult = await reserveH("999", "TX-001", 1_000, d1 as any);
    expect(hResult.ok).toBe(false);
    if (!hResult.ok) expect(hResult.reason).toBe("BANK_NOT_FOUND");
  });

  it("allows multiple reservations up to h_limit", async () => {
    const r1 = await reserveH(BANK_ID, "TX-001", 400_000, d1 as any);
    const r2 = await reserveH(BANK_ID, "TX-002", 600_000, d1 as any);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const status = await getHStatus(BANK_ID, d1 as any);
    expect(status?.h_used).toBe(1_000_000);
  });

  it("rejects the next reservation when h_limit is exactly met", async () => {
    await reserveH(BANK_ID, "TX-001", 1_000_000, d1 as any);
    const r2 = await reserveH(BANK_ID, "TX-002", 1, d1 as any);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("H_LIMIT_EXCEEDED");
  });

  // B1: the h_used increment and the HReservations INSERT are now one atomic
  // batch. The invariant that protects against a leak is: h_used always equals
  // the sum of active (un-released) reservations — a successful reserve creates
  // exactly one row, and a rejected reserve creates none and moves h_used not at
  // all. There is never an increment without a matching, releasable row.
  it("keeps h_used reconciled with active reservations (no orphaned increment)", async () => {
    const ok1 = await reserveH(BANK_ID, "TX-A", 300_000, d1 as any);
    const ok2 = await reserveH(BANK_ID, "TX-B", 250_000, d1 as any);
    const rejected = await reserveH(BANK_ID, "TX-C", H_LIMIT, d1 as any); // would exceed
    expect(ok1.ok && ok2.ok).toBe(true);
    expect(rejected.ok).toBe(false);

    const status = await getHStatus(BANK_ID, d1 as any);
    const activeSum = await d1
      .prepare(
        `SELECT COALESCE(SUM(amount),0) AS s FROM HReservations WHERE bank_id=? AND is_released=0`
      )
      .bind(BANK_ID)
      .first<{ s: number }>();
    const rowCount = await d1
      .prepare(`SELECT COUNT(*) AS n FROM HReservations WHERE bank_id=?`)
      .bind(BANK_ID)
      .first<{ n: number }>();

    // h_used == Σ active reservations, and the rejected reserve left no row.
    expect(status?.h_used).toBe(550_000);
    expect(activeSum?.s).toBe(550_000);
    expect(rowCount?.n).toBe(2); // only the two successful reserves created rows
  });
});

describe("lockH", () => {
  it("promotes a RESERVED reservation to LOCKED", async () => {
    const hResult = await reserveH(BANK_ID, "TX-001", 50_000, d1 as any);
    expect(hResult.ok).toBe(true);
    const rid = hResult.ok ? hResult.reservation_id : "";
    const locked = await lockH(rid, d1 as any);
    expect(locked).toBe(true);

    const row = await d1
      .prepare(`SELECT mode FROM HReservations WHERE reservation_id=?`)
      .bind(rid)
      .first<{ mode: string }>();
    expect(row?.mode).toBe("LOCKED");
  });

  it("returns false for an already-released reservation", async () => {
    const hResult = await reserveH(BANK_ID, "TX-001", 50_000, d1 as any);
    expect(hResult.ok).toBe(true);
    const rid = hResult.ok ? hResult.reservation_id : "";
    await releaseH(rid, d1 as any);
    const locked = await lockH(rid, d1 as any);
    expect(locked).toBe(false);
  });

  it("returns false for a non-existent reservation id", async () => {
    const locked = await lockH("H-does-not-exist", d1 as any);
    expect(locked).toBe(false);
  });
});

describe("releaseH", () => {
  it("marks the reservation released and decrements h_used", async () => {
    const hResult = await reserveH(BANK_ID, "TX-001", 200_000, d1 as any);
    expect(hResult.ok).toBe(true);
    const rid = hResult.ok ? hResult.reservation_id : "";
    const released = await releaseH(rid, d1 as any);
    expect(released).toBe(true);

    const status = await getHStatus(BANK_ID, d1 as any);
    expect(status?.h_used).toBe(0);
  });

  it("prevents double-release (idempotency guard)", async () => {
    const hResult = await reserveH(BANK_ID, "TX-001", 200_000, d1 as any);
    expect(hResult.ok).toBe(true);
    const rid = hResult.ok ? hResult.reservation_id : "";
    await releaseH(rid, d1 as any);
    const second = await releaseH(rid, d1 as any);
    expect(second).toBe(false);

    // h_used should still be 0 (not negative)
    const status = await getHStatus(BANK_ID, d1 as any);
    expect(status?.h_used).toBe(0);
  });

  it("restores capacity so new reservations can succeed", async () => {
    const hRes1 = await reserveH(BANK_ID, "TX-001", H_LIMIT, d1 as any);
    expect(hRes1.ok).toBe(true);
    const rid = hRes1.ok ? hRes1.reservation_id : "";
    // At this point h_used == h_limit; another reservation fails
    expect((await reserveH(BANK_ID, "TX-002", 1, d1 as any)).ok).toBe(false);

    await releaseH(rid, d1 as any);

    // After release the full limit is available again
    const r2 = await reserveH(BANK_ID, "TX-002", H_LIMIT, d1 as any);
    expect(r2.ok).toBe(true);
  });

  it("never allows h_used to go below zero", async () => {
    const hResult = await reserveH(BANK_ID, "TX-001", 100_000, d1 as any);
    expect(hResult.ok).toBe(true);
    const rid = hResult.ok ? hResult.reservation_id : "";
    await releaseH(rid, d1 as any);

    // Force a second release by directly resetting is_released
    d1.prepare(`UPDATE HReservations SET is_released=0 WHERE reservation_id=?`)
      .bind(rid)
      ._runSync();
    await releaseH(rid, d1 as any);

    const status = await getHStatus(BANK_ID, d1 as any);
    expect(status?.h_used).toBeGreaterThanOrEqual(0);
  });
});
