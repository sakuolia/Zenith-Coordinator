/**
 * @file RTP (Request-to-Pay) lane lifecycle tests.
 *
 * Covers (single state column after the RTP consolidation):
 * - registerRtpRequest: REGISTERED vs DUPLICATE
 * - registerRtpRequest: state transitions (CREATED → NOTIFIED)
 * - attemptRtp: NOTIFIED → TX_CREATED (happy path)
 * - attemptRtp: expired RTP → EXPIRED
 * - attemptRtp: max_attempts exceeded → FAILED
 * - attemptRtp: already non-CREATED/NOTIFIED state → false
 * - respondToRtp: ACCEPTED → TX_CREATED + linked transaction created
 * - respondToRtp: REJECTED → DECLINED
 * - respondToRtp: already responded → ALREADY_RESPONDED
 * - respondToRtp: expired → EXPIRED
 * - settleRtp: marks RTP as COMPLETED
 * - expireRtpRequests: cron-based batch expiration
 * - getRtpStatus: returns the canonical state directly
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  registerRtpRequest,
  attemptRtp,
  respondToRtp,
  settleRtp,
  expireRtpRequests,
  getRtpStatus,
} from "../../src/zc/lanes/rtp";

// ---------------------------------------------------------------------------
// Env mock
// ---------------------------------------------------------------------------
function makeEnv(db: MockD1Database): any {
  return {
    DB: db,
    QUEUE: { send: async () => {} },
    ZC_HMAC_SECRET: "test-secret",
  };
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------
const PAYER_BANK = "001";
const PAYEE_BANK = "002";
const PAYER_ACCOUNT = "0010000001";
const PAYEE_ACCOUNT = "0020000001";
const FUTURE_EXPIRY = "2099-12-31T00:00:00Z";
const PAST_EXPIRY = "2000-01-01T00:00:00Z";

let d1: MockD1Database;

function seedParticipants(db: MockD1Database) {
  for (const bankId of [PAYER_BANK, PAYEE_BANK]) {
    db.prepare(
      `INSERT OR REPLACE INTO Participants
       (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
       VALUES (?, 'Test Bank', '/bank/${bankId}', 1000000, 0, 1, '2025-01-01T00:00:00Z')`
    )
      .bind(bankId)
      ._runSync();
  }
}

function seedAccounts(db: MockD1Database) {
  for (const [bankId, accountId] of [
    [PAYER_BANK, PAYER_ACCOUNT],
    [PAYEE_BANK, PAYEE_ACCOUNT],
  ]) {
    db.prepare(
      `INSERT OR IGNORE INTO BankAccounts
       (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, ?, 'Test User', 'SAVINGS', 'NORMAL', '2025-01-01T00:00:00Z')`
    )
      .bind(accountId, bankId, `CUST-${accountId}`)
      ._runSync();
  }
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  seedParticipants(d1);
  seedAccounts(d1);
});

// ---------------------------------------------------------------------------
// registerRtpRequest
// ---------------------------------------------------------------------------

describe("registerRtpRequest — REGISTERED vs DUPLICATE", () => {
  it("returns REGISTERED on first call", async () => {
    const result = await registerRtpRequest(
      d1 as any,
      "RTP-001",
      PAYEE_BANK,
      PAYER_BANK,
      { value: 50_000, currency: "JPY" },
      FUTURE_EXPIRY,
      "IK-RTP-001",
      { payeeName: "Test Payee", description: "Invoice #42" },
      makeEnv(d1)
    );
    expect(result.result).toBe("REGISTERED");
    expect(result.rtpId).toBe("RTP-001");
  });

  it("returns DUPLICATE on second call with same rtp_id", async () => {
    await registerRtpRequest(
      d1 as any,
      "RTP-DUP-001",
      PAYEE_BANK,
      PAYER_BANK,
      { value: 10_000, currency: "JPY" },
      FUTURE_EXPIRY,
      "IK-DUP-001",
      {},
      makeEnv(d1)
    );
    const second = await registerRtpRequest(
      d1 as any,
      "RTP-DUP-001",
      PAYEE_BANK,
      PAYER_BANK,
      { value: 10_000, currency: "JPY" },
      FUTURE_EXPIRY,
      "IK-DUP-001",
      {},
      makeEnv(d1)
    );
    expect(second.result).toBe("DUPLICATE");
  });

  it("creates RtpRequests row with NOTIFIED state after bank notification", async () => {
    await registerRtpRequest(
      d1 as any,
      "RTP-ROW-001",
      PAYEE_BANK,
      PAYER_BANK,
      { value: 30_000, currency: "JPY" },
      FUTURE_EXPIRY,
      "IK-ROW-001",
      {},
      makeEnv(d1)
    );
    const row = await d1
      .prepare(`SELECT state FROM RtpRequests WHERE rtp_id=?`)
      .bind("RTP-ROW-001")
      .first<{ state: string }>();
    expect(row?.state).toBe("NOTIFIED");
  });

  it("sets notified_at after bank notification", async () => {
    await registerRtpRequest(
      d1 as any,
      "RTP-NOTIF-001",
      PAYEE_BANK,
      PAYER_BANK,
      { value: 20_000, currency: "JPY" },
      FUTURE_EXPIRY,
      "IK-NOTIF-001",
      {},
      makeEnv(d1)
    );
    const row = await d1
      .prepare(`SELECT state, notified_at FROM RtpRequests WHERE rtp_id=?`)
      .bind("RTP-NOTIF-001")
      .first<{ state: string; notified_at: string | null }>();
    expect(row?.state).toBe("NOTIFIED");
    expect(row?.notified_at).toBeTruthy();
  });

  it("writes RtpRequested FinalityLog entry", async () => {
    await registerRtpRequest(
      d1 as any,
      "RTP-LOG-001",
      PAYEE_BANK,
      PAYER_BANK,
      { value: 15_000, currency: "JPY" },
      FUTURE_EXPIRY,
      "IK-LOG-001",
      {},
      makeEnv(d1)
    );
    const log = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE event_type='RtpRequested' LIMIT 1`)
      .first<{ event_type: string }>();
    expect(log).not.toBeNull();
  });

  it("stores optional fields (payeeName, description, ediRef, payeeAccountHash)", async () => {
    await registerRtpRequest(
      d1 as any,
      "RTP-OPT-001",
      PAYEE_BANK,
      PAYER_BANK,
      { value: 5_000, currency: "JPY" },
      FUTURE_EXPIRY,
      "IK-OPT-001",
      {
        payeeName: "Acme Corp",
        description: "Monthly fee",
        ediRef: "EDI-123",
        payeeAccountHash: PAYEE_ACCOUNT,
      },
      makeEnv(d1)
    );
    const row = await d1
      .prepare(
        `SELECT payee_name, description, edi_ref, payee_account_hash FROM RtpRequests WHERE rtp_id=?`
      )
      .bind("RTP-OPT-001")
      .first<{
        payee_name: string | null;
        description: string | null;
        edi_ref: string | null;
        payee_account_hash: string | null;
      }>();
    expect(row?.payee_name).toBe("Acme Corp");
    expect(row?.description).toBe("Monthly fee");
    expect(row?.edi_ref).toBe("EDI-123");
    expect(row?.payee_account_hash).toBe(PAYEE_ACCOUNT);
  });
});

// ---------------------------------------------------------------------------
// attemptRtp
// ---------------------------------------------------------------------------

describe("attemptRtp", () => {
  async function seedNotifiedRtp(rtpId: string) {
    d1.prepare(
      `INSERT INTO RtpRequests
       (rtp_id, payee_bank_id, payer_bank_id, amount_value, state,
        attempt_count, max_attempts, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 25000, 'NOTIFIED', 0, 3, ?, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`
    )
      .bind(rtpId, PAYEE_BANK, PAYER_BANK, FUTURE_EXPIRY)
      ._runSync();
  }

  it("returns true and transitions to TX_CREATED", async () => {
    await seedNotifiedRtp("RTP-ATT-001");
    const ok = await attemptRtp("RTP-ATT-001", "TX-LINKED-001", makeEnv(d1));
    expect(ok).toBe(true);

    const row = await d1
      .prepare(`SELECT state, linked_txid, attempt_count FROM RtpRequests WHERE rtp_id=?`)
      .bind("RTP-ATT-001")
      .first<{ state: string; linked_txid: string; attempt_count: number }>();
    expect(row?.state).toBe("TX_CREATED");
    expect(row?.linked_txid).toBe("TX-LINKED-001");
    expect(row?.attempt_count).toBe(1);
  });

  it("returns false for unknown rtp_id", async () => {
    const ok = await attemptRtp("RTP-UNKNOWN", "TX-001", makeEnv(d1));
    expect(ok).toBe(false);
  });

  it("returns false and marks EXPIRED when RTP has passed expires_at", async () => {
    d1.prepare(
      `INSERT INTO RtpRequests
       (rtp_id, payee_bank_id, payer_bank_id, amount_value, state,
        attempt_count, max_attempts, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 10000, 'NOTIFIED', 0, 3, ?, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`
    )
      .bind("RTP-EXP-001", PAYEE_BANK, PAYER_BANK, PAST_EXPIRY)
      ._runSync();

    const ok = await attemptRtp("RTP-EXP-001", "TX-EXP-LINK", makeEnv(d1));
    expect(ok).toBe(false);

    const row = await d1
      .prepare(`SELECT state FROM RtpRequests WHERE rtp_id=?`)
      .bind("RTP-EXP-001")
      .first<{ state: string }>();
    expect(row?.state).toBe("EXPIRED");
  });

  it("returns false and marks FAILED when max_attempts reached", async () => {
    d1.prepare(
      `INSERT INTO RtpRequests
       (rtp_id, payee_bank_id, payer_bank_id, amount_value, state,
        attempt_count, max_attempts, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 10000, 'NOTIFIED', 3, 3, ?, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`
    )
      .bind("RTP-MAX-001", PAYEE_BANK, PAYER_BANK, FUTURE_EXPIRY)
      ._runSync();

    const ok = await attemptRtp("RTP-MAX-001", "TX-MAX-LINK", makeEnv(d1));
    expect(ok).toBe(false);

    const row = await d1
      .prepare(`SELECT state FROM RtpRequests WHERE rtp_id=?`)
      .bind("RTP-MAX-001")
      .first<{ state: string }>();
    expect(row?.state).toBe("FAILED");
  });

  it("returns false when RTP is already in TX_CREATED state", async () => {
    d1.prepare(
      `INSERT INTO RtpRequests
       (rtp_id, payee_bank_id, payer_bank_id, amount_value, state,
        attempt_count, max_attempts, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 10000, 'TX_CREATED', 1, 3, ?, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`
    )
      .bind("RTP-ATT-DUP-001", PAYEE_BANK, PAYER_BANK, FUTURE_EXPIRY)
      ._runSync();

    const ok = await attemptRtp("RTP-ATT-DUP-001", "TX-DUP", makeEnv(d1));
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// respondToRtp
// ---------------------------------------------------------------------------

describe("respondToRtp", () => {
  async function registerRtp(rtpId: string, expiresAt = FUTURE_EXPIRY) {
    await registerRtpRequest(
      d1 as any,
      rtpId,
      PAYEE_BANK,
      PAYER_BANK,
      { value: 50_000, currency: "JPY" },
      expiresAt,
      `IK-${rtpId}`,
      { payeeAccountHash: PAYEE_ACCOUNT },
      makeEnv(d1)
    );
  }

  it("ACCEPTED: creates a linked Transaction and returns txid", async () => {
    await registerRtp("RTP-RESP-ACC-001");
    const result = await respondToRtp(
      d1 as any,
      "RTP-RESP-ACC-001",
      {
        response: "ACCEPTED",
        payer_account_id: PAYER_ACCOUNT,
        idempotency_key: "IK-RESP-ACC-001",
      },
      makeEnv(d1)
    );

    expect(result.result).toBe("ACCEPTED");
    expect(result.txid).toBeTruthy();

    // Verify linked Transaction was created
    const tx = await d1
      .prepare(`SELECT lane, state, amount_value FROM Transactions WHERE txid=?`)
      .bind(result.txid!)
      .first<{ lane: string; state: string; amount_value: number }>();
    expect(tx?.lane).toBe("RTP");
    expect(tx?.state).toBe("RECEIVED");
    expect(tx?.amount_value).toBe(50_000);
  });

  it("ACCEPTED: transitions RTP to TX_CREATED state", async () => {
    await registerRtp("RTP-RESP-ACC-002");
    const result = await respondToRtp(
      d1 as any,
      "RTP-RESP-ACC-002",
      {
        response: "ACCEPTED",
        payer_account_id: PAYER_ACCOUNT,
        idempotency_key: "IK-RESP-ACC-002",
      },
      makeEnv(d1)
    );

    expect(result.result).toBe("ACCEPTED");

    const row = await d1
      .prepare(`SELECT state FROM RtpRequests WHERE rtp_id=?`)
      .bind("RTP-RESP-ACC-002")
      .first<{ state: string }>();
    expect(row?.state).toBe("TX_CREATED");
  });

  it("ACCEPTED: writes RtpAccepted FinalityLog entry", async () => {
    await registerRtp("RTP-RESP-ACC-003");
    await respondToRtp(
      d1 as any,
      "RTP-RESP-ACC-003",
      {
        response: "ACCEPTED",
        payer_account_id: PAYER_ACCOUNT,
        idempotency_key: "IK-RESP-ACC-003",
      },
      makeEnv(d1)
    );

    const log = await d1
      .prepare(`SELECT event_type FROM FinalityLog WHERE event_type='RtpAccepted' LIMIT 1`)
      .first<{ event_type: string }>();
    expect(log).not.toBeNull();
  });

  it("REJECTED: returns DECLINED and sets state to DECLINED", async () => {
    await registerRtp("RTP-RESP-REJ-001");
    const result = await respondToRtp(
      d1 as any,
      "RTP-RESP-REJ-001",
      {
        response: "REJECTED",
        payer_account_id: PAYER_ACCOUNT,
        idempotency_key: "IK-RESP-REJ-001",
      },
      makeEnv(d1)
    );

    expect(result.result).toBe("DECLINED");

    const row = await d1
      .prepare(`SELECT state FROM RtpRequests WHERE rtp_id=?`)
      .bind("RTP-RESP-REJ-001")
      .first<{ state: string }>();
    expect(row?.state).toBe("DECLINED");
  });

  it("returns NOT_FOUND for unknown rtp_id", async () => {
    const result = await respondToRtp(
      d1 as any,
      "RTP-UNKNOWN",
      {
        response: "ACCEPTED",
        payer_account_id: PAYER_ACCOUNT,
        idempotency_key: "IK-UNKNOWN",
      },
      makeEnv(d1)
    );
    expect(result.result).toBe("NOT_FOUND");
  });

  it("returns ALREADY_RESPONDED when RTP was previously accepted", async () => {
    await registerRtp("RTP-RESP-DUP-001");
    await respondToRtp(
      d1 as any,
      "RTP-RESP-DUP-001",
      {
        response: "ACCEPTED",
        payer_account_id: PAYER_ACCOUNT,
        idempotency_key: "IK-RESP-DUP-001",
      },
      makeEnv(d1)
    );

    const second = await respondToRtp(
      d1 as any,
      "RTP-RESP-DUP-001",
      {
        response: "ACCEPTED",
        payer_account_id: PAYER_ACCOUNT,
        idempotency_key: "IK-RESP-DUP-002",
      },
      makeEnv(d1)
    );
    expect(second.result).toBe("ALREADY_RESPONDED");
  });

  it("returns EXPIRED when RTP expires_at has passed", async () => {
    await registerRtp("RTP-RESP-EXP-001", PAST_EXPIRY);
    const result = await respondToRtp(
      d1 as any,
      "RTP-RESP-EXP-001",
      {
        response: "ACCEPTED",
        payer_account_id: PAYER_ACCOUNT,
        idempotency_key: "IK-RESP-EXP-001",
      },
      makeEnv(d1)
    );
    expect(result.result).toBe("EXPIRED");
  });
});

// ---------------------------------------------------------------------------
// settleRtp
// ---------------------------------------------------------------------------

describe("settleRtp", () => {
  it("transitions RTP to COMPLETED state", async () => {
    d1.prepare(
      `INSERT INTO RtpRequests
       (rtp_id, payee_bank_id, payer_bank_id, amount_value, state,
        attempt_count, max_attempts, expires_at, created_at, updated_at)
       VALUES ('RTP-SETTLE-001', ?, ?, 10000, 'TX_CREATED', 1, 3, ?, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`
    )
      .bind(PAYEE_BANK, PAYER_BANK, FUTURE_EXPIRY)
      ._runSync();

    await settleRtp("RTP-SETTLE-001", d1 as any);

    const row = await d1
      .prepare(`SELECT state FROM RtpRequests WHERE rtp_id=?`)
      .bind("RTP-SETTLE-001")
      .first<{ state: string }>();
    expect(row?.state).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// expireRtpRequests (cron)
// ---------------------------------------------------------------------------

describe("expireRtpRequests", () => {
  it("expires CREATED/NOTIFIED RTPs past their expires_at", async () => {
    // Insert two expired RTPs
    for (const rtpId of ["RTP-EXP-CRON-001", "RTP-EXP-CRON-002"]) {
      d1.prepare(
        `INSERT INTO RtpRequests
         (rtp_id, payee_bank_id, payer_bank_id, amount_value, state,
          attempt_count, max_attempts, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 5000, 'NOTIFIED', 0, 3, ?, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`
      )
        .bind(rtpId, PAYEE_BANK, PAYER_BANK, PAST_EXPIRY)
        ._runSync();
    }
    // One still-valid RTP
    d1.prepare(
      `INSERT INTO RtpRequests
       (rtp_id, payee_bank_id, payer_bank_id, amount_value, state,
        attempt_count, max_attempts, expires_at, created_at, updated_at)
       VALUES ('RTP-VALID-001', ?, ?, 5000, 'NOTIFIED', 0, 3, ?, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`
    )
      .bind(PAYEE_BANK, PAYER_BANK, FUTURE_EXPIRY)
      ._runSync();

    const count = await expireRtpRequests(d1 as any);
    expect(count).toBe(2);

    for (const rtpId of ["RTP-EXP-CRON-001", "RTP-EXP-CRON-002"]) {
      const row = await d1
        .prepare(`SELECT state FROM RtpRequests WHERE rtp_id=?`)
        .bind(rtpId)
        .first<{ state: string }>();
      expect(row?.state).toBe("EXPIRED");
    }

    const valid = await d1
      .prepare(`SELECT state FROM RtpRequests WHERE rtp_id='RTP-VALID-001'`)
      .first<{ state: string }>();
    expect(valid?.state).toBe("NOTIFIED");
  });

  it("returns 0 when no RTPs need expiration", async () => {
    const count = await expireRtpRequests(d1 as any);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getRtpStatus
// ---------------------------------------------------------------------------

describe("getRtpStatus", () => {
  it("returns null for unknown rtp_id", async () => {
    const status = await getRtpStatus(d1 as any, "RTP-UNKNOWN");
    expect(status).toBeNull();
  });

  it("returns CREATED status for CREATED state", async () => {
    d1.prepare(
      `INSERT INTO RtpRequests
       (rtp_id, payee_bank_id, payer_bank_id, amount_value, state,
        attempt_count, max_attempts, expires_at, created_at, updated_at)
       VALUES ('RTP-STATUS-001', ?, ?, 10000, 'CREATED', 0, 3, ?, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`
    )
      .bind(PAYEE_BANK, PAYER_BANK, FUTURE_EXPIRY)
      ._runSync();

    const result = await getRtpStatus(d1 as any, "RTP-STATUS-001");
    expect(result).not.toBeNull();
    expect(result!.rtpId).toBe("RTP-STATUS-001");
    expect(result!.status).toBe("CREATED");
  });

  it("returns TX_CREATED state directly", async () => {
    d1.prepare(
      `INSERT INTO RtpRequests
       (rtp_id, payee_bank_id, payer_bank_id, amount_value, state,
        attempt_count, max_attempts, expires_at, created_at, updated_at)
       VALUES ('RTP-STATUS-002', ?, ?, 10000, 'TX_CREATED', 1, 3, ?, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`
    )
      .bind(PAYEE_BANK, PAYER_BANK, FUTURE_EXPIRY)
      ._runSync();

    const result = await getRtpStatus(d1 as any, "RTP-STATUS-002");
    expect(result!.status).toBe("TX_CREATED");
  });

  it("returns EXPIRED status for EXPIRED state", async () => {
    d1.prepare(
      `INSERT INTO RtpRequests
       (rtp_id, payee_bank_id, payer_bank_id, amount_value, state,
        attempt_count, max_attempts, expires_at, created_at, updated_at)
       VALUES ('RTP-STATUS-003', ?, ?, 10000, 'EXPIRED', 0, 3, ?, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`
    )
      .bind(PAYEE_BANK, PAYER_BANK, PAST_EXPIRY)
      ._runSync();

    const result = await getRtpStatus(d1 as any, "RTP-STATUS-003");
    expect(result!.status).toBe("EXPIRED");
  });
});
