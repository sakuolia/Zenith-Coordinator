/**
 * @file finality_cosign_extension.test.ts — co-signing extended to GTID and DNS
 *       chains + the mandatory-cosign policy (30_internal_design.md § 7).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { writeFinalityLog } from "../../src/zc/orchestrator";
import {
  recordFinalityCosign,
  buildFinalityCosignPayload,
  cosignChainKind,
  setCosignPolicy,
  getCosignPolicy,
  checkCosignRequirement,
  resolveCosignBasis,
  createFinalityAnchor,
} from "../../src/zc/finality/finality_anchor";
import { buildSignedMessage, exportVerificationKey } from "../../src/shared/external_signature";

function b64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}
async function registerKey(
  db: MockD1Database,
  keyId: string,
  publicKey: CryptoKey,
  ownerRef: string
) {
  await db
    .prepare(
      `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
       VALUES (?, 'PARTICIPANT', ?, ?, 'ED25519', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
    )
    .bind(keyId, ownerRef, await exportVerificationKey(publicKey))
    .run();
}

let d1: MockD1Database;
let keys: Record<string, { priv: CryptoKey; pub: CryptoKey }> = {};

async function keyFor(bankId: string) {
  if (!keys[bankId]) {
    const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]);
    keys[bankId] = { priv: privateKey, pub: publicKey };
    await registerKey(d1, `KEY-${bankId}`, publicKey, bankId);
  }
  return keys[bankId]!;
}

async function cosign(chainId: string, bankId: string, nonce = "n1") {
  const { priv } = await keyFor(bankId);
  const entryHash = (await resolveCosignBasis(d1 as any, chainId)).entry_hash;
  const occurredAt = new Date().toISOString();
  const message = buildSignedMessage(
    buildFinalityCosignPayload({ chainId, entryHash }),
    `KEY-${bankId}`,
    nonce,
    occurredAt
  );
  const signatureB64 = b64(await crypto.subtle.sign({ name: "Ed25519" }, priv, message));
  return recordFinalityCosign(d1 as any, {
    chainId,
    participantId: bankId,
    signerKeyId: `KEY-${bankId}`,
    nonce,
    occurredAt,
    signatureB64,
  });
}

beforeEach(() => {
  ({ d1 } = createTestDb());
  keys = {};
});

describe("cosignChainKind", () => {
  it("classifies chain ids", () => {
    expect(cosignChainKind("TX-1")).toBe("TX");
    expect(cosignChainKind("GT-1")).toBe("GTID");
    expect(cosignChainKind("GTID-DNS-x")).toBe("GTID");
    expect(cosignChainKind("DNS-2025-06-18")).toBe("DNS");
    expect(cosignChainKind("GLOBAL")).toBeNull();
  });
});

describe("recordFinalityCosign — GTID chains", () => {
  beforeEach(async () => {
    // A GTID with two leg banks + a chain entry to co-sign.
    d1.prepare(
      `INSERT INTO GtidTransactions (gtid, state, initiator_bank_id, total_amount, leg_count, legs_ready_count, legs_settled_count, version, created_at, updated_at) VALUES ('GT-CS-1','GT_SETTLED','001',100,2,2,2,0,'t','t')`
    )._runSync();
    d1.prepare(
      `INSERT INTO GtidLegs (leg_id, gtid, role, bank_id, account_hash, amount_value, state, version, created_at, updated_at) VALUES ('L1','GT-CS-1','PAYER','001','a',100,'LEG_SETTLED',0,'t','t')`
    )._runSync();
    d1.prepare(
      `INSERT INTO GtidLegs (leg_id, gtid, role, bank_id, account_hash, amount_value, state, version, created_at, updated_at) VALUES ('L2','GT-CS-1','PAYEE','002','b',100,'LEG_SETTLED',0,'t','t')`
    )._runSync();
    await writeFinalityLog(d1 as any, {
      txid: null,
      event_type: "GtidSettled",
      state_from: "GT_DECIDED_TO_SETTLE",
      state_to: "GT_SETTLED",
      payload_json: "{}",
      txid_or_gtid: "GT-CS-1",
    });
  });

  it("a leg bank can co-sign the GTID chain and chain_kind is recorded", async () => {
    const row = await cosign("GT-CS-1", "001");
    expect(row.chain_kind).toBe("GTID");
    // Audit event lands on the GLOBAL chain (so it does not perturb the co-signed
    // chain's tip); identified by payload, not the gtid column.
    const ev = await d1
      .prepare(`SELECT payload_json FROM FinalityLog WHERE event_type='FinalityCosigned'`)
      .first<{ payload_json: string }>();
    expect(ev?.payload_json).toContain("GT-CS-1");
  });

  it("a non-party bank is rejected COSIGN_NOT_APPLICABLE", async () => {
    await keyFor("003");
    await expect(cosign("GT-CS-1", "003")).rejects.toMatchObject({
      reason_code: "COSIGN_NOT_APPLICABLE",
    });
  });
});

describe("recordFinalityCosign — DNS chains", () => {
  beforeEach(async () => {
    d1.prepare(
      `INSERT INTO DnsCycles (cycle_id, business_date, state, igs_mode, currency, intraday_seq, created_at) VALUES ('DNS-2025-06-18','2025-06-18','SETTLED','NORMAL','JPY',1,'t')`
    )._runSync();
    d1.prepare(
      `INSERT INTO DnsNetPositions (id, cycle_id, bank_id, gross_send, gross_receive, net_position, is_settled) VALUES ('p1','DNS-2025-06-18','001',100,0,-100,1)`
    )._runSync();
    d1.prepare(
      `INSERT INTO DnsNetPositions (id, cycle_id, bank_id, gross_send, gross_receive, net_position, is_settled) VALUES ('p2','DNS-2025-06-18','002',0,100,100,1)`
    )._runSync();
    await writeFinalityLog(d1 as any, {
      txid: null,
      event_type: "DnsSettled",
      state_from: "KICKED",
      state_to: "SETTLED",
      payload_json: "{}",
      txid_or_gtid: "DNS-2025-06-18",
    });
  });

  it("a net-position bank can co-sign the DNS cycle chain", async () => {
    const row = await cosign("DNS-2025-06-18", "002");
    expect(row.chain_kind).toBe("DNS");
  });
});

describe("CosignPolicy — mandatory co-signing", () => {
  beforeEach(async () => {
    d1.prepare(
      `INSERT INTO DnsCycles (cycle_id, business_date, state, igs_mode, currency, intraday_seq, created_at) VALUES ('DNS-2025-06-18','2025-06-18','SETTLED','NORMAL','JPY',1,'t')`
    )._runSync();
    d1.prepare(
      `INSERT INTO DnsNetPositions (id, cycle_id, bank_id, gross_send, gross_receive, net_position, is_settled) VALUES ('p1','DNS-2025-06-18','001',100,0,-100,1)`
    )._runSync();
    d1.prepare(
      `INSERT INTO DnsNetPositions (id, cycle_id, bank_id, gross_send, gross_receive, net_position, is_settled) VALUES ('p2','DNS-2025-06-18','002',0,100,100,1)`
    )._runSync();
    await writeFinalityLog(d1 as any, {
      txid: null,
      event_type: "DnsSettled",
      state_from: "KICKED",
      state_to: "SETTLED",
      payload_json: "{}",
      txid_or_gtid: "DNS-2025-06-18",
    });
  });

  it("set/get a policy", async () => {
    await setCosignPolicy(d1 as any, "DNS", { minCosigners: 2, isMandatory: true });
    const p = await getCosignPolicy(d1 as any, "DNS");
    expect(p?.min_cosigners).toBe(2);
    expect(p?.is_mandatory).toBe(1);
  });

  it("an unclassified / no-policy chain is trivially satisfied", async () => {
    const r = await checkCosignRequirement(d1 as any, "DNS-2025-06-18");
    expect(r.required).toBe(false);
    expect(r.satisfied).toBe(true);
  });

  it("a mandatory chain is satisfied only once enough distinct parties co-sign the basis entry", async () => {
    await setCosignPolicy(d1 as any, "DNS", { minCosigners: 2, isMandatory: true });

    let r = await checkCosignRequirement(d1 as any, "DNS-2025-06-18");
    expect(r.required).toBe(true);
    expect(r.satisfied).toBe(false); // 0 cosigners

    await cosign("DNS-2025-06-18", "001");
    r = await checkCosignRequirement(d1 as any, "DNS-2025-06-18");
    expect(r.cosign_count).toBe(1);
    expect(r.satisfied).toBe(false); // still short of 2

    await cosign("DNS-2025-06-18", "002");
    r = await checkCosignRequirement(d1 as any, "DNS-2025-06-18");
    expect(r.cosign_count).toBe(2);
    expect(r.satisfied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: the basis entry does not move, so a quorum can actually form.
//
// Co-signing used to be taken over the chain's *current tip*. A quorum is "k
// distinct parties over one hash", and the tip moves on every ordinary business
// append — so with any settlement traffic between two parties' signatures the
// count over any single hash could never exceed 1, and a mandatory policy of 2
// was unreachable. Every assertion below that involves an intervening append
// fails against that construction.
// ---------------------------------------------------------------------------
describe("co-sign basis entry (quorum survives ordinary appends)", () => {
  const TXID = "TX-BASIS-1";

  async function appendBusinessEvent(eventType: string, from: string, to: string) {
    await writeFinalityLog(d1 as any, {
      txid: TXID,
      event_type: eventType,
      state_from: from,
      state_to: to,
      payload_json: "{}",
      txid_or_gtid: TXID,
    });
  }

  beforeEach(async () => {
    d1.prepare(
      `INSERT INTO Transactions (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash, idempotency_key, created_at, updated_at)
       VALUES ('${TXID}','EXPRESS','PAYEE_EXEC_CONFIRMED',100,'JPY','001','a','002','b','idem-${TXID}','t','t')`
    )._runSync();
    await appendBusinessEvent("PaymentInitiated", null as unknown as string, "RECEIVED");
    await appendBusinessEvent("PayeeExecConfirmed", "PAYER_EXEC_CONFIRMED", "PAYEE_EXEC_CONFIRMED");
  });

  it("resolves the irreversibility entry (b), not the tip", async () => {
    const beforeAppend = await resolveCosignBasis(d1 as any, TXID);
    expect(beforeAppend.basis_kind).toBe("IRREVERSIBILITY");

    await appendBusinessEvent("Settled", "PAYEE_EXEC_CONFIRMED", "SETTLED");
    const afterAppend = await resolveCosignBasis(d1 as any, TXID);
    expect(afterAppend.entry_hash).toBe(beforeAppend.entry_hash);

    // ...and the tip really did move, so this is not a vacuous comparison.
    const { getChainTipHash } = await import("../../src/zc/finality/finality_chain");
    expect(await getChainTipHash(d1 as any, TXID)).not.toBe(afterAppend.entry_hash);
  });

  it("two parties reach quorum even when business events land between their signatures", async () => {
    await setCosignPolicy(d1 as any, "TX", { minCosigners: 2, isMandatory: true });

    await cosign(TXID, "001");
    expect((await checkCosignRequirement(d1 as any, TXID)).cosign_count).toBe(1);

    // The append that used to break the quorum.
    await appendBusinessEvent("Settled", "PAYEE_EXEC_CONFIRMED", "SETTLED");

    await cosign(TXID, "002");
    const r = await checkCosignRequirement(d1 as any, TXID);
    expect(r.cosign_count).toBe(2);
    expect(r.satisfied).toBe(true);
  });

  it("a satisfied quorum is not undone by later appends", async () => {
    await setCosignPolicy(d1 as any, "TX", { minCosigners: 2, isMandatory: true });
    await cosign(TXID, "001");
    await cosign(TXID, "002");
    expect((await checkCosignRequirement(d1 as any, TXID)).satisfied).toBe(true);

    await appendBusinessEvent("Settled", "PAYEE_EXEC_CONFIRMED", "SETTLED");
    await appendBusinessEvent("CaseOpened", "SETTLED", "SETTLED");

    const r = await checkCosignRequirement(d1 as any, TXID);
    expect(r.cosign_count).toBe(2);
    expect(r.satisfied).toBe(true);
  });

  it("falls back to the latest anchor when no irreversibility entry exists", async () => {
    const other = "TX-BASIS-2";
    d1.prepare(
      `INSERT INTO Transactions (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash, idempotency_key, created_at, updated_at)
       VALUES ('${other}','EXPRESS','PRECHECKED',100,'JPY','001','a','002','b','idem-${other}','t','t')`
    )._runSync();
    await writeFinalityLog(d1 as any, {
      txid: other,
      event_type: "PreCheckPassed",
      state_from: "RECEIVED",
      state_to: "PRECHECKED",
      payload_json: "{}",
      txid_or_gtid: other,
    });

    await expect(resolveCosignBasis(d1 as any, other)).rejects.toMatchObject({
      reason_code: "COSIGN_BASIS_NOT_FOUND",
    });

    const anchor = await createFinalityAnchor(d1 as any);
    const basis = await resolveCosignBasis(d1 as any, other);
    expect(basis.basis_kind).toBe("ANCHOR");
    expect(basis.anchor_id).toBe(anchor!.anchor_id);

    // The anchored basis is likewise immune to later appends.
    await writeFinalityLog(d1 as any, {
      txid: other,
      event_type: "HReservationPlaced",
      state_from: "PRECHECKED",
      state_to: "H_RESERVED",
      payload_json: "{}",
      txid_or_gtid: other,
    });
    expect((await resolveCosignBasis(d1 as any, other)).entry_hash).toBe(basis.entry_hash);
  });
});
