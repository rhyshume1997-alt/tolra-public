import { describe, expect, it } from "vitest";
import { reconcile, parseDbRows, type DbRow, type SourceTotals } from "@/lib/sliq-reconcile/reconcile";
import { renderSigningSheet } from "@/lib/sliq-reconcile/sheet";

const source: SourceTotals = {
  files: [{ name: "inv.csv", sha256: "c".repeat(64) }],
  counts: { customers: 2, invoices: 2, payments: 1, credit_notes: 0 },
  invoiceTotalPence: 30000, paymentsTotalPence: 10000, creditsTotalPence: 0, outstandingPence: 20000,
  customerBalancesPence: { "Acme Ltd": 20000, "Brook  Co": 0 },
  invoiceRefMin: 1, invoiceRefMax: 2,
};
const row = (metric: string, key: string, value: string | number | null): DbRow => ({ metric, key, value });
const clean = (): DbRow[] => [
  row("count", "customers", 2), row("count", "invoices", 2), row("count", "payments", 1), row("count", "credit_notes", 0),
  row("total_pence", "invoiced", 30000), row("total_pence", "paid", 10000), row("total_pence", "credits", 0), row("total_pence", "outstanding", 20000),
  row("total_pence", "refunds", 0), row("total_pence", "customer_credit", 0), row("total_pence", "net_live", 20000), row("excluded_invoices", "count", 0),
  row("customer_outstanding_pence", "acme ltd", 20000), row("customer_outstanding_pence", "brook co", 0),
  row("invoice_ref", "min_number", 1), row("invoice_ref", "max_number", 2), row("invoice_ref", "not_INV_format", 0),
  row("counter_last", "INV", 2), row("counter_last", "QUO", 5),
  row("dup_customer_name", "groups", 0), row("dup_customer_email", "groups", 0), row("dup_invoice_ref", "groups", 0), row("dup_payment", "groups", 0),
  row("orphan_payments", "count", 0), row("overpaid_invoices", "count", 0),
];
const opts = { countersBefore: { INV: 0, QUO: 5 } };
const failed = (rows: DbRow[], s = source, o = opts) => reconcile(s, rows, o).rows.filter((r) => r.status === "FAIL").map((r) => r.check);

describe("sliq reconcile", () => {
  it("passes a clean import", () => {
    const r = reconcile(source, clean(), opts);
    expect(r.pass).toBe(true);
    expect(r.rows.every((x) => x.difference === "0")).toBe(true);
  });

  it("fails an off-by-one-penny balance", () => {
    const rows = clean().map((x) => (x.metric === "customer_outstanding_pence" && x.key === "acme ltd" ? { ...x, value: 20001 } : x.metric === "total_pence" && x.key === "outstanding" ? { ...x, value: 20001 } : x));
    const f = failed(rows);
    expect(f).toContain("outstanding (pence)");
    expect(f).toContain("customer balance: acme ltd");
    expect(reconcile(source, rows, opts).pass).toBe(false);
  });

  it("fails when the database outstanding does not follow from its parts", () => {
    // The parts (live invoices, unfloored) no longer add up to outstanding - customer credit.
    const rows = clean().map((x) => (x.metric === "total_pence" && x.key === "net_live" ? { ...x, value: 20001 } : x));
    expect(failed(rows)).toContain("database outstanding - customer credit = live invoiced - paid - credits + refunds");
  });

  it("fails duplicates, orphans and overpaid invoices", () => {
    const rows = clean().map((x) => (x.metric === "dup_customer_name" ? { ...x, value: 1 } : x.metric === "dup_payment" ? { ...x, value: 2 } : x.metric === "orphan_payments" ? { ...x, value: 1 } : x.metric === "overpaid_invoices" ? { ...x, value: 1 } : x));
    expect(failed(rows)).toEqual(expect.arrayContaining([
      "duplicate customer names (groups)", "duplicate payments (invoice, date, amount, reference) (groups)", "orphan payments", "invoices with paid + credits above total",
    ]));
  });

  it("fails a counter at or below the highest ref, and a changed other prefix", () => {
    const low = clean().map((x) => (x.metric === "counter_last" && x.key === "INV" ? { ...x, value: 1 } : x));
    expect(failed(low)).toContain("INV counter next value above highest ref");
    const moved = clean().map((x) => (x.metric === "counter_last" && x.key === "QUO" ? { ...x, value: 6 } : x));
    expect(failed(moved)).toContain("counter unchanged: QUO");
  });

  it("fails when counts differ and when a customer is missing from the database", () => {
    const rows = clean().map((x) => (x.metric === "count" && x.key === "customers" ? { ...x, value: 3 } : x)).filter((x) => x.key !== "brook co" || x.metric !== "customer_outstanding_pence");
    expect(failed(rows)).toContain("count: customers");
  });

  it("limits the customer list to the top N by difference", () => {
    const s = { ...source, customerBalancesPence: { a: 1, b: 2, c: 3 } };
    const r = reconcile(s, [...clean().filter((x) => x.metric !== "customer_outstanding_pence")], { ...opts, topN: 2 });
    expect(r.rows.filter((x) => x.check.startsWith("customer balance: "))).toHaveLength(2);
    expect(r.rows.find((x) => x.check === "customer balances differing (count)")?.database).toBe("3");
  });

  it("parses details and renders a sheet that says FAIL and has signature lines", () => {
    const rows = [...clean(), row("dup_customer_name_detail", "acme ltd", 2), row("overpaid_invoices_detail", "INV-0001", 100000)];
    expect(parseDbRows(rows).dupDetail).toEqual(["customer_name: acme ltd x2"]);
    const rep = reconcile(source, rows, opts);
    const sheet = renderSigningSheet(source, rep, { company: "Test Ltd", importedOn: "2026-01-01" });
    expect(sheet).toContain("c".repeat(64));
    expect(sheet).toContain("John:");
    expect(sheet).toContain("Rhys:");
    expect(renderSigningSheet(source, reconcile(source, clean(), opts), { company: "Test Ltd", importedOn: "x" })).toContain("Overall result: PASS");
  });

  it("follows the app's balance (034): refunds and void / draft invoices in Tolra the source did not state FAIL loudly; overpayment is customer credit", () => {
    const refunded = clean().map((x) => (x.metric === "total_pence" && x.key === "refunds" ? { ...x, value: 500 } : x));
    expect(failed(refunded)).toContain("refunds total (pence)");
    const voided = clean().map((x) => (x.metric === "excluded_invoices" ? { ...x, value: 1 } : x));
    expect(failed(voided)).toContain("invoices left out of what is owed (void, cancelled, written off, draft)");
    const credit = clean().map((x) => (x.metric === "total_pence" && x.key === "customer_credit" ? { ...x, value: 300 } : x.metric === "total_pence" && x.key === "net_live" ? { ...x, value: 19700 } : x));
    expect(failed(credit)).toEqual(["customer credit (pence)"]);
    expect(failed(credit, { ...source, customerCreditPence: 300, outstandingPence: 20000, paymentsTotalPence: 10300 }).filter((c) => !c.startsWith("payments total"))).toEqual([]);
  });
});
