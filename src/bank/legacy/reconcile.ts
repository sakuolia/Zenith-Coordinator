/**
 * @file reconcile.ts — Three-way reconciliation (#3): core vs shadow vs outbox.
 *
 * The moment the adapter authorises against a shadow instead of the core, it
 * creates the possibility of drift. This is the price of never blocking ZC on a
 * batch core, and it must be paid back by a reconciliation that CANNOT be
 * silently skipped — the adapter's equivalent of ZC's rule "an unexplained
 * state is forbidden; converge it into a CASE".
 *
 * The invariant that must hold for every account whenever the core is online:
 *
 *   core.balance == shadow.available + shadow.reserved
 *                    + Σ(pending DEBIT) − Σ(pending CREDIT)
 *
 * because pending debits were already taken off the shadow but not yet off the
 * core (core is higher by that much), and pending credits are the mirror. Any
 * residual is real drift (a lost posting, an out-of-band core change) and is
 * recorded OPEN = a CASE.
 */
import { nowISO } from "../../types";
import { newUUID } from "../../shared/idempotency";
import { openOrAggregateCase } from "../../zc/cases/case";
import type { LegacyCore } from "./legacy_core";

export interface DriftRecord {
  drift_id: string;
  bank_id: string;
  account_id: string;
  core_balance: number;
  shadow_expected: number;
  drift_amount: number;
  case_id: string;
}

async function pendingNet(
  db: D1Database,
  bankId: string,
  accountId: string
): Promise<{ debits: number; credits: number }> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN op='DEBIT'  THEN amount ELSE 0 END), 0) AS debits,
         COALESCE(SUM(CASE WHEN op='CREDIT' THEN amount ELSE 0 END), 0) AS credits
       FROM AdapterOutbox
       WHERE bank_id=? AND account_id=? AND status='PENDING'`
    )
    .bind(bankId, accountId)
    .first<{ debits: number; credits: number }>();
  return { debits: row?.debits ?? 0, credits: row?.credits ?? 0 };
}

/**
 * Reconcile one account. Returns the drift record if a mismatch was found and
 * recorded (OPEN = CASE), or null if the invariant holds. Requires the core to
 * be online (a batch core cannot be read mid-window — that is itself the reason
 * reconciliation is scheduled after the window, not during it).
 */
export async function reconcileAccount(
  db: D1Database,
  core: LegacyCore,
  bankId: string,
  accountId: string
): Promise<DriftRecord | null> {
  const coreBalance = await core.getBalance(bankId, accountId);
  const shadow = await db
    .prepare(`SELECT available, reserved FROM AdapterShadow WHERE bank_id=? AND account_id=?`)
    .bind(bankId, accountId)
    .first<{ available: number; reserved: number }>();
  const available = shadow?.available ?? 0;
  const reserved = shadow?.reserved ?? 0;
  const { debits, credits } = await pendingNet(db, bankId, accountId);

  const expected = available + reserved + debits - credits;
  const drift = coreBalance - expected;
  if (drift === 0) return null;

  // Converge the unexplained state into a real Cases row — the same queue
  // tellers/ops already watch for the rest of ZC — rather than only a table
  // in this subsystem that nothing else observes.
  // Aggregated on the participant (§10.7.2): a shadow-balance divergence is
  // usually one adapter-level cause showing up on many accounts at once, and
  // one CASE per account is the ticket explosion the norm exists to prevent.
  // Each account's DriftRecord still points at the CASE, so the breakdown is
  // not lost — it moves from "many CASEs" to "one CASE, many relations".
  const { case_id: caseId } = await openOrAggregateCase(db, {
    reason_code: "LEGACY_ADAPTER_RECON_DRIFT",
    opened_by: "ZC",
    cause_party_id: bankId,
    // The subject here is an account, not a transaction: without its own key
    // every drifting account after the first would look like a repeat of the
    // first, and the count would stay at 1 across a bank-wide divergence.
    link_key: `${bankId}/${accountId}`,
    description: `Legacy adapter reconciliation drift for ${bankId}/${accountId}: core=${coreBalance}, shadow_expected=${expected}, drift=${drift}.`,
  });

  const record: DriftRecord = {
    drift_id: `DRIFT-${newUUID()}`,
    bank_id: bankId,
    account_id: accountId,
    core_balance: coreBalance,
    shadow_expected: expected,
    drift_amount: drift,
    case_id: caseId,
  };
  await db
    .prepare(
      `INSERT INTO AdapterReconDrift
         (drift_id, bank_id, account_id, core_balance, shadow_expected, drift_amount, case_id, status, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`
    )
    .bind(record.drift_id, bankId, accountId, coreBalance, expected, drift, caseId, nowISO())
    .run();
  return record;
}

/** Reconcile every shadowed account for a bank. Returns the OPEN drift records. */
export async function reconcileBank(
  db: D1Database,
  core: LegacyCore,
  bankId: string
): Promise<DriftRecord[]> {
  const accounts = await db
    .prepare(`SELECT account_id FROM AdapterShadow WHERE bank_id=?`)
    .bind(bankId)
    .all<{ account_id: string }>();
  const drifts: DriftRecord[] = [];
  for (const a of accounts.results) {
    const d = await reconcileAccount(db, core, bankId, a.account_id);
    if (d) drifts.push(d);
  }
  return drifts;
}

/** Count of unresolved (OPEN) drift records — a non-zero value is an open CASE. */
export async function openDriftCount(db: D1Database, bankId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM AdapterReconDrift WHERE bank_id=? AND status='OPEN'`)
    .bind(bankId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
