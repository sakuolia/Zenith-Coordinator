/**
 * @file chaos_adversarial.test.ts — Regression net for the adversarial
 *       ("いじわる") API-contract probes run against the live system.
 *
 * Each probe was designed to be mean: it either follows the spec's own
 * documented example verbatim, drives two guards into conflict, or exploits a
 * code path that bypasses the cross-cutting contract. The live run surfaced a
 * batch of spec violations / self-contradictions; this file pins the *fixed*
 * behaviour so the bugs cannot silently return. Probe IDs (Txx) match the
 * report and the live HTTP harness.
 *
 *   T01/T07 — every error response carries the full envelope + X-Request-Id,
 *             regardless of which code path produced it (jsonError vs throw).
 *   T03     — operator bcp-activate must NOT overwrite/mask an automatic
 *             QUORUM_LOSS_READONLY degradation (design principle 10).
 *   T08     — 422 business-rule reason_codes carry a sane category.
 *   T12     — mandate_id format is validated on /api/htlc/create too.
 *   T15     — a non-FX-provider posting rates is 401 (AUTH), not 403.
 *   T16     — amount.value (and equivalents) are capped at MAX_AMOUNT_VALUE
 *             uniformly across every amount-accepting ingress, closing off
 *             unbounded-integer input that could overflow downstream FX/
 *             aggregation math.
 *   T18     — POST /api/qr/generate validates input → 400, never a 500 crash.
 *   T21     — POST /api/transfers/:txid/no-debit-proof keeps the spec's own
 *             check order (signature, then proof_ref) under combined-violation
 *             input, and never touches H on a rejected request.
 *   T22     — /internal/* (handleInternal) is fail-closed end-to-end for every
 *             CRON_SECRET combination, including the empty-string trap, and a
 *             correctly-authenticated request still falls through to a normal
 *             404 (the guard isn't accidentally swallowing routing).
 *   T23     — GET /api/circuit-breaker/:bank_id for a bank with no recorded
 *             metrics returns the documented synthetic CLOSED object (200),
 *             never 404.
 *   T24     — quorum is a strict majority (floor(N/2)+1), not a simple half,
 *             for even-sized replica membership.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  activateBcpReadOnly,
  deactivateBcpReadOnly,
  degradeToQuorumLossReadOnly,
  getSystemMode,
  assertWritable,
} from "../../src/zc/platform/system_mode";
import { generateQrCode } from "../../src/zc/directory/qr";
import {
  validateHtlcCreate,
  validatePaymentInitiated,
  validateGtidRegister,
  validateRtpRequest,
} from "../../src/shared/validator";
import { handlePutFxRate } from "../../src/zc/fx/api";
import { handleCashDeposit } from "../../src/bank/teller_api";
import { finalizeResponse, jsonError, json } from "../../src/zc/ingress";
import { DomainError, isDomainError } from "../../src/shared/errors";
import { MAX_AMOUNT_VALUE } from "../../src/shared/constants";
import { handleZcApi } from "../../src/router/zc";
import { handleInternal } from "../../src/router/internal";
import { signPayload } from "../../src/shared/hmac";
import { evaluateQuorum, reconcileQuorum } from "../../src/zc/platform/quorum";

let d1: MockD1Database;
beforeEach(() => {
  ({ d1 } = createTestDb());
});

function makeEnv(db: MockD1Database): any {
  return { DB: db, QR_SECRET: "test-qr-secret", ZC_HMAC_SECRET: "test-secret" };
}

// ===========================================================================
// T03 — quorum-loss masking. The mean sequence: an operator declares
// BCP_READONLY *while* the system has already auto-degraded to
// QUORUM_LOSS_READONLY, then clears BCP — which previously left the system
// NORMAL with quorum still genuinely lost. The guard must keep the quorum-loss
// posture intact.
// ===========================================================================
describe("T03: bcp-activate must not mask an active QUORUM_LOSS_READONLY", () => {
  it("refuses to activate BCP_READONLY while QUORUM_LOSS_READONLY is active", async () => {
    const env = makeEnv(d1);
    await degradeToQuorumLossReadOnly(env, "consensus quorum lost: 1/3 reachable");

    await expect(
      activateBcpReadOnly(env, "vendor outage during quorum loss")
    ).rejects.toMatchObject({ reason_code: "SYSTEM_QUORUM_LOSS_READ_ONLY" });

    // The automatic degradation survives the rejected operator action.
    expect((await getSystemMode(d1 as any)).mode).toBe("QUORUM_LOSS_READONLY");
  });

  it("the full attack (degrade → bcp-activate → bcp-deactivate) cannot reach NORMAL while quorum is lost", async () => {
    const env = makeEnv(d1);
    await degradeToQuorumLossReadOnly(env, "consensus quorum lost");

    // Step 1: bcp-activate is rejected (cannot overwrite the quorum-loss mode).
    await expect(activateBcpReadOnly(env, "simulated outage")).rejects.toBeInstanceOf(DomainError);
    expect((await getSystemMode(d1 as any)).mode).toBe("QUORUM_LOSS_READONLY");

    // Step 2: bcp-deactivate is still refused too (the original guard).
    await expect(deactivateBcpReadOnly(env)).rejects.toMatchObject({
      reason_code: "SYSTEM_QUORUM_LOSS_READ_ONLY",
    });

    // The system never returns to NORMAL, so money-moving writes stay blocked.
    const mode = await getSystemMode(d1 as any);
    expect(mode.mode).toBe("QUORUM_LOSS_READONLY");
    expect(() => assertWritable(mode)).toThrow(DomainError);
  });

  it("still allows BCP activation from NORMAL (no regression to the normal path)", async () => {
    const env = makeEnv(d1);
    const mode = await activateBcpReadOnly(env, "planned vendor maintenance");
    expect(mode.mode).toBe("BCP_READONLY");
    // And it can be cleared normally.
    expect((await deactivateBcpReadOnly(env)).mode).toBe("NORMAL");
  });
});

// ===========================================================================
// T18 — copying the spec's own request example crashed the server with a
// D1_TYPE_ERROR 500. Validation must reject malformed input with a 400-class
// VALIDATION DomainError before anything reaches the database.
// ===========================================================================
describe("T18: POST /api/qr/generate validates input instead of crashing", () => {
  it("rejects the legacy/spec-example shape (qr_type + amount object) without a 500", async () => {
    const env = makeEnv(d1);
    // The old documented example used `qr_type` (not `type`) and an amount
    // object — so `type` is undefined here, exactly the input that used to bind
    // undefined into a NOT NULL column and throw D1_TYPE_ERROR.
    const legacyExample: any = {
      qr_type: "STATIC",
      payee_bank_id: "001",
      payee_account_id: "0010000001",
      amount: { value: 1000, currency: "JPY" },
    };

    let threw: unknown;
    try {
      await generateQrCode(d1 as any, legacyExample, env);
    } catch (e) {
      threw = e;
    }
    expect(isDomainError(threw)).toBe(true);
    expect((threw as DomainError).category).toBe("VALIDATION"); // 400, not INTERNAL/500
    expect((threw as DomainError).reason_code).toBe("INVALID_REQUEST");

    // Nothing was written to the database.
    const n = await d1.prepare("SELECT COUNT(*) AS n FROM QrCodes").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("rejects missing payee fields and a non-positive amount", async () => {
    const env = makeEnv(d1);
    await expect(
      generateQrCode(d1 as any, { type: "STATIC", payee_account_id: "0010000001" } as any, env)
    ).rejects.toMatchObject({ reason_code: "MISSING_FIELD", category: "VALIDATION" });

    await expect(
      generateQrCode(
        d1 as any,
        {
          type: "DYNAMIC",
          payee_bank_id: "001",
          payee_account_id: "0010000001",
          amount: -5,
        } as any,
        env
      )
    ).rejects.toMatchObject({ reason_code: "INVALID_AMOUNT", category: "VALIDATION" });
  });

  it("still accepts a well-formed request (no regression)", async () => {
    const env = makeEnv(d1);
    const qr = await generateQrCode(
      d1 as any,
      {
        type: "DYNAMIC",
        payee_bank_id: "001",
        payee_account_id: "0010000001",
        payee_name: "田中商店",
        amount: 1000,
      } as any,
      env
    );
    expect(qr.qr_type).toBe("DYNAMIC");
    expect(qr.amount_value).toBe(1000);
  });
});

// ===========================================================================
// T12 — mandate_id format (MANDATE- prefix) is enforced on /api/transfers but
// was silently skipped on /api/htlc/create. Both ingresses must agree.
// ===========================================================================
describe("T12: mandate_id format is validated uniformly across ingresses", () => {
  const goodHtlc = {
    htlc_id: "HTLC-X",
    timelock: "2999-01-01T00:00:00Z",
    amount: { value: 1000, currency: "JPY" },
    payer_account_hash: "0010000001",
    payee_account_hash: "0020000001",
    payer_bank_id: "001",
    payee_bank_id: "002",
    idempotency_key: "IK-1",
  };

  it("validateHtlcCreate rejects a malformed mandate_id", () => {
    const r = validateHtlcCreate({ ...goodHtlc, mandate_id: "not-a-mandate" } as any);
    expect(r.ok).toBe(false);
    expect((r as any).reason_code).toBe("INVALID_MANDATE_ID");
  });

  it("validateHtlcCreate accepts a well-formed mandate_id and omitted mandate_id", () => {
    expect(validateHtlcCreate({ ...goodHtlc, mandate_id: "MANDATE-abc" } as any).ok).toBe(true);
    expect(validateHtlcCreate({ ...goodHtlc } as any).ok).toBe(true);
  });

  it("matches the /api/transfers ingress behaviour for the same bad value", () => {
    const transfer = {
      schema_version: "1.0" as const,
      txid: "TX-1",
      idempotency_key: "IK-1",
      lane: "EXPRESS" as const,
      amount: { value: 1000, currency: "JPY" },
      payer: { bank_id: "001", account_hash: "0010000001" },
      payee: { bank_id: "002" },
      purpose: "MERCHANT" as const,
      mandate_id: "not-a-mandate",
    };
    const r = validatePaymentInitiated(transfer as any);
    expect(r.ok).toBe(false);
    expect((r as any).reason_code).toBe("INVALID_MANDATE_ID");
  });
});

// ===========================================================================
// T15 — a non-FX-provider posting rates was rejected with 403, but UNAUTHORIZED
// is an AUTH-category reason_code, which the catalog maps to 401.
// ===========================================================================
describe("T15: non-FX-provider rate post is 401 UNAUTHORIZED (AUTH category)", () => {
  function seedParticipant(db: MockD1Database, bankId: string, isFxp: boolean) {
    db.prepare(
      `INSERT OR REPLACE INTO Participants
       (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, is_fx_provider, registered_at)
       VALUES (?, 'Test Bank', '/bank/${bankId}', 100000000, 0, 1, ?, '2025-01-01T00:00:00Z')`
    )
      .bind(bankId, isFxp ? 1 : 0)
      ._runSync();
  }

  it("returns 401 with reason_code UNAUTHORIZED", async () => {
    seedParticipant(d1, "001", false); // not an FX provider
    const env = makeEnv(d1);
    const res = await handlePutFxRate(
      new Request("https://zc.test/api/fx/rates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fxp_bank_id: "001",
          from_currency: "JPY",
          to_currency: "USD",
          rate: 670_000,
          valid_to: "2999-01-01T00:00:00.000Z",
        }),
      }),
      env
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.reason_code).toBe("UNAUTHORIZED");
    expect(body.category).toBe("AUTH");
  });
});

// ===========================================================================
// T01/T07 + T08 — the cross-cutting envelope contract. jsonError now carries
// category/details, and finalizeResponse stamps X-Request-Id + request_id on
// every response, so a validation error and a thrown DomainError are
// indistinguishable in shape.
// ===========================================================================
describe("T01/T07/T08: error envelope + X-Request-Id are enforced everywhere", () => {
  it("jsonError fills category (from the catalog) and details", async () => {
    const res = jsonError(400, "INVALID_CURRENCY", "amount.currency must be JPY");
    const body = (await res.json()) as any;
    expect(body).toMatchObject({
      error: "amount.currency must be JPY",
      reason_code: "INVALID_CURRENCY",
      category: "VALIDATION",
      details: {},
    });
  });

  it("jsonError infers a sane category for endpoint-local codes by status (incl. 422)", async () => {
    // OVER_REVERSAL is not catalog-registered; a 422 must still read as VALIDATION,
    // not INTERNAL — this is the T08 fix (422 is a real, documented status).
    const res = jsonError(422, "OVER_REVERSAL", "would exceed the original amount");
    expect(((await res.json()) as any).category).toBe("VALIDATION");
  });

  it("finalizeResponse stamps X-Request-Id and back-fills request_id into the body", async () => {
    const raw = jsonError(404, "NOT_FOUND", "Path /api/nope not found");
    const fin = await finalizeResponse(raw, "req-test-123");

    expect(fin.headers.get("X-Request-Id")).toBe("req-test-123");
    const body = (await fin.json()) as any;
    expect(body.request_id).toBe("req-test-123");
    expect(body.reason_code).toBe("NOT_FOUND");
    expect(body.category).toBe("NOT_FOUND");
    expect(body.details).toEqual({});
  });

  it("finalizeResponse normalizes a bare {error,reason_code} body (the old jsonError shape)", async () => {
    // Simulate a legacy/bare error body to prove the central normalizer fills
    // the full envelope even when the producer did not.
    const bare = json(409, { error: "state guard", reason_code: "STATE_GUARD" });
    const fin = await finalizeResponse(bare, "req-xyz");
    const body = (await fin.json()) as any;
    expect(body).toMatchObject({
      error: "state guard",
      reason_code: "STATE_GUARD",
      category: "CONFLICT",
      details: {},
      request_id: "req-xyz",
    });
    expect(fin.headers.get("X-Request-Id")).toBe("req-xyz");
  });

  it("finalizeResponse leaves success responses untouched (only stamps the header)", async () => {
    const ok = json(200, { result: "DECISION_ACCEPTED", txid: "TX-1" });
    const fin = await finalizeResponse(ok, "req-ok");
    expect(fin.status).toBe(200);
    expect(fin.headers.get("X-Request-Id")).toBe("req-ok");
    const body = (await fin.json()) as any;
    expect(body).toEqual({ result: "DECISION_ACCEPTED", txid: "TX-1" }); // no envelope fields injected
  });
});

// ===========================================================================
// T16 — every amount-accepting ingress rejected negative/non-integer amounts,
// but none capped the upper bound: a 1e15-or-larger amount.value sailed
// through unrejected and could overflow downstream FX-rate / aggregation
// math (which approaches Number.MAX_SAFE_INTEGER, ~9e15, well before that).
// MAX_AMOUNT_VALUE (1 trillion) is now enforced uniformly at every ingress
// that already performs INVALID_AMOUNT-style validation.
// ===========================================================================
describe("T16: amount.value is capped at MAX_AMOUNT_VALUE everywhere", () => {
  const overCap = MAX_AMOUNT_VALUE + 1;

  it("validatePaymentInitiated rejects an amount above the cap, accepts the boundary", () => {
    const base = {
      schema_version: "1.0" as const,
      txid: "TX-1",
      idempotency_key: "IK-1",
      lane: "EXPRESS" as const,
      payer: { bank_id: "001", account_hash: "0010000001" },
      payee: { bank_id: "002" },
      purpose: "MERCHANT" as const,
    };
    const over = validatePaymentInitiated({
      ...base,
      amount: { value: overCap, currency: "JPY" },
    } as any);
    expect(over.ok).toBe(false);
    expect((over as any).reason_code).toBe("INVALID_AMOUNT");

    const atCap = validatePaymentInitiated({
      ...base,
      amount: { value: MAX_AMOUNT_VALUE, currency: "JPY" },
    } as any);
    expect(atCap.ok).toBe(true);
  });

  it("validateHtlcCreate rejects an amount above the cap", () => {
    const r = validateHtlcCreate({
      htlc_id: "HTLC-X",
      timelock: "2999-01-01T00:00:00Z",
      amount: { value: overCap, currency: "JPY" },
      payer_account_hash: "0010000001",
      payee_account_hash: "0020000001",
      payer_bank_id: "001",
      payee_bank_id: "002",
      idempotency_key: "IK-1",
    } as any);
    expect(r.ok).toBe(false);
    expect((r as any).reason_code).toBe("INVALID_AMOUNT");
  });

  it("validateGtidRegister rejects a leg amount above the cap", () => {
    const r = validateGtidRegister({
      gtid: "GT-1",
      idempotency_key: "IK-1",
      legs: [
        {
          leg_id: "L1",
          role: "PAYER",
          bank_id: "001",
          account_hash: "h:a",
          amount: { value: overCap, currency: "JPY" },
        },
        {
          leg_id: "L2",
          role: "PAYEE",
          bank_id: "002",
          account_hash: "h:b",
          amount: { value: 1000, currency: "JPY" },
        },
      ],
    } as any);
    expect(r.ok).toBe(false);
    expect((r as any).reason_code).toBe("INVALID_LEG_AMOUNT");
  });

  it("validateRtpRequest rejects an amount above the cap", () => {
    const r = validateRtpRequest({
      rtp_id: "RTP-1",
      payee_bank_id: "001",
      payer_bank_id: "002",
      amount: { value: overCap, currency: "JPY" },
      expires_at: "2999-01-01T00:00:00Z",
      idempotency_key: "IK-1",
    } as any);
    expect(r.ok).toBe(false);
    expect((r as any).reason_code).toBe("INVALID_AMOUNT");
  });

  it("generateQrCode rejects an amount above the cap", async () => {
    const env = makeEnv(d1);
    await expect(
      generateQrCode(
        d1 as any,
        {
          type: "DYNAMIC",
          payee_bank_id: "001",
          payee_account_id: "0010000001",
          amount: overCap,
        } as any,
        env
      )
    ).rejects.toMatchObject({ reason_code: "INVALID_AMOUNT", category: "VALIDATION" });
  });

  it("bank teller cash/deposit rejects an amount above the cap (uniform across ZC and Bank)", async () => {
    const res = await handleCashDeposit(
      new Request("https://bank.test/bank/001/v1/teller/cash/deposit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bank-Id": "001",
          "X-Teller-Id": "T-1",
        },
        body: JSON.stringify({ account_id: "0010000001", amount: overCap }),
      }),
      "001",
      { DB: d1 } as any
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.reason_code).toBe("INVALID_AMOUNT");
  });
});

// ===========================================================================
// T21 — combined-violation precedence on the no-debit-proof ingress. The spec
// (32_api_contracts.md ~line 459, mirrored from the bank-ingress HTTP wrapper)
// mandates signature verification before the proof_ref presence check, so an
// unauthenticated caller never learns which fields are missing. These probes
// drive both guards into conflict at once, then confirm H is never touched on
// any rejected request.
// ===========================================================================
describe("T21: no-debit-proof keeps signature-before-fields under combined violations", () => {
  const BANK = "001";
  const AMOUNT = 5000;

  function seedStuckTx(db: MockD1Database, txid: string, state = "FAILED_EXECUTION") {
    db.prepare(
      `INSERT OR REPLACE INTO Participants
       (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
       VALUES (?, 'Test Bank', '/bank/${BANK}', 1000000, ?, 1, '2025-01-01T00:00:00Z')`
    )
      .bind(BANK, AMOUNT)
      ._runSync();

    const reservationId = `H-${txid}`;
    db.prepare(
      `INSERT INTO HReservations
       (reservation_id, txid, bank_id, amount, mode, is_released, created_at)
       VALUES (?, ?, ?, ?, 'LOCKED', 0, '2025-06-01T09:00:00Z')`
    )
      .bind(reservationId, txid, BANK, AMOUNT)
      ._runSync();

    db.prepare(
      `INSERT INTO Transactions
       (txid, lane, state, amount_value, amount_currency,
        payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
        idempotency_key, schema_version, h_reservation_id,
        created_at, updated_at, version)
       VALUES (?, 'EXPRESS', ?, ?, 'JPY', ?, 'payerAcc', '002', 'payeeAcc',
               ?, '1.0', ?, '2025-06-01T09:00:00Z', '2025-06-01T09:00:00Z', 0)`
    )
      .bind(txid, state, AMOUNT, BANK, `IK-${txid}`, reservationId)
      ._runSync();
    return reservationId;
  }

  async function hUsed(db: MockD1Database): Promise<number> {
    const row = await db
      .prepare(`SELECT h_used FROM Participants WHERE bank_id = ?`)
      .bind(BANK)
      .first<{ h_used: number }>();
    return row?.h_used ?? -1;
  }

  async function isReleased(db: MockD1Database, reservationId: string): Promise<number> {
    const row = await db
      .prepare(`SELECT is_released FROM HReservations WHERE reservation_id = ?`)
      .bind(reservationId)
      .first<{ is_released: number }>();
    return row?.is_released ?? -1;
  }

  function makeZcEnv(db: MockD1Database): any {
    return { DB: db, ZC_HMAC_SECRET: "test-secret" };
  }

  it("missing signature AND missing proof_ref → 401 MISSING_SIGNATURE, not 400 PROOF_REF_REQUIRED", async () => {
    const resId = seedStuckTx(d1, "TX-T21-1");
    const res = await handleZcApi(
      new Request("https://zc.test/api/transfers/TX-T21-1/no-debit-proof", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}), // no proof_ref, no bank_id
      }),
      "/api/transfers/TX-T21-1/no-debit-proof",
      "POST",
      makeZcEnv(d1)
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).reason_code).toBe("MISSING_SIGNATURE");
    expect(await isReleased(d1, resId)).toBe(0);
    expect(await hUsed(d1)).toBe(AMOUNT);
  });

  it("a garbage-but-present signature AND missing proof_ref → 401 INVALID_SIGNATURE; the field gap is still not revealed", async () => {
    const resId = seedStuckTx(d1, "TX-T21-2");
    const res = await handleZcApi(
      new Request("https://zc.test/api/transfers/TX-T21-2/no-debit-proof", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ZC-Signature": "deadbeef00".repeat(6) },
        body: JSON.stringify({}),
      }),
      "/api/transfers/TX-T21-2/no-debit-proof",
      "POST",
      makeZcEnv(d1)
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).reason_code).toBe("INVALID_SIGNATURE");
    expect(await isReleased(d1, resId)).toBe(0);
    expect(await hUsed(d1)).toBe(AMOUNT);
  });

  it("a VALID signature over an empty body still fails on PROOF_REF_REQUIRED — the field gate is reachable once auth passes", async () => {
    const resId = seedStuckTx(d1, "TX-T21-3");
    const body = {}; // deliberately no proof_ref
    const sig = await signPayload(body, "test-secret");
    const res = await handleZcApi(
      new Request("https://zc.test/api/transfers/TX-T21-3/no-debit-proof", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ZC-Signature": sig },
        body: JSON.stringify(body),
      }),
      "/api/transfers/TX-T21-3/no-debit-proof",
      "POST",
      makeZcEnv(d1)
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).reason_code).toBe("PROOF_REF_REQUIRED");
    // Auth passed but the business gate still blocked the release.
    expect(await isReleased(d1, resId)).toBe(0);
    expect(await hUsed(d1)).toBe(AMOUNT);
  });

  it("a valid signature AND a valid proof_ref releases H (positive control — no regression)", async () => {
    const resId = seedStuckTx(d1, "TX-T21-4");
    const body = { proof_ref: "PROOF-T21-4", bank_id: BANK };
    const sig = await signPayload(body, "test-secret");
    const res = await handleZcApi(
      new Request("https://zc.test/api/transfers/TX-T21-4/no-debit-proof", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ZC-Signature": sig },
        body: JSON.stringify(body),
      }),
      "/api/transfers/TX-T21-4/no-debit-proof",
      "POST",
      makeZcEnv(d1)
    );
    expect(res.status).toBe(200);
    expect(await isReleased(d1, resId)).toBe(1);
    expect(await hUsed(d1)).toBe(0);
  });
});

// ===========================================================================
// T22 — the /internal/* CRON_SECRET guard (handleInternal) must be fail-closed
// for every combination of header/env state, per 32_api_contracts.md ~lines
// 1320-1339: "ヘッダ欠落・環境側未設定はいずれも fail-closed（403）で拒否し、
// 空文字どうしの一致を通過扱いにしてはならない。" The empty-string trap and the
// same-length-wrong-value case are the meanest variants; a positive control
// confirms the guard isn't accidentally swallowing a correctly-authenticated
// request that simply doesn't match any route.
// ===========================================================================
describe("T22: /internal/* CRON_SECRET guard is fail-closed for every combination", () => {
  function makeInternalEnv(cronSecret?: string): any {
    return { DB: d1, CRON_SECRET: cronSecret };
  }

  async function hitInternal(
    headerValue: string | undefined,
    env: any,
    path = "/internal/does-not-exist"
  ) {
    const headers: Record<string, string> = {};
    if (headerValue !== undefined) headers["X-Cron-Secret"] = headerValue;
    return handleInternal(
      new Request(`https://zc.test${path}`, { method: "POST", headers }),
      path,
      "POST",
      env
    );
  }

  it("missing header, secret configured → 403", async () => {
    const res = await hitInternal(undefined, makeInternalEnv("real-secret"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).reason_code).toBe("FORBIDDEN");
  });

  it("the empty-string trap: header='' AND env.CRON_SECRET='' must still be 403, never an accidental pass", async () => {
    const res = await hitInternal("", makeInternalEnv(""));
    expect(res.status).toBe(403);
  });

  it("header set correctly but env.CRON_SECRET is unset (undefined) → 403, never trusts a missing server-side secret", async () => {
    const res = await hitInternal("real-secret", makeInternalEnv(undefined));
    expect(res.status).toBe(403);
  });

  it("a wrong header value against a configured secret → 403", async () => {
    const res = await hitInternal("wrong-secret", makeInternalEnv("real-secret"));
    expect(res.status).toBe(403);
  });

  it("a same-length-but-different header is still rejected", async () => {
    const res = await hitInternal("real-secrex", makeInternalEnv("real-secret")); // last char differs only
    expect(res.status).toBe(403);
  });

  it("positive control: a correctly-authenticated request still falls through to ordinary 404 routing (the guard isn't masking valid-but-unmatched requests as 403)", async () => {
    const res = await hitInternal(
      "real-secret",
      makeInternalEnv("real-secret"),
      "/internal/does-not-exist"
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).reason_code).toBe("NOT_FOUND");
  });
});

// ===========================================================================
// T23 — GET /api/circuit-breaker/:bank_id for a bank with zero recorded
// metrics must return the documented synthetic CLOSED object (200), per
// 32_api_contracts.md ~line 932-933: "未登録（メトリクスがまだ無い）行は
// `state: CLOSED` の初期値が返る（404 ではない）。" The probe checks the exact
// shape against the spec's own documented example (line ~923-926), not just
// the status code.
// ===========================================================================
describe("T23: GET /api/circuit-breaker/:bank_id returns the documented synthetic CLOSED default, never 404", () => {
  it("an unregistered bank with zero recorded metrics returns 200 + the default object verbatim", async () => {
    const env = makeEnv(d1);
    const res = await handleZcApi(
      new Request("https://zc.test/api/circuit-breaker/999", {
        // Party-scoped read (S-5/S-7): a participant reads its own breaker state.
        headers: { "X-Bank-Id": "999", "X-Purpose-Code": "P01" },
      }),
      "/api/circuit-breaker/999",
      "GET",
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({
      bank_id: "999",
      state: "CLOSED",
      consecutive_failures: 0,
      total_requests: 0,
      total_successes: 0,
      total_failures: 0,
      total_denied: 0,
      half_open_inflight: 0,
      last_success_at: null,
    });
  });
});

// ===========================================================================
// T24 — quorum.ts implements the spec's literal formula (32_api_contracts.md
// ~line 822: "quorum は厳密過半数（floor(N/2)+1）") rather than a bare half.
// For even N this matters: exactly half reachable must NOT be quorum. The
// live reconcileQuorum() boundary is exercised too (not just the pure
// evaluateQuorum() math), since that's what actually gates write traffic.
// ===========================================================================
describe("T24: quorum is a strict majority (floor(N/2)+1), not bare half, for even N", () => {
  it("N=4: 2 reachable is NOT quorum even though it's exactly half", () => {
    const health = evaluateQuorum(["r1", "r2", "r3", "r4"], ["r1", "r2"]);
    expect(health.required).toBe(3);
    expect(health.hasQuorum).toBe(false);
  });

  it("N=4: 3 reachable IS quorum", () => {
    const health = evaluateQuorum(["r1", "r2", "r3", "r4"], ["r1", "r2", "r3"]);
    expect(health.required).toBe(3);
    expect(health.hasQuorum).toBe(true);
  });

  it("reconcileQuorum degrades the live system at exactly 2/4 and restores at 3/4 — the boundary the spec's formula draws — without flapping on a re-affirm", async () => {
    const env: any = { DB: d1, ZC_QUORUM_REPLICAS: "r1,r2,r3,r4" };
    const lost = await reconcileQuorum(env, ["r1", "r2"]);
    expect(lost.action).toBe("DEGRADED");
    expect((await getSystemMode(d1 as any)).mode).toBe("QUORUM_LOSS_READONLY");

    const stillLost = await reconcileQuorum(env, ["r1", "r2"]); // re-affirm, no flapping
    expect(stillLost.action).toBe("NO_CHANGE");

    const restored = await reconcileQuorum(env, ["r1", "r2", "r3"]);
    expect(restored.action).toBe("RESTORED");
    expect((await getSystemMode(d1 as any)).mode).toBe("NORMAL");
  });

  it("N=2 is a degenerate case: required=2, so losing a single replica out of two always reads as quorum loss (zero fault tolerance) — a deployment-guidance trap, not a code bug, but worth flagging since a 2-replica deployment cannot tolerate any node loss under this formula", () => {
    const health = evaluateQuorum(["r1", "r2"], ["r1"]);
    expect(health.required).toBe(2);
    expect(health.hasQuorum).toBe(false); // 1 of 2 is not a strict majority
  });
});
