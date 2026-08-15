/**
 * @file HIGH_VALUE lane — H-model bypass tests.
 *
 * HIGH_VALUE uses BOJ pre-fund balance (not the H bilateral-net cap) for risk
 * management. This is intentional per the spec (BOJ/IGS RTGS path). These
 * tests verify that:
 *   1. h_used stays 0 after HIGH_VALUE processing (H-model is not touched)
 *   2. No HReservations row is created
 *   3. The TX reaches DECIDED_TO_SETTLE via the BOJ pre-fund check
 *   4. BOJ_INSUFFICIENT_FUNDS is returned when the pre-fund is depleted
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import { advanceHighValue } from "../../src/zc/lanes/highvalue";
import type { Env } from "../../src/types";

const PAYER_BANK = "001";
const PAYEE_BANK = "002";
const PAYER_ACCOUNT = "0010000001";
const PAYEE_ACCOUNT = "0020000001";
const BOJ_PREFUND = -500_000_000; // negative = pre-funded into BOJ

let d1: MockD1Database;

function makeEnv(): Env {
  return {
    DB: d1 as unknown as D1Database,
    QUEUE: { send: async () => {} } as any,
    R2: {} as any,
    ZC_HMAC_SECRET: "",
    VAULT_URL: "",
    VAULT_TOKEN: "",
  } as unknown as Env;
}

function seedParticipant(bankId: string, hLimit = 5_000_000) {
  d1.prepare(
    `INSERT OR REPLACE INTO Participants
     (bank_id, bank_name, ingress_base_url, h_limit, h_used, is_active, registered_at)
     VALUES (?, 'Test Bank', '/bank/${bankId}', ?, 0, 1, '2025-01-01T00:00:00Z')`
  )
    .bind(bankId, hLimit)
    ._runSync();
}

function seedAccount(bankId: string, accountId: string, balance = 0) {
  d1.prepare(
    `INSERT OR IGNORE INTO BankAccounts
     (account_id, bank_id, customer_id, customer_name, account_type, status, opened_at)
     VALUES (?, ?, 'CUST', 'Test User', 'SAVINGS', 'NORMAL', '2025-01-01T00:00:00Z')`
  )
    .bind(accountId, bankId)
    ._runSync();
  if (balance !== 0) {
    d1.prepare(
      `INSERT INTO BankJournals
       (journal_id, bank_id, account_id, amount, tx_type, tx_group_id, value_date, created_at)
       VALUES (?, ?, ?, ?, 'CASH', 'INIT', '2025-01-01', '2025-01-01T00:00:00Z')`
    )
      .bind(`JNL-${accountId}`, bankId, accountId, balance)
      ._runSync();
  }
}

function seedHighValueTx(txid: string, amount = 200_000_000) {
  d1.prepare(
    `INSERT INTO Transactions
     (txid, lane, state, amount_value, amount_currency,
      payer_bank_id, payer_account_hash, payee_bank_id, payee_account_hash,
      idempotency_key, schema_version, version, created_at, updated_at)
     VALUES (?, 'HIGH_VALUE', 'RECEIVED', ?, 'JPY', ?, ?, ?, ?,
             ?, '1.0', 0, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`
  )
    .bind(txid, amount, PAYER_BANK, PAYER_ACCOUNT, PAYEE_BANK, PAYEE_ACCOUNT, `IK-${txid}`)
    ._runSync();
}

beforeEach(() => {
  const { d1: db } = createTestDb();
  d1 = db;
  seedParticipant(PAYER_BANK);
  seedParticipant(PAYEE_BANK);
  seedAccount(PAYER_BANK, PAYER_ACCOUNT);
  seedAccount(PAYEE_BANK, PAYEE_ACCOUNT);
  seedAccount(PAYER_BANK, `${PAYER_BANK}-ZCS`);
  seedAccount(PAYEE_BANK, `${PAYEE_BANK}-ZCS`);
  // BOJ pre-fund: large negative balance means funds are pre-deposited at BOJ
  seedAccount(PAYER_BANK, `${PAYER_BANK}-BOJ`, BOJ_PREFUND);
});

// ---------------------------------------------------------------------------
// H-model bypass
// ---------------------------------------------------------------------------

describe("HIGH_VALUE lane — H-model bypass (spec §HV)", () => {
  it("h_used stays 0 after processing (H-model not used for HIGH_VALUE)", async () => {
    seedHighValueTx("TX-HV-HBYP-001", 200_000_000);
    await advanceHighValue("TX-HV-HBYP-001", makeEnv());

    const p = await d1
      .prepare(`SELECT h_used FROM Participants WHERE bank_id=?`)
      .bind(PAYER_BANK)
      .first<{ h_used: number }>();
    expect(p?.h_used).toBe(0);
  });

  it("creates NO HReservations row (H is never reserved for HIGH_VALUE)", async () => {
    seedHighValueTx("TX-HV-HBYP-002", 200_000_000);
    await advanceHighValue("TX-HV-HBYP-002", makeEnv());

    const hRes = await d1
      .prepare(`SELECT reservation_id FROM HReservations WHERE txid=?`)
      .bind("TX-HV-HBYP-002")
      .first<{ reservation_id: string }>();
    expect(hRes).toBeNull();
  });

  it("advances to DECIDED_TO_SETTLE using BOJ pre-fund check", async () => {
    seedHighValueTx("TX-HV-HBYP-003", 200_000_000);
    await advanceHighValue("TX-HV-HBYP-003", makeEnv());

    const tx = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid=?`)
      .bind("TX-HV-HBYP-003")
      .first<{ state: string }>();
    expect(tx?.state).toBe("DECIDED_TO_SETTLE");
  });

  it("h_used remains 0 even for concurrent HIGH_VALUE transactions", async () => {
    seedHighValueTx("TX-HV-CONC-001", 100_000_000);
    seedHighValueTx("TX-HV-CONC-002", 100_000_000);

    await advanceHighValue("TX-HV-CONC-001", makeEnv());
    await advanceHighValue("TX-HV-CONC-002", makeEnv());

    const p = await d1
      .prepare(`SELECT h_used FROM Participants WHERE bank_id=?`)
      .bind(PAYER_BANK)
      .first<{ h_used: number }>();
    expect(p?.h_used).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BOJ pre-fund check
// ---------------------------------------------------------------------------

describe("HIGH_VALUE lane — BOJ pre-fund check", () => {
  it("rejects with BOJ_INSUFFICIENT_FUNDS when payer has no BOJ pre-fund", async () => {
    // Override: remove the BOJ journal so calcBalance('001-BOJ') = 0
    d1.prepare(`DELETE FROM BankJournals WHERE account_id=?`).bind(`${PAYER_BANK}-BOJ`)._runSync();

    seedHighValueTx("TX-HV-NOFUND-001", 1_000);
    await advanceHighValue("TX-HV-NOFUND-001", makeEnv());

    const tx = await d1
      .prepare(`SELECT state, reason_code FROM Transactions WHERE txid=?`)
      .bind("TX-HV-NOFUND-001")
      .first<{ state: string; reason_code: string | null }>();
    expect(tx?.state).toBe("CANCELLED");
    expect(tx?.reason_code).toBe("BOJ_INSUFFICIENT_FUNDS");
  });

  it("rejects when transfer amount exceeds remaining BOJ pre-fund", async () => {
    // BOJ pre-fund = -500_000_000 (available), amount = 600_000_000 (exceeds)
    seedHighValueTx("TX-HV-EXCEED-001", 600_000_000);
    await advanceHighValue("TX-HV-EXCEED-001", makeEnv());

    const tx = await d1
      .prepare(`SELECT state, reason_code FROM Transactions WHERE txid=?`)
      .bind("TX-HV-EXCEED-001")
      .first<{ state: string; reason_code: string | null }>();
    expect(tx?.state).toBe("CANCELLED");
    expect(tx?.reason_code).toBe("BOJ_INSUFFICIENT_FUNDS");
  });

  it("accepts when transfer amount exactly equals BOJ pre-fund capacity", async () => {
    // BOJ balance = -500_000_000 → available = 500_000_000
    // Check: bojBalance + amount > 0 → -500_000_000 + 500_000_000 = 0 → NOT > 0 → passes
    seedHighValueTx("TX-HV-EXACT-001", 500_000_000);
    await advanceHighValue("TX-HV-EXACT-001", makeEnv());

    const tx = await d1
      .prepare(`SELECT state FROM Transactions WHERE txid=?`)
      .bind("TX-HV-EXACT-001")
      .first<{ state: string }>();
    expect(tx?.state).toBe("DECIDED_TO_SETTLE");
  });
});
