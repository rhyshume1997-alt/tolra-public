/**
 * Candidate 2F: tests for the behaviours the importer red team's mutants showed were not pinned (RT-IMP-SONNETB-EDGE.md: M59, M114,
 * M115, M111, M102, M101, M44-M50, M53-M55, M29). Each test names the mutant it is meant to kill.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildSliqPayload, sourceTotalsFromValidated } from "@/lib/sliq-import-build";
import { type Rpc, type SliqPayload, SLIQ_PREFLIGHT_MAX_BYTES, jsonbTextBytes, planSliqBatches, preflightTooLarge, sliqPreflight, sliqRunBatches } from "@/lib/sliq-import-route";
import { type DbRow, type SourceTotals, reconcile } from "@/lib/sliq-reconcile/reconcile";
import { renderSigningSheet } from "@/lib/sliq-reconcile/sheet";
import { type SliqMapping, type ValidationReport, validateSliqExportWith } from "@/lib/sliq-validate";

const enc = new TextEncoder();
const base = { source_sha256: "a".repeat(64), source_files: [] };
const ok = (args: Record<string, unknown>) => ({ data: { ok: true, entity: args.p_entity, batch_no: args.p_batch_no, created: 1, rows: 1 }, error: null });
const payload = (n: number): SliqPayload => ({
  ...base,
  customers: [{ source_row_id: "C:A", name: "A Ltd", external_ref: "A" }],
  invoices: Array.from({ length: n }, (_, i) => ({ source_row_id: `I:INV-${i + 1}`, invoice_ref: `INV-${i + 1}`, customer: "A Ltd", total: "1.00" })),
});

describe("batch run (M59): stops at the first batch the database answers not ok", () => {
  it("one not-ok answer: no later batch is sent, and the run says which batch failed", async () => {
    const calls: Record<string, unknown>[] = [];
    const rpc: Rpc = async (_fn, args) => {
      calls.push(args);
      return calls.length === 2 ? { data: { ok: false, errors: [{ source_row_id: "I:INV-1", message: "no" }] }, error: null } : ok(args);
    };
    const p = payload(60);
    const total = planSliqBatches(p, 20).batches.length;
    expect(total).toBeGreaterThan(3);
    const out = await sliqRunBatches(rpc, p, "live", undefined, 0, 20);
    expect(out.failedAt).toBe(1);
    expect(calls).toHaveLength(2);
    expect(out.results).toHaveLength(2);
    expect(out.last?.ok).toBe(false);
  });
});

describe("INV gap override (M114, M115): false unless the admin ticks it", () => {
  it("the preflight sends p_allow_inv_gap false by default and true only when asked", async () => {
    const seen: unknown[] = [];
    const rpc: Rpc = async (_fn, args) => { seen.push(args.p_allow_inv_gap); return { data: { ok: true }, error: null }; };
    await sliqPreflight(rpc, payload(1));
    await sliqPreflight(rpc, payload(1), {});
    await sliqPreflight(rpc, payload(1), { allowInvGap: false });
    await sliqPreflight(rpc, payload(1), { allowInvGap: true });
    expect(seen).toEqual([false, false, false, true]);
  });
  it("every batch sends p_allow_inv_gap false by default and true only when asked", async () => {
    const seen: unknown[] = [];
    const rpc: Rpc = async (_fn, args) => { seen.push(args.p_allow_inv_gap); return ok(args); };
    await sliqRunBatches(rpc, payload(30), "live", undefined, 0, 20);
    const n = seen.length;
    expect(n).toBeGreaterThan(1);
    expect(seen.every((v) => v === false)).toBe(true);
    await sliqRunBatches(rpc, payload(30), "live", undefined, 0, 20, { allowInvGap: true });
    expect(seen.slice(n)).toHaveLength(n);
    expect(seen.slice(n).every((v) => v === true)).toBe(true);
  });
});

describe("batch plan (M111): suppliers are sent", () => {
  it("every supplier is in exactly one suppliers batch, after the customers and before the invoices", () => {
    const suppliers = Array.from({ length: 5 }, (_, i) => ({ source_row_id: `S:${i}`, name: `S ${i}`, external_ref: `${i}` }));
    const { batches } = planSliqBatches({ ...payload(2), suppliers }, 2);
    const sent = batches.flatMap((b) => b.rows.suppliers ?? []).map((s) => s.source_row_id);
    expect(sent).toEqual(suppliers.map((s) => s.source_row_id));
    const order = batches.map((b) => b.entity);
    expect(order.indexOf("suppliers")).toBeGreaterThan(order.lastIndexOf("customers"));
    expect(order.lastIndexOf("suppliers")).toBeLessThan(order.indexOf("invoices"));
  });
});

const source: SourceTotals = {
  files: [{ name: "inv.csv", sha256: "c".repeat(64) }],
  counts: { customers: 1, invoices: 1, payments: 0, credit_notes: 0 },
  invoiceTotalPence: 10000, paymentsTotalPence: 0, creditsTotalPence: 0, outstandingPence: 10000,
  customerBalancesPence: { "acct:C1": 10000 },
};
const row = (metric: string, key: string, value: string | number | null): DbRow => ({ metric, key, value });
const dbRows = (balance: number): DbRow[] => [
  row("count", "customers", 1), row("count", "invoices", 1), row("count", "payments", 0), row("count", "credit_notes", 0),
  row("total_pence", "invoiced", 10000), row("total_pence", "paid", 0), row("total_pence", "credits", 0), row("total_pence", "outstanding", 10000),
  row("total_pence", "refunds", 0), row("total_pence", "customer_credit", 0), row("total_pence", "net_live", 10000), row("excluded_invoices", "count", 0),
  row("customer_outstanding_pence", "acct:C1", balance),
  row("invoice_ref", "min_number", null), row("invoice_ref", "max_number", null), row("invoice_ref", "not_INV_format", 1),
  row("dup_customer_name", "groups", 0), row("dup_customer_email", "groups", 0), row("dup_invoice_ref", "groups", 0), row("dup_payment", "groups", 0),
  row("orphan_payments", "count", 0), row("overpaid_invoices", "count", 0),
];
const srcNoInv: SourceTotals = { ...source, invoiceRefsNotInvFormat: 1 };

describe("reconciliation (M101): a customer balance with the wrong sign fails", () => {
  it("source +100.00 and database -100.00 for the same account is a FAIL row and the report fails", () => {
    expect(reconcile(srcNoInv, dbRows(10000), { countersBefore: {} }).pass).toBe(true);
    const r = reconcile(srcNoInv, dbRows(-10000), { countersBefore: {} });
    expect(r.pass).toBe(false);
    const bad = r.rows.filter((x) => x.status === "FAIL").map((x) => `${x.check}|${x.source}|${x.database}`);
    expect(bad.some((b) => /^customer balance: .*c1\|10000\|-10000$/i.test(b))).toBe(true);
  });
});

describe("signing sheet (M102): a failed report can never print PASS", () => {
  it("prints FAIL - do not sign for a failing report, and PASS only for a passing one", () => {
    const failing = reconcile(srcNoInv, dbRows(-10000), { countersBefore: {} });
    const sheet = renderSigningSheet(srcNoInv, failing, { company: "Synthetic (t-x)", importedOn: "2026-11-08" });
    expect(sheet).toContain("Overall result: FAIL - do not sign");
    expect(sheet).not.toContain("PASS - all differences are zero");
    const passing = reconcile(srcNoInv, dbRows(10000), { countersBefore: {} });
    expect(renderSigningSheet(srcNoInv, passing, { company: "Synthetic (t-x)", importedOn: "2026-11-08" })).toContain("Overall result: PASS - all differences are zero");
  });
});

describe("source totals (M44-M48): the app's outstanding rule and the INV-number rule", () => {
  // A hand-made report that agrees with the payload (sourceTotalsFromValidated checks counts and money against it). Overpaid INV-1
  // can't pass the validator; it is here to pin the arithmetic (defence in depth: the database applies the same 034 rule).
  const invoices = [
    { source_row_id: "I:INV-1", invoice_ref: "INV-1", customer: "C One", customer_key: "C1", total: "1.00" },
    { source_row_id: "I:INV-2", invoice_ref: "INV-2", customer: "C One", customer_key: "C1", total: "2.00" },
    { source_row_id: "I:INV-1000000000", invoice_ref: "INV-1000000000", customer: "C Two", customer_key: "C2", total: "0.10" },
    { source_row_id: "I:inv-5", invoice_ref: "inv-5", customer: "C Two", customer_key: "C2", total: "0.05" },
  ];
  const h = (c: string) => c.repeat(64);
  const p: SliqPayload = {
    ...base,
    source_files: [{ entity: "customers", name: "c.csv", sha256: h("1") }, { entity: "invoices", name: "i.csv", sha256: h("2") }, { entity: "payments", name: "p.csv", sha256: h("3") }, { entity: "creditNotes", name: "n.csv", sha256: h("4") }],
    customers: [{ source_row_id: "C:C1", name: "C One" }, { source_row_id: "C:C2", name: "C Two" }], invoices,
    payments: [{ source_row_id: "P:1", invoice_ref: "INV-1", amount: "1.50" }], credit_notes: [{ source_row_id: "N:CRD-1", invoice_ref: "INV-2", total: "0.30" }],
  };
  const report = { ok: true, totals: { entities: {
    customers: { rows: 2, file: "c.csv", sha256: h("1") }, invoices: { rows: 4, file: "i.csv", sha256: h("2"), moneyPence: { gross: 315 } },
    payments: { rows: 1, file: "p.csv", sha256: h("3"), moneyPence: { amount: 150 } }, creditNotes: { rows: 1, file: "n.csv", sha256: h("4"), moneyPence: { gross: 30 } },
  } } } as unknown as ValidationReport;
  it("outstanding floors each invoice at 0, the excess is customer credit, credit notes reduce what is owed", () => {
    const s = sourceTotalsFromValidated(report, p);
    // INV-1: 100 - 150 = -50 (credit 50, owed 0); INV-2: 200 - 30 = 170; 10; 5.
    expect(s.outstandingPence).toBe(185);
    expect(s.customerCreditPence).toBe(50);
    expect(s.customerBalancesPence).toEqual({ "acct:C1": 120, "acct:C2": 15 });
    expect(s.invoiceTotalPence).toBe(315);
    expect(s.creditsTotalPence).toBe(30);
  });
  it("only INV-<1..9 digits> in upper case is an INV number (INV-1000000000 and inv-5 are not)", () => {
    const s = sourceTotalsFromValidated(report, p);
    expect(s.invoiceRefMin).toBe(1);
    expect(s.invoiceRefMax).toBe(2);
    expect(s.invoiceRefsNotInvFormat).toBe(2);
  });
});

describe("payload build (M49, M50)", () => {
  const mapping = {
    version: 1, confirmed: true, dateFormat: "DD/MM/YYYY",
    entities: {
      customers: { file: "c.csv", columns: { key: "K", name: "N" } }, suppliers: { file: "s.csv", columns: { key: "K", name: "N" } },
      invoices: { file: "i.csv", columns: { ref: "R", customerKey: "K", date: "D", gross: "G" } }, payments: { file: "p.csv", columns: { invoiceRef: "R", date: "D", amount: "A" } },
    },
  } as SliqMapping;
  const f = (name: string, text: string) => ({ name, bytes: enc.encode(text) });
  const files = (invCust: string, pays: string) => ({
    customers: f("c.csv", "K,N\nACC1,Acme Ltd\n"), suppliers: f("s.csv", "K,N\n"), invoices: f("i.csv", `R,K,D,G\nINV-1,${invCust},15/03/2026,10.00\n`), payments: f("p.csv", `R,D,A\n${pays}`),
  });
  it("two identical unkeyed payment rows get ordinals 1 and 2 (two source ids, never one)", async () => {
    const { payload } = await buildSliqPayload(files("ACC1", "INV-1,16/03/2026,1.00\nINV-1,16/03/2026,1.00\n"), mapping);
    expect(payload.payments!.map((x) => x.source_row_id)).toEqual(["P:INV-1|2026-03-16|1.00|1", "P:INV-1|2026-03-16|1.00|2"]);
  });
  it("the invoice's customer is found by account code whatever its case", async () => {
    const { payload } = await buildSliqPayload(files("acc1", ""), mapping);
    expect(payload.invoices![0]).toMatchObject({ customer: "Acme Ltd", customer_key: "acc1" });
  });
});

describe("preflight byte limit (M53-M55): measured in UTF-8 bytes, inclusive at 4 MiB", () => {
  it("characters are not bytes: 'é' is two bytes each", () => {
    const k = Math.ceil(SLIQ_PREFLIGHT_MAX_BYTES / 2) + 10;
    const p = { ...base, customers: [{ source_row_id: "C:1", notes: "é".repeat(k) }] };
    expect(JSON.stringify({ customers: p.customers }).length).toBeLessThan(SLIQ_PREFLIGHT_MAX_BYTES);
    expect(preflightTooLarge(p)).toMatch(/too large for one preflight/);
  });
  it("exactly the limit passes and one byte more is refused (also with two-byte characters)", () => {
    const sized = (k: number, tail: string) => ({ ...base, customers: [{ source_row_id: "C:1", notes: "x".repeat(k) + tail }] });
    const k0 = SLIQ_PREFLIGHT_MAX_BYTES - jsonbTextBytes({ customers: [{ source_row_id: "C:1", notes: "é" }] });
    expect(jsonbTextBytes({ customers: sized(k0, "é").customers })).toBe(SLIQ_PREFLIGHT_MAX_BYTES);
    expect(preflightTooLarge(sized(k0, "é"))).toBeNull();
    expect(preflightTooLarge(sized(k0 + 1, "é"))).toMatch(/too large/);
    expect(preflightTooLarge(sized(k0 - 1, "é"))).toBeNull();
  });
});

describe("UTF-8 BOM with a quoted header (M29)", () => {
  it("is read as the header (the BOM is not part of the first column name)", () => {
    const mapping = {
      version: 1, confirmed: true, dateFormat: "DD/MM/YYYY",
      entities: {
        customers: { file: "c.csv", columns: { key: "Code", name: "Name" } }, suppliers: { file: "s.csv", columns: { key: "Code", name: "Name" } },
        invoices: { file: "i.csv", columns: { ref: "Inv", customerKey: "Cust", date: "Date", gross: "Gross" } }, payments: { file: "p.csv", columns: { invoiceRef: "Inv", date: "Date", amount: "Amount" } },
      },
    };
    const bom = (text: string) => new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(text)]);
    const files = {
      customers: { name: "c.csv", bytes: bom('"Code","Name"\r\n"C1","Acme"\r\n') }, suppliers: { name: "s.csv", bytes: bom('"Code","Name"\r\n') },
      invoices: { name: "i.csv", bytes: bom('"Inv","Cust","Date","Gross"\r\n"S1","C1","15/03/2026","1.00"\r\n') }, payments: { name: "p.csv", bytes: bom('"Inv","Date","Amount"\r\n') },
    };
    const r = validateSliqExportWith({ files, mapping }, (b) => createHash("sha256").update(b).digest("hex"));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.totals.entities.customers?.bom).toBe(true);
  });
});
