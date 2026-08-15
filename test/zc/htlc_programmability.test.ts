/**
 * @file htlc_programmability.test.ts — THRESHOLD (k-of-n) node, per-template
 *       distinct-operator quorum + equivocation, and ZC-ledger-state predicates
 *       layered on claimHtlcByConditions.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { createHtlc, claimHtlcByConditions } from "../../src/zc/lanes/htlc";
import { processQueueMessage } from "../../src/zc/orchestrator";
import {
  validateConditionExpr,
  evaluateConditionExpr,
  type ConditionExpr,
} from "../../src/zc/platform/condition_expr";
import { buildAttestationMessage } from "../../src/shared/attestation";
import { exportVerificationKey } from "../../src/shared/external_signature";
import { sha256hex } from "../../src/shared/hmac";

// ---------------------------------------------------------------------------
// THRESHOLD node — pure evaluator / validator
// ---------------------------------------------------------------------------

describe("condition_expr — THRESHOLD node", () => {
  const thr = (k: number): ConditionExpr => ({
    op: "THRESHOLD",
    k,
    operands: [{ template_id: "A" }, { template_id: "B" }, { template_id: "C" }],
  });

  it("validates k within 1..#operands", () => {
    expect(validateConditionExpr(thr(2)).ok).toBe(true);
    expect(validateConditionExpr(thr(0)).ok).toBe(false);
    expect(validateConditionExpr(thr(4)).ok).toBe(false);
    expect(
      validateConditionExpr({ op: "THRESHOLD", k: 1.5, operands: [{ template_id: "A" }] }).ok
    ).toBe(false);
  });

  it("is satisfied when at least k operands are satisfied (2-of-3)", () => {
    const e = thr(2);
    expect(evaluateConditionExpr(e, new Set(["A"]))).toBe(false);
    expect(evaluateConditionExpr(e, new Set(["A", "B"]))).toBe(true);
    expect(evaluateConditionExpr(e, new Set(["A", "B", "C"]))).toBe(true);
  });

  it("AND == THRESHOLD(n), OR == THRESHOLD(1)", () => {
    const ops: ConditionExpr[] = [{ template_id: "A" }, { template_id: "B" }];
    const asAnd = evaluateConditionExpr({ op: "THRESHOLD", k: 2, operands: ops }, new Set(["A"]));
    const asOr = evaluateConditionExpr({ op: "THRESHOLD", k: 1, operands: ops }, new Set(["A"]));
    expect(asAnd).toBe(false);
    expect(asOr).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration fixtures
// ---------------------------------------------------------------------------

const BANK_A = "001";
const BANK_B = "002";
const ACC_A = "0010000001";
const ACC_B = "0020000001";

interface TestEnv {
  DB: MockD1Database;
  QUEUE: { _sink: any[]; send: (m: any) => Promise<void> };
  ZC_HMAC_SECRET: string;
}
let d1: MockD1Database;

function makeEnv(db: MockD1Database): TestEnv {
  const sink: any[] = [];
  return {
    DB: db,
    QUEUE: { _sink: sink, send: async (m) => void sink.push(m) },
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

interface Operator {
  keyId: string;
  ownerRef: string;
  privateKey: CryptoKey;
}

/** Register a verification key for an attester operator (owner_ref = operator identity). */
async function registerOperatorKey(
  db: MockD1Database,
  keyId: string,
  ownerRef: string
): Promise<Operator> {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  await db
    .prepare(
      `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
       VALUES (?, 'ATTESTER', ?, ?, 'ED25519', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
    )
    .bind(keyId, ownerRef, await exportVerificationKey(publicKey))
    .run();
  return { keyId, ownerRef, privateKey };
}

async function registerTemplate(db: MockD1Database, templateId: string, minQuorum = 1) {
  await db
    .prepare(
      `INSERT INTO ConditionTemplate (template_id, predicate_kind, allowed_attester_scope, status, description, registered_at, min_attester_quorum, ledger_predicate_json)
       VALUES (?, 'GENERIC', ?, 'ACTIVE', 't', '2020-01-01T00:00:00.000Z', ?, NULL)`
    )
    .bind(templateId, JSON.stringify({ owner_types: ["ATTESTER"] }), minQuorum)
    .run();
}

async function registerLedgerTemplate(db: MockD1Database, templateId: string, predicate: unknown) {
  await db
    .prepare(
      `INSERT INTO ConditionTemplate (template_id, predicate_kind, allowed_attester_scope, status, description, registered_at, min_attester_quorum, ledger_predicate_json)
       VALUES (?, 'ZC_LEDGER_STATE', '{}', 'ACTIVE', 't', '2020-01-01T00:00:00.000Z', 1, ?)`
    )
    .bind(templateId, JSON.stringify(predicate))
    .run();
}

async function appendFinalityLog(db: MockD1Database, txid: string, stateTo: string, tag: string) {
  // event_seq is globally unique; allocate the next free value so this manual
  // dependency-chain entry does not collide with the HTLC's own log entries.
  const max = await db
    .prepare(`SELECT COALESCE(MAX(event_seq), 0) AS m FROM FinalityLog`)
    .first<{ m: number }>();
  const seq = (max?.m ?? 0) + 1;
  await db
    .prepare(
      `INSERT INTO FinalityLog (log_id, txid, gtid, event_type, state_from, state_to, payload_json, event_seq, occurred_at)
       VALUES (?, ?, NULL, 'Test', NULL, ?, '{}', ?, ?)`
    )
    .bind(`LOG-${txid}-${tag}`, txid, stateTo, seq, new Date().toISOString())
    .run();
}

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
  return env;
}

async function attestation(
  htlcId: string,
  templateId: string,
  result: "PASS" | "FAIL",
  op: Operator,
  nonce: string
) {
  const statementHash = await sha256hex(`${templateId}:${result}:${op.keyId}:${nonce}`);
  const occurredAt = new Date().toISOString();
  const message = buildAttestationMessage(
    templateId,
    `TX-HTLC-${htlcId}`,
    statementHash,
    result,
    op.keyId,
    nonce,
    occurredAt
  );
  const signature = b64(await crypto.subtle.sign({ name: "Ed25519" }, op.privateKey, message));
  return {
    template_id: templateId,
    statement_hash: statementHash,
    verified_result: result,
    attester_key_id: op.keyId,
    nonce,
    occurred_at: occurredAt,
    signature,
  };
}

beforeEach(() => {
  ({ d1 } = createTestDb());
  seedParticipant(d1, BANK_A);
  seedParticipant(d1, BANK_B);
});

// ---------------------------------------------------------------------------
// Per-template distinct-operator quorum
// ---------------------------------------------------------------------------

describe("claimHtlcByConditions — distinct-operator quorum", () => {
  it("a 2-of-n template is not satisfied by a single operator, then settles on the 2nd distinct operator", async () => {
    await registerTemplate(d1, "TPL-Q", 2);
    const op1 = await registerOperatorKey(d1, "K-OP1", "op-1");
    const op2 = await registerOperatorKey(d1, "K-OP2", "op-2");
    const htlcId = "HTLC-Q-1";
    const env = await createAndLock(htlcId, { template_id: "TPL-Q" });

    const first = await claimHtlcByConditions(
      {
        htlc_id: htlcId,
        idempotency_key: "IK-Q1",
        attestations: [await attestation(htlcId, "TPL-Q", "PASS", op1, "n1")],
      } as any,
      env as any
    );
    expect(first.result).toBe("REJECTED");
    expect(first.reason_code).toBe("CONDITIONS_NOT_MET");

    const second = await claimHtlcByConditions(
      {
        htlc_id: htlcId,
        idempotency_key: "IK-Q2",
        attestations: [await attestation(htlcId, "TPL-Q", "PASS", op2, "n2")],
      } as any,
      env as any
    );
    expect(second.result).toBe("ACCEPTED");
  });

  it("counts distinct operators, not keys — one operator with two keys cannot meet a 2-of-n quorum", async () => {
    await registerTemplate(d1, "TPL-Q", 2);
    const k1 = await registerOperatorKey(d1, "K-A", "op-multi");
    const k2 = await registerOperatorKey(d1, "K-B", "op-multi"); // same owner_ref
    const htlcId = "HTLC-Q-2";
    const env = await createAndLock(htlcId, { template_id: "TPL-Q" });

    const res = await claimHtlcByConditions(
      {
        htlc_id: htlcId,
        idempotency_key: "IK-Q3",
        attestations: [
          await attestation(htlcId, "TPL-Q", "PASS", k1, "n1"),
          await attestation(htlcId, "TPL-Q", "PASS", k2, "n2"),
        ],
      } as any,
      env as any
    );
    expect(res.result).toBe("REJECTED");
    expect(res.reason_code).toBe("CONDITIONS_NOT_MET");
  });
});

// ---------------------------------------------------------------------------
// Equivocation
// ---------------------------------------------------------------------------

describe("claimHtlcByConditions — equivocation", () => {
  it("contradictory PASS/FAIL from distinct operators is fail-closed and opens a CASE", async () => {
    await registerTemplate(d1, "TPL-E", 1);
    const op1 = await registerOperatorKey(d1, "K-E1", "op-1");
    const op2 = await registerOperatorKey(d1, "K-E2", "op-2");
    const htlcId = "HTLC-E-1";
    const env = await createAndLock(htlcId, { template_id: "TPL-E" });

    const res = await claimHtlcByConditions(
      {
        htlc_id: htlcId,
        idempotency_key: "IK-E1",
        attestations: [
          await attestation(htlcId, "TPL-E", "PASS", op1, "n1"),
          await attestation(htlcId, "TPL-E", "FAIL", op2, "n2"),
        ],
      } as any,
      env as any
    );
    expect(res.result).toBe("REJECTED");
    expect(res.reason_code).toBe("CONDITIONS_NOT_MET");

    const caseRow = await d1
      .prepare(`SELECT reason_code FROM Cases WHERE related_txid=?`)
      .bind(`TX-HTLC-${htlcId}`)
      .first<{ reason_code: string }>();
    expect(caseRow?.reason_code).toBe("ATTESTATION_EQUIVOCATION");

    const ev = await d1
      .prepare(
        `SELECT payload_json FROM FinalityLog WHERE event_type='HtlcConditionsEvaluated' AND txid=?`
      )
      .bind(`TX-HTLC-${htlcId}`)
      .first<{ payload_json: string }>();
    expect(ev?.payload_json).toContain('"equivocating_templates":["TPL-E"]');
  });
});

// ---------------------------------------------------------------------------
// ZC-ledger-state predicate
// ---------------------------------------------------------------------------

describe("claimHtlcByConditions — ledger-state predicate", () => {
  it("a ledger predicate gates settlement on a committed FinalityLog state (no attestation)", async () => {
    await registerLedgerTemplate(d1, "TPL-L", {
      kind: "TX_REACHED_STATE",
      txid: "TX-DEP",
      states: ["SETTLED"],
    });
    const htlcId = "HTLC-L-1";
    const env = await createAndLock(htlcId, { template_id: "TPL-L" });

    // Dependency not yet settled → not met.
    const before = await claimHtlcByConditions(
      { htlc_id: htlcId, idempotency_key: "IK-L1", attestations: [] } as any,
      env as any
    );
    expect(before.result).toBe("REJECTED");
    expect(before.reason_code).toBe("CONDITIONS_NOT_MET");

    // Dependency reaches SETTLED on its own chain → predicate now true → settles.
    await appendFinalityLog(d1, "TX-DEP", "SETTLED", "a");
    const after = await claimHtlcByConditions(
      { htlc_id: htlcId, idempotency_key: "IK-L2", attestations: [] } as any,
      env as any
    );
    expect(after.result).toBe("ACCEPTED");
  });

  it("composes a ledger predicate AND an attested condition", async () => {
    await registerTemplate(d1, "TPL-A", 1);
    await registerLedgerTemplate(d1, "TPL-L2", {
      kind: "TX_REACHED_STATE",
      txid: "TX-DEP2",
      states: ["SETTLED"],
    });
    const op = await registerOperatorKey(d1, "K-C1", "op-1");
    const htlcId = "HTLC-L-2";
    const env = await createAndLock(htlcId, {
      op: "AND",
      operands: [{ template_id: "TPL-A" }, { template_id: "TPL-L2" }],
    });

    // Attestation present but ledger leg false → not met.
    const before = await claimHtlcByConditions(
      {
        htlc_id: htlcId,
        idempotency_key: "IK-L3",
        attestations: [await attestation(htlcId, "TPL-A", "PASS", op, "n1")],
      } as any,
      env as any
    );
    expect(before.result).toBe("REJECTED");

    await appendFinalityLog(d1, "TX-DEP2", "SETTLED", "a");
    const after = await claimHtlcByConditions(
      {
        htlc_id: htlcId,
        idempotency_key: "IK-L4",
        attestations: [await attestation(htlcId, "TPL-A", "PASS", op, "n2")],
      } as any,
      env as any
    );
    expect(after.result).toBe("ACCEPTED");
  });
});

// ---------------------------------------------------------------------------
// Deterministic predicates: TIME_* and GTID_REACHED_STATE
// ---------------------------------------------------------------------------

async function appendGtidFinalityLog(
  db: MockD1Database,
  gtid: string,
  stateTo: string,
  tag: string
) {
  const max = await db
    .prepare(`SELECT COALESCE(MAX(event_seq), 0) AS m FROM FinalityLog`)
    .first<{ m: number }>();
  const seq = (max?.m ?? 0) + 1;
  await db
    .prepare(
      `INSERT INTO FinalityLog (log_id, txid, gtid, event_type, state_from, state_to, payload_json, event_seq, occurred_at)
       VALUES (?, NULL, ?, 'Test', NULL, ?, '{}', ?, ?)`
    )
    .bind(`GLOG-${gtid}-${tag}`, gtid, stateTo, seq, new Date().toISOString())
    .run();
}

describe("claimHtlcByConditions — TIME_* predicates", () => {
  it("TIME_AFTER a past instant settles; a future instant does not", async () => {
    await registerLedgerTemplate(d1, "TPL-T-PAST", {
      kind: "TIME_AFTER",
      at: "2000-01-01T00:00:00Z",
    });
    const past = await createAndLock("HTLC-T-1", { template_id: "TPL-T-PAST" });
    expect(
      (
        await claimHtlcByConditions(
          { htlc_id: "HTLC-T-1", idempotency_key: "IK-T1", attestations: [] } as any,
          past as any
        )
      ).result
    ).toBe("ACCEPTED");

    await registerLedgerTemplate(d1, "TPL-T-FUT", {
      kind: "TIME_AFTER",
      at: "2999-01-01T00:00:00Z",
    });
    const fut = await createAndLock("HTLC-T-2", { template_id: "TPL-T-FUT" });
    const r = await claimHtlcByConditions(
      { htlc_id: "HTLC-T-2", idempotency_key: "IK-T2", attestations: [] } as any,
      fut as any
    );
    expect(r.result).toBe("REJECTED");
    expect(r.reason_code).toBe("CONDITIONS_NOT_MET");
  });

  it("TIME_BEFORE a future instant (deadline) settles now", async () => {
    await registerLedgerTemplate(d1, "TPL-T-DL", {
      kind: "TIME_BEFORE",
      at: "2999-01-01T00:00:00Z",
    });
    const env = await createAndLock("HTLC-T-3", { template_id: "TPL-T-DL" });
    expect(
      (
        await claimHtlcByConditions(
          { htlc_id: "HTLC-T-3", idempotency_key: "IK-T3", attestations: [] } as any,
          env as any
        )
      ).result
    ).toBe("ACCEPTED");
  });

  it("records the evaluated `now` in the HtlcConditionsEvaluated evidence", async () => {
    await registerLedgerTemplate(d1, "TPL-T-EV", {
      kind: "TIME_AFTER",
      at: "2000-01-01T00:00:00Z",
    });
    const env = await createAndLock("HTLC-T-4", { template_id: "TPL-T-EV" });
    await claimHtlcByConditions(
      { htlc_id: "HTLC-T-4", idempotency_key: "IK-T4", attestations: [] } as any,
      env as any
    );
    const ev = await d1
      .prepare(
        `SELECT payload_json FROM FinalityLog WHERE event_type='HtlcConditionsEvaluated' AND txid=?`
      )
      .bind("TX-HTLC-HTLC-T-4")
      .first<{ payload_json: string }>();
    expect(ev?.payload_json).toContain('"evaluated_at"');
  });
});

describe("claimHtlcByConditions — GTID_REACHED_STATE predicate", () => {
  it("gates on a committed GTID aggregate state", async () => {
    await registerLedgerTemplate(d1, "TPL-G", {
      kind: "GTID_REACHED_STATE",
      gtid: "G-DEP",
      states: ["GT_SETTLED"],
    });
    const env = await createAndLock("HTLC-G-1", { template_id: "TPL-G" });

    const before = await claimHtlcByConditions(
      { htlc_id: "HTLC-G-1", idempotency_key: "IK-G1", attestations: [] } as any,
      env as any
    );
    expect(before.result).toBe("REJECTED");

    await appendGtidFinalityLog(d1, "G-DEP", "GT_SETTLED", "a");
    const after = await claimHtlcByConditions(
      { htlc_id: "HTLC-G-1", idempotency_key: "IK-G2", attestations: [] } as any,
      env as any
    );
    expect(after.result).toBe("ACCEPTED");
  });
});
