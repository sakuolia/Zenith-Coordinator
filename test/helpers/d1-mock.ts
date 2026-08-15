/**
 * @file D1 mock backed by better-sqlite3 (in-memory SQLite).
 *
 * Implements the subset of the D1Database / D1PreparedStatement interfaces
 * used by ZC and Bank modules so they can be exercised in Vitest without a
 * live Cloudflare Worker environment.
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../migrations");

// ---------------------------------------------------------------------------
// Minimal D1 type shims (avoids pulling Workers types into the test runtime)
// ---------------------------------------------------------------------------

export interface D1Meta {
  changes: number;
  last_row_id: number;
  duration?: number;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  meta: D1Meta;
  success: boolean;
}

// ---------------------------------------------------------------------------
// MockPreparedStatement
// ---------------------------------------------------------------------------

export class MockPreparedStatement {
  private params: unknown[] = [];

  constructor(
    private db: Database.Database,
    private sql: string
  ) {}

  bind(...values: unknown[]): MockPreparedStatement {
    const clone = new MockPreparedStatement(this.db, this.sql);
    clone.params = values;
    return clone;
  }

  /** Async wrapper used by production code. */
  async run(): Promise<D1Result> {
    return this._runSync();
  }

  /** Synchronous variant used by batch(). */
  _runSync(): D1Result {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(this.params);
    return {
      results: [],
      meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
      success: true,
    };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(this.params);
    return (row as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(this.params);
    return {
      results: rows as T[],
      meta: { changes: 0, last_row_id: 0 },
      success: true,
    };
  }
}

// ---------------------------------------------------------------------------
// MockD1Database
// ---------------------------------------------------------------------------

export class MockD1Database {
  constructor(private db: Database.Database) {}

  prepare(sql: string): MockPreparedStatement {
    return new MockPreparedStatement(this.db, sql);
  }

  async batch(stmts: MockPreparedStatement[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    // Run all statements inside a single SQLite transaction for consistency.
    const trx = this.db.transaction(() => {
      // Defer FK checks to COMMIT for the duration of this batch so a child
      // row may be inserted alongside (or just before) its parent within the
      // same atomic batch — matching D1's all-or-nothing batch semantics. The
      // pragma auto-resets at COMMIT, so it is re-enabled per batch.
      this.db.pragma("defer_foreign_keys = ON");
      for (const stmt of stmts) {
        results.push(stmt._runSync());
      }
    });
    trx();
    return results;
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    this.db.exec(query);
    return { count: 0, duration: 0 };
  }
}

// ---------------------------------------------------------------------------
// Schema loader
// ---------------------------------------------------------------------------

/**
 * Migration files to apply when creating a test database.
 * The full ZC/Bank schema (including the BankJournals currency dimension, the
 * DnsCycles settlement chain, and the FX marketplace tables) has been squashed
 * into a single definitive schema; apply that one file to get the complete
 * schema + seed data.
 */
const SCHEMA_MIGRATIONS = ["0001_consolidated_schema.sql"];

/**
 * Create a fresh in-memory SQLite database with the ZC/Bank schema applied.
 *
 * Each call returns an independent database instance (no shared state between
 * tests).
 */
export function createTestDb(): { sqlite: Database.Database; d1: MockD1Database } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  // Enforce declared FOREIGN KEY constraints, matching a FK-enforcing
  // production backend (Cloudflare D1 / distributed SQL). Referential
  // integrity is therefore exercised by the suite rather than silently
  // disabled. Within db.batch() the checks are deferred to COMMIT (see
  // MockD1Database.batch) so a child row may ride in the same atomic batch
  // as its parent; single statements use immediate per-statement checking.
  sqlite.pragma("foreign_keys = ON");

  for (const migration of SCHEMA_MIGRATIONS) {
    const sql = readFileSync(join(MIGRATIONS_DIR, migration), "utf-8");
    sqlite.exec(sql);
  }

  return { sqlite, d1: new MockD1Database(sqlite) };
}
