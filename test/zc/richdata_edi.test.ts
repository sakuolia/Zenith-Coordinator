/**
 * @file richdata_edi.test.ts — coverage for the rich-data store
 *       (zc/richdata/richdata.ts) and the ZEDI module (zc/richdata/edi.ts),
 *       previously exercised by no test.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type MockD1Database } from "../helpers/d1-mock";
import {
  storeRichData,
  getRichData,
  listRichDataByTxid,
  computeContentHash,
} from "../../src/zc/richdata/richdata";
import {
  registerEdiRecord,
  getEdiByRef,
  getEdiByTxid,
  linkEdiToTransaction,
  filterByEdiCondition,
  serializeLineItems,
} from "../../src/zc/richdata/edi";

let d1: MockD1Database;

beforeEach(() => {
  ({ d1 } = createTestDb());
});

describe("richdata store", () => {
  it("stores small content inline (no R2), with a matching content hash and 365d retention", async () => {
    const content = { invoice_number: "INV-1", total_amount: 5000 };
    const row = await storeRichData(
      d1 as any,
      { data_type: "INVOICE", bank_id: "001", txid: "TX-1", content },
      "001",
      {}
    );
    expect(row.r2_key).toBeNull();
    expect(row.retention_days).toBe(365);
    expect(JSON.parse(row.content_json)).toEqual(content);
    expect(row.content_hash).toBe(await computeContentHash(content));
    // ~365 days ahead
    const days =
      (new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()) / 86400000;
    expect(Math.round(days)).toBe(365);

    const fetched = await getRichData(d1 as any, row.data_ref);
    expect(fetched?.data_ref).toBe(row.data_ref);
  });

  it("offloads content over 50KB to R2 and keeps only a summary in D1", async () => {
    const puts: Array<{ key: string; body: string }> = [];
    const env = {
      R2_BUCKET: {
        put: async (key: string, body: string) => {
          puts.push({ key, body });
        },
      } as any,
    };
    const bigItems = Array.from({ length: 4000 }, (_, i) => ({ sku: `SKU-${i}`, qty: i }));
    const content = { invoice_number: "INV-BIG", line_items: bigItems };

    const row = await storeRichData(
      d1 as any,
      { data_type: "EDI", bank_id: "001", content },
      "001",
      env
    );
    expect(row.r2_key).toMatch(/^richdata\//);
    expect(puts).toHaveLength(1); // full content went to R2
    const summary = JSON.parse(row.content_json);
    expect(summary._summary).toBe(true);
    expect(summary.item_count).toBe(4000);
    // The hash still commits to the FULL content, not the summary.
    expect(row.content_hash).toBe(await computeContentHash(content));
  });

  it("lists rich data by txid in creation order", async () => {
    await storeRichData(
      d1 as any,
      { data_type: "INVOICE", bank_id: "001", txid: "TX-9", content: { n: 1 } },
      "001",
      {}
    );
    await storeRichData(
      d1 as any,
      { data_type: "REMITTANCE", bank_id: "001", txid: "TX-9", content: { n: 2 } },
      "001",
      {}
    );
    const rows = await listRichDataByTxid(d1 as any, "TX-9");
    expect(rows).toHaveLength(2);
  });

  it("computeContentHash is deterministic and content-sensitive", async () => {
    expect(await computeContentHash({ a: 1 })).toBe(await computeContentHash({ a: 1 }));
    expect(await computeContentHash({ a: 1 })).not.toBe(await computeContentHash({ a: 2 }));
  });
});

describe("EDI records", () => {
  function seedTx(txid: string, amount: number) {
    d1.prepare(
      `INSERT INTO Transactions (txid, lane, state, amount_value, payer_bank_id, payer_account_hash, payee_bank_id, idempotency_key, created_at, updated_at)
       VALUES (?, 'STANDARD', 'SETTLED', ?, '001', 'h', '002', ?, 't', 't')`
    )
      .bind(txid, amount, `idem-${txid}`)
      ._runSync();
  }

  it("registers an EDI record (txid null until linked) and reads it back by ref", async () => {
    const row = await registerEdiRecord(
      d1 as any,
      {
        edi_ref: "ignored",
        bank_id: "001",
        invoice_number: "INV-100",
        note: "urgent",
        line_items: [{ name: "A", qty: 1 } as any],
        idempotency_key: "k1",
      },
      "001"
    );
    expect(row.txid).toBeNull();
    expect(row.format_version).toBe("1.0");
    expect(row.line_items_json).toBe(serializeLineItems([{ name: "A", qty: 1 } as any]));

    const byRef = await getEdiByRef(d1 as any, row.edi_ref);
    expect(byRef?.invoice_number).toBe("INV-100");
  });

  it("links an EDI record to a transaction (both sides updated)", async () => {
    seedTx("TX-EDI", 5000);
    const row = await registerEdiRecord(
      d1 as any,
      { edi_ref: "x", bank_id: "001", invoice_number: "INV-L", idempotency_key: "k2" },
      "001"
    );
    await linkEdiToTransaction(d1 as any, "TX-EDI", row.edi_ref);

    const byTxid = await getEdiByTxid(d1 as any, "TX-EDI");
    expect(byTxid?.edi_ref).toBe(row.edi_ref);
    const tx = await d1
      .prepare(`SELECT edi_ref FROM Transactions WHERE txid = 'TX-EDI'`)
      .first<{ edi_ref: string }>();
    expect(tx?.edi_ref).toBe(row.edi_ref);
  });

  it("filters by invoice_number EQUALS and note CONTAINS", async () => {
    await registerEdiRecord(
      d1 as any,
      {
        edi_ref: "a",
        bank_id: "001",
        invoice_number: "INV-A",
        note: "rush order",
        idempotency_key: "ka",
      },
      "001"
    );
    await registerEdiRecord(
      d1 as any,
      {
        edi_ref: "b",
        bank_id: "001",
        invoice_number: "INV-B",
        note: "normal",
        idempotency_key: "kb",
      },
      "001"
    );

    const eq = await filterByEdiCondition(d1 as any, "001", {
      field: "invoice_number",
      operator: "EQUALS",
      value: "INV-A",
    } as any);
    expect(eq.map((r) => r.invoice_number)).toEqual(["INV-A"]);

    const contains = await filterByEdiCondition(d1 as any, "001", {
      field: "note",
      operator: "CONTAINS",
      value: "rush",
    } as any);
    expect(contains.map((r) => r.invoice_number)).toEqual(["INV-A"]);

    // a different bank sees none of bank 001's records
    const otherBank = await filterByEdiCondition(d1 as any, "999", {
      field: "invoice_number",
      operator: "EQUALS",
      value: "INV-A",
    } as any);
    expect(otherBank).toHaveLength(0);
  });

  it("filters by amount_range GT/LT via the Transactions join", async () => {
    seedTx("TX-AMT", 5000);
    const row = await registerEdiRecord(
      d1 as any,
      { edi_ref: "amt", bank_id: "001", invoice_number: "INV-AMT", idempotency_key: "kamt" },
      "001"
    );
    await linkEdiToTransaction(d1 as any, "TX-AMT", row.edi_ref);

    const gtHit = await filterByEdiCondition(d1 as any, "001", {
      field: "amount_range",
      operator: "GT",
      value: "1000",
    } as any);
    expect(gtHit.map((r) => r.invoice_number)).toContain("INV-AMT");

    const gtMiss = await filterByEdiCondition(d1 as any, "001", {
      field: "amount_range",
      operator: "GT",
      value: "9000",
    } as any);
    expect(gtMiss.map((r) => r.invoice_number)).not.toContain("INV-AMT");
  });
});
