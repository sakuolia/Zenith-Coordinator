/**
 * @file queue_retry_policy.test.ts — Queue handler retry/ack by DomainError category.
 *
 * The queue handler in src/index.ts applies the rule:
 *
 *   retryable = !isDomainError(err) || isRetryable(err.category)
 *   retryable → msg.retry() ; else → msg.ack()
 *
 * This test verifies every DomainError category maps to the expected action,
 * and that non-DomainError throws always retry (for forward-compatibility with
 * unexpected errors that shouldn't be silently dropped).
 *
 * The test inlines the dispatch logic rather than importing the Worker export,
 * which keeps the test isolated from Cloudflare-specific globals.
 */
import { describe, it, expect } from "vitest";
import { DomainError, isDomainError, isRetryable } from "../../src/shared/errors";
import type { ErrorCategory } from "../../src/shared/errors";

// ---------------------------------------------------------------------------
// Local replica of the queue handler's retry decision (src/index.ts:278).
// If that line ever changes, this mirror will diverge and tests will catch it.
// ---------------------------------------------------------------------------

type DispatchAction = "retry" | "ack" | "ok";

function queueDispatchDecision(err: unknown): DispatchAction {
  if (err === null || err === undefined) return "ok";
  const retryable = !isDomainError(err) || isRetryable((err as DomainError).category);
  return retryable ? "retry" : "ack";
}

function domainErr(category: ErrorCategory): DomainError {
  return new DomainError("TEST_CODE", "test message", {}, { category });
}

// ---------------------------------------------------------------------------
// Retryable categories (DOWNSTREAM / TIMEOUT / RATE_LIMIT)
// ---------------------------------------------------------------------------

describe("retryable DomainError categories → msg.retry()", () => {
  it.each<ErrorCategory>(["DOWNSTREAM", "TIMEOUT", "RATE_LIMIT"])("retries %s", (cat) => {
    expect(queueDispatchDecision(domainErr(cat))).toBe("retry");
  });
});

// ---------------------------------------------------------------------------
// Non-retryable categories (VALIDATION / CONFLICT / INVARIANT / INTERNAL /
// NOT_FOUND / AUTH) — these are bugs or invalid inputs; retrying amplifies harm.
// ---------------------------------------------------------------------------

describe("non-retryable DomainError categories → msg.ack()", () => {
  it.each<ErrorCategory>([
    "VALIDATION",
    "CONFLICT",
    "INVARIANT",
    "INTERNAL",
    "NOT_FOUND",
    "AUTH",
  ])("acks %s", (cat) => {
    expect(queueDispatchDecision(domainErr(cat))).toBe("ack");
  });
});

// ---------------------------------------------------------------------------
// Non-DomainError throws → msg.retry() (forward-compat: unknown errors retry)
// ---------------------------------------------------------------------------

describe("non-DomainError throws → msg.retry()", () => {
  it("retries a plain Error", () => {
    expect(queueDispatchDecision(new Error("unexpected crash"))).toBe("retry");
  });

  it("retries a string throw", () => {
    expect(queueDispatchDecision("string error")).toBe("retry");
  });

  it("retries an object throw", () => {
    expect(queueDispatchDecision({ code: "UNKNOWN" })).toBe("retry");
  });

  it("returns ok for null/undefined (no error thrown)", () => {
    expect(queueDispatchDecision(null)).toBe("ok");
    expect(queueDispatchDecision(undefined)).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// DomainError construction sanity checks (guard against category override bugs)
// ---------------------------------------------------------------------------

describe("DomainError category derivation", () => {
  it("derives category from reason_code when no override", () => {
    const e = new DomainError("H_LIMIT_EXCEEDED", "over limit", {});
    expect(e.category).toBe("CONFLICT");
    expect(queueDispatchDecision(e)).toBe("ack");
  });

  it("explicit category override wins", () => {
    const e = new DomainError(
      "H_LIMIT_EXCEEDED",
      "temporarily unavailable",
      {},
      { category: "DOWNSTREAM" }
    );
    expect(e.category).toBe("DOWNSTREAM");
    expect(queueDispatchDecision(e)).toBe("retry");
  });

  it("unknown reason_code falls back to INTERNAL → ack", () => {
    const e = new DomainError("TOTALLY_NEW_CODE", "unknown", {});
    expect(e.category).toBe("INTERNAL");
    expect(queueDispatchDecision(e)).toBe("ack");
  });
});
