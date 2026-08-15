/**
 * @file HIGH_VALUE auto-escalation threshold (`PR-HV-THRESHOLD`,
 *       docs/specs/10_requirements.md §3.2.7 / docs/specs/30_internal_design.md §12.9).
 *
 * `handlePostTransfers` resolves the escalation threshold in three steps —
 * `Participants.hv_threshold` (per-bank) → `env.ZC_HV_THRESHOLD` (system-wide)
 * → `DEFAULT_HV_THRESHOLD` (`src/shared/constants.ts`) — and rewrites
 * `EXPRESS`/`STANDARD` requests at or above it to `HIGH_VALUE` before the
 * `Transactions` row is inserted. This had no dedicated coverage; these tests
 * pin each level of the resolution order and the boundary (`>=`, not `>`).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { handlePostTransfers } from "../../src/zc/ingress";
import { DEFAULT_HV_THRESHOLD } from "../../src/shared/constants";
import type { Env } from "../../src/types";

const PAYER_BANK = "001";
const PAYEE_BANK = "002";
const PAYER_ACCOUNT = "0010000001";
const PAYEE_ACCOUNT = "0020000001";

let d1: MockD1Database;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: d1 as unknown as D1Database,
    QUEUE: { send: async () => {} } as any,
    R2: {} as any,
    ZC_HMAC_SECRET: "",
    VAULT_URL: "",
    VAULT_TOKEN: "",
    ...overrides,
  } as unknown as Env;
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("https://zc.example.com/api/transfers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function payload(txid: string, idem: string, amount: number, lane: "EXPRESS" | "STANDARD") {
  return {
    schema_version: "1.0",
    txid,
    idempotency_key: idem,
    lane,
    amount: { value: amount, currency: "JPY" },
    payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACCOUNT },
    payee: { bank_id: PAYEE_BANK, account_hash: PAYEE_ACCOUNT },
    purpose: "P2P",
  };
}

async function laneOf(txid: string): Promise<string | undefined> {
  const row = await d1
    .prepare(`SELECT lane FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ lane: string }>();
  return row?.lane;
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;

  for (const bankId of [PAYER_BANK, PAYEE_BANK]) {
    d1.prepare(
      `INSERT OR REPLACE INTO Participants
       (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
       VALUES (?, 'Test Bank', '/bank/${bankId}', 10000000000, 0, 1, '2025-01-01T00:00:00Z')`
    )
      .bind(bankId)
      ._runSync();
  }

  const accounts = [
    [PAYER_ACCOUNT, PAYER_BANK],
    [PAYEE_ACCOUNT, PAYEE_BANK],
    [`${PAYER_BANK}0000000`, PAYER_BANK], // suspense
    [`${PAYER_BANK}-ZCS`, PAYER_BANK],
    [`${PAYEE_BANK}0000000`, PAYEE_BANK],
    [`${PAYEE_BANK}-ZCS`, PAYEE_BANK],
  ];
  for (const [acctId, bankId] of accounts) {
    d1.prepare(
      `INSERT OR IGNORE INTO BankAccounts
       (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
       VALUES (?, ?, 'CUST', 'User', 'SAVINGS', 'NORMAL', '2025-01-01T00:00:00Z')`
    )
      .bind(acctId, bankId)
      ._runSync();
    d1.prepare(
      `INSERT OR IGNORE INTO BankJournals
       (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES (?, ?, ?, 500000000000, 'CASH', 'INIT', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(`JNL-INIT-${acctId}`, bankId, acctId)
      ._runSync();
  }
});

describe("HIGH_VALUE auto-escalation threshold (PR-HV-THRESHOLD)", () => {
  it("leaves STANDARD alone just below the system default fallback", async () => {
    const resp = await handlePostTransfers(
      makeRequest(payload("TX-HVT-001", "ik-hvt-001", DEFAULT_HV_THRESHOLD - 1, "STANDARD")),
      makeEnv()
    );
    expect(resp.status).toBeLessThan(400);
    expect(await laneOf("TX-HVT-001")).toBe("STANDARD");
  });

  it("escalates STANDARD to HIGH_VALUE at exactly the default fallback (boundary is >=)", async () => {
    const resp = await handlePostTransfers(
      makeRequest(payload("TX-HVT-002", "ik-hvt-002", DEFAULT_HV_THRESHOLD, "STANDARD")),
      makeEnv()
    );
    expect(resp.status).toBeLessThan(400);
    expect(await laneOf("TX-HVT-002")).toBe("HIGH_VALUE");
  });

  it("escalates EXPRESS the same way as STANDARD", async () => {
    const resp = await handlePostTransfers(
      makeRequest(payload("TX-HVT-003", "ik-hvt-003", DEFAULT_HV_THRESHOLD, "EXPRESS")),
      makeEnv()
    );
    expect(resp.status).toBeLessThan(400);
    expect(await laneOf("TX-HVT-003")).toBe("HIGH_VALUE");
  });

  it("honors a system-wide ZC_HV_THRESHOLD override below the default", async () => {
    const env = makeEnv({ ZC_HV_THRESHOLD: "5000000" } as Partial<Env>);
    const below = await handlePostTransfers(
      makeRequest(payload("TX-HVT-004", "ik-hvt-004", 4_999_999, "STANDARD")),
      env
    );
    expect(below.status).toBeLessThan(400);
    expect(await laneOf("TX-HVT-004")).toBe("STANDARD");

    const atThreshold = await handlePostTransfers(
      makeRequest(payload("TX-HVT-005", "ik-hvt-005", 5_000_000, "STANDARD")),
      env
    );
    expect(atThreshold.status).toBeLessThan(400);
    expect(await laneOf("TX-HVT-005")).toBe("HIGH_VALUE");
  });

  it("prefers the per-bank Participants.hv_threshold over ZC_HV_THRESHOLD and the default", async () => {
    await d1
      .prepare(`UPDATE Participants SET hv_threshold = ? WHERE bank_id = ?`)
      .bind(1_000_000, PAYER_BANK)
      ._runSync();
    // A system-wide override is also set, but the per-bank column must win.
    const env = makeEnv({ ZC_HV_THRESHOLD: "50000000" } as Partial<Env>);

    const below = await handlePostTransfers(
      makeRequest(payload("TX-HVT-006", "ik-hvt-006", 999_999, "STANDARD")),
      env
    );
    expect(below.status).toBeLessThan(400);
    expect(await laneOf("TX-HVT-006")).toBe("STANDARD");

    const atThreshold = await handlePostTransfers(
      makeRequest(payload("TX-HVT-007", "ik-hvt-007", 1_000_000, "STANDARD")),
      env
    );
    expect(atThreshold.status).toBeLessThan(400);
    expect(await laneOf("TX-HVT-007")).toBe("HIGH_VALUE");
  });

  it("does not escalate lanes the norm excludes (BULK stays BULK even far above threshold)", async () => {
    const resp = await handlePostTransfers(
      makeRequest({
        schema_version: "1.0",
        txid: "TX-HVT-008",
        idempotency_key: "ik-hvt-008",
        lane: "BULK",
        amount: { value: DEFAULT_HV_THRESHOLD * 10, currency: "JPY" },
        payer: { bank_id: PAYER_BANK, account_hash: PAYER_ACCOUNT },
        payee: { bank_id: PAYEE_BANK, account_hash: PAYEE_ACCOUNT },
        purpose: "P2P",
        batch_id: "BATCH-HVT-008",
        cutoff_time: "2025-01-01T23:59:59Z",
      }),
      makeEnv()
    );
    expect(resp.status).toBeLessThan(400);
    expect(await laneOf("TX-HVT-008")).toBe("BULK");
  });
});
