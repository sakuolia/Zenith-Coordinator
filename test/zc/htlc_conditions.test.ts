/**
 * @file htlc_conditions.test.ts — HTLC AND/OR ConditionTemplate composition
 *       (programmability generalization, 30_internal_design.md § 7).
 *
 * Two layers:
 *   1. The pure boolean evaluator + validator (zc/condition_expr.ts).
 *   2. claimHtlcByConditions end-to-end: an HTLC with a condition_expr_json tree
 *      settles only when the presented PASS attestations satisfy the expression.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { createHtlc, claimHtlcByConditions } from "../../src/zc/lanes/htlc";
import { processQueueMessage } from "../../src/zc/orchestrator";
import {
  validateConditionExpr,
  evaluateConditionExpr,
  collectTemplateIds,
  type ConditionExpr,
} from "../../src/zc/platform/condition_expr";
import { buildAttestationMessage } from "../../src/shared/attestation";
import { exportVerificationKey } from "../../src/shared/external_signature";
import { sha256hex } from "../../src/shared/hmac";

// ---------------------------------------------------------------------------
// 1. Pure evaluator / validator
// ---------------------------------------------------------------------------

describe("condition_expr — validation", () => {
  it("accepts a leaf and a nested AND/OR", () => {
    expect(validateConditionExpr({ template_id: "A" }).ok).toBe(true);
    expect(
      validateConditionExpr({
        op: "AND",
        operands: [
          { template_id: "A" },
          { op: "OR", operands: [{ template_id: "B" }, { template_id: "C" }] },
        ],
      }).ok
    ).toBe(true);
  });

  it("rejects malformed trees", () => {
    expect(validateConditionExpr(null).ok).toBe(false);
    expect(validateConditionExpr({ template_id: "" }).ok).toBe(false);
    expect(validateConditionExpr({ op: "AND", operands: [] }).ok).toBe(false);
    expect(validateConditionExpr({ op: "XOR", operands: [{ template_id: "A" }] }).ok).toBe(false);
    // Too deep (> MAX_EXPR_DEPTH=6).
    let deep: any = { template_id: "Z" };
    for (let i = 0; i < 7; i++) deep = { op: "AND", operands: [deep] };
    expect(validateConditionExpr(deep).ok).toBe(false);
  });

  it("enforces MAX_TEMPLATES on the distinct-template count", () => {
    // A wide-but-shallow tree can reference far more than MAX_TEMPLATES distinct
    // templates while staying inside MAX_EXPR_DEPTH/MAX_OPERANDS (the operand
    // limit caps a single node's fan-out, not the whole tree). Build a balanced
    // tree of OR-of-AND nodes referencing 40 distinct templates (> MAX_TEMPLATES=32).
    const leaves = (n: number, base: string): ConditionExpr => ({
      op: "OR",
      operands: Array.from({ length: n }, (_, i) => ({ template_id: `${base}-${i}` })),
    });
    // 4 groups × 10 leaves = 40 distinct templates, depth 3, max fan-out 10 (< 16).
    const wide: ConditionExpr = {
      op: "AND",
      operands: [leaves(10, "G0"), leaves(10, "G1"), leaves(10, "G2"), leaves(10, "G3")],
    };
    expect(collectTemplateIds(wide).length).toBe(40);
    const v = validateConditionExpr(wide);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.error).toMatch(/MAX_TEMPLATES/);

    // Exactly MAX_TEMPLATES (32) distinct templates is still accepted.
    const at32: ConditionExpr = {
      op: "OR",
      operands: [leaves(16, "H0"), leaves(16, "H1")],
    };
    expect(collectTemplateIds(at32).length).toBe(32);
    expect(validateConditionExpr(at32).ok).toBe(true);
  });
});

describe("condition_expr — evaluation", () => {
  const AND_OR: ConditionExpr = {
    op: "AND",
    operands: [
      { template_id: "INSPECT" },
      { op: "OR", operands: [{ template_id: "DELIVERY" }, { template_id: "SIGNOFF" }] },
    ],
  };

  it("collects template ids", () => {
    expect(collectTemplateIds(AND_OR).sort()).toEqual(["DELIVERY", "INSPECT", "SIGNOFF"]);
  });

  it("AND requires all branches; OR any branch", () => {
    expect(evaluateConditionExpr(AND_OR, new Set(["INSPECT", "DELIVERY"]))).toBe(true);
    expect(evaluateConditionExpr(AND_OR, new Set(["INSPECT", "SIGNOFF"]))).toBe(true);
    expect(evaluateConditionExpr(AND_OR, new Set(["INSPECT"]))).toBe(false); // OR branch unmet
    expect(evaluateConditionExpr(AND_OR, new Set(["DELIVERY", "SIGNOFF"]))).toBe(false); // INSPECT unmet
  });
});

// ---------------------------------------------------------------------------
// 2. claimHtlcByConditions integration
// ---------------------------------------------------------------------------

const BANK_A = "001";
const BANK_B = "002";
const ACC_A = "0010000001";
const ACC_B = "0020000001";

let d1: MockD1Database;

interface TestEnv {
  DB: MockD1Database;
  QUEUE: { _sink: any[]; send: (m: any) => Promise<void> };
  ZC_HMAC_SECRET: string;
}
function makeEnv(db: MockD1Database): TestEnv {
  const sink: any[] = [];
  return {
    DB: db,
    QUEUE: {
      _sink: sink,
      send: async (m) => {
        sink.push(m);
      },
    },
    ZC_HMAC_SECRET: "s",
  };
}
async function drain(env: TestEnv, max = 20): Promise<void> {
  let n = 0;
  while (env.QUEUE._sink.length > 0 && n < max) {
    await processQueueMessage(env.QUEUE._sink.shift()!, env as any);
    n++;
  }
  if (n >= max) throw new Error("drain did not converge");
}
function seedParticipant(db: MockD1Database, bankId: string) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 10000000, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId)
    ._runSync();
}
function b64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}
async function registerKey(db: MockD1Database, keyId: string, publicKey: CryptoKey) {
  await db
    .prepare(
      `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
       VALUES (?, 'ATTESTER', 'attester-1', ?, 'ED25519', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
    )
    .bind(keyId, await exportVerificationKey(publicKey))
    .run();
}
async function registerTemplate(db: MockD1Database, templateId: string) {
  await db
    .prepare(
      `INSERT INTO ConditionTemplate (template_id, predicate_kind, allowed_attester_scope, status, description, registered_at)
       VALUES (?, 'GENERIC', ?, 'ACTIVE', 't', '2020-01-01T00:00:00.000Z')`
    )
    .bind(templateId, JSON.stringify({ owner_types: ["ATTESTER"] }))
    .run();
}

let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeEach(async () => {
  ({ d1 } = createTestDb());
  seedParticipant(d1, BANK_A);
  seedParticipant(d1, BANK_B);
  ({ privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]));
  await registerKey(d1, "KEY-1", publicKey);
});

async function createAndLock(htlcId: string, expr: ConditionExpr): Promise<TestEnv> {
  const env = makeEnv(d1);
  const created = await createHtlc(
    {
      htlc_id: htlcId,
      idempotency_key: `IK-${htlcId}`,
      amount: { value: 10_000, currency: "JPY" },
      payer_bank_id: BANK_A,
      payer_account_hash: ACC_A,
      payee_bank_id: BANK_B,
      payee_account_hash: ACC_B,
      timelock: new Date(Date.now() + 24 * 3600_000).toISOString(),
      condition_expr_json: expr,
    } as any,
    env as any
  );
  expect(created.result).toBe("CREATED");
  await drain(env);
  const locked = await d1
    .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id=?`)
    .bind(htlcId)
    .first<{ state: string }>();
  expect(locked?.state).toBe("HTLC_LOCKED");
  return env;
}

async function attestationFor(
  htlcId: string,
  templateId: string,
  result: "PASS" | "FAIL",
  nonce: string
) {
  const statementHash = await sha256hex(`${templateId}:${result}`);
  const occurredAt = new Date().toISOString();
  const message = buildAttestationMessage(
    templateId,
    `TX-HTLC-${htlcId}`,
    statementHash,
    result,
    "KEY-1",
    nonce,
    occurredAt
  );
  const signature = b64(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message));
  return {
    template_id: templateId,
    statement_hash: statementHash,
    verified_result: result,
    attester_key_id: "KEY-1",
    nonce,
    occurred_at: occurredAt,
    signature,
  };
}

describe("claimHtlcByConditions", () => {
  it("settles an AND tree when every branch is PASS-attested", async () => {
    await registerTemplate(d1, "TPL-X");
    await registerTemplate(d1, "TPL-Y");
    const htlcId = "HTLC-AND-1";
    const env = await createAndLock(htlcId, {
      op: "AND",
      operands: [{ template_id: "TPL-X" }, { template_id: "TPL-Y" }],
    });

    const res = await claimHtlcByConditions(
      {
        htlc_id: htlcId,
        idempotency_key: `IK-CLM-${htlcId}`,
        attestations: [
          await attestationFor(htlcId, "TPL-X", "PASS", "n1"),
          await attestationFor(htlcId, "TPL-Y", "PASS", "n2"),
        ],
      },
      env as any
    );
    expect(res.result).toBe("ACCEPTED");
    expect(res.state).toBe("PAYER_EXEC_CONFIRMED");

    const ev = await d1
      .prepare(
        `SELECT payload_json FROM FinalityLog WHERE event_type='HtlcConditionsEvaluated' AND txid=?`
      )
      .bind(`TX-HTLC-${htlcId}`)
      .first<{ payload_json: string }>();
    expect(ev?.payload_json).toContain('"met":true');
  });

  it("rejects an AND tree when one branch is missing (CONDITIONS_NOT_MET)", async () => {
    await registerTemplate(d1, "TPL-X");
    await registerTemplate(d1, "TPL-Y");
    const htlcId = "HTLC-AND-2";
    const env = await createAndLock(htlcId, {
      op: "AND",
      operands: [{ template_id: "TPL-X" }, { template_id: "TPL-Y" }],
    });

    const res = await claimHtlcByConditions(
      {
        htlc_id: htlcId,
        idempotency_key: `IK-CLM-${htlcId}`,
        attestations: [await attestationFor(htlcId, "TPL-X", "PASS", "n1")],
      },
      env as any
    );
    expect(res.result).toBe("REJECTED");
    expect(res.reason_code).toBe("CONDITIONS_NOT_MET");

    const htlc = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id=?`)
      .bind(htlcId)
      .first<{ state: string }>();
    expect(htlc?.state).toBe("HTLC_LOCKED"); // unchanged
  });

  it("settles an OR tree when any one branch is PASS-attested", async () => {
    await registerTemplate(d1, "TPL-X");
    await registerTemplate(d1, "TPL-Y");
    const htlcId = "HTLC-OR-1";
    const env = await createAndLock(htlcId, {
      op: "OR",
      operands: [{ template_id: "TPL-X" }, { template_id: "TPL-Y" }],
    });

    const res = await claimHtlcByConditions(
      {
        htlc_id: htlcId,
        idempotency_key: `IK-CLM-${htlcId}`,
        attestations: [await attestationFor(htlcId, "TPL-Y", "PASS", "n1")],
      },
      env as any
    );
    expect(res.result).toBe("ACCEPTED");
  });

  it("does NOT count a FAIL attestation toward the satisfied set", async () => {
    await registerTemplate(d1, "TPL-X");
    await registerTemplate(d1, "TPL-Y");
    const htlcId = "HTLC-OR-FAIL";
    const env = await createAndLock(htlcId, {
      op: "OR",
      operands: [{ template_id: "TPL-X" }, { template_id: "TPL-Y" }],
    });

    const res = await claimHtlcByConditions(
      {
        htlc_id: htlcId,
        idempotency_key: `IK-CLM-${htlcId}`,
        attestations: [
          await attestationFor(htlcId, "TPL-X", "FAIL", "n1"),
          await attestationFor(htlcId, "TPL-Y", "FAIL", "n2"),
        ],
      },
      env as any
    );
    expect(res.result).toBe("REJECTED");
    expect(res.reason_code).toBe("CONDITIONS_NOT_MET");
  });

  it("rejects CONDITION_EXPR_NOT_SET for an HTLC without an expression", async () => {
    const env = makeEnv(d1);
    const htlcId = "HTLC-NOEXPR";
    await createHtlc(
      {
        htlc_id: htlcId,
        idempotency_key: `IK-${htlcId}`,
        amount: { value: 10_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: ACC_A,
        payee_bank_id: BANK_B,
        payee_account_hash: ACC_B,
        timelock: new Date(Date.now() + 24 * 3600_000).toISOString(),
      } as any,
      env as any
    );
    await drain(env);
    const res = await claimHtlcByConditions(
      {
        htlc_id: htlcId,
        idempotency_key: `IK-CLM-${htlcId}`,
        attestations: [await attestationFor(htlcId, "TPL-X", "PASS", "n1")],
      },
      env as any
    );
    expect(res.result).toBe("REJECTED");
    expect(res.reason_code).toBe("CONDITION_EXPR_NOT_SET");
  });

  it("rejects a malformed condition_expr_json at create time", async () => {
    const env = makeEnv(d1);
    await expect(
      createHtlc(
        {
          htlc_id: "HTLC-BADEXPR",
          idempotency_key: "IK-BADEXPR",
          amount: { value: 10_000, currency: "JPY" },
          payer_bank_id: BANK_A,
          payer_account_hash: ACC_A,
          payee_bank_id: BANK_B,
          payee_account_hash: ACC_B,
          timelock: new Date(Date.now() + 24 * 3600_000).toISOString(),
          condition_expr_json: { op: "AND", operands: [] },
        } as any,
        env as any
      )
    ).rejects.toMatchObject({ reason_code: "CONDITION_EXPR_INVALID" });
  });
});
