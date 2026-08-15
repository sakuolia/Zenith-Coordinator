/**
 * @file query_access.test.ts — the S-5 / S-7 gate on ZC reads.
 *
 * Two halves, deliberately in one file because they are one requirement
 * (`10_requirements.md` §8.5):
 *
 *  1. **Behaviour** — a read without a purpose code is blocked in real time
 *     (S-5), a participant reaches only rows it is a party to (S-7), and every
 *     decision lands in the Access Audit Log.
 *  2. **Coverage** — a static sweep asserting that every `GET /api/…` route in
 *     the router is either classified by the route table or listed as public
 *     with a reason. Without this, the next read endpoint is ungated *by
 *     omission* — the failure mode a per-route check cannot see.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { handleZcApi } from "../../src/router/zc";
import { classifyRead, isPublicRead, PUBLIC_READ_TABLE } from "../../src/zc/platform/access_routes";
import { participantAuthPayload } from "../../src/zc/platform/access";
import { buildSignedMessage, exportVerificationKey } from "../../src/shared/external_signature";

const CRON = "test-cron-secret";
let d1: MockD1Database;
let env: any;

function get(path: string, headers: Record<string, string> = {}) {
  return handleZcApi(new Request(`http://x${path}`, { headers }), path, "GET", env);
}

const asParticipant = (bankId: string, purpose = "P01") => ({
  "X-Bank-Id": bankId,
  "X-Purpose-Code": purpose,
});
const asOperator = (purpose = "P04") => ({ "X-Cron-Secret": CRON, "X-Purpose-Code": purpose });

function seedTx(txid: string, payer = "001", payee = "002") {
  d1.prepare(
    `INSERT INTO Transactions
       (txid, lane, state, amount_value, payer_bank_id, payer_account_hash,
        payee_bank_id, payee_account_hash, idempotency_key, created_at, updated_at)
     VALUES (?, 'STANDARD', 'SETTLED', 1000, ?, 'h:p', ?, 'h:q', ?, ?, ?)`
  )
    .bind(
      txid,
      payer,
      payee,
      `idem-${txid}`,
      "2026-07-30T00:00:00.000Z",
      "2026-07-30T00:00:00.000Z"
    )
    ._runSync();
}

async function auditRows() {
  const r = await d1.prepare(`SELECT * FROM AccessAuditLog ORDER BY rowid`).all<any>();
  return r.results ?? [];
}

beforeEach(() => {
  ({ d1 } = createTestDb());
  env = { DB: d1, ZC_HMAC_SECRET: "s", CRON_SECRET: CRON };
});

// ---------------------------------------------------------------------------
// S-5 — no read without a purpose code
// ---------------------------------------------------------------------------
describe("S-5: a read without a purpose code does not succeed", () => {
  it("blocks in real time (403) and never reaches the resource", async () => {
    seedTx("TX-1");
    const res = await get("/api/transactions/TX-1");
    expect(res.status).toBe(403);
    expect((await res.json()).reason_code).toBe("PURPOSE_CODE_REQUIRED");
  });

  it("blocks an unknown purpose code exactly like a missing one", async () => {
    seedTx("TX-1");
    const res = await get("/api/transactions/TX-1", {
      "X-Bank-Id": "001",
      "X-Purpose-Code": "P99",
    });
    expect(res.status).toBe(403);
  });

  it("blocks a purposeful but unidentified caller", async () => {
    seedTx("TX-1");
    const res = await get("/api/transactions/TX-1", { "X-Purpose-Code": "P01" });
    expect(res.status).toBe(403);
    expect((await res.json()).reason_code).toBe("REQUESTER_UNIDENTIFIED");
  });

  it("refuses before the lookup — a missing purpose code cannot reveal existence", async () => {
    const absent = await get("/api/transactions/TX-DOES-NOT-EXIST");
    seedTx("TX-1");
    const present = await get("/api/transactions/TX-1");
    expect(absent.status).toBe(present.status);
    expect(await absent.json()).toEqual(await present.json());
  });

  it("records the denial, and the DataAccessViolationDetected evidence", async () => {
    seedTx("TX-1");
    await get("/api/transactions/TX-1");
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("DENY");
    expect(rows[0].reason_code).toBe("PURPOSE_CODE_REQUIRED");
    expect(rows[0].subject_type).toBe("UNIDENTIFIED");

    const viol = await d1
      .prepare(
        `SELECT COUNT(*) AS n FROM FinalityLog WHERE event_type='DataAccessViolationDetected'`
      )
      .first<{ n: number }>();
    expect(viol?.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// S-7 — no cross-participant reach
// ---------------------------------------------------------------------------
describe("S-7: a participant reaches only what it is a party to", () => {
  it("permits the payer bank and the payee bank", async () => {
    seedTx("TX-1", "001", "002");
    expect((await get("/api/transactions/TX-1", asParticipant("001"))).status).toBe(200);
    expect((await get("/api/transactions/TX-1", asParticipant("002"))).status).toBe(200);
  });

  it("refuses a third bank with 404 — indistinguishable from a row that does not exist", async () => {
    seedTx("TX-1", "001", "002");
    const outsider = await get("/api/transactions/TX-1", asParticipant("003"));
    const absent = await get("/api/transactions/TX-NOPE", asParticipant("003"));
    expect(outsider.status).toBe(404);
    expect(absent.status).toBe(404);
    // Byte-identical: a 403 here would answer "it exists but is not yours",
    // which is the cross-participant fact S-7 forbids.
    expect(await outsider.json()).toEqual(await absent.json());
  });

  it("covers the derived views of a transaction, not just the row", async () => {
    seedTx("TX-1", "001", "002");
    for (const suffix of ["events", "explain", "story", "verify", "reversals"]) {
      const res = await get(`/api/transactions/TX-1/${suffix}`, asParticipant("003"));
      expect(res.status, suffix).toBe(404);
    }
  });

  it("lets the operator read across participants", async () => {
    seedTx("TX-1", "001", "002");
    expect((await get("/api/transactions/TX-1", asOperator())).status).toBe(200);
  });

  it("refuses participants the aggregate reads outright (§3.3.2.2.3)", async () => {
    for (const path of ["/api/transactions", "/api/gtid", "/api/htlc", "/api/events"]) {
      const res = await get(path, asParticipant("001", "P04"));
      expect(res.status, path).toBe(403);
      expect((await res.json()).reason_code).toBe("CROSS_PARTICIPANT_SCOPE");
    }
  });

  it("still serves the aggregate reads to the operator", async () => {
    expect((await get("/api/transactions", asOperator())).status).toBe(200);
    expect((await get("/api/events", asOperator())).status).toBe(200);
  });

  it("keeps the public status endpoint public — HOLD status is for every participant", async () => {
    // 20_method_design.md §9.4.4 (A): this response is deliberately identical for
    // all participants, so gating it would contradict the norm it implements.
    expect((await get("/api/dns/2026-07-30/status")).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Access Audit Log
// ---------------------------------------------------------------------------
describe("Access Audit Log records every decision", () => {
  it("records a permit with subject, purpose, and resource", async () => {
    seedTx("TX-1", "001", "002");
    await get("/api/transactions/TX-1", asParticipant("001", "P02"));
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject_type: "PARTICIPANT",
      // Asserted-only identity is marked as such in the ledger: bank 001 has no
      // registered participant key in this fixture, so the read is permitted but
      // recorded as unproven.
      subject_id: "001(unauthenticated)",
      purpose_code: "P02",
      resource: "transactions/TX-1",
      decision: "PERMIT",
      reason_code: null,
    });
  });

  it("records the non-party denial that the response deliberately hides", async () => {
    seedTx("TX-1", "001", "002");
    await get("/api/transactions/TX-1", asParticipant("003"));
    const rows = await auditRows();
    expect(rows[0]).toMatchObject({
      subject_id: "003(unauthenticated)",
      decision: "DENY",
      reason_code: "NOT_A_PARTY",
    });
  });

  it("does not fail the read when the audit write fails", async () => {
    // The log must not become an availability dependency of every query
    // (31_schema.md § AccessAuditLog).
    seedTx("TX-1", "001", "002");
    d1.prepare(`DROP TABLE AccessAuditLog`)._runSync();
    const res = await get("/api/transactions/TX-1", asParticipant("001"));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Coverage — no read escapes classification by omission
// ---------------------------------------------------------------------------
describe("every GET /api/… route is classified or explicitly public", () => {
  const router = readFileSync(join(process.cwd(), "src/router/zc.ts"), "utf8");

  /**
   * The `/api/…` paths the router serves **on GET**. Two forms appear:
   * a literal (`method === "GET" && path === "/api/x"`) and a pre-computed regex
   * match (`const m = path.match(/…/); if (method === "GET" && m)`). Both are
   * resolved to a concrete path with a token standing in for each parameter.
   */
  const getPaths = (): string[] => {
    const paths = new Set<string>();

    for (const m of router.matchAll(/method === "GET" && path === "(\/api\/[^"]*)"/g)) {
      paths.add(m[1]!);
    }

    // Named match variables used under a GET guard, resolved to their pattern.
    const guarded = new Set([...router.matchAll(/method === "GET" && (\w+)\b/g)].map((m) => m[1]!));
    for (const m of router.matchAll(/const (\w+) = path\.match\(\/\^([^;]+?)\$\/\)/g)) {
      if (!guarded.has(m[1]!)) continue;
      const concrete = m[2]!
        .replace(/\\\//g, "/")
        .replace(/\(\[\^\/\]\+\)/g, "X")
        .replace(/\[\^\/\]\+/g, "X");
      if (concrete.startsWith("/api/")) paths.add(concrete);
    }
    return [...paths];
  };

  it("classifies or exempts each one", () => {
    const paths = getPaths();
    expect(paths.length, "no GET routes parsed — has the router's shape changed?").toBeGreaterThan(
      10
    );
    const unclassified = paths.filter((p) => !classifyRead(p) && !isPublicRead(p));
    expect(
      unclassified.sort().join("\n"),
      "these GET /api paths are neither party-scoped nor declared public — " +
        "add a row to access_routes.ts (guarded) or PUBLIC_READS (with the reason it is public)"
    ).toBe("");
  });

  it("every public-read exemption carries a reason", () => {
    for (const row of PUBLIC_READ_TABLE) {
      expect(row.why.length, String(row.pattern)).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// The subject is bound to a credential (requirement S-7)
// ---------------------------------------------------------------------------
/**
 * `X-Bank-Id` on its own is a claim, not an identity — anyone can type another
 * bank's id, which would make the party check above decorative. A participant
 * proves the id by signing the request with a `KeyRegistry` key
 * (`owner_type='PARTICIPANT'`).
 *
 * The property that matters here is *who decides whether proof is required*: it
 * is the registry, not the caller. A bank with a registered key cannot go back
 * to asserting by dropping the header.
 */
describe("participant identity is bound to a KeyRegistry credential", () => {
  const b64 = (buf: ArrayBuffer) => Buffer.from(new Uint8Array(buf)).toString("base64");

  async function registerKey(bankId: string, keyId = `KEY-${bankId}`) {
    const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]);
    await d1
      .prepare(
        `INSERT INTO KeyRegistry (key_id, owner_type, owner_ref, public_key, algo, valid_from, valid_to, revoked_at, status, created_at)
         VALUES (?, 'PARTICIPANT', ?, ?, 'ED25519', '2020-01-01T00:00:00.000Z', NULL, NULL, 'ACTIVE', '2020-01-01T00:00:00.000Z')`
      )
      .bind(keyId, bankId, await exportVerificationKey(publicKey))
      .run();
    return { privateKey, keyId };
  }

  async function signedHeaders(
    priv: CryptoKey,
    keyId: string,
    bankId: string,
    path: string,
    purpose = "P01",
    nonce = `n-${Math.random()}`
  ) {
    const occurredAt = new Date().toISOString();
    const message = buildSignedMessage(
      participantAuthPayload({ method: "GET", path, bankId, purposeCode: purpose }),
      keyId,
      nonce,
      occurredAt
    );
    return {
      "X-Bank-Id": bankId,
      "X-Purpose-Code": purpose,
      "X-Participant-Key-Id": keyId,
      "X-Participant-Sig-Nonce": nonce,
      "X-Participant-Sig-Time": occurredAt,
      "X-Participant-Signature": b64(await crypto.subtle.sign({ name: "Ed25519" }, priv, message)),
    };
  }

  it("permits a correctly signed read and records it as authenticated", async () => {
    seedTx("TX-1", "001", "002");
    const { privateKey, keyId } = await registerKey("001");
    const res = await get(
      "/api/transactions/TX-1",
      await signedHeaders(privateKey, keyId, "001", "transactions/TX-1")
    );
    expect(res.status).toBe(200);
    const rows = await auditRows();
    expect(rows[0].subject_id).toBe("001"); // no "(unauthenticated)" marker
  });

  it("refuses an unsigned read once the bank has a registered key", async () => {
    seedTx("TX-1", "001", "002");
    await registerKey("001");
    const res = await get("/api/transactions/TX-1", asParticipant("001"));
    expect(res.status).toBe(403);
    expect((await res.json()).reason_code).toBe("PARTICIPANT_SIGNATURE_REQUIRED");
  });

  it("still permits an unsigned read for a bank with no registered key (migration)", async () => {
    seedTx("TX-1", "001", "002");
    await registerKey("002"); // a *different* bank migrating does not break 001
    const res = await get("/api/transactions/TX-1", asParticipant("001"));
    expect(res.status).toBe(200);
  });

  it("refuses a signature made with another bank's key — the core impersonation", async () => {
    seedTx("TX-1", "001", "002");
    const evil = await registerKey("003", "KEY-003");
    await registerKey("001");
    // 003 signs correctly, but claims to be 001.
    const headers = await signedHeaders(evil.privateKey, evil.keyId, "001", "transactions/TX-1");
    const res = await get("/api/transactions/TX-1", headers);
    expect(res.status).toBe(403);
    expect((await res.json()).reason_code).toBe("PARTICIPANT_SIGNATURE_INVALID");
  });

  it("refuses a signature lifted onto a different request", async () => {
    seedTx("TX-1", "001", "002");
    seedTx("TX-2", "001", "002");
    const { privateKey, keyId } = await registerKey("001");
    // Signed for TX-1, replayed against TX-2: the path is inside the payload.
    const headers = await signedHeaders(privateKey, keyId, "001", "transactions/TX-1");
    const res = await get("/api/transactions/TX-2", headers);
    expect(res.status).toBe(403);
  });

  it("refuses a replayed nonce", async () => {
    seedTx("TX-1", "001", "002");
    const { privateKey, keyId } = await registerKey("001");
    const headers = await signedHeaders(
      privateKey,
      keyId,
      "001",
      "transactions/TX-1",
      "P01",
      "fixed-nonce"
    );
    expect((await get("/api/transactions/TX-1", headers)).status).toBe(200);
    expect((await get("/api/transactions/TX-1", headers)).status).toBe(403);
  });

  it("leaves the operator path untouched", async () => {
    seedTx("TX-1", "001", "002");
    await registerKey("001");
    expect((await get("/api/transactions/TX-1", asOperator())).status).toBe(200);
  });
});
