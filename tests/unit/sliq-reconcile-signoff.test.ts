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
const failed = (rows: DbRow[], s = source, o: { countersBefore: Record<string, number> } = opts) => reconcile(s, rows, o).rows.filter((r) => r.status === "FAIL").map((r) => r.check);

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

  it("non-INV refs (S1001, 1001): the ref range is none on both sides, the not-INV count must match, the INV counter must not move", () => {
    const noInv: SourceTotals = { ...source, invoiceRefMin: undefined, invoiceRefMax: undefined };
    const s = { ...noInv, invoiceRefsNotInvFormat: 2 };
    // As import_sliq_reconcile_rows answers for refs S1001 / S1002 (the e2e files): min and max null, two refs not in INV-number format.
    const rows = (inv: number | null) => clean().map((x) => (x.metric === "invoice_ref" && x.key !== "not_INV_format" ? { ...x, value: null } : x.metric === "invoice_ref" ? { ...x, value: 2 } : x))
      .filter((x) => inv !== null || !(x.metric === "counter_last" && x.key === "INV")).map((x) => (x.metric === "counter_last" && x.key === "INV" ? { ...x, value: inv } : x));
    const r = reconcile(s, rows(null), { countersBefore: { QUO: 5 } });
    expect(r.rows.filter((x) => x.status === "FAIL")).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.rows.find((x) => x.check === "invoice refs not in INV-number format")).toMatchObject({ source: "2", database: "2", status: "PASS" });
    expect(r.rows.find((x) => x.check === "counter unchanged: INV (no INV-number refs)")).toMatchObject({ source: "0", database: "0", status: "PASS" });
    expect(r.rows.some((x) => x.check.startsWith("invoice ref m"))).toBe(false);
    // An INV counter that was there before and is unchanged passes; one the import moved fails.
    expect(reconcile(s, rows(7), { countersBefore: { INV: 7, QUO: 5 } }).pass).toBe(true);
    expect(failed(rows(8), s, { countersBefore: { INV: 7, QUO: 5 } })).toEqual(["counter unchanged: INV (no INV-number refs)"]);
    // The source says two non-INV refs; Tolra has one, or the source states none (old callers): FAIL.
    expect(failed(rows(null).map((x) => (x.key === "not_INV_format" ? { ...x, value: 1 } : x)), s, { countersBefore: { QUO: 5 } })).toEqual(["invoice refs not in INV-number format"]);
    expect(failed(rows(null), noInv, { countersBefore: { QUO: 5 } })).toEqual(["invoice refs not in INV-number format"]);
  });

  it("INV-number refs on one side only fail loudly (none against a number)", () => {
    const noInv: SourceTotals = { ...source, invoiceRefMin: undefined, invoiceRefMax: undefined };
    expect(failed(clean(), noInv)).toEqual(expect.arrayContaining(["invoice ref min", "invoice ref max"]));
    const dbNone = clean().map((x) => (x.metric === "invoice_ref" && x.key !== "not_INV_format" ? { ...x, value: null } : x));
    const r = reconcile(source, dbNone, opts);
    expect(r.rows.find((x) => x.check === "invoice ref min")).toMatchObject({ source: "1", database: "none", status: "FAIL" });
    expect(r.rows.find((x) => x.check === "INV counter above highest ref")?.status).toBe("FAIL");
  });

  it("none is not zero: no INV refs shows none on both sides (not-INV count 0 vs 0 is a number); an INV ref of 0 is a number; none against a number fails", () => {
    const refRows = (min: number | null, max: number | null, notInv: number) => clean().map((x) => (x.metric === "invoice_ref" && x.key === "min_number" ? { ...x, value: min }
      : x.metric === "invoice_ref" && x.key === "max_number" ? { ...x, value: max } : x.metric === "invoice_ref" ? { ...x, value: notInv } : x));
    const find = (rep: ReturnType<typeof reconcile>, check: string) => rep.rows.find((x) => x.check === check);
    // Source has no INV refs (range left out), database has none: none on both sides, so no range row and no FAIL; the not-INV count is 0 vs 0, a different row.
    const noInv: SourceTotals = { ...source, invoiceRefMin: undefined, invoiceRefMax: undefined, invoiceRefsNotInvFormat: 0 };
    const rNone = reconcile(noInv, refRows(null, null, 0), { countersBefore: { INV: 2, QUO: 5 } });
    expect(find(rNone, "invoice ref min")).toBeUndefined();
    expect(find(rNone, "invoice ref max")).toBeUndefined();
    expect(rNone.rows.filter((x) => x.status === "FAIL")).toEqual([]);
    expect(find(rNone, "invoice refs not in INV-number format")).toMatchObject({ source: "0", database: "0", difference: "0", status: "PASS" });
    // An INV ref of 0 (INV-0) is a number, not none: 0 vs 0 shows "0" and passes.
    const zero: SourceTotals = { ...source, invoiceRefMin: 0, invoiceRefMax: 0, invoiceRefsNotInvFormat: 0 };
    const rZero = reconcile(zero, refRows(0, 0, 0), opts);
    expect(find(rZero, "invoice ref min")).toMatchObject({ source: "0", database: "0", difference: "0", status: "PASS" });
    expect(find(rZero, "invoice ref max")).toMatchObject({ source: "0", database: "0", status: "PASS" });
    // none against a zero fails, in both directions (they are different things).
    const srcNoneDbZero = reconcile(noInv, refRows(0, 0, 0), { countersBefore: { INV: 2, QUO: 5 } });
    expect(find(srcNoneDbZero, "invoice ref min")).toMatchObject({ source: "none", database: "0", status: "FAIL" });
    expect(find(srcNoneDbZero, "invoice ref max")).toMatchObject({ source: "none", database: "0", status: "FAIL" });
    const srcZeroDbNone = reconcile(zero, refRows(null, null, 0), opts);
    expect(find(srcZeroDbNone, "invoice ref min")).toMatchObject({ source: "0", database: "none", status: "FAIL" });
    expect(find(srcZeroDbNone, "invoice ref max")).toMatchObject({ source: "0", database: "none", status: "FAIL" });
    // none against a real number fails too.
    expect(find(reconcile(noInv, refRows(1, 2, 0), { countersBefore: { INV: 2, QUO: 5 } }), "invoice ref min")).toMatchObject({ source: "none", database: "1", status: "FAIL" });
    expect(find(reconcile(source, refRows(null, null, 0), opts), "invoice ref min")).toMatchObject({ source: "1", database: "none", status: "FAIL" });
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
