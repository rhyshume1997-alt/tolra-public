/**
 * The Customers page shows saved customers plus names that exist only on RFQs, quotes, sales orders and invoices (which store the
 * customer as text), read page by page past the API's 1,000-row cap. Names with no record are marked, never written. The customer
 * pickers keep the saved list only.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

import { type DocumentNameReader, mergeKnownCustomers, newCustomerDraft, readDocumentCustomerNames } from "@/lib/customers";
import { MAX_LIST_ROWS } from "@/lib/fetch-all";

const saved = (name: string, id = name) => ({ id, name, contactName: "", email: "", phone: "", address: "", notes: "" });

/** A fake API: each table's rows, at most `cap` per request (hosted Supabase answers at most 1,000), "error" or "throw". */
function reader(rows: Record<string, Array<{ customer: string | null }> | "error" | "throw">, cap = 1_000): DocumentNameReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    from: (table: string) => ({
      select: (columns: string) => ({
        order: (column: string) => ({
          range: (from: number, to: number) => {
            reads.push(`${table}:${columns}:${column}:${from}-${to}`);
            const result = rows[table];
            if (result === "throw") throw new Error("boom");
            if (result === "error" || result === undefined) return Promise.resolve({ data: null, error: { message: "denied" } });
            const page = result.slice(from, Math.min(to + 1, from + cap)).map((row, i) => ({ id: `${table}-${from + i}`, ...row }));
            return Promise.resolve({ data: page, error: null });
          },
        }),
      }),
    }),
  };
}

describe("mergeKnownCustomers", () => {
  it("lists a document-only name after the saved customers, marked not saved", () => {
    const merged = mergeKnownCustomers([saved("Acme Ltd")], ["ZZ TEST Customer"]);
    expect(merged.map((c) => c.name)).toEqual(["Acme Ltd", "ZZ TEST Customer"]);
    expect(merged[0].notSaved).toBeUndefined();
    expect(merged[1]).toMatchObject({ name: "ZZ TEST Customer", notSaved: true });
    expect(merged[1].id).toBeUndefined();
  });

  it("does not repeat a saved customer or a repeated document name (case and spaces ignored)", () => {
    const merged = mergeKnownCustomers([saved("Acme Ltd")], ["acme ltd ", "Test Company Ltd", " TEST COMPANY LTD", "", null, undefined]);
    expect(merged.map((c) => c.name)).toEqual(["Acme Ltd", "Test Company Ltd"]);
  });

  it("sorts the unsaved names and keeps the saved list as read", () => {
    const merged = mergeKnownCustomers([saved("B"), saved("A")], ["Zed Co", "Defence Manufacturing Co"]);
    expect(merged.map((c) => c.name)).toEqual(["B", "A", "Defence Manufacturing Co", "Zed Co"]);
  });
});

describe("readDocumentCustomerNames", () => {
  it("reads the customer column of RFQs, quotes, sales orders and invoices, page by page in id order", async () => {
    const client = reader({ rfqs: [{ customer: "R" }], quotes: [{ customer: "Q" }], sales_orders: [{ customer: "S" }], invoices: [{ customer: "I" }] });
    const { names, truncated } = await readDocumentCustomerNames(client);
    expect(names.sort()).toEqual(["I", "Q", "R", "S"]);
    expect(truncated).toBe(false);
    expect(client.reads.filter((read) => read.endsWith(":0-999")).sort()).toEqual(["invoices:id, customer:id:0-999", "quotes:id, customer:id:0-999", "rfqs:id, customer:id:0-999", "sales_orders:id, customer:id:0-999"]);
  });

  it("finds a name that is only past row 1,000 (the API answers at most 1,000 rows a request)", async () => {
    const quotes = Array.from({ length: 1_500 }, (_, i) => ({ customer: i === 1_249 ? "Late Row Ltd" : "Common Co" }));
    const { names } = await readDocumentCustomerNames(reader({ rfqs: [], quotes, sales_orders: [], invoices: [] }));
    expect(names).toContain("Late Row Ltd");
    expect(names).toHaveLength(1_500);
    expect(mergeKnownCustomers([saved("Common Co")], names).map((c) => c.name)).toEqual(["Common Co", "Late Row Ltd"]);
  });

  it("says so when a table has more rows than the list reads", async () => {
    const invoices = Array.from({ length: MAX_LIST_ROWS + 5 }, () => ({ customer: "Busy Co" }));
    const { truncated } = await readDocumentCustomerNames(reader({ rfqs: [], quotes: [], sales_orders: [], invoices }));
    expect(truncated).toBe(true);
  });

  it("a table that cannot be read adds nothing and never fails the list", async () => {
    const client = reader({ rfqs: "error", quotes: "throw", sales_orders: [{ customer: null }, { customer: "S" }], invoices: [] });
    expect((await readDocumentCustomerNames(client)).names).toEqual(["", "S"]);
  });
});

describe("customer pickers", () => {
  it("keep the saved customer list: only the Customers page reads names from documents", () => {
    const picker = readFileSync("components/customer-select.tsx", "utf8");
    // The saved list less archived customers (097): fetchPickerCustomers reads fetchCustomers, never document names.
    expect(picker).toContain("loadPickerNames(fetchPickerCustomers)");
    const lib = readFileSync("lib/customers.ts", "utf8");
    const fn = lib.slice(lib.indexOf("export async function fetchPickerCustomers"), lib.indexOf("\n}\n", lib.indexOf("export async function fetchPickerCustomers")));
    expect(fn).toContain("await fetchCustomers()");
    expect(fn).not.toMatch(/fetchKnownCustomers|readDocumentCustomerNames/);
    expect(picker).not.toMatch(/fetchKnownCustomers|readDocumentCustomerNames/);
  });
});

describe("newCustomerDraft (opening a not-saved name uses the Add customer form)", () => {
  it("prefills the name, has no id, and offers the mobile only when the database has it", () => {
    expect(newCustomerDraft("ZZ TEST Customer")).toEqual({ name: "ZZ TEST Customer", contactName: "", email: "", phone: "", address: "", notes: "" });
    expect(newCustomerDraft("ZZ TEST Customer", true)).toMatchObject({ name: "ZZ TEST Customer", mobile: "" });
    expect(newCustomerDraft("X").id).toBeUndefined();
  });
});
