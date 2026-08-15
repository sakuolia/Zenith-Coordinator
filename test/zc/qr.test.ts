/**
 * @file qr.test.ts — QR-initiated payment single-use enforcement.
 *
 * Regression net for a double-spend window in `processQrPayment`: a DYNAMIC QR
 * is single-use, but consumption used to be a bare `UPDATE QrCodes SET
 * is_used = 1 WHERE qr_ref = ?` with no `is_used = 0` predicate and no
 * `changes()` check. Because the `is_used` *read* (guard) and the *write*
 * (consume) are two separate statements, two concurrent payments for the same
 * QR both pass the read guard (TOCTOU) and both used to commit — the same QR
 * paid more than once.
 *
 * The fix makes consumption a CAS (`... WHERE qr_ref = ? AND is_used = 0`) and
 * rejects the loser when `changes() == 0`. These tests pin both the end-to-end
 * single-use behaviour and the TOCTOU race that the bare UPDATE allowed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { generateQrCode, processQrPayment } from "../../src/zc/directory/qr";

const QR_SECRET = "test-qr-secret";
const ENV = { QR_SECRET };
const PAYEE_BANK = "002";

async function makeDynamicQr(d1: MockD1Database, amount = 5000): Promise<string> {
  const qr = await generateQrCode(
    d1 as never,
    {
      type: "DYNAMIC",
      payee_bank_id: PAYEE_BANK,
      payee_account_id: "0020000001",
      payee_name: "ﾔﾏﾀﾞ ﾐｻｷ",
      amount,
    },
    ENV
  );
  return qr.qr_ref;
}

function payReq(qrRef: string) {
  return {
    qr_ref: qrRef,
    payer_bank_id: "001",
    payer_account_id: "0010000001",
    idempotency_key: `IK-${qrRef}-${Math.random()}`,
  };
}

describe("processQrPayment — DYNAMIC QR is single-use", () => {
  let d1: MockD1Database;
  beforeEach(() => {
    d1 = createTestDb().d1;
  });

  it("accepts the first payment and rejects a second (sequential)", async () => {
    const qrRef = await makeDynamicQr(d1);

    const first = await processQrPayment(d1 as never, payReq(qrRef), ENV);
    expect(first.valid).toBe(true);
    expect(first.effectiveAmount).toBe(5000);

    const second = await processQrPayment(d1 as never, payReq(qrRef), ENV);
    expect(second.valid).toBe(false);
    expect(second.error).toBe("QR_ALREADY_USED");
  });

  it("rejects the loser of a TOCTOU race (read sees is_used=0, a racer consumes before our write)", async () => {
    const qrRef = await makeDynamicQr(d1);

    // Model the race: a wrapper that, on the QR row SELECT, returns the real
    // (is_used = 0) row but then immediately marks the QR used in the backing
    // store — exactly as a concurrent payment that won the CAS would. Our call
    // therefore reaches its consume UPDATE with is_used already = 1.
    let consumed = false;
    const racing = {
      prepare(sql: string) {
        const stmt = d1.prepare(sql);
        if (sql.includes("SELECT * FROM QrCodes")) {
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return {
                first: async <T>() => {
                  const row = await bound.first<T>();
                  if (row && !consumed) {
                    consumed = true;
                    // The concurrent winner consumes the QR.
                    await d1
                      .prepare("UPDATE QrCodes SET is_used = 1 WHERE qr_ref = ? AND is_used = 0")
                      .bind(qrRef)
                      .run();
                  }
                  return row; // stale is_used = 0 snapshot, as a real reader would see
                },
                run: () => bound.run(),
                all: () => bound.all(),
              };
            },
          };
        }
        return stmt;
      },
    };

    const res = await processQrPayment(racing as never, payReq(qrRef), ENV);
    // The bare UPDATE (no `AND is_used = 0`) would have re-set is_used=1,
    // reported changes()=1, and returned valid:true — a double-spend. The CAS
    // makes our consume a no-op (changes()=0) and rejects it.
    expect(res.valid).toBe(false);
    expect(res.error).toBe("QR_ALREADY_USED");

    // And the QR really is consumed exactly once.
    const row = await d1
      .prepare("SELECT is_used FROM QrCodes WHERE qr_ref = ?")
      .bind(qrRef)
      .first<{ is_used: number }>();
    expect(row?.is_used).toBe(1);
  });

  it("consume UPDATE is a CAS: a second identical consume affects zero rows", async () => {
    const qrRef = await makeDynamicQr(d1);
    const sql = "UPDATE QrCodes SET is_used = 1 WHERE qr_ref = ? AND is_used = 0";

    const r1 = await d1.prepare(sql).bind(qrRef).run();
    const r2 = await d1.prepare(sql).bind(qrRef).run();

    expect(r1.meta.changes).toBe(1); // winner
    expect(r2.meta.changes).toBe(0); // loser — the predicate that makes single-use safe
  });
});
