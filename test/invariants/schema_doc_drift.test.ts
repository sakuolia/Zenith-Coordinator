/**
 * @file Spec/implementation drift guards for docs/specs/31_schema.md.
 *
 * Background: an audit found two drift cases between docs/specs/31_schema.md and the
 * actual migrated schema:
 *   - DnsCycles.business_date was documented as `UNIQUE` and missing
 *     `updated_at`, even though the schema dropped the UNIQUE constraint and
 *     added the column.
 *   - GtidLegs.idx_legs_txid and DnsCycles.idx_dns_business_date were absent
 *     from the "Index Catalog" section entirely.
 *
 * These tests guard against the *class* of bug (docs silently falling behind
 * the schema), not just the two instances above:
 *
 *   1. STATIC GUARD — every `CREATE [UNIQUE] INDEX <name>` defined across
 *      migrations/*.sql must be mentioned somewhere in docs/specs/31_schema.md. A new
 *      migration that adds an index but forgets to document it fails this test.
 *
 *   2. RUNTIME GUARDS — the actual migrated schema (via createTestDb, which
 *      applies the same SCHEMA_MIGRATIONS used by every other test) for
 *      DnsCycles and GtidLegs matches what docs/specs/31_schema.md now documents:
 *      columns, the absence of a UNIQUE constraint on business_date, and the
 *      presence of idx_dns_business_date / idx_legs_txid.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDb } from "../helpers/d1-mock";

const SCHEMA_DOC = readFileSync(join("docs", "specs", "31_schema.md"), "utf8");

// ---------------------------------------------------------------------------
// 1. STATIC GUARD: every index in the final migrated schema is documented
// ---------------------------------------------------------------------------

describe("invariant: docs/specs/31_schema.md does not drift from the migrated schema", () => {
  it("every user-defined index that exists after all migrations is mentioned in docs/specs/31_schema.md", () => {
    const { sqlite } = createTestDb();
    const indexes = sqlite
      .prepare(
        `SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%'`
      )
      .all() as Array<{ name: string; tbl_name: string }>;

    // Index names created with the table-prefix style (e.g. idx_rtp_request_rows_*)
    // belong to tables that were dropped before the schema was squashed (e.g.
    // RtpRequestRows, folded out by the RTP consolidation) and so are absent
    // from the consolidated 0001 schema — this query only sees indexes on tables
    // that still exist in the final schema.
    const undocumented = indexes.map((i) => i.name).filter((name) => !SCHEMA_DOC.includes(name));

    expect(
      undocumented,
      "These indexes exist in the final migrated schema but are never mentioned in " +
        "docs/specs/31_schema.md (e.g. the Index Catalog). Document them so the schema reference " +
        "stays accurate."
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. RUNTIME GUARDS: DnsCycles / GtidLegs match the documented schema
// ---------------------------------------------------------------------------

describe("invariant: DnsCycles actual schema matches docs/specs/31_schema.md", () => {
  it("has updated_at (added by 0012) and no UNIQUE constraint on business_date alone", () => {
    const { sqlite } = createTestDb();

    const columns = sqlite.prepare(`PRAGMA table_info(DnsCycles)`).all() as Array<{
      name: string;
    }>;
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain("updated_at");

    const indexes = sqlite.prepare(`PRAGMA index_list(DnsCycles)`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
    }>;
    // The only UNIQUE index should be the implicit PK index on cycle_id —
    // business_date must not be UNIQUE (0012 dropped that constraint).
    const uniqueNonPk = indexes.filter((i) => i.unique === 1 && i.origin !== "pk");
    expect(uniqueNonPk).toEqual([]);
  });

  it("has idx_dns_business_date (added by 0012, documented in the Index Catalog)", () => {
    const { sqlite } = createTestDb();
    const indexes = sqlite.prepare(`PRAGMA index_list(DnsCycles)`).all() as Array<{
      name: string;
    }>;
    expect(indexes.map((i) => i.name)).toContain("idx_dns_business_date");
    expect(SCHEMA_DOC).toContain("idx_dns_business_date");
  });
});

describe("invariant: GtidLegs actual schema matches docs/specs/31_schema.md", () => {
  it("has idx_legs_txid (added by 0011, documented in the Index Catalog)", () => {
    const { sqlite } = createTestDb();
    const indexes = sqlite.prepare(`PRAGMA index_list(GtidLegs)`).all() as Array<{
      name: string;
    }>;
    expect(indexes.map((i) => i.name)).toContain("idx_legs_txid");
    expect(SCHEMA_DOC).toContain("idx_legs_txid");
  });
});
