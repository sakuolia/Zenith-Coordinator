/**
 * @file simulate_endpoints.test.ts — read-only dry-run endpoints for condition
 *       expressions and mandates (programmability addition #5). These never
 *       write, move funds, or record an Attestation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { handleZcApi } from "../../src/router/zc";
import { registerMandate, buildMandatePayload } from "../../src/shared/mandate";
import { buildSignedMessage, exportVerificationKey } from "../../src/shared/external_signature";

let d1: MockD1Database;
let env: any;

function b64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}
async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const resp = await handleZcApi(
    new Request(`http://x${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    path,
    "POST",
    env
  );
  return { status: resp.status, json: await resp.json() };
}

beforeEach(() => {
  ({ d1 } = createTestDb());
  env = { DB: d1, ZC_HMAC_SECRET: "s" };
});

describe("POST /api/conditions/validate", () => {
  it("accepts a valid expression and returns the referenced templates", async () => {
    const r = await post("/api/conditions/validate", {
      condition_expr: { op: "AND", operands: [{ template_id: "B" }, { template_id: "A" }] },
    });
    expect(r.status).toBe(200);
    expect(r.json.valid).toBe(true);
    expect(r.json.required_templates).toEqual(["A", "B"]);
  });

  it("reports a structural error for a malformed expression", async () => {
    const r = await post("/api/conditions/validate", {
      condition_expr: { op: "AND", operands: [] },
    });
    expect(r.status).toBe(200);
    expect(r.json.valid).toBe(false);
    expect(typeof r.json.error).toBe("string");
  });

  it("400s when condition_expr is absent", async () => {
    const r = await post("/api/conditions/validate", {});
    expect(r.status).toBe(400);
  });
});

describe("POST /api/conditions/simulate", () => {
  it("evaluates met/missing against a hypothetical satisfied set", async () => {
    const expr = {
      op: "THRESHOLD",
      k: 2,
      operands: [{ template_id: "A" }, { template_id: "B" }, { template_id: "C" }],
    };
    const unmet = await post("/api/conditions/simulate", {
      condition_expr: expr,
      satisfied: ["A"],
    });
    expect(unmet.json.met).toBe(false);
    expect(unmet.json.missing).toEqual(["B", "C"]);

    const met = await post("/api/conditions/simulate", {
      condition_expr: expr,
      satisfied: ["A", "C"],
    });
    expect(met.json.met).toBe(true);
  });

  it("400s on an invalid expression", async () => {
    const r = await post("/api/conditions/simulate", {
      condition_expr: { op: "XOR", operands: [{ template_id: "A" }] },
    });
    expect(r.status).toBe(400);
    expect(r.json.reason_code).toBe("CONDITION_EXPR_INVALID");
  });
});

describe("POST /api/mandates/check", () => {
  async function seedMandate(): Promise<string> {
    const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]);
    await d1
      .prepare(
        `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
         VALUES ('KEY-P', 'PARTICIPANT', 'P-1', ?, 'ED25519', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
      )
      .bind(await exportVerificationKey(publicKey))
      .run();
    const terms = {
      principalParticipantId: "P-1",
      granteeRef: "agent-1",
      maxAmount: 5000,
      allowedPurposes: ["P01"],
      allowedLanes: ["EXPRESS"],
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2999-01-01T00:00:00.000Z",
    };
    const nonce = "mn-1";
    const occurredAt = new Date().toISOString();
    const sig = b64(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        privateKey,
        buildSignedMessage(buildMandatePayload(terms), "KEY-P", nonce, occurredAt)
      )
    );
    const row = await registerMandate(d1 as any, {
      ...terms,
      principalKeyId: "KEY-P",
      nonce,
      occurredAt,
      signatureB64: sig,
    });
    return row.mandate_id;
  }

  it("returns ok for an in-scope instruction and a breach reason for an out-of-scope one", async () => {
    const mandateId = await seedMandate();

    const ok = await post("/api/mandates/check", {
      mandate_id: mandateId,
      amount: 4000,
      purpose: "P01",
      lane: "EXPRESS",
    });
    expect(ok.status).toBe(200);
    expect(ok.json.ok).toBe(true);

    const breach = await post("/api/mandates/check", {
      mandate_id: mandateId,
      amount: 9999,
      purpose: "P01",
      lane: "EXPRESS",
    });
    expect(breach.json.ok).toBe(false);
    expect(breach.json.reason_code).toBe("MANDATE_BREACH");

    // Dry-run must not have written anything: no FinalityLog, no new rows.
    const fl = await d1.prepare(`SELECT COUNT(*) AS n FROM FinalityLog`).first<{ n: number }>();
    expect(fl?.n).toBe(0);
  });

  it("404-style NOT_FOUND reason for an unknown mandate", async () => {
    const r = await post("/api/mandates/check", { mandate_id: "MANDATE-nope" });
    expect(r.json.ok).toBe(false);
    expect(r.json.reason_code).toBe("MANDATE_NOT_FOUND");
  });
});
