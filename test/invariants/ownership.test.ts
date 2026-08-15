/**
 * @file ownership.test.ts — 単一所有者則 (single-owner rule) invariants
 *       (docs/specs/30_internal_design.md §5 単一所有者則).
 *
 * Every Transactions row carries exactly one `owner` allowed to move it:
 * 'ZC' | 'CYCLE:<cycle_id>' | 'VENUE:<venue_id>' | 'CHAIN:<watcher_set>'.
 * These tests pin the four layers of the rule:
 *
 *   1. STATIC GUARD — `owner` may only be written by the _helpers.ts
 *      primitives (transferOwnership / setColumns plumbing) and the two
 *      whitelisted DNS bulk sites (kickDns snapshot stamp, settleDns return).
 *      Lane/venue code hand-rolling `UPDATE Transactions ... owner=` would
 *      reopen the unaudited-handoff hole the column exists to close.
 *
 *   2. CHOKE-POINT GUARD — transitionWithLog / cancelInFlightTx throw
 *      OWNERSHIP_VIOLATION (unconditionally, `strict` notwithstanding) when
 *      `issuer !== owner`, table-driven over the owner kinds.
 *
 *   3. transferOwnership — CAS semantics (wrong fromOwner → {applied:false}),
 *      version bump, and a FinalityLog handoff entry that keeps the tx hash
 *      chain intact.
 *
 *   4. SWEEP PREDICATE — the timeout sweep abandons only `owner='ZC'` rows.
 *      The two two-ledger divergences (docs/specs/30_internal_design.md §5.1) (BOJ late settlement vs T3
 *      abandonment; DNS snapshot vs individual sweep) are recreated with the
 *      owner column ALONE (no dns_cycle_id / external_settlement_status
 *      seeded), proving the protection is structural, not predicate-listed.
 *      Plus the one-release old/new disagreement verification (Phase 3 step 2)
 *      and the HTLC outer-timelock lease-expiry reclaim (期限切れ→回収).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runTimeoutSweep } from "../../src/cron/timeout_sweep";
import { isDomainError } from "../../src/shared/errors";
import { buildSignedMessage, exportVerificationKey } from "../../src/shared/external_signature";
import {
  buildWatcherObservationPayload,
  type RecordWatcherObservationParams,
} from "../../src/shared/watcher";
import { verifyChain } from "../../src/zc/finality/finality_chain";
import {
  cancelInFlightTx,
  cycleOwner,
  OWNER_CHAIN_DEFAULT,
  OWNER_VENUE_BOJ,
  transferOwnership,
  transitionWithLog,
} from "../../src/zc/lanes/_helpers";
import { createHtlc, recordCrossChainLock } from "../../src/zc/lanes/htlc";
import { processQueueMessage } from "../../src/zc/orchestrator";
import { suspendTx, writeFinalityLog } from "../../src/zc/orchestrator/finality";
import { handleIgsCallback } from "../../src/zc/settlement/igs";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";

// ---------------------------------------------------------------------------
// 1. STATIC GUARD: raw `UPDATE Transactions ... owner=` only at the sanctioned sites
// ---------------------------------------------------------------------------

/**
 * Files permitted to issue a raw `UPDATE Transactions SET ... owner = ...`:
 *  - lanes/_helpers.ts       — transferOwnership CAS + cancelInFlightTx's
 *                              owner-return (the choke points themselves).
 *  - settlement/dns/cycle.ts — kickDns bulk snapshot stamp (owner='CYCLE:<id>'
 *                              in the same batch as the dns_cycle_id stamp; a
 *                              per-tx transferOwnership loop would add N log
 *                              round-trips the snapshot never had — docs/specs/30_internal_design.md §5).
 *  - settlement/dns/settle.ts— the symmetric bulk return to 'ZC' in the
 *                              SETTLED batch.
 * Everything else must hand off through transferOwnership or a
 * transitionWithLog `setColumns` (which commits under the ownership guard).
 */
const OWNER_UPDATE_ALLOWLIST = new Set<string>([
  "src/zc/lanes/_helpers.ts",
  "src/zc/settlement/dns/cycle.ts",
  "src/zc/settlement/dns/settle.ts",
]);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** True if the file text contains an `UPDATE Transactions ... SET ... owner = ...` write. */
function hasOwnerMutatingUpdate(src: string): boolean {
  const parts = src.split(/UPDATE\s+Transactions/i).slice(1);
  return parts.some((seg) => {
    const setClause = seg.split(/\bWHERE\b/i)[0] ?? seg;
    return /\bowner\s*=/.test(setClause);
  });
}

describe("invariant: raw owner-mutating UPDATE Transactions is confined to the sanctioned sites", () => {
  it("no file outside the allowlist hand-rolls an owner write", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles("src")) {
      const rel = file.replace(/\\/g, "/");
      if (OWNER_UPDATE_ALLOWLIST.has(rel)) continue;
      if (hasOwnerMutatingUpdate(readFileSync(file, "utf8"))) offenders.push(rel);
    }
    expect(
      offenders,
      `These files hand-roll 'UPDATE Transactions ... owner=', bypassing the ` +
        `single-owner handoff audit trail. Route them through transferOwnership or a ` +
        `transitionWithLog setColumns (see lanes/_helpers.ts).`
    ).toEqual([]);
  });

  it("the allowlist itself is honest — each allowlisted file really does contain one", () => {
    for (const rel of OWNER_UPDATE_ALLOWLIST) {
      expect(
        hasOwnerMutatingUpdate(readFileSync(rel, "utf8")),
        `${rel} is allowlisted but has no owner-mutating UPDATE`
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime fixtures
// ---------------------------------------------------------------------------

let d1: MockD1Database;

function makeEnv(db: MockD1Database): any {
  const sink: any[] = [];
  return {
    DB: db,
    QUEUE: { _sink: sink, send: async (m: any) => sink.push(m) },
    ZC_HMAC_SECRET: "test-secret",
  };
}

function seedParticipant(db: MockD1Database, bankId: string) {
  db.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', 10000000, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId)
    ._runSync();
}

function seedTx(
  db: MockD1Database,
  txid: string,
  opts: { state: string; owner?: string; lane?: string; updatedAt?: string }
) {
  db.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, owner, version, created_at, updated_at)
     VALUES (?, ?, ?, 40000, 'JPY', '001', '0010000001', '002', '0020000001',
             ?, '1.0', ?, 0, '2025-06-01T00:00:00Z', ?)`
  )
    .bind(
      txid,
      opts.lane ?? "STANDARD",
      opts.state,
      `IK-${txid}`,
      opts.owner ?? "ZC",
      opts.updatedAt ?? "2025-06-01T00:00:00Z"
    )
    ._runSync();
}

async function stateAndOwner(db: MockD1Database, txid: string) {
  return db
    .prepare(`SELECT state, owner, version FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ state: string; owner: string; version: number }>();
}

beforeEach(() => {
  ({ d1 } = createTestDb());
  seedParticipant(d1, "001");
  seedParticipant(d1, "002");
});

// ---------------------------------------------------------------------------
// 2. Choke-point guard: issuer must equal owner (table-driven)
// ---------------------------------------------------------------------------

describe("transitionWithLog / cancelInFlightTx — issuer must equal owner", () => {
  const VIOLATIONS: Array<{ name: string; owner: string; issuer?: string }> = [
    { name: "ZC-owned row + issuer 'CYCLE:x'", owner: "ZC", issuer: cycleOwner("x") },
    {
      name: "CYCLE-owned row + default issuer (ZC)",
      owner: cycleOwner("DNS-X"),
      issuer: undefined,
    },
    { name: "VENUE-owned row + default issuer (ZC)", owner: OWNER_VENUE_BOJ, issuer: undefined },
    {
      name: "CHAIN-owned row + default issuer (ZC)",
      owner: OWNER_CHAIN_DEFAULT,
      issuer: undefined,
    },
    { name: "VENUE-owned row + issuer 'CYCLE:x'", owner: OWNER_VENUE_BOJ, issuer: cycleOwner("x") },
  ];

  for (const v of VIOLATIONS) {
    it(`transition: ${v.name} → OWNERSHIP_VIOLATION (even with strict:false)`, async () => {
      seedTx(d1, "TX-OWN-T", { state: "DECIDED_TO_SETTLE", owner: v.owner });
      let caught: unknown;
      try {
        await transitionWithLog(d1 as any, {
          txid: "TX-OWN-T",
          fromState: "DECIDED_TO_SETTLE",
          toState: "PAYER_EXEC_CONFIRMED",
          eventType: "PayerExecConfirmed",
          ...(v.issuer !== undefined ? { issuer: v.issuer } : {}),
          strict: false, // the guard must throw anyway — invariant severity
        });
      } catch (e) {
        caught = e;
      }
      expect(isDomainError(caught) && caught.reason_code === "OWNERSHIP_VIOLATION").toBe(true);
      // Nothing moved, nothing logged.
      const row = await stateAndOwner(d1, "TX-OWN-T");
      expect(row?.state).toBe("DECIDED_TO_SETTLE");
      expect(row?.version).toBe(0);
      const logs = await d1
        .prepare(`SELECT COUNT(*) AS c FROM FinalityLog WHERE txid='TX-OWN-T'`)
        .first<{ c: number }>();
      expect(logs?.c).toBe(0);
    });
  }

  it("cancel: CYCLE-owned row + default issuer → OWNERSHIP_VIOLATION", async () => {
    seedTx(d1, "TX-OWN-C", { state: "RECEIVED", owner: cycleOwner("DNS-X") });
    await expect(
      cancelInFlightTx(d1 as any, { txid: "TX-OWN-C", reasonCode: "TEST_CANCEL" })
    ).rejects.toMatchObject({ reason_code: "OWNERSHIP_VIOLATION" });
    expect((await stateAndOwner(d1, "TX-OWN-C"))?.state).toBe("RECEIVED");
  });

  it("correct issuer succeeds and can return ownership in the same batch", async () => {
    seedTx(d1, "TX-OWN-OK", { state: "PAYER_EXEC_CONFIRMED", owner: OWNER_VENUE_BOJ });
    const res = await transitionWithLog(d1 as any, {
      txid: "TX-OWN-OK",
      fromState: "PAYER_EXEC_CONFIRMED",
      toState: "SUSPENDED",
      eventType: "Suspended",
      issuer: OWNER_VENUE_BOJ,
      setColumns: { owner: "ZC", reason_code: "IGS_FAILED" },
      payload: { reason: "IGS_FAILED" },
    });
    expect(res.applied).toBe(true);
    const row = await stateAndOwner(d1, "TX-OWN-OK");
    expect(row?.state).toBe("SUSPENDED");
    expect(row?.owner).toBe("ZC"); // ownership returned atomically with the exit
  });

  it("correct issuer on a cancel returns ownership to ZC in the canonical UPDATE", async () => {
    seedTx(d1, "TX-OWN-CC", { state: "RECEIVED", owner: OWNER_CHAIN_DEFAULT });
    const cancelled = await cancelInFlightTx(d1 as any, {
      txid: "TX-OWN-CC",
      reasonCode: "TEST_CANCEL",
      issuer: OWNER_CHAIN_DEFAULT,
      skipReleaseH: true,
    });
    expect(cancelled).toBe(true);
    const row = await stateAndOwner(d1, "TX-OWN-CC");
    expect(row?.state).toBe("CANCELLED");
    expect(row?.owner).toBe("ZC");
  });
});

// ---------------------------------------------------------------------------
// 3. transferOwnership — CAS + audited handoff
// ---------------------------------------------------------------------------

describe("transferOwnership", () => {
  it("wrong fromOwner loses the CAS: {applied:false}, nothing written", async () => {
    seedTx(d1, "TX-XFER-MISS", { state: "DECIDED_TO_SETTLE", owner: "ZC" });
    const res = await transferOwnership(d1 as any, {
      txid: "TX-XFER-MISS",
      fromOwner: OWNER_VENUE_BOJ, // wrong — the row is ZC-owned
      toOwner: "ZC",
    });
    expect(res).toEqual({ applied: false, previousOwner: "ZC" });
    const row = await stateAndOwner(d1, "TX-XFER-MISS");
    expect(row?.owner).toBe("ZC");
    expect(row?.version).toBe(0);
    const logs = await d1
      .prepare(`SELECT COUNT(*) AS c FROM FinalityLog WHERE txid='TX-XFER-MISS'`)
      .first<{ c: number }>();
    expect(logs?.c).toBe(0);
  });

  it("missing row: {applied:false, previousOwner:null}", async () => {
    const res = await transferOwnership(d1 as any, {
      txid: "TX-NOPE",
      fromOwner: "ZC",
      toOwner: OWNER_VENUE_BOJ,
    });
    expect(res).toEqual({ applied: false, previousOwner: null });
  });

  it("success bumps version and appends an OwnershipTransferred entry with an intact hash chain", async () => {
    seedTx(d1, "TX-XFER-OK", { state: "DECIDED_TO_SETTLE", owner: "ZC" });
    // Give the tx chain a prior entry so the handoff must correctly extend it.
    await writeFinalityLog(d1 as any, {
      txid: "TX-XFER-OK",
      event_type: "DecidedToSettle",
      state_from: "H_RESERVED",
      state_to: "DECIDED_TO_SETTLE",
      payload_json: JSON.stringify({ txid: "TX-XFER-OK" }),
      txid_or_gtid: "TX-XFER-OK",
    });

    const res = await transferOwnership(d1 as any, {
      txid: "TX-XFER-OK",
      fromOwner: "ZC",
      toOwner: cycleOwner("DNS-20260708"),
      payload: { reason: "TEST_HANDOFF" },
    });
    expect(res).toEqual({ applied: true, previousOwner: "ZC" });

    const row = await stateAndOwner(d1, "TX-XFER-OK");
    expect(row?.owner).toBe("CYCLE:DNS-20260708");
    expect(row?.version).toBe(1); // CAS bumped the optimistic lock

    const log = await d1
      .prepare(
        `SELECT event_type, state_from, state_to, payload_json FROM FinalityLog
         WHERE txid='TX-XFER-OK' AND event_type='OwnershipTransferred'`
      )
      .first<{ event_type: string; state_from: string; state_to: string; payload_json: string }>();
    expect(log).not.toBeNull();
    // A handoff moves custody, not the state machine.
    expect(log?.state_from).toBe("DECIDED_TO_SETTLE");
    expect(log?.state_to).toBe("DECIDED_TO_SETTLE");
    const payload = JSON.parse(log?.payload_json ?? "{}");
    expect(payload.from_owner).toBe("ZC");
    expect(payload.to_owner).toBe("CYCLE:DNS-20260708");

    const chain = await verifyChain(d1 as any, "TX-XFER-OK");
    expect(chain.valid).toBe(true);
    expect(chain.entries_checked).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4a. Sweep predicate: the two §5.1 divergences, via the owner column ALONE
// ---------------------------------------------------------------------------

describe("timeout sweep — owner predicate makes the §5.1 divergences structurally impossible", () => {
  const STALE = "2000-01-01T00:00:00Z";

  it("§5.1 divergence #1: a VENUE:BOJ-owned PAYER_EXEC_CONFIRMED row is not abandoned by T3 (owner alone, no status column)", async () => {
    // Deliberately NO external_settlement_status seeded — the owner column by
    // itself must keep T3 away (previously this depended on remembering the
    // `external_settlement_status != 'REQUESTED'` exclusion).
    seedTx(d1, "TX-B1-VENUE", {
      state: "PAYER_EXEC_CONFIRMED",
      owner: OWNER_VENUE_BOJ,
      lane: "HIGH_VALUE",
      updatedAt: STALE,
    });
    await runTimeoutSweep(makeEnv(d1));
    expect((await stateAndOwner(d1, "TX-B1-VENUE"))?.state).toBe("PAYER_EXEC_CONFIRMED");

    // …and even a direct suspend (the sweep's abandoning action) is a no-op.
    await suspendTx("TX-B1-VENUE", "SUSPEND_PAYEE_PROOF_TIMEOUT", d1 as any);
    expect((await stateAndOwner(d1, "TX-B1-VENUE"))?.state).toBe("PAYER_EXEC_CONFIRMED");
  });

  it("§5.1 divergence #2: a CYCLE-owned DECIDED_TO_SETTLE row is not abandoned by T2 (owner alone, no dns_cycle_id)", async () => {
    seedTx(d1, "TX-B2-CYCLE", {
      state: "DECIDED_TO_SETTLE",
      owner: cycleOwner("DNS-20260708"),
      lane: "STANDARD", // not T2-exempt: only the owner protects it
      updatedAt: STALE,
    });
    await runTimeoutSweep(makeEnv(d1));
    expect((await stateAndOwner(d1, "TX-B2-CYCLE"))?.state).toBe("DECIDED_TO_SETTLE");
  });

  it("positive controls: identical ZC-owned rows ARE swept", async () => {
    seedTx(d1, "TX-B1-ZC", { state: "PAYER_EXEC_CONFIRMED", owner: "ZC", updatedAt: STALE });
    seedTx(d1, "TX-B2-ZC", { state: "DECIDED_TO_SETTLE", owner: "ZC", updatedAt: STALE });
    await runTimeoutSweep(makeEnv(d1));
    expect((await stateAndOwner(d1, "TX-B1-ZC"))?.state).toBe("SUSPENDED");
    expect((await stateAndOwner(d1, "TX-B2-ZC"))?.state).toBe("SUSPENDED");
  });

  it("§5.1 divergence #1 end-to-end: the late BOJ SETTLED callback still lands after the sweep window", async () => {
    // Production shape: submission stamped REQUESTED + owner=VENUE:BOJ, the
    // BOJ callback lags past T3, the sweep fires, then the callback arrives.
    const env = makeEnv(d1);
    seedTx(d1, "TX-B1-E2E", {
      state: "PAYER_EXEC_CONFIRMED",
      owner: OWNER_VENUE_BOJ,
      lane: "HIGH_VALUE",
      updatedAt: STALE,
    });
    d1.prepare(
      `UPDATE Transactions SET external_settlement_status='REQUESTED', payee_account_hash='0020000001'
       WHERE txid='TX-B1-E2E'`
    )._runSync();
    d1.prepare(
      `INSERT INTO IgsRequests (ext_instruction_id, txid, payer_bank_id, payee_bank_id, amount_value, amount_currency, status, retry_count, requested_at)
       VALUES ('IGS-B1-E2E', 'TX-B1-E2E', '001', '002', 40000, 'JPY', 'REQUESTED', 0, '2025-06-01T00:00:00Z')`
    )._runSync();

    await runTimeoutSweep(env);
    expect((await stateAndOwner(d1, "TX-B1-E2E"))?.state).toBe("PAYER_EXEC_CONFIRMED");

    // The lagging callback settles the money leg: ownership returns to ZC and
    // the credit fans out — no payer-debited/payee-never-credited divergence.
    await handleIgsCallback(
      d1 as any,
      { ext_instruction_id: "IGS-B1-E2E", result: "SETTLED", boj_settle_ref: "BOJ-B1" },
      env
    );
    const after = await stateAndOwner(d1, "TX-B1-E2E");
    expect(after?.owner).toBe("ZC");
    expect(env.QUEUE._sink.some((m: any) => m.type === "ZC_BANK_CREDIT")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4b. One-release verification: old predicates vs owner column disagreement
// ---------------------------------------------------------------------------

describe("timeout sweep — owner/legacy-predicate divergence opens a CASE (one-release check)", () => {
  it("owner='ZC' with external_settlement_status='REQUESTED' is flagged exactly once", async () => {
    const env = makeEnv(d1);
    // Fresh updated_at: the row must be flagged, not swept.
    seedTx(d1, "TX-DIVERGE-1", {
      state: "PAYER_EXEC_CONFIRMED",
      owner: "ZC",
      lane: "HIGH_VALUE",
      updatedAt: new Date().toISOString(),
    });
    d1.prepare(
      `UPDATE Transactions SET external_settlement_status='REQUESTED' WHERE txid='TX-DIVERGE-1'`
    )._runSync();

    await runTimeoutSweep(env);
    await runTimeoutSweep(env); // second run must not duplicate the CASE

    const cases = await d1
      .prepare(
        `SELECT COUNT(*) AS c FROM Cases WHERE related_txid='TX-DIVERGE-1' AND reason_code='OWNER_PREDICATE_DIVERGENCE'`
      )
      .first<{ c: number }>();
    expect(cases?.c).toBe(1);
  });

  it("owner='ZC' with dns_cycle_id on a KICKED cycle is flagged; an OPEN cycle is not", async () => {
    const env = makeEnv(d1);
    for (const [cycleId, cycleState] of [
      ["DNS-DIV-KICKED", "KICKED"],
      ["DNS-DIV-OPEN", "OPEN"],
    ] as const) {
      d1.prepare(
        `INSERT INTO DnsCycles (cycle_id, business_date, state, igs_mode, currency, intraday_seq, created_at)
         VALUES (?, '2026-07-08', ?, 'NORMAL', 'JPY', 1, '2026-07-08T00:00:00Z')`
      )
        .bind(cycleId, cycleState)
        ._runSync();
    }
    seedTx(d1, "TX-DIVERGE-K", {
      state: "DECIDED_TO_SETTLE",
      owner: "ZC",
      lane: "BULK",
      updatedAt: new Date().toISOString(),
    });
    seedTx(d1, "TX-DIVERGE-O", {
      state: "DECIDED_TO_SETTLE",
      owner: "ZC",
      lane: "BULK",
      updatedAt: new Date().toISOString(),
    });
    d1.prepare(
      `UPDATE Transactions SET dns_cycle_id='DNS-DIV-KICKED' WHERE txid='TX-DIVERGE-K'`
    )._runSync();
    d1.prepare(
      `UPDATE Transactions SET dns_cycle_id='DNS-DIV-OPEN' WHERE txid='TX-DIVERGE-O'`
    )._runSync();

    await runTimeoutSweep(env);

    const flagged = await d1
      .prepare(
        `SELECT related_txid FROM Cases WHERE reason_code='OWNER_PREDICATE_DIVERGENCE' ORDER BY related_txid`
      )
      .all<{ related_txid: string }>();
    // Pre-attachment to a not-yet-kicked (OPEN) cycle is legitimate ZC custody.
    expect(flagged.results.map((r) => r.related_txid)).toEqual(["TX-DIVERGE-K"]);
  });
});

// ---------------------------------------------------------------------------
// 4c. HTLC outer-timelock lease expiry: reclaim (期限切れ→回収) then cancel
// ---------------------------------------------------------------------------

describe("HTLC cross-chain — outer-timelock lease expiry reclaims ownership then cancels", () => {
  async function generateKeyPair(): Promise<CryptoKeyPair> {
    return crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  }

  it("sweep: CHAIN:default → ZC (OwnershipReclaimed) → CANCELLED, end-to-end", async () => {
    const env = makeEnv(d1);
    const { privateKey, publicKey } = await generateKeyPair();
    await d1
      .prepare(
        `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
         VALUES ('KEY-WATCHER-OWN', 'EXTERNAL_RAIL', 'watcher-own-001', ?, 'ED25519', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
      )
      .bind(await exportVerificationKey(publicKey))
      .run();

    const timelock = new Date(Date.now() + 24 * 3600_000).toISOString();
    const onchainTimelock = new Date(Date.now() + 12 * 3600_000).toISOString();
    const created = await createHtlc(
      {
        htlc_id: "HTLC-OWN-1",
        idempotency_key: "IK-HTLC-OWN-1",
        amount: { value: 10_000, currency: "JPY" },
        payer_bank_id: "001",
        payer_account_hash: "0010000001",
        payee_bank_id: "002",
        payee_account_hash: "0020000001",
        timelock,
        cross_chain: { source: "ONCHAIN:ETH", onchain_timelock: onchainTimelock },
        onchain_chain_class: "PRIVATE",
      } as any,
      env
    );
    expect(created.result).toBe("CREATED");
    while (env.QUEUE._sink.length > 0) await processQueueMessage(env.QUEUE._sink.shift(), env);

    const lockParams: Omit<
      RecordWatcherObservationParams,
      "watcherKeyId" | "nonce" | "occurredAt" | "signatureB64"
    > = {
      source: "ONCHAIN:ETH",
      externalRef: "0xlock-own-1",
      venue: "ONCHAIN",
      proofType: "ONCHAIN_ESCROW_LOCK_PROOF",
      issuerRef: "002",
    };
    const occurredAt = new Date().toISOString();
    const message = buildSignedMessage(
      buildWatcherObservationPayload(lockParams),
      "KEY-WATCHER-OWN",
      "nonce-own-1",
      occurredAt
    );
    const signature = Buffer.from(
      await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message)
    ).toString("base64");

    const lockRes = await recordCrossChainLock(
      {
        htlc_id: "HTLC-OWN-1",
        external_ref: "0xlock-own-1",
        watcher_key_id: "KEY-WATCHER-OWN",
        nonce: "nonce-own-1",
        occurred_at: occurredAt,
        signature,
        idempotency_key: "IK-XC-LOCK-OWN-1",
      },
      env
    );
    expect(lockRes.state).toBe("HTLC_ONCHAIN_PENDING");

    const txid = (await d1
      .prepare(`SELECT txid FROM HtlcContracts WHERE htlc_id='HTLC-OWN-1'`)
      .first<{ txid: string }>())!.txid;
    // Entering HTLC_ONCHAIN_PENDING handed the row to the Watcher set.
    expect((await stateAndOwner(d1, txid))?.owner).toBe(OWNER_CHAIN_DEFAULT);

    // While the lease runs, ZC cannot abandon the row.
    await suspendTx(txid, "SUSPEND_EXEC_TIMEOUT", d1 as any);
    expect((await stateAndOwner(d1, txid))?.state).toBe("HTLC_ONCHAIN_PENDING");

    // The OUTER timelock — the lease's contractual expiry — passes.
    d1.prepare(
      `UPDATE HtlcContracts SET timelock='2000-01-01T00:00:00Z' WHERE htlc_id='HTLC-OWN-1'`
    )._runSync();

    await runTimeoutSweep(env);

    const after = await stateAndOwner(d1, txid);
    expect(after?.state).toBe("CANCELLED");
    expect(after?.owner).toBe("ZC");
    const htlcRow = await d1
      .prepare(`SELECT state FROM HtlcContracts WHERE htlc_id='HTLC-OWN-1'`)
      .first<{ state: string }>();
    expect(htlcRow?.state).toBe("DECIDED_CANCEL");

    // The reclaim is a first-class audit fact preceding the cancel.
    const events = await d1
      .prepare(
        `SELECT event_type, payload_json FROM FinalityLog WHERE txid=? ORDER BY event_seq ASC`
      )
      .bind(txid)
      .all<{ event_type: string; payload_json: string }>();
    const names = events.results.map((e) => e.event_type);
    expect(names).toContain("OwnershipReclaimed");
    expect(names.indexOf("OwnershipReclaimed")).toBeLessThan(names.indexOf("HtlcCancelled"));
    const reclaim = events.results.find((e) => e.event_type === "OwnershipReclaimed")!;
    expect(JSON.parse(reclaim.payload_json).reason).toBe("OUTER_TIMELOCK_EXPIRED");

    // The whole story — lock, handoff, reclaim, cancel — verifies as one chain.
    const chain = await verifyChain(d1 as any, txid);
    expect(chain.valid).toBe(true);
  });
});
