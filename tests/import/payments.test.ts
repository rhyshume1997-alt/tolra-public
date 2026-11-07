/**
 * (3) PAYMENTS. Cash comes only from the payments file (never from a status word). Proven on the database: amounts and allocation to invoices
 * reconcile; part payments keep their exact part and the balance owed; overpayments, duplicates, zero amounts, undated and unallocated
 * payments are NOT imported and are reported; and every penny of source cash is accounted for as written, held to confirm, or unallocated.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reconcileReadOnly, type ReconciliationReport } from "./reconcile";
import { withClient } from "./support/db";
import { buildWorld, type World } from "./support/world";

let w: World;
type Inv = { ref: string; total: string; status: string; amount_paid: string; unverified: boolean; paid_at: string | null };
type Pay = { ref: string; amount: string; paid_on: string; method: string | null; reference: string | null; source: string };
let invs: Inv[];
let pays: Pay[];
let rec: ReconciliationReport;
const p = (s: string | number) => Math.round(Number(s) * 100);
const inv = (ref: string) => invs.find((i) => i.ref === ref)!;
const paysOf = (ref: string) => pays.filter((x) => x.ref === ref);
const srcPays = (ref: string) => w.scenario.payments.filter((x) => x.invoice === ref);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

beforeAll(async () => {
  w = await buildWorld("payments");
  await withClient(w.db.url, async (db) => {
    invs = (await db.query("select invoice_ref as ref, total::text, status, amount_paid::text, coalesce(payment_unverified,false) as unverified, paid_at::text from public.invoices where organization_id = $1", [w.orgId])).rows;
    pays = (await db.query("select i.invoice_ref as ref, p.amount::text, p.paid_on::text, p.method, p.reference, p.source from public.invoice_payments p join public.invoices i on i.id = p.invoice_id where p.organization_id = $1", [w.orgId])).rows;
  });
  rec = await reconcileReadOnly(w.db.url, w.snapshot, { organizationId: w.orgId });
});
afterAll(async () => {
  await w?.db.drop();
});

describe("full and split payments", () => {
  it("INV-0130 (120.00 paid once) is paid with one payment of exactly 120.00, dated and referenced as in the source", () => {
    expect(inv("INV-0130")).toMatchObject({ status: "paid", unverified: false });
    expect(p(inv("INV-0130").amount_paid)).toBe(12000);
    const [row] = paysOf("INV-0130");
    expect([p(row.amount), row.paid_on, row.method, row.source]).toEqual([12000, srcPays("INV-0130")[0].date, "BACS", "legacy"]);
    expect(row.reference).toBe(srcPays("INV-0130")[0].reference);
  });

  it("INV-0132 (300.00) paid in three instalments of 100.00 keeps all three rows and is paid, dated by its latest payment", () => {
    expect(paysOf("INV-0132").map((x) => p(x.amount))).toEqual([10000, 10000, 10000]);
    expect(inv("INV-0132")).toMatchObject({ status: "paid" });
    expect(p(inv("INV-0132").amount_paid)).toBe(30000);
    expect(inv("INV-0132").paid_at!.slice(0, 10)).toBe(srcPays("INV-0132").map((x) => x.date).sort().at(-1));
  });
});

describe("part payments", () => {
  it("INV-0131 (600.00, 200.00 + 150.00 received) is partial: 350.00 paid, both payments kept, 250.00 still owed", () => {
    expect(inv("INV-0131")).toMatchObject({ status: "partial", unverified: false });
    expect(p(inv("INV-0131").amount_paid)).toBe(35000);
    expect(paysOf("INV-0131").map((x) => p(x.amount)).sort((a, b) => a - b)).toEqual([15000, 20000]);
    expect(p(inv("INV-0131").total) - p(inv("INV-0131").amount_paid)).toBe(25000);
  });

  it("the importer's report and the post-write reconciliation both list the part-paid invoices with the balance", () => {
    expect(w.run.report.balances.partial.map((b: { number: string }) => b.number)).toContain("INV-0131");
    const d = rec.discrepancies.find((x) => x.check === "invoice_part_paid" && x.key === "INV-0131")!;
    expect([d.expected, d.actual]).toEqual([60000, 35000]);
    // every part-paid invoice in the database is listed
    const partial = invs.filter((i) => i.status === "partial").map((i) => i.ref).sort();
    expect(rec.discrepancies.filter((x) => x.check === "invoice_part_paid").map((x) => x.key).sort()).toEqual(partial);
    expect(partial.length).toBeGreaterThanOrEqual(2);
  });
});

describe("overpayments, duplicates and other cash that is not imported", () => {
  it("INV-0133 (120.00, 130.00 received): no payment row, amount paid 0, marked Payment to confirm, and reported as 10.00 over", () => {
    expect(paysOf("INV-0133")).toHaveLength(0);
    expect(inv("INV-0133")).toMatchObject({ status: "sent", unverified: true });
    expect(p(inv("INV-0133").amount_paid)).toBe(0);
    expect(w.run.report.balances.exceptions.find((e: { number: string }) => e.number === "INV-0133").reason).toMatch(/exceed/);
    const d = rec.discrepancies.find((x) => x.check === "payment_overpaid_in_source" && x.key === "INV-0133")!;
    expect([d.expected, d.actual]).toEqual([12000, 13000]);
    expect(d.detail).toMatch(/£10\.00 over/);
  });

  it.each([
    ["INV-0135", "the same receipt listed twice is never summed"],
    ["INV-0136", "a zero payment is an error, not cash"],
    ["INV-0137", "a payment with no date is not guessed"],
  ])("%s: %s -> nothing imported, Payment to confirm, reported", (ref) => {
    expect(paysOf(ref)).toHaveLength(0);
    expect(inv(ref)).toMatchObject({ unverified: true });
    expect(p(inv(ref).amount_paid)).toBe(0);
    const item = w.run.report.balances.items.find((b: { number: string }) => b.number === ref);
    expect(item.paymentToConfirm).toBe(true);
    const d = rec.discrepancies.find((x) => x.check === "payment_not_imported" && x.key === ref);
    if (ref !== "INV-0136") expect(d?.explained).toBe("payment to confirm"); // INV-0136's only payment is 0.00: nothing to import, nothing to report
  });

  it("INV-0138 (a draft with a payment) keeps its draft status and gets no payment; INV-0139 (void) stays void", () => {
    expect(inv("INV-0138").status).toBe("draft");
    expect(paysOf("INV-0138")).toHaveLength(0);
    expect(inv("INV-0139").status).toBe("void");
    expect(w.run.report.balances.exceptions.some((e: { number: string }) => e.number === "INV-0138")).toBe(true);
  });

  it("a status word is never cash: INV-0100 says Paid but has no payment records, so it is NOT paid, and nothing was invented", () => {
    expect(paysOf("INV-0100")).toHaveLength(0);
    expect(inv("INV-0100")).toMatchObject({ status: "sent", unverified: true });
    expect(p(inv("INV-0100").amount_paid)).toBe(0);
  });

  it("an unpaid invoice (INV-0134, no payments) is Payment to confirm with nothing paid", () => {
    expect(inv("INV-0134")).toMatchObject({ status: "sent", unverified: true });
    expect(p(inv("INV-0134").amount_paid)).toBe(0);
  });
});

describe("unallocated payments", () => {
  it("a receipt for an invoice that is not in the export (INV-0999, 77.77) is reported by both reports and not written anywhere", () => {
    const missing = w.run.report.missingRelationships.paymentsForUnknownInvoice as { invoiceNumber: string; amount: number }[];
    expect(missing.map((m) => [m.invoiceNumber, m.amount])).toEqual([["INV-0999", 7777]]);
    const d = rec.discrepancies.find((x) => x.check === "payment_unallocated")!;
    expect(d.key).toBe("INV-0999");
    expect(d.detail).toMatch(/£77\.77/);
    expect(paysOf("INV-0999")).toHaveLength(0);
  });
});

describe("allocation and reconciliation of the money", () => {
  it("every payment row belongs to an imported invoice, is legacy-sourced, positive, and no invoice receives more than its total", () => {
    expect(pays.length).toBeGreaterThanOrEqual(40);
    for (const x of pays) {
      expect(x.source).toBe("legacy");
      expect(p(x.amount)).toBeGreaterThan(0);
      expect(w.expectedImported.has(x.ref)).toBe(true);
    }
    for (const i of invs) expect(sum(paysOf(i.ref).map((x) => p(x.amount))), i.ref).toBeLessThanOrEqual(p(i.total));
  });

  it("amount paid on every verified invoice equals the sum of its payment rows; unverified ones are at 0.00 with no rows", () => {
    for (const i of invs) {
      const rows = sum(paysOf(i.ref).map((x) => p(x.amount)));
      if (i.unverified) {
        expect([p(i.amount_paid), rows], i.ref).toEqual([0, 0]);
      } else {
        expect(p(i.amount_paid), i.ref).toBe(rows);
      }
    }
  });

  it("every penny of source cash is accounted for: written + held to confirm + on draft/void invoices + unallocated = the source total", () => {
    const total = sum(w.scenario.payments.map((x) => x.amountP));
    const written = sum(pays.map((x) => p(x.amount)));
    const toConfirm = sum(w.scenario.payments.filter((x) => w.expectedImported.has(x.invoice) && inv(x.invoice)?.unverified).map((x) => x.amountP));
    const unallocated = sum(w.scenario.payments.filter((x) => !w.scenario.invoices.some((i) => i.number === x.invoice)).map((x) => x.amountP));
    const heldInvoices = sum(w.scenario.payments.filter((x) => w.scenario.invoices.some((i) => i.number === x.invoice) && !w.expectedImported.has(x.invoice)).map((x) => x.amountP));
    const onUnissued = sum(w.scenario.payments.filter((x) => ["draft", "void"].includes(inv(x.invoice)?.status ?? "")).map((x) => x.amountP));
    expect(heldInvoices).toBe(0);
    expect(onUnissued).toBe(5000);
    expect(written + toConfirm + unallocated + onUnissued).toBe(total);
  });

  it("the post-write reconciliation finds no payment error: no payment_sum, amount_paid_vs_payments, payments_exceed_invoice, paid_but_not_settled or payment_without_invoice", () => {
    const errors = rec.discrepancies.filter((d) => d.entity === "payment" && d.severity === "error");
    expect(errors).toEqual([]);
    expect(rec.counts.payments.database).toBe(pays.length);
    expect(rec.totalsPence.databasePayments).toBe(rec.totalsPence.databaseAmountPaid);
  });
});
