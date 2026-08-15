/**
 * @file cosign_enforcement.test.ts — the mandatory co-sign policy enforced
 *       through the *live* router, not just the unit helper.
 *
 * Proves the production wiring of FinalityCosign:
 *   1. ops sets a mandatory DNS co-sign policy via PUT /internal/cosign-policy/DNS
 *   2. GET /api/dns/:cycle/verify reports finality_confirmed=false (policy unmet)
 *   3. two net-position banks co-sign via POST /api/finality/cosign
 *   4. GET /api/dns/:cycle/verify now reports finality_confirmed=true
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { handleZcApi } from "../../src/router/zc";
import { handleInternal } from "../../src/router/internal";
import { writeFinalityLog } from "../../src/zc/orchestrator";
import { resolveCosignBasis } from "../../src/zc/finality/finality_anchor";
import { buildFinalityCosignPayload } from "../../src/zc/finality/finality_anchor";
import { buildSignedMessage, exportVerificationKey } from "../../src/shared/external_signature";

const CYCLE = "DNS-2026-06-30";
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

async function callVerify(): Promise<any> {
  const path = `/api/dns/${CYCLE}/verify`;
  // Chain verification is a party-scoped read (S-5/S-7): call it as the operator.
  const resp = await handleZcApi(
    new Request(`http://x${path}`, {
      headers: { "X-Cron-Secret": CRON_SECRET, "X-Purpose-Code": "P04" },
    }),
    path,
    "GET",
    env
  );
  return resp.json();
}

async function submitCosign(bankId: string): Promise<Response> {
  const { priv } = await keyFor(bankId);
  const chainId = CYCLE;
  const entryHash = (await resolveCosignBasis(d1 as any, chainId)).entry_hash;
  const occurredAt = new Date().toISOString();
  const nonce = `n-${bankId}`;
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

beforeEach(async () => {
  ({ d1 } = createTestDb());
  env = { DB: d1, CRON_SECRET, ZC_HMAC_SECRET: "test-secret" };
  for (const k of Object.keys(keys)) delete keys[k];

  d1.prepare(
    `INSERT INTO DnsCycles (cycle_id, business_date, state, igs_mode, currency, intraday_seq, created_at) VALUES (?, '2026-06-30','SETTLED','NORMAL','JPY',1,'t')`
  )
    .bind(CYCLE)
    ._runSync();
  d1.prepare(
    `INSERT INTO DnsNetPositions (id, cycle_id, bank_id, gross_send, gross_receive, net_position, is_settled) VALUES ('p1', ?, '001',100,0,-100,1)`
  )
    .bind(CYCLE)
    ._runSync();
  d1.prepare(
    `INSERT INTO DnsNetPositions (id, cycle_id, bank_id, gross_send, gross_receive, net_position, is_settled) VALUES ('p2', ?, '002',0,100,100,1)`
  )
    .bind(CYCLE)
    ._runSync();
  await writeFinalityLog(d1 as any, {
    txid: null,
    event_type: "DnsSettled",
    state_from: "KICKED",
    state_to: "SETTLED",
    payload_json: "{}",
    txid_or_gtid: CYCLE,
  });
});

describe("mandatory co-sign enforced through the live router", () => {
  it("verify reports finality_confirmed only after the policy is met", async () => {
    // No policy yet: hash chain is valid and finality is confirmed.
    let v = await callVerify();
    expect(v.valid).toBe(true);
    expect(v.cosign.required).toBe(false);
    expect(v.finality_confirmed).toBe(true);

    // Ops sets a mandatory DNS policy (2 distinct cosigners) via the internal API.
    const policyPath = "/internal/cosign-policy/DNS";
    const policyResp = await handleInternal(
      new Request(`http://x${policyPath}`, {
        method: "PUT",
        body: JSON.stringify({ min_cosigners: 2, is_mandatory: true }),
        headers: { "X-Cron-Secret": CRON_SECRET },
      }),
      policyPath,
      "PUT",
      env
    );
    expect(policyResp.status).toBe(200);

    // Now finality is NOT externally confirmed until cosigns arrive.
    v = await callVerify();
    expect(v.valid).toBe(true); // hash chain still intact
    expect(v.cosign.required).toBe(true);
    expect(v.cosign.satisfied).toBe(false);
    expect(v.finality_confirmed).toBe(false);

    // First bank co-signs: still short of the 2-of-N threshold.
    expect((await submitCosign("001")).status).toBe(200);
    v = await callVerify();
    expect(v.cosign.cosign_count).toBe(1);
    expect(v.finality_confirmed).toBe(false);

    // Second distinct bank co-signs: threshold met, finality confirmed.
    expect((await submitCosign("002")).status).toBe(200);
    v = await callVerify();
    expect(v.cosign.cosign_count).toBe(2);
    expect(v.cosign.satisfied).toBe(true);
    expect(v.finality_confirmed).toBe(true);
  });

  it("rejects a co-sign from a non-party bank (typed DomainError → mapped to 4xx by the top-level handler)", async () => {
    // The handler lets recordFinalityCosign's DomainError propagate; index.ts's
    // request-level catch turns it into the JSON error response in production.
    await expect(submitCosign("003")).rejects.toMatchObject({
      reason_code: "COSIGN_NOT_APPLICABLE",
    });
  });
});
