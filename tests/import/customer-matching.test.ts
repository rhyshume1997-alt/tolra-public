/**
 * (1) CUSTOMER MATCHING. The importer matches an invoice's customer text to the customers file by a normalised name (case, spacing, punctuation,
 * "&"/"and", Ltd/Limited ignored). Proven here on the database the real importer wrote, not on its report:
 *   - the same customer under different spellings ends up as ONE customer, and the invoice names that customer;
 *   - genuinely different customers (near names) never merge, and none is dropped;
 *   - a duplicate in the file is REPORTED and both records are kept (nothing silently dropped);
 *   - a customer text that matches nobody holds the invoice instead of guessing;
 *   - a customer that already exists in the company is flagged for review and added separately, never merged behind the owner's back.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRehearsalDb, makeOrg, runImport, withClient } from "./support/db";
import { buildScenario } from "./support/synthetic";
import { buildWorld, type World } from "./support/world";

let w: World;
const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => withClient(w.db.url, async (db) => (await db.query(sql, p)).rows as T[]);
const invoiceCustomer = async (ref: string) => (await q<{ customer: string }>("select customer from public.invoices where organization_id = $1 and invoice_ref = $2", [w.orgId, ref]))[0]?.customer;
const customerRows = async (name: string) => (await q("select id from public.customers where organization_id = $1 and name = $2", [w.orgId, name])).length;

beforeAll(async () => {
  w = await buildWorld("custmatch");
});
afterAll(async () => {
  await w?.db.drop();
});

describe("same customer, different spellings -> one customer", () => {
  it.each([
    ["INV-0100", "alpha fabrications ltd", "Alpha Fabrications Ltd"],
    ["INV-0101", "  Alpha   Fabrications   LIMITED ", "Alpha Fabrications Ltd"],
    ["INV-0102", "BETA ENGINEERING LTD", "Beta Engineering Limited"],
    ["INV-0103", "Smith and Sons Limited", "Smith & Sons Ltd"],
    ["INV-0104", "SMITH & SONS LTD", "Smith & Sons Ltd"],
    ["INV-0106", "Delta Steel UK Ltd", "Delta Steel (UK) Ltd"],
  ])("%s (%j) is filed under %j and that customer exists exactly once", async (ref, _spelling, canonical) => {
    expect(await invoiceCustomer(ref)).toBe(canonical);
    expect(await customerRows(canonical)).toBe(1);
  });

  it("every imported invoice names the customer the generator intended, whatever its spelling in the file", async () => {
    let checked = 0;
    for (const inv of w.scenario.invoices) {
      if (!w.expectedImported.has(inv.number) || inv.customerName === null) continue;
      expect(await invoiceCustomer(inv.number), inv.number).toBe(inv.customerName === "ZETA METALS LTD" ? "Zeta Metals Ltd" : inv.customerName);
      checked++;
    }
    expect(checked).toBe(w.expectedImported.size);
    expect(checked).toBeGreaterThanOrEqual(60);
  });

  it("no spelling variant created a customer of its own: the database holds exactly the customers file, nothing more", async () => {
    const names = (await q<{ name: string }>("select name from public.customers where organization_id = $1 order by name", [w.orgId])).map((r) => r.name);
    expect(names).toEqual(w.scenario.customers.map((c) => c.name).sort());
  });
});

describe("genuinely different customers never merge", () => {
  it.each([
    ["Epsilon Welding", "Epsilon Welding Services", "INV-0107", "INV-0108"],
    ["Theta Ltd", "Theta Holdings Ltd", "INV-0109", "INV-0112"],
    ["Acme Tools", "Acme Toolz", "INV-0126", "INV-0114"],
  ])("%s and %s stay two customers, each keeping its own invoice", async (a, b, invA, invB) => {
    expect(await customerRows(a)).toBe(1);
    expect(await customerRows(b)).toBe(1);
    expect(await invoiceCustomer(invA)).toBe(a);
    expect(await invoiceCustomer(invB)).toBe(b);
  });

  it("the customer with no invoices (Omega Unused Ltd) is imported too: a customer is not dropped for lack of activity", async () => {
    expect(await customerRows("Omega Unused Ltd")).toBe(1);
  });
});

describe("duplicates in the file are reported, not silently dropped", () => {
  it("the importer's report lists the pair with file rows, and the database keeps BOTH records", async () => {
    const dup = w.run.report.duplicates.customers;
    expect(dup).toHaveLength(1);
    expect(dup[0].records.map((r: { name: string }) => r.name)).toEqual(w.scenario.facts.duplicateCustomerNames[0]);
    expect(dup[0].records.map((r: { row: number }) => r.row)).toEqual([8, 9]);
    expect(await customerRows("Zeta Metals Ltd")).toBe(1);
    expect(await customerRows("ZETA METALS LTD")).toBe(1);
  });

  it("an invoice naming the duplicated customer is filed under the FIRST record (documented behaviour), and the second record has none", async () => {
    expect(await invoiceCustomer("INV-0113")).toBe("Zeta Metals Ltd");
    const upper = await q("select 1 from public.invoices where organization_id = $1 and customer = 'ZETA METALS LTD'", [w.orgId]);
    expect(upper).toHaveLength(0);
  });
});

describe("a customer text that matches nobody is held, not guessed", () => {
  it("INV-0111 (Nonexistent Fabrications Ltd) is in the report's held list and not in the database", async () => {
    const held = w.run.report.held.find((h: { number: string }) => h.number === "INV-0111");
    expect(held.reasons.join(" ")).toMatch(/customer not found/);
    expect(await invoiceCustomer("INV-0111")).toBeUndefined();
    expect(await customerRows("Nonexistent Fabrications Ltd")).toBe(0);
  });
});

describe("a customer already in the company", () => {
  it("is flagged for review (same normalised name) and the imported one is added separately; the owner's record is untouched", async () => {
    const rehearsal = await createRehearsalDb("custexist");
    try {
      const { orgId } = await makeOrg(rehearsal.url, "t-custexist");
      await withClient(rehearsal.url, (db) => db.query("insert into public.customers (organization_id, name, email) values ($1, 'ALPHA FABRICATIONS LIMITED', 'owner-entered@example.test')", [orgId]));
      const run = await runImport({ url: rehearsal.url, orgId, scenario: buildScenario() });
      const review = run.report.collisions.customerReview as { sliqName: string; tolraNames: string[] }[];
      expect(review.map((r) => r.sliqName)).toContain("Alpha Fabrications Ltd");
      expect(review.find((r) => r.sliqName === "Alpha Fabrications Ltd")!.tolraNames).toEqual(["ALPHA FABRICATIONS LIMITED"]);
      const rows = await withClient(rehearsal.url, async (db) => (await db.query("select name, email from public.customers where organization_id = $1 and name ilike 'alpha fab%' order by name", [orgId])).rows);
      expect(rows.map((r) => r.name)).toEqual(["ALPHA FABRICATIONS LIMITED", "Alpha Fabrications Ltd"]);
      expect(rows[0].email).toBe("owner-entered@example.test");
    } finally {
      await rehearsal.drop();
    }
  });
});
