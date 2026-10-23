/**
 * Company isolation. A snapshot is for one company. A row of another company (here "org B"), or a row that does not say which
 * company it belongs to, must never be compared and never be silently dropped: it is taken out and reported as a BLOCKER, and so is
 * every row that joins to it. Synthetic companies only: org A is the clean fixture's company, org B is made up.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT } from "../../scripts/sliq-reconcile/cli.mjs";
import { ORG, analyse, editTable, first, idOf, pick, runCli, workspace, type Row, type Ws } from "../support/sliq-reconcile";

const ORG_B = "bbbbbbbb-2222-4333-8444-555555555555";
const sev = (rows: Row[], s: string) => rows.filter((r) => r.severity === s);

/** Org B's invoice, credit note, delivery note, job and quote, all with made-up content. */
function addOrgBDocuments(ws: Ws) {
  editTable(ws, "invoices", (rows) => {
    rows.push({ organization_id: ORG_B, id: "b-inv-1", invoice_ref: "B-7001", customer: "Org B Fabrications", subtotal: "10.00", vat: "2.00", total: "12.00", status: "sent", amount_paid: "0.00", credited_amount: "0.00", refunded_amount: "0.00", payment_unverified: false, vat_enabled: true });
  });
  editTable(ws, "credit_notes", (rows) => {
    rows.push({ organization_id: ORG_B, id: "b-cn-1", invoice_id: "b-inv-1", credit_ref: "CN-B1", status: "issued", customer: "Org B Fabrications", subtotal: "5.00", vat: "1.00", total: "6.00", allocated_amount: "0.00" });
  });
  editTable(ws, "delivery_notes", (rows) => {
    rows.push({ organization_id: ORG_B, id: "b-dn-1", dn_number: "DN-B1", sales_order_id: null, job_id: null, invoice_id: null, status: "delivered", delivery_date: "2026-03-01" });
  });
  editTable(ws, "jobs", (rows) => {
    rows.push({ organization_id: ORG_B, id: "b-job-1", job_no: "J-B1", customer: "Org B Fabrications", stage: "setup", status: "on_track", quantity_required: 5, value: "1.00", converted_from_sales_order_id: null, finished_at: null, due_date: "2026-05-01" });
  });
}

describe("foreign rows are rejected, not dropped", () => {
  it("an org B row among org A's is a BLOCKER that names the table, row, id and both companies (fingerprints), and is not compared", async () => {
    const ws = workspace();
    addOrgBDocuments(ws);
    const { rows } = await analyse(ws);
    for (const [table, id] of [["invoices", "b-inv-1"], ["credit_notes", "b-cn-1"], ["delivery_notes", "b-dn-1"], ["jobs", "b-job-1"]]) {
      const hit = pick(rows, "foreign_company_row").find((r) => r.identifier.startsWith(`table=${table};`));
      expect(hit, table).toBeTruthy();
      expect(hit).toMatchObject({ area: "company-isolation", severity: "BLOCKER", field: "company (organization_id)" });
      expect(hit!.identifier).toContain(`row id=${id}`);
      expect(hit!.identifier).toMatch(/row=\d+/);
      expect(hit!.source_value).toMatch(/^org-[0-9a-f]{8}$/);
      expect(hit!.target_value).toMatch(/^org-[0-9a-f]{8}$/);
      expect(hit!.source_value).not.toBe(hit!.target_value);
      expect(hit!.reason).toContain("NOT compared");
    }
    // org B's documents were not read as org A's: no "only in Tolra" row, no count change, no org A row disturbed
    expect(rows.filter((r) => r.code.startsWith("tolra_only"))).toEqual([]);
    expect(rows.filter((r) => r.severity === "BLOCKER").every((r) => r.area === "company-isolation")).toBe(true);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("Org B");
    expect(text).not.toContain(ORG_B);
  });

  it("the run fails (exit 4, FAIL) and says so in the summary", async () => {
    const ws = workspace();
    addOrgBDocuments(ws);
    const r = await runCli(ws);
    expect(r.code).toBe(EXIT.BLOCKERS);
    const s = JSON.parse(readFileSync(path.join(ws.out, "summary.json"), "utf8"));
    expect(s.verdict.status).toBe("FAIL");
    expect(s.counts.byArea["company-isolation"].BLOCKER).toBe(4);
    expect(readdirSync(ws.out)).toContain("mismatches-company-isolation.csv");
  });

  it("a row with no organization_id, in a table that has the column, is a BLOCKER", async () => {
    const ws = workspace();
    editTable(ws, "quotes", (rows) => {
      delete rows.find((r) => r.quote_ref === "Q2003").organization_id;
      rows.find((r) => r.quote_ref === "Q2004").organization_id = null;
    });
    const { rows } = await analyse(ws);
    const hits = pick(rows, "row_without_company");
    expect(hits).toHaveLength(2);
    expect(hits.every((r) => r.severity === "BLOCKER" && r.identifier.startsWith("table=quotes;"))).toBe(true);
    expect(hits[0].target_value).toBe("(blank)");
    // not silently dropped and not compared: the two quotes are reported as missing from the data, never as matched
    expect(pick(rows, "quote_missing_in_tolra").map((r) => r.severity)).toEqual(["WARN", "WARN"]);
  });

  it("company ids compare without regard to case", async () => {
    const ws = workspace();
    editTable(ws, "customers", (rows) => rows.forEach((r) => (r.organization_id = r.organization_id.toUpperCase())));
    const { rows } = await analyse(ws);
    expect(rows.map((r) => r.code)).toEqual(["wip_valuation"]);
  });
});

describe("joins across companies", () => {
  it("a payment, an allocation, a delivery item, a ledger row, a job-quantity row and a legacy-map row that point at org B's documents are rejected", async () => {
    const ws = workspace();
    addOrgBDocuments(ws);
    const s1001 = idOf(ws, "invoices", "invoice_ref", "S1001");
    editTable(ws, "invoice_payments", (rows) => {
      rows.push({ organization_id: ORG, id: "a-pay-x", invoice_id: "b-inv-1", amount: "12.00", paid_on: "2026-03-30", source: "recorded" });
    });
    editTable(ws, "invoice_credit_allocations", (rows) => {
      rows.push({ organization_id: ORG, id: "a-alloc-x", invoice_id: s1001, credit_note_id: "b-cn-1", amount: "6.00", allocated_on: "2026-03-30" });
    });
    editTable(ws, "delivery_note_items", (rows) => {
      rows.push({ organization_id: ORG, id: "a-item-x", delivery_note_id: "b-dn-1", quantity: "3", description: "x" });
    });
    editTable(ws, "customer_credit_ledger", (rows) => {
      rows.push({ organization_id: ORG, id: "a-led-x", kind: "refund", invoice_id: "b-inv-1", to_invoice_id: null, amount: "1.00", paid_on: "2026-03-30" });
    });
    editTable(ws, "job_quantities", (rows) => {
      rows.push({ job_id: "b-job-1", quantity_made: 1, quantity_accepted: 1, quantity_rejected: 0, quantity_reworked: 0 });
    });
    editTable(ws, "legacy_import_map", (rows) => {
      rows.push({ source: "invoices", old_id: "4444444444444444", new_id: "b-inv-1" });
    });
    const { rows } = await analyse(ws);
    const joins = pick(rows, "cross_company_join");
    const tables = joins.map((r) => /table=([a-z_]+);/.exec(r.identifier)![1]).sort();
    expect(tables).toEqual(["customer_credit_ledger", "delivery_note_items", "invoice_credit_allocations", "invoice_payments", "job_quantities", "legacy_import_map"]);
    for (const r of joins) {
      expect(r).toMatchObject({ area: "company-isolation", severity: "BLOCKER" });
      expect(r.reason).toMatch(/The link is [a-z_]+\.[a-z_]+ -> [a-z_]+\./);
    }
    // org A's own invoice S1001 is untouched: nothing from org B reached its payments, credits or refunds
    expect(pick(rows, "payment_only_in_tolra")).toEqual([]);
    expect(pick(rows, "allocation_only_in_tolra")).toEqual([]);
    expect(pick(rows, "refund_only_in_tolra")).toEqual([]);
    expect(sev(rows, "BLOCKER").every((r) => r.area === "company-isolation")).toBe(true);
  });

  it("a row whose parent is a foreign row, whose own company is right, is still caught (and its children after it)", async () => {
    const ws = workspace();
    addOrgBDocuments(ws);
    editTable(ws, "invoice_payments", (rows) => {
      rows.push({ organization_id: ORG, id: "a-pay-1", invoice_id: "b-inv-1", amount: "12.00", paid_on: "2026-03-30", source: "recorded" });
      rows.push({ organization_id: ORG, id: "a-pay-2", invoice_id: idOf(ws, "invoices", "invoice_ref", "S1001"), amount: "-12.00", paid_on: "2026-03-31", source: "recorded", reverses_payment_id: "a-pay-1" });
    });
    const { rows } = await analyse(ws);
    const hits = pick(rows, "cross_company_join").filter((r) => r.identifier.startsWith("table=invoice_payments;"));
    expect(hits.map((r) => /row id=([a-z0-9-]+)/.exec(r.identifier)![1]).sort()).toEqual(["a-pay-1", "a-pay-2"]);
  });
});

describe("document numbers across companies", () => {
  it("org B using org A's invoice number is a cross-company collision, not a duplicate inside org A", async () => {
    const ws = workspace();
    editTable(ws, "invoices", (rows) => {
      rows.push({ organization_id: ORG_B, id: "b-inv-9", invoice_ref: "S1003", customer: "Org B Fabrications", subtotal: "1.00", vat: "0.20", total: "1.20", status: "sent", amount_paid: "0.00", credited_amount: "0.00", refunded_amount: "0.00", payment_unverified: false, vat_enabled: true });
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "foreign_company_row")).toMatchObject({ severity: "BLOCKER" });
    expect(first(rows, "cross_company_number", "S1003")).toMatchObject({ area: "company-isolation", severity: "BLOCKER" });
    expect(pick(rows, "tolra_duplicate_number")).toEqual([]);
    expect(pick(rows, "invoice_gross", "S1003")).toEqual([]); // org A's S1003 is compared against org A's only, and agrees
    expect(pick(rows, "invoice_outstanding")).toEqual([]);
  });

  it("the same number in org B's quote, job and credit note is reported too", async () => {
    const ws = workspace();
    editTable(ws, "quotes", (rows) => {
      rows.push({ organization_id: ORG_B, id: "b-q", quote_ref: "Q2001", customer: "x", total_value: "1.00", status: "sent", valid_until: null });
    });
    editTable(ws, "jobs", (rows) => {
      rows.push({ organization_id: ORG_B, id: "b-j", job_no: "J-0001", customer: "x", stage: "setup", status: "on_track", quantity_required: 1, value: "1.00", converted_from_sales_order_id: null, finished_at: null, due_date: null });
    });
    editTable(ws, "credit_notes", (rows) => {
      rows.push({ organization_id: ORG_B, id: "b-c", invoice_id: "b-i", credit_ref: "CN-001", status: "issued", customer: "x", subtotal: "1.00", vat: "0.20", total: "1.20", allocated_amount: "0.00" });
    });
    const { rows } = await analyse(ws);
    expect(pick(rows, "cross_company_number").map((r) => `${/table=([a-z_]+)/.exec(r.identifier)![1]}:${/number=(\S+)/.exec(r.identifier)![1]}`).sort()).toEqual(["credit_notes:CN-001", "jobs:J-0001", "quotes:Q2001"]);
  });

  it("two rows of one table with one id are a BLOCKER (joins to them cannot be trusted)", async () => {
    const ws = workspace();
    editTable(ws, "jobs", (rows) => {
      rows.push({ ...rows[0], job_no: "J-0009" });
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "duplicate_id")).toMatchObject({ area: "company-isolation", severity: "BLOCKER" });
  });
});

describe("a company that is not declared", () => {
  it("no company id on a table that should have one is UNVERIFIED, not a pass", async () => {
    const ws = workspace();
    editTable(ws, "quotes", (rows) => rows.map(({ organization_id, ...r }) => (void organization_id, r)));
    const { rows } = await analyse(ws);
    expect(first(rows, "table_without_company", "quotes")).toMatchObject({ area: "company-isolation", severity: "UNVERIFIED" });
    expect(sev(rows, "BLOCKER")).toEqual([]);
  });

  function metaWithout(ws: Ws) {
    const p = path.join(ws.tolra, "meta.json");
    const meta = JSON.parse(readFileSync(p, "utf8"));
    delete meta.organization_id;
    writeFileSync(p, JSON.stringify(meta));
  }

  it("rows of one company with no company declared in meta: UNVERIFIED", async () => {
    const ws = workspace();
    metaWithout(ws);
    const { rows } = await analyse(ws);
    expect(first(rows, "no_company_declared")).toMatchObject({ severity: "UNVERIFIED" });
    expect(sev(rows, "BLOCKER")).toEqual([]);
  });

  it("rows of two companies with no company declared: BLOCKER (nothing can be told apart)", async () => {
    const ws = workspace();
    metaWithout(ws);
    addOrgBDocuments(ws);
    const { rows } = await analyse(ws);
    expect(first(rows, "mixed_companies_no_meta")).toMatchObject({ severity: "BLOCKER", reason: expect.stringContaining("2 companies seen") });
  });

  it("a legacy-map row that carries a company id of another company is rejected", async () => {
    const ws = workspace();
    editTable(ws, "legacy_import_map", (rows) => {
      rows[0].organization_id = ORG_B;
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "foreign_company_row", "legacy_import_map").severity).toBe("BLOCKER");
  });
});
