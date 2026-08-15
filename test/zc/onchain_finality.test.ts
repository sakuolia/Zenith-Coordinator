/**
 * @file onchain_finality.test.ts — cross-chain finality classification +
 *       quantum-risk metadata (30_internal_design.md § 7 "オンチェーン接続").
 *
 * Pure classifiers (classifyFinality / classifyQuantumRisk / requiredConfirmations)
 * plus the create-time storage + OnchainFinalityClassified audit event.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  classifyFinality,
  classifyQuantumRisk,
  requiredConfirmations,
} from "../../src/zc/finality/onchain_finality";
import { createHtlc } from "../../src/zc/lanes/htlc";

// ---------------------------------------------------------------------------
// Pure classifiers
// ---------------------------------------------------------------------------

describe("onchain_finality — classifiers", () => {
  it("classifyFinality: PUBLIC ⇒ probabilistic, private/permissioned ⇒ deterministic", () => {
    expect(classifyFinality("PUBLIC")).toBe("PROBABILISTIC");
    expect(classifyFinality("PRIVATE")).toBe("DETERMINISTIC");
    expect(classifyFinality("PERMISSIONED")).toBe("DETERMINISTIC");
  });

  it("classifyQuantumRisk: classical suites VULNERABLE, PQ suites RESISTANT, else UNKNOWN", () => {
    expect(classifyQuantumRisk("secp256k1")).toBe("VULNERABLE");
    expect(classifyQuantumRisk("ed25519")).toBe("VULNERABLE");
    expect(classifyQuantumRisk("BLS12-381")).toBe("VULNERABLE");
    expect(classifyQuantumRisk("dilithium3")).toBe("RESISTANT");
    expect(classifyQuantumRisk("ML-DSA-65")).toBe("RESISTANT");
    expect(classifyQuantumRisk("something-new")).toBe("UNKNOWN");
  });

  it("requiredConfirmations: deterministic caps at 1, probabilistic honours configured depth", () => {
    expect(requiredConfirmations("DETERMINISTIC", 6)).toBe(1);
    expect(requiredConfirmations("DETERMINISTIC", 0)).toBe(0); // no gate introduced
    expect(requiredConfirmations("PROBABILISTIC", 6)).toBe(6);
    expect(requiredConfirmations(null, 3)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// create-time classification storage + audit event
// ---------------------------------------------------------------------------

const BANK_A = "001";
const BANK_B = "002";

let d1: MockD1Database;
function makeEnv(db: MockD1Database): any {
  return { DB: db, QUEUE: { send: async () => {} }, ZC_HMAC_SECRET: "s" };
}
function seedParticipant(db: MockD1Database, bankId: string) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'T', '/bank/${bankId}', 10000000, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId)
    ._runSync();
}

beforeEach(() => {
  ({ d1 } = createTestDb());
  seedParticipant(d1, BANK_A);
  seedParticipant(d1, BANK_B);
});

describe("createHtlc — cross-chain finality classification", () => {
  it("stores the derived finality_class + quantum_risk and emits OnchainFinalityClassified", async () => {
    const htlcId = "HTLC-CC-PUBLIC";
    const inner = new Date(Date.now() + 12 * 3600_000).toISOString();
    const outer = new Date(Date.now() + 24 * 3600_000).toISOString();
    const created = await createHtlc(
      {
        htlc_id: htlcId,
        idempotency_key: `IK-${htlcId}`,
        amount: { value: 10_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: "0010000001",
        payee_bank_id: BANK_B,
        payee_account_hash: "0020000001",
        timelock: outer,
        cross_chain: { source: "ONCHAIN:ETH", onchain_timelock: inner, min_confirmations: 6 },
        onchain_chain_class: "PUBLIC",
        onchain_crypto_suite: "secp256k1",
      } as any,
      makeEnv(d1) as any
    );
    expect(created.result).toBe("CREATED");

    const row = await d1
      .prepare(
        `SELECT onchain_chain_class, onchain_finality_class, onchain_crypto_suite, onchain_quantum_risk
         FROM HtlcContracts WHERE htlc_id=?`
      )
      .bind(htlcId)
      .first<any>();
    expect(row.onchain_chain_class).toBe("PUBLIC");
    expect(row.onchain_finality_class).toBe("PROBABILISTIC");
    expect(row.onchain_crypto_suite).toBe("secp256k1");
    expect(row.onchain_quantum_risk).toBe("VULNERABLE"); // derived from the suite

    const ev = await d1
      .prepare(
        `SELECT payload_json FROM FinalityLog WHERE event_type='OnchainFinalityClassified' AND txid=?`
      )
      .bind(`TX-HTLC-${htlcId}`)
      .first<{ payload_json: string }>();
    expect(ev).toBeTruthy();
    expect(ev!.payload_json).toContain('"finality_class":"PROBABILISTIC"');
    expect(ev!.payload_json).toContain('"effective_required_confirmations":6');
  });

  it("a private chain is deterministic and caps the effective gate at 1", async () => {
    const htlcId = "HTLC-CC-PRIVATE";
    const inner = new Date(Date.now() + 12 * 3600_000).toISOString();
    const outer = new Date(Date.now() + 24 * 3600_000).toISOString();
    await createHtlc(
      {
        htlc_id: htlcId,
        idempotency_key: `IK-${htlcId}`,
        amount: { value: 10_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: "0010000001",
        payee_bank_id: BANK_B,
        payee_account_hash: "0020000001",
        timelock: outer,
        cross_chain: {
          source: "ONCHAIN:CONSORTIUM",
          onchain_timelock: inner,
          min_confirmations: 6,
        },
        onchain_chain_class: "PRIVATE",
        onchain_crypto_suite: "dilithium3",
      } as any,
      makeEnv(d1) as any
    );

    const row = await d1
      .prepare(
        `SELECT onchain_finality_class, onchain_quantum_risk FROM HtlcContracts WHERE htlc_id=?`
      )
      .bind(htlcId)
      .first<any>();
    expect(row.onchain_finality_class).toBe("DETERMINISTIC");
    expect(row.onchain_quantum_risk).toBe("RESISTANT");

    const ev = await d1
      .prepare(
        `SELECT payload_json FROM FinalityLog WHERE event_type='OnchainFinalityClassified' AND txid=?`
      )
      .bind(`TX-HTLC-${htlcId}`)
      .first<{ payload_json: string }>();
    expect(ev!.payload_json).toContain('"effective_required_confirmations":1');
  });

  it("does not emit a classification event when chain_class is absent", async () => {
    const htlcId = "HTLC-CC-NONE";
    await createHtlc(
      {
        htlc_id: htlcId,
        idempotency_key: `IK-${htlcId}`,
        amount: { value: 10_000, currency: "JPY" },
        payer_bank_id: BANK_A,
        payer_account_hash: "0010000001",
        payee_bank_id: BANK_B,
        payee_account_hash: "0020000001",
        timelock: new Date(Date.now() + 24 * 3600_000).toISOString(),
      } as any,
      makeEnv(d1) as any
    );
    const ev = await d1
      .prepare(`SELECT 1 FROM FinalityLog WHERE event_type='OnchainFinalityClassified' AND txid=?`)
      .bind(`TX-HTLC-${htlcId}`)
      .first();
    expect(ev).toBeFalsy();
  });
});
