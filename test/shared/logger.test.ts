/**
 * @file Unit tests for src/shared/logger.ts
 *
 * The logger writes to console.{info,warn,error,log}. We patch those during
 * each test, capture the JSON lines, and assert structure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { newRequestLogger } from "../../src/shared/logger";

interface CapturedLine {
  level: string;
  ts: string;
  event: string;
  request_id: string;
  [k: string]: unknown;
}

let captured: CapturedLine[] = [];
const spies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  captured = [];
  for (const m of ["log", "info", "warn", "error"] as const) {
    spies.push(
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        const line = args[0];
        if (typeof line === "string") captured.push(JSON.parse(line));
      })
    );
  }
});

afterEach(() => {
  for (const s of spies) s.mockRestore();
  spies.length = 0;
});

describe("newRequestLogger", () => {
  it("emits one JSON line per call with the expected envelope", () => {
    const log = newRequestLogger({ method: "POST", path: "/api/transfers" });
    log.info("http.request");

    expect(captured).toHaveLength(1);
    const line = captured[0];
    expect(line.level).toBe("info");
    expect(line.event).toBe("http.request");
    expect(line.method).toBe("POST");
    expect(line.path).toBe("/api/transfers");
    expect(line.request_id).toMatch(/^req-/);
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("honors an inbound request_id", () => {
    const log = newRequestLogger({ request_id: "req-from-client", path: "/x" });
    log.info("e");
    expect(captured[0].request_id).toBe("req-from-client");
    expect(log.request_id).toBe("req-from-client");
  });

  it("child() merges baggage into every subsequent call", () => {
    const log = newRequestLogger({ request_id: "req-1" });
    const child = log.child({ txid: "TX-1", lane: "EXPRESS" });
    child.info("lane.dispatch");

    expect(captured[0].txid).toBe("TX-1");
    expect(captured[0].lane).toBe("EXPRESS");
    expect(captured[0].request_id).toBe("req-1");
  });

  it("redacts PII-shaped keys", () => {
    const log = newRequestLogger({ request_id: "r" });
    log.info("test", {
      vault_ref: "V-secret",
      preimage: "deadbeef",
      api_key: "sk-123",
      user_password: "p@ss",
      txid: "TX-9",
    });

    expect(captured[0].vault_ref).toBe("[REDACTED]");
    expect(captured[0].preimage).toBe("[REDACTED]");
    expect(captured[0].api_key).toBe("[REDACTED]");
    expect(captured[0].user_password).toBe("[REDACTED]");
    expect(captured[0].txid).toBe("TX-9");
  });

  it("redacts raw customer-PII keys (docs/specs/10_requirements.md §3.2.1)", () => {
    const log = newRequestLogger({ request_id: "r" });
    log.info("test", {
      customer_name: "Taro Yamada",
      account_holder_name: "Taro Yamada",
      address: "1 Chiyoda, Tokyo",
      phone: "+81-3-0000-0000",
      email: "taro@example.com",
      date_of_birth: "1990-01-01",
      account_number: "1234567",
      payer_account_hash: "0010000001",
    });

    expect(captured[0].customer_name).toBe("[REDACTED]");
    expect(captured[0].account_holder_name).toBe("[REDACTED]");
    expect(captured[0].address).toBe("[REDACTED]");
    expect(captured[0].phone).toBe("[REDACTED]");
    expect(captured[0].email).toBe("[REDACTED]");
    expect(captured[0].date_of_birth).toBe("[REDACTED]");
    expect(captured[0].account_number).toBe("[REDACTED]");
    expect(captured[0].payer_account_hash).toBe("0010000001");
  });

  it("serializes Error fields with name/message and reason_code/details if present", () => {
    const log = newRequestLogger({ request_id: "r" });
    const e = Object.assign(new Error("boom"), { reason_code: "X_FAIL", details: { txid: "T" } });
    log.error("something.failed", { error: e });

    const err = captured[0].error as { name: string; message: string; reason_code: string };
    expect(err.name).toBe("Error");
    expect(err.message).toBe("boom");
    expect(err.reason_code).toBe("X_FAIL");
  });

  it("elapsed() returns a non-negative number", async () => {
    const log = newRequestLogger();
    await new Promise((r) => setTimeout(r, 5));
    expect(log.elapsed()).toBeGreaterThanOrEqual(0);
  });

  it("writes warn at warn level and error at error level", () => {
    const log = newRequestLogger({ request_id: "r" });
    log.warn("w");
    log.error("e");
    expect(captured[0].level).toBe("warn");
    expect(captured[1].level).toBe("error");
  });
});
