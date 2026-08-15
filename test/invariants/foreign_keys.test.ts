/**
 * @file Foreign-key enforcement + declared-FK drift guard.
 *
 * Referential integrity in ZC is not decorative: the test D1 is created with
 * `PRAGMA foreign_keys = ON` (see test/helpers/d1-mock.ts), so every other test
 * in the suite exercises the declared constraints. These guards pin two things:
 *
 *   1. ENFORCEMENT — the migrated test DB actually has foreign_keys ON, so a
 *      regression that silently disables it (back to the old foreign_keys = OFF)
 *      is caught here rather than letting dangling references slip through.
 *
 *   2. DECLARED-FK SET — the exact set of FOREIGN KEY constraints in the migrated
 *      schema matches the documented set in docs/specs/31_schema.md ("Foreign Key 戦略").
 *      Adding or removing a FK without updating the doc fails this test, the same
 *      way schema_doc_drift guards indexes.
 *
 * NB on what is intentionally NOT a FK (documented in docs/specs/31_schema.md):
 *   - FinalityLog / TxEventLog / BankAuditLog / EntityStateLog: append-only audit
 *     logs; FinalityLog.txid_or_gtid is polymorphic (no single parent).
 *   - HReservations.txid: H is reserved against a *predicted* txid before the
 *     Transactions row exists (GTID/FX), so it is a forward reference, not a
 *     satisfiable FK.
 */
import { describe, it, expect } from "vitest";
import { createTestDb } from "../helpers/d1-mock";

/** The authoritative set of declared foreign keys, as "Child.col -> Parent.col". */
const EXPECTED_FKS = [
  "Attestation.template_id -> ConditionTemplate.template_id",
  "CaseRelatedTransactions.case_id -> Cases.case_id",
  "CollectionAttempt.collection_id -> ScheduledCollection.collection_id",
  "DebitMandate.mandate_id -> Mandate.mandate_id",
  "DnsNetPositions.cycle_id -> DnsCycles.cycle_id",
  "FxLegLocks.gtid -> FxTransfers.gtid",
  "GtidLegs.gtid -> GtidTransactions.gtid",
  "GtidLegs.txid -> Transactions.txid",
  "HtlcAuthRequests.whitelist_id -> HtlcAuthWhitelist.whitelist_id",
  "HtlcContracts.txid -> Transactions.txid",
  "Mandate.parent_mandate_id -> Mandate.mandate_id",
  "MandateBudget.dd_mandate_id -> DebitMandate.dd_mandate_id",
  "ScheduledCollection.dd_mandate_id -> DebitMandate.dd_mandate_id",
  "ScheduledCollection.extra_mandate_id -> Mandate.mandate_id",
].sort();

describe("invariant: foreign key enforcement", () => {
  it("the migrated test database enforces foreign keys (PRAGMA foreign_keys = ON)", () => {
    const { sqlite } = createTestDb();
    const [{ foreign_keys }] = sqlite.prepare(`PRAGMA foreign_keys`).all() as Array<{
      foreign_keys: number;
    }>;
    expect(foreign_keys).toBe(1);
  });

  it("a dangling child INSERT is rejected by the FK (HtlcContracts.txid)", () => {
    const { sqlite } = createTestDb();
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO HtlcContracts
             (htlc_id, txid, state, hashlock, timelock, amount_value,
              payer_bank_id, payee_bank_id, version, created_at, updated_at)
           VALUES ('H-ORPHAN', 'TX-DOES-NOT-EXIST', 'HTLC_LOCKED', 'hh', '2099-01-01T00:00:00Z',
                   100, '001', '002', 0, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`
        )
        .run()
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe("invariant: declared foreign keys do not drift from docs/specs/31_schema.md", () => {
  it("the migrated schema declares exactly the documented set of foreign keys", () => {
    const { sqlite } = createTestDb();
    const tables = (
      sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);

    const actual: string[] = [];
    for (const table of tables) {
      const fks = sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
        table: string;
        from: string;
        to: string;
      }>;
      for (const fk of fks) actual.push(`${table}.${fk.from} -> ${fk.table}.${fk.to}`);
    }

    expect(actual.sort()).toEqual(EXPECTED_FKS);
  });
});
