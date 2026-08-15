/**
 * @file cosign_router.test.ts — FinalityCosign live-router coverage for TX and
 *       GTID chains, the policy GET endpoint, and idempotent re-cosigning.
 *
 * Complements cosign_enforcement.test.ts (DNS) so all three co-signable chain
 * kinds (TX/GTID/DNS) are exercised through the production router, not just the
 * unit helpers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { handleZcApi } from "../../src/router/zc";
import { handleInternal } from "../../src/router/internal";
import { writeFinalityLog } from "../../src/zc/orchestrator";
import { resolveCosignBasis } from "../../src/zc/finality/finality_anchor";
import { buildFinalityCosignPayload } from "../../src/zc/finality/finality_anchor";
import { buildSignedMessage, exportVerificationKey } from "../../src/shared/external_signature";

const CRON_SECRET = "test-cron-secret";

let d1: MockD1Database;
let env: any;
const keys: Record<string, { priv: CryptoKey; pub: CryptoKey }> = {};

function b64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

async function keyFor(bankId: string) {
  if (!keys[bankId]) {
    const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]);
    keys[bankId] = { priv: privateKey, pub: publicKey };
    await d1
      .prepare(
        `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
         VALUES (?, 'PARTICIPANT', ?, ?, 'ED25519', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
      )
      .bind(`KEY-${bankId}`, bankId, await exportVerificationKey(publicKey))
      .run();
  }
  return keys[bankId]!;
}

async function setPolicy(kind: "TX" | "GTID" | "DNS", minCosigners: number, mandatory: boolean) {
  const path = `/internal/cosign-policy/${kind}`;
  return handleInternal(
    new Request(`http://x${path}`, {
      method: "PUT",
      body: JSON.stringify({ min_cosigners: minCosigners, is_mandatory: mandatory }),
      headers: { "X-Cron-Secret": CRON_SECRET },
    }),
    path,
    "PUT",
    env
  );
}

async function getPolicy(kind: "TX" | "GTID" | "DNS"): Promise<any> {
  const path = `/internal/cosign-policy/${kind}`;
  const resp = await handleInternal(
    new Request(`http://x${path}`, { headers: { "X-Cron-Secret": CRON_SECRET } }),
    path,
    "GET",
    env
  );
  return resp.json();
}

async function verify(verifyPath: string): Promise<any> {
  // Chain verification is a party-scoped read (S-5/S-7): call it as the operator.
  const resp = await handleZcApi(
    new Request(`http://x${verifyPath}`, {
      headers: { "X-Cron-Secret": CRON_SECRET, "X-Purpose-Code": "P04" },
    }),
    verifyPath,
    "GET",
    env
  );
  return resp.json();
}

async function cosign(chainId: string, bankId: string, nonce = `n-${bankId}`): Promise<Response> {
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
  const body = JSON.stringify({
    chainId,
    participantId: bankId,
    signerKeyId: `KEY-${bankId}`,
    nonce,
    occurredAt,
    signatureB64,
  });
  const path = "/api/finality/cosign";
  return handleZcApi(new Request(`http://x${path}`, { method: "POST", body }), path, "POST", env);
}

beforeEach(() => {
  ({ d1 } = createTestDb());
  env = { DB: d1, CRON_SECRET, ZC_HMAC_SECRET: "test-secret" };
  for (const k of Object.keys(keys)) delete keys[k];
});

describe("co-sign enforcement on a TX chain (live router)", () => {
  const TXID = "TX-CS-LIVE-1";
  beforeEach(async () => {
    d1.prepare(
      `INSERT INTO Transactions (txid, lane, state, amount_value, amount_currency, payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash, idempotency_key, created_at, updated_at)
       VALUES (?, 'EXPRESS', 'SETTLED', 5000, 'JPY', '001', 'h:payer', '002', 'h:payee', ?, 't', 't')`
    )
      .bind(TXID, `idem-${TXID}`)
      ._runSync();
    // b (PAYEE_EXEC_CONFIRMED) is the co-sign basis entry for a TX chain; the
    // Settled entry after it is exactly the kind of ordinary append that used to
    // move the signed hash out from under a quorum.
    await writeFinalityLog(d1 as any, {
      txid: TXID,
      event_type: "PayeeExecConfirmed",
      state_from: "PAYER_EXEC_CONFIRMED",
      state_to: "PAYEE_EXEC_CONFIRMED",
      payload_json: "{}",
      txid_or_gtid: TXID,
    });
    await writeFinalityLog(d1 as any, {
      txid: TXID,
      event_type: "Settled",
      state_from: "PAYEE_EXEC_CONFIRMED",
      state_to: "SETTLED",
      payload_json: "{}",
      txid_or_gtid: TXID,
    });
  });

  it("payer + payee must co-sign before finality_confirmed flips true", async () => {
    await setPolicy("TX", 2, true);
    const vpath = `/api/transactions/${TXID}/verify`;

    let v = await verify(vpath);
    expect(v.valid).toBe(true);
    expect(v.cosign.required).toBe(true);
    expect(v.finality_confirmed).toBe(false);

    expect((await cosign(TXID, "001")).status).toBe(200); // payer
    expect((await verify(vpath)).finality_confirmed).toBe(false);

    expect((await cosign(TXID, "002")).status).toBe(200); // payee
    v = await verify(vpath);
    expect(v.cosign.cosign_count).toBe(2);
    expect(v.finality_confirmed).toBe(true);
  });

  it("a re-cosign by the same party over the same tip is idempotent (no double count)", async () => {
    await setPolicy("TX", 2, true);
    expect((await cosign(TXID, "001", "same-nonce")).status).toBe(200);
    expect((await cosign(TXID, "001", "same-nonce")).status).toBe(200); // repeat

    const v = await verify(`/api/transactions/${TXID}/verify`);
    expect(v.cosign.cosign_count).toBe(1); // still one distinct participant
    expect(v.finality_confirmed).toBe(false);
  });
});

describe("co-sign enforcement on a GTID chain (live router)", () => {
  const GTID = "GT-CS-LIVE-1";
  beforeEach(async () => {
    d1.prepare(
      `INSERT INTO GtidTransactions (gtid, state, initiator_bank_id, total_amount, leg_count, legs_ready_count, legs_settled_count, version, created_at, updated_at)
       VALUES (?, 'GT_SETTLED', '001', 100, 2, 2, 2, 0, 't', 't')`
    )
      .bind(GTID)
      ._runSync();
    d1.prepare(
      `INSERT INTO GtidLegs (leg_id, gtid, role, bank_id, account_hash, amount_value, state, version, created_at, updated_at)
       VALUES ('L1', ?, 'PAYER', '001', 'a', 100, 'LEG_SETTLED', 0, 't', 't')`
    )
      .bind(GTID)
      ._runSync();
    d1.prepare(
      `INSERT INTO GtidLegs (leg_id, gtid, role, bank_id, account_hash, amount_value, state, version, created_at, updated_at)
       VALUES ('L2', ?, 'PAYEE', '002', 'b', 100, 'LEG_SETTLED', 0, 't', 't')`
    )
      .bind(GTID)
      ._runSync();
    await writeFinalityLog(d1 as any, {
      txid: null,
      event_type: "GtidSettled",
      state_from: "GT_DECIDED_TO_SETTLE",
      state_to: "GT_SETTLED",
      payload_json: "{}",
      txid_or_gtid: GTID,
    });
  });

  it("both leg banks must co-sign before finality_confirmed flips true", async () => {
    await setPolicy("GTID", 2, true);
    const vpath = `/api/gtid/${GTID}/verify`;

    expect((await verify(vpath)).finality_confirmed).toBe(false);
    expect((await cosign(GTID, "001")).status).toBe(200);
    expect((await verify(vpath)).finality_confirmed).toBe(false);
    expect((await cosign(GTID, "002")).status).toBe(200);

    const v = await verify(vpath);
    expect(v.cosign.chain_kind).toBe("GTID");
    expect(v.cosign.cosign_count).toBe(2);
    expect(v.finality_confirmed).toBe(true);
  });
});

describe("cosign policy GET endpoint", () => {
  it("returns a not-mandatory default before any policy is set, then the stored policy", async () => {
    const before = await getPolicy("TX");
    expect(before.is_mandatory).toBe(0);

    await setPolicy("TX", 3, true);
    const after = await getPolicy("TX");
    expect(after.min_cosigners).toBe(3);
    expect(after.is_mandatory).toBe(1);
  });
});
