/**
 * (5) THE READ-ONLY RECONCILIATION REPORT (tests/import/reconcile.ts). Proven here:
 *   - it produces counts and a discrepancy list that match what the synthetic scenario was designed to contain, no more and no fewer;
 *   - it is read only: every statement it sends is a SELECT, it runs inside BEGIN READ ONLY, and a content fingerprint of every table plus every
 *     sequence is identical before and after (and a negative control shows a READ ONLY transaction really would have refused a write);
 *   - it is not a rubber stamp: when the database is tampered with (inside a rolled-back transaction) each tamper is caught and named;
 *   - its source side agrees whether it is built from the generator's own figures or from the importer's parse of the CSV files.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { heldFromReport, reconcile, reconcileReadOnly, selectOnly, snapshotFromLoaded, type ReconciliationReport } from "./reconcile";
import { withClient } from "./support/db";
import { buildWorld, type World } from "./support/world";

let w: World;
let base: ReconciliationReport;
beforeAll(async () => {
  w = await buildWorld("reconcile");
  base = await reconcileReadOnly(w.db.url, w.snapshot, { organizationId: w.orgId });
});
afterAll(async () => {
  await w?.db.drop();
});

/** md5 of every row of every table in public/auth, plus every sequence's position: any INSERT/UPDATE/DELETE/nextval changes it. */
async function fingerprint(url: string) {
  return withClient(url, async (db) => {
    const tables = (await db.query("select schemaname, tablename from pg_tables where schemaname in ('public','auth','storage','supabase_migrations') order by 1,2")).rows;
    const out: Record<string, string> = {};
    for (const t of tables) {
      const r = await db.query(`select count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as f from ${t.schemaname}.${t.tablename} x`);
      out[`${t.schemaname}.${t.tablename}`] = r.rows[0].f;
    }
    const seqs = (await db.query("select schemaname || '.' || sequencename as n, last_value::text as v from pg_sequences order by 1")).rows;
    for (const s of seqs) out[`seq:${s.n}`] = String(s.v);
    return out;
  });
}

describe("what the report says about the designed scenario", () => {
  it("counts: source and database, per entity", () => {
    expect(base.format).toBe("sliq-import-reconciliation/1");
    expect(base.readOnly).toBe(true);
    expect(base.counts).toEqual({
      customers: { source: 33, sourceDistinctNormalised: 32, database: 33 },
      invoices: { source: 75, sourceDistinctNumbers: 74, database: 71, importedByMap: 71 },
      invoiceLines: { source: 133, database: 133 },
      payments: { source: 57, database: 50 },
      quotes: { source: 3, database: 3 },
    });
  });

  it("totals: the imported invoices' gross equals the source gross of those same invoices, and payments equal amount paid", () => {
    expect(base.totalsPence.sourceGrossOfImportedInvoices).toBe(base.totalsPence.databaseGross);
    expect(base.totalsPence.databasePayments).toBe(base.totalsPence.databaseAmountPaid);
  });

  it("the discrepancy list is exactly the designed awkward cases (a regression pin: a new kind of discrepancy, or a lost one, fails here)", () => {
    expect(base.summary).toEqual({
      customer_duplicate_in_source: 1,
      customer_duplicate_in_database: 1,
      invoice_duplicate_in_source: 1,
      invoice_missing: 3,
      invoice_vat_rounding: 1,
      invoice_internal_total: 1,
      payment_overpaid_in_source: 1,
      payment_not_imported: 3,
      payment_on_unissued_invoice: 1,
      payment_unallocated: 1,
      invoice_part_paid: base.summary.invoice_part_paid, // data-dependent (seeded bulk); asserted > 0 below
      number_gap: 2,
    });
    expect(base.summary.invoice_part_paid).toBeGreaterThanOrEqual(2);
    expect(base.discrepancies.filter((d) => d.severity === "error").map((d) => `${d.check}:${d.key}`).sort()).toEqual(["invoice_internal_total:INV-0123", "invoice_missing:INV-0110", "invoice_missing:INV-0111", "invoice_missing:INV-0124"]);
  });

  it("given the importer's own held list, the three missing invoices are still LISTED but explained, and the only real error left is INV-0123", async () => {
    const held = heldFromReport(w.run.report);
    const rep = await reconcileReadOnly(w.db.url, w.snapshot, { organizationId: w.orgId, held });
    const missing = rep.discrepancies.filter((d) => d.check === "invoice_missing");
    expect(missing).toHaveLength(3);
    expect(missing.every((d) => d.severity === "info" && d.explained)).toBe(true);
    expect(rep.discrepancies.filter((d) => d.severity === "error").map((d) => d.key)).toEqual(["INV-0123"]);
  });

  it("the source side is the same whether it comes from the generator's pence or from the importer's parse of the CSV files", async () => {
    const parsed = snapshotFromLoaded(w.run.loaded);
    const a = await reconcileReadOnly(w.db.url, parsed, { organizationId: w.orgId });
    expect(a.counts).toEqual(base.counts);
    expect(a.discrepancies).toEqual(base.discrepancies);
  });
});

describe("read only", () => {
  it("every statement it sends is a SELECT/WITH: recorded across a full run", async () => {
    const sent: string[] = [];
    await withClient(w.db.url, async (db) => {
      const spy = { query: (sql: string, p?: unknown[]) => (sent.push(sql), db.query(sql, p)) } as Pick<Client, "query">;
      await reconcile(spy, w.snapshot, { organizationId: w.orgId });
    });
    expect(sent.length).toBeGreaterThan(5);
    expect(sent.filter((s) => !/^\s*(select|with)\b/i.test(s))).toEqual([]);
    expect(sent.some((s) => /nextval|next_doc_number|setval/i.test(s))).toBe(false);
  });

  it("the guard refuses anything that is not a single SELECT before it reaches the server", async () => {
    const never = { query: () => { throw new Error("reached the server"); } } as unknown as Pick<Client, "query">;
    for (const sql of ["insert into public.customers (name) values ('x')", "update public.invoices set total = 0", "delete from public.invoices", "select 1; drop table public.invoices", "select public.next_doc_number('INV')", "select nextval('x')", "with a as (delete from public.invoices returning 1) select * from a", "truncate public.invoices", "create table x()"]) {
      await expect(selectOnly(never, sql), sql).rejects.toThrow(/read only/);
    }
  });

  it("negative control: a READ ONLY transaction really refuses a write (SQLSTATE 25006), so running inside one is a proof", async () => {
    await withClient(w.db.url, async (db) => {
      await db.query("begin read only");
      await expect(db.query("update public.doc_counters set last = last")).rejects.toMatchObject({ code: "25006" });
      await db.query("rollback");
    });
  });

  it("the database is unchanged by a run: every table's content and every sequence has the same fingerprint before and after, run repeatedly", async () => {
    const before = await fingerprint(w.db.url);
    expect(Object.keys(before).length).toBeGreaterThan(100);
    for (let i = 0; i < 3; i++) await reconcileReadOnly(w.db.url, w.snapshot, { organizationId: w.orgId, held: heldFromReport(w.run.report) });
    const after = await fingerprint(w.db.url);
    expect(after).toEqual(before);
  });

  it("the fingerprint is able to see a change (a counter moved by one) - so 'unchanged' above means something", async () => {
    const before = await fingerprint(w.db.url);
    await withClient(w.db.url, (db) => db.query("update public.doc_counters set last = last + 1 where organization_id = $1 and prefix = 'INV'", [w.orgId]));
    const after = await fingerprint(w.db.url);
    await withClient(w.db.url, (db) => db.query("update public.doc_counters set last = last - 1 where organization_id = $1 and prefix = 'INV'", [w.orgId]));
    expect(after["public.doc_counters"]).not.toBe(before["public.doc_counters"]);
    expect(await fingerprint(w.db.url)).toEqual(before);
  });
});

describe("it is not a rubber stamp: tampering is caught and named", () => {
  /** Tamper inside a transaction that is always rolled back, reconcile on the same connection, return the discrepancies. Triggers are bypassed for the tamper only (disposable database). */
  async function tampered(tamper: string[], held: Record<string, string> = {}) {
    return withClient(w.db.url, async (db) => {
      await db.query("begin");
      try {
        await db.query("set local session_replication_role = replica");
        for (const t of tamper) await db.query(t.replaceAll("$ORG", `'${w.orgId}'`));
        await db.query("set local session_replication_role = origin");
        return (await reconcile(db, w.snapshot, { organizationId: w.orgId, held })).discrepancies;
      } finally {
        await db.query("rollback");
      }
    });
  }
  const has = (d: { check: string; key: string }[], check: string, key: string) => d.some((x) => x.check === check && x.key === key);

  it("a total moved by one penny -> invoice_total (and the internal total no longer adds up)", async () => {
    const d = await tampered(["update public.invoices set total = total + 0.01 where organization_id = $ORG and invoice_ref = 'INV-0100'"]);
    expect(has(d, "invoice_total", "INV-0100")).toBe(true);
    expect(has(d, "invoice_internal_total", "INV-0100")).toBe(true);
  });

  it("a payment row deleted -> payment_sum and amount_paid_vs_payments", async () => {
    const d = await tampered(["delete from public.invoice_payments where id = (select p.id from public.invoice_payments p join public.invoices i on i.id = p.invoice_id where i.invoice_ref = 'INV-0132' order by p.paid_on limit 1)"]);
    expect(has(d, "payment_sum", "INV-0132")).toBe(true);
    expect(has(d, "amount_paid_vs_payments", "INV-0132")).toBe(true);
    expect(has(d, "paid_but_not_settled", "INV-0132")).toBe(true);
  });

  it("a payment altered so the invoice is overpaid -> payments_exceed_invoice", async () => {
    const d = await tampered(["update public.invoice_payments set amount = amount + 5 where invoice_id = (select id from public.invoices where invoice_ref = 'INV-0130')"]);
    expect(has(d, "payments_exceed_invoice", "INV-0130")).toBe(true);
    expect(has(d, "payment_sum", "INV-0130")).toBe(true);
  });

  it("a line removed -> invoice_line_count and invoice_lines_vs_net", async () => {
    const d = await tampered(["delete from public.invoice_line_items where id = (select l.id from public.invoice_line_items l join public.invoices i on i.id = l.invoice_id where i.invoice_ref = 'INV-0121' order by l.position limit 1)"]);
    expect(has(d, "invoice_line_count", "INV-0121")).toBe(true);
    expect(has(d, "invoice_lines_vs_net", "INV-0121")).toBe(true);
  });

  it("an imported invoice deleted -> invoice_missing as an ERROR (nothing explains it), and as explained info when the importer's held list says so", async () => {
    const del = ["delete from public.invoice_payments where invoice_id in (select id from public.invoices where invoice_ref = 'INV-0101')", "delete from public.invoice_line_items where invoice_id in (select id from public.invoices where invoice_ref = 'INV-0101')", "delete from public.invoices where invoice_ref = 'INV-0101' and organization_id = $ORG"];
    const d = await tampered(del);
    expect(d.find((x) => x.check === "invoice_missing" && x.key === "INV-0101")).toMatchObject({ severity: "error" });
    const e = await tampered(del, { "INV-0101": "test: pretend the importer held it" });
    expect(e.find((x) => x.check === "invoice_missing" && x.key === "INV-0101")).toMatchObject({ severity: "info", explained: "test: pretend the importer held it" });
  });

  it("a renumbered invoice (-B suffix) -> invoice_unexpected plus invoice_missing for the original number", async () => {
    const d = await tampered(["update public.invoices set invoice_ref = 'INV-0100-B' where organization_id = $ORG and invoice_ref = 'INV-0100'"]);
    expect(has(d, "invoice_unexpected", "INV-0100-B")).toBe(true);
    expect(has(d, "invoice_missing", "INV-0100")).toBe(true);
  });

  it("an invoice pointed at a customer who does not exist -> invoice_customer_unknown and invoice_customer_changed", async () => {
    const d = await tampered(["update public.invoices set customer = 'Ghost Ltd' where organization_id = $ORG and invoice_ref = 'INV-0102'"]);
    expect(has(d, "invoice_customer_unknown", "INV-0102")).toBe(true);
    expect(has(d, "invoice_customer_changed", "INV-0102")).toBe(true);
  });

  it("a customer re-keyed with different case -> customer_duplicate_in_database; a customer removed -> customer_missing", async () => {
    const dup = await tampered(["insert into public.customers (organization_id, name) values ($ORG, 'alpha  fabrications limited')"]);
    expect(dup.some((x) => x.check === "customer_duplicate_in_database" && /alpha/i.test(x.key))).toBe(true);
    const gone = await tampered(["delete from public.customers where organization_id = $ORG and name = 'Omega Unused Ltd'"]);
    expect(has(gone, "customer_missing", "Omega Unused Ltd")).toBe(true);
  });

  it("a counter behind the highest number -> counter_behind (the collision risk); a counter row deleted -> counter_behind with no value", async () => {
    const behind = await tampered(["update public.doc_counters set last = 10 where organization_id = $ORG and prefix = 'INV'"]);
    expect(behind.find((x) => x.check === "counter_behind" && x.key === "INV")).toMatchObject({ severity: "error", actual: 10 });
    const gone = await tampered(["delete from public.doc_counters where organization_id = $ORG and prefix = 'QUO'"]);
    expect(gone.find((x) => x.check === "counter_behind" && x.key === "QUO")).toMatchObject({ severity: "error", actual: null });
  });

  it("a quote total changed -> quote_total", async () => {
    const d = await tampered(["update public.quotes set total_value = total_value + 1 where organization_id = $ORG and quote_ref = 'QUO-0050'"]);
    expect(has(d, "quote_total", "QUO-0050")).toBe(true);
  });

  it("the untampered database reports none of these (each tamper above is the only reason for its finding)", () => {
    const keys = new Set(base.discrepancies.map((d) => d.check));
    for (const c of ["invoice_total", "payment_sum", "amount_paid_vs_payments", "payments_exceed_invoice", "paid_but_not_settled", "invoice_line_count", "invoice_lines_vs_net", "invoice_unexpected", "invoice_customer_unknown", "invoice_customer_changed", "customer_missing", "counter_behind", "quote_total", "quote_missing", "payment_without_invoice"]) expect(keys.has(c), c).toBe(false);
  });
});
