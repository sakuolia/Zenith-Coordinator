/**
 * @file Unit tests for src/shared/errors.ts
 */
import { describe, it, expect } from "vitest";
import {
  DomainError,
  isDomainError,
  errorResponse,
  categoryOf,
  httpStatusOf,
  isRetryable,
  REASON_CODE_CATEGORY,
} from "../../src/shared/errors";

describe("condition-expression codes are classified, not silently INTERNAL", () => {
  // lanes/htlc/create.ts throws DomainError('CONDITION_EXPR_INVALID') for a
  // malformed condition_expr_json. While it was unregistered, categoryOf() fell
  // through to INTERNAL, so a client's bad input surfaced as 500 (and the queue
  // treated it as a non-retryable bug) instead of the documented 400 VALIDATION.
  it("CONDITION_EXPR_INVALID is a 400 VALIDATION, not a 500", () => {
    expect(categoryOf("CONDITION_EXPR_INVALID")).toBe("VALIDATION");
    expect(httpStatusOf(categoryOf("CONDITION_EXPR_INVALID"))).toBe(400);
    expect(isRetryable(categoryOf("CONDITION_EXPR_INVALID"))).toBe(false);
  });

  it("the rest of the condition/quorum family is registered too", () => {
    expect(categoryOf("CONDITION_EXPR_NOT_SET")).toBe("VALIDATION");
    expect(categoryOf("CONDITIONS_NOT_MET")).toBe("VALIDATION");
    expect(categoryOf("ONCHAIN_QUORUM_PENDING")).toBe("VALIDATION");
    // Equivocation is a genuine conflict between statements, symmetric with
    // WATCHER_EQUIVOCATION; both are fail-closed and converge to a CASE.
    expect(categoryOf("ATTESTATION_EQUIVOCATION")).toBe("CONFLICT");
    expect(categoryOf("WATCHER_EQUIVOCATION")).toBe("CONFLICT");
  });
});

describe("categoryOf", () => {
  it("returns the registered category for a known code", () => {
    expect(categoryOf("H_LIMIT_EXCEEDED")).toBe("CONFLICT");
    expect(categoryOf("BANK_TIMEOUT")).toBe("TIMEOUT");
    expect(categoryOf("TX_NOT_FOUND")).toBe("NOT_FOUND");
    expect(categoryOf("UNAUTHORIZED")).toBe("AUTH");
  });

  it("falls back to INTERNAL for an unknown code", () => {
    expect(categoryOf("TOTALLY_MADE_UP_CODE")).toBe("INTERNAL");
  });
});

describe("httpStatusOf", () => {
  it("maps every category to a unique status", () => {
    expect(httpStatusOf("VALIDATION")).toBe(400);
    expect(httpStatusOf("AUTH")).toBe(401);
    expect(httpStatusOf("NOT_FOUND")).toBe(404);
    expect(httpStatusOf("CONFLICT")).toBe(409);
    expect(httpStatusOf("RATE_LIMIT")).toBe(429);
    expect(httpStatusOf("DOWNSTREAM")).toBe(502);
    expect(httpStatusOf("INVARIANT")).toBe(500);
    expect(httpStatusOf("INTERNAL")).toBe(500);
    expect(httpStatusOf("TIMEOUT")).toBe(504);
  });
});

describe("isRetryable", () => {
  it("marks DOWNSTREAM/TIMEOUT/RATE_LIMIT retryable and the rest not", () => {
    expect(isRetryable("DOWNSTREAM")).toBe(true);
    expect(isRetryable("TIMEOUT")).toBe(true);
    expect(isRetryable("RATE_LIMIT")).toBe(true);
    expect(isRetryable("VALIDATION")).toBe(false);
    expect(isRetryable("CONFLICT")).toBe(false);
    expect(isRetryable("INVARIANT")).toBe(false);
  });
});

describe("DomainError", () => {
  it("derives category from reason_code", () => {
    const e = new DomainError("H_LIMIT_EXCEEDED", "over limit", { bank: "001" });
    expect(e.category).toBe("CONFLICT");
    expect(e.reason_code).toBe("H_LIMIT_EXCEEDED");
    expect(e.details).toEqual({ bank: "001" });
    expect(e.message).toBe("over limit");
  });

  it("honors an explicit category override", () => {
    const e = new DomainError("CUSTOM_CODE", "forced timeout", {}, { category: "TIMEOUT" });
    expect(e.category).toBe("TIMEOUT");
  });

  it("serializes to JSON with the expected shape", () => {
    const e = new DomainError("NAME_MISMATCH", "name does not match", { txid: "TX-1" });
    expect(e.toJSON()).toEqual({
      error: "name does not match",
      reason_code: "NAME_MISMATCH",
      category: "CONFLICT",
      details: { txid: "TX-1" },
    });
  });
});

describe("isDomainError", () => {
  it("narrows DomainError", () => {
    expect(isDomainError(new DomainError("X", "y"))).toBe(true);
  });

  it("rejects plain Errors and other values", () => {
    expect(isDomainError(new Error("plain"))).toBe(false);
    expect(isDomainError("string")).toBe(false);
    expect(isDomainError(undefined)).toBe(false);
    expect(isDomainError({ reason_code: "X" })).toBe(false);
  });
});

describe("errorResponse", () => {
  it("returns the mapped HTTP status for a DomainError", async () => {
    const r = errorResponse(new DomainError("TX_NOT_FOUND", "not here"));
    expect(r.status).toBe(404);
    const body = (await r.json()) as { reason_code: string; category: string; error: string };
    expect(body.reason_code).toBe("TX_NOT_FOUND");
    expect(body.category).toBe("NOT_FOUND");
    expect(body.error).toBe("not here");
  });

  it("includes the request_id when supplied", async () => {
    const r = errorResponse(new DomainError("UNAUTHORIZED", "no key"), "req-abc");
    const body = (await r.json()) as { request_id: string };
    expect(body.request_id).toBe("req-abc");
  });

  it("renders unknown errors as INTERNAL 500", async () => {
    const r = errorResponse(new Error("boom"));
    expect(r.status).toBe(500);
    const body = (await r.json()) as { reason_code: string; category: string };
    expect(body.reason_code).toBe("INTERNAL_ERROR");
    expect(body.category).toBe("INTERNAL");
  });

  it("renders non-Error throws", async () => {
    const r = errorResponse("string boom");
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("string boom");
  });
});

describe("REASON_CODE_CATEGORY catalog", () => {
  it("has no duplicate keys (sanity check)", () => {
    const keys = Object.keys(REASON_CODE_CATEGORY);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every value is a valid ErrorCategory", () => {
    const valid = new Set([
      "VALIDATION",
      "AUTH",
      "NOT_FOUND",
      "CONFLICT",
      "INVARIANT",
      "DOWNSTREAM",
      "TIMEOUT",
      "RATE_LIMIT",
      "INTERNAL",
    ]);
    for (const v of Object.values(REASON_CODE_CATEGORY)) {
      expect(valid.has(v)).toBe(true);
    }
  });
});
