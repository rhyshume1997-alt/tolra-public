/**
 * The global search against a stand-in database that applies the filters it is given (eq on organization_id, or/ilike with escapes):
 * proves what is FOUND (quote number, customer PO, customer, job, invoice, supplier PO, line text, customer name/email), that another
 * company's rows are never returned, and what each role is shown. Row level security is the real wall (tests/db); this proves the
 * route also scopes every read to the session's company and never asks for a group the role may not open.
 */
import { describe, expect, it } from "vitest";

import { allowedGroups, runSearch, type SearchClient, type SearchQuery } from "@/lib/global-search";

type Row = Record<string, unknown>;
const ORG_A = "org-a";
const ORG_B = "org-b";

const tables: Record<string, Row[]> = {
  quotes: [
    { id: "qa", organization_id: ORG_A, quote_ref: "QUO-1001", customer: "Acme Ltd", customer_po: "PO-ACME-77" },
    { id: "qb", organization_id: ORG_B, quote_ref: "QUO-1001", customer: "Acme Ltd", customer_po: "PO-ACME-77" },
  ],
  invoices: [
    { id: "ia", organization_id: ORG_A, invoice_ref: "INV-2001", customer: "Acme Ltd", customer_po: "PO-ACME-77" },
    { id: "ib", organization_id: ORG_B, invoice_ref: "INV-2001", customer: "Acme Ltd", customer_po: "PO-ACME-77" },
  ],
  jobs: [
    { id: "ja", organization_id: ORG_A, job_no: "J-3001", customer: "Acme Ltd", description: "Gland nut" },
    { id: "jb", organization_id: ORG_B, job_no: "J-3001", customer: "Acme Ltd", description: "Gland nut" },
  ],
  purchase_orders: [
    { id: "pa", organization_id: ORG_A, po_ref: "PO-0001", po_number: "PO-0001", supplier: "Steel Co" },
    { id: "pb", organization_id: ORG_B, po_ref: "PO-0001", po_number: "PO-0001", supplier: "Steel Co" },
  ],
  customers: [
    { id: "ca", organization_id: ORG_A, name: "Acme Ltd", email: "buyer@acme.test" },
    { id: "cb", organization_id: ORG_B, name: "Acme Ltd", email: "buyer@acme.test" },
  ],
  quote_line_items: [
    { id: "qla", organization_id: ORG_A, quote_id: "qa", description: "Titanium bracket", quotes: { id: "qa", quote_ref: "QUO-1001", customer: "Acme Ltd" } },
    { id: "qlb", organization_id: ORG_B, quote_id: "qb", description: "Titanium bracket", quotes: { id: "qb", quote_ref: "QUO-1001", customer: "Acme Ltd" } },
  ],
  invoice_line_items: [
    { id: "ila", organization_id: ORG_A, invoice_id: "ia", description: "Titanium bracket", invoices: { id: "ia", invoice_ref: "INV-2001", customer: "Acme Ltd" } },
    { id: "ilb", organization_id: ORG_B, invoice_id: "ib", description: "Titanium bracket", invoices: { id: "ib", invoice_ref: "INV-2001", customer: "Acme Ltd" } },
  ],
};

/** An ilike pattern (% any run, _ any one, backslash escapes) as a regular expression. */
function ilike(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) { i += 1; source += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
    else if (ch === "%") source += ".*";
    else if (ch === "_") source += ".";
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

const selectedColumns = (select: string) => select.replace(/\w+\([^)]*\)/g, "").split(",").map((c) => c.trim()).filter(Boolean);

function stand(): SearchClient {
  return {
    from(table: string): SearchQuery {
      let rows = [...(tables[table] ?? [])];
      let select = "";
      const q: SearchQuery = {
        select: (cols) => { select = cols; return q; },
        eq: (column, value) => { rows = rows.filter((r) => r[column] === value); return q; },
        or: (filter) => {
          const conditions = filter.split(",").map((c) => /^([a-z_]+)\.ilike\.(.*)$/.exec(c)!);
          // A column that is not in this table is an error, as in the real database.
          const known = new Set(Object.keys(tables[table][0]));
          for (const [, column] of conditions) if (!known.has(column)) throw new Error(`unknown column ${column}`);
          rows = rows.filter((r) => conditions.some(([, column, pattern]) => ilike(pattern).test(String(r[column] ?? ""))));
          return q;
        },
        ilike: (column, pattern) => { rows = rows.filter((r) => ilike(pattern).test(String(r[column] ?? ""))); return q; },
        order: () => q,
        limit: (n) => {
          const wanted = selectedColumns(select);
          return Promise.resolve({ data: rows.slice(0, n).map((r) => ({ ...Object.fromEntries(Object.entries(r).filter(([k]) => wanted.includes(k) || /^(quotes|invoices)$/.test(k))) })), error: null });
        },
      };
      return q;
    },
  };
}

const search = (q: string, roles: string[], org = ORG_A, hidden: string[] = []) => runSearch(stand(), org, q, allowedGroups(roles, hidden));
const keys = async (q: string, roles: string[] = ["office"], org = ORG_A) => (await search(q, roles, org)).groups.map((g) => g.key);

describe("what is found", () => {
  it("a quote number finds the quote (and nothing from another company)", async () => {
    const { groups } = await search("QUO-1001", ["office"]);
    expect(groups.find((g) => g.key === "quotes")!.results.map((r) => r.id)).toEqual(["qa"]);
  });
  it("a customer's PO finds its quote and invoice", async () => {
    const { groups } = await search("acme-77", ["office"]);
    expect(groups.find((g) => g.key === "quotes")!.results.map((r) => r.id)).toEqual(["qa"]);
    expect(groups.find((g) => g.key === "invoices")!.results.map((r) => r.id)).toEqual(["ia"]);
  });
  it("a customer name finds the customer, their quote, invoice and job", async () => {
    expect(await keys("acme ltd")).toEqual(["quotes", "invoices", "jobs", "customers"]);
  });
  it("a job number finds the job; an invoice number finds the invoice; a supplier finds the supplier PO; line text finds its parent", async () => {
    expect((await search("J-3001", ["office"])).groups.map((g) => g.key)).toEqual(["jobs"]);
    expect((await search("INV-2001", ["office"])).groups.map((g) => g.key)).toEqual(["invoices"]);
    expect((await search("steel", ["office"])).groups.find((g) => g.key === "purchase_orders")!.results[0].href).toBe("/purchase-orders?po=pa");
    const lines = (await search("titanium", ["office"])).groups.find((g) => g.key === "lines")!;
    expect(lines.results.map((r) => r.href)).toEqual(["/quotes?quote=qa", "/invoices?invoice=ia"]);
  });
  it("a customer's e-mail finds the customer", async () => {
    expect((await search("buyer@acme", ["office"])).groups.find((g) => g.key === "customers")!.results[0].href).toBe("/customers?customer=ca");
  });
  it("a typed underscore or percent is not a wildcard", async () => {
    expect(await keys("J_3001")).toEqual([]);
    expect(await keys("J%3001")).toEqual([]);
    expect(await keys("J-3001")).toEqual(["jobs"]);
  });
});

describe("another company's search sees only its own rows", () => {
  it("company B finds its own rows and never A's ids", async () => {
    const result = await search("acme", ["office"], ORG_B);
    const ids = result.groups.flatMap((g) => g.results.map((r) => r.id));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.endsWith("b"))).toBe(true);
  });
  it("a company with no rows gets nothing at all, for every group", async () => {
    expect(await search("acme", ["admin"], "org-empty")).toMatchObject({ groups: [], unavailable: [] });
    expect(await search("titanium", ["admin"], "org-empty")).toMatchObject({ groups: [] });
  });
});

describe("each role", () => {
  it("admin and office: all groups", async () => {
    for (const role of ["admin", "office"]) expect(await keys("acme", [role]), role).toEqual(["quotes", "invoices", "jobs", "customers"]);
  });
  it("workshop and viewer: jobs only, even for text that matches quotes, invoices, customers and lines", async () => {
    for (const role of ["workshop", "viewer"]) {
      expect(await keys("acme", [role]), role).toEqual(["jobs"]);
      expect(await keys("titanium", [role]), role).toEqual([]);
      expect(await keys("QUO-1001", [role]), role).toEqual([]);
      expect(await keys("steel", [role]), role).toEqual([]);
    }
  });
  it("a page hidden from an office person is not searched", async () => {
    expect((await search("acme", ["office"], ORG_A, ["customers", "invoices"])).groups.map((g) => g.key)).toEqual(["quotes", "jobs"]);
  });
});
