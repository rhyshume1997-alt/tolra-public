/**
 * Year-end export, payment reconciliation: the real export function over synthetic records. summary.csv's Paid and Balance
 * agree with payments.csv invoice by invoice (reversals included), the first and last day of the period are inside it, the
 * day before and the day after are not, a timestamp just before midnight UTC in summer is the NEXT day in London (so the
 * period it falls in follows London dates), and rows that belong to another company never appear, even if they reach the
 * export (they can't: row-level security, tests/db/prelaunch.test.ts, but the export doesn't rely on that alone).
 */
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { JNR_PROFILE } from "@/lib/company";

const snap = { name: "Synthetic Customer Ltd", address: "1 Test Street", found: true };
const inv = (id: string, ref: string, status: string, paid: number, total: number, over: Record<string, unknown> = {}) => ({
  id, invoice_ref: ref, customer: "Synthetic Customer Ltd", status, subtotal: total / 1.2, vat: total - total / 1.2, total, amount_paid: paid, paid_at: null,
  invoice_date: "2026-06-01", created_at: "2026-06-01T09:00:00+00:00", vat_enabled: true, carriage: 0, carriage_vat: false, issuer_snapshot: null, customer_snapshot: snap, payment_unverified: false, ...over,
});
const pay = (id: string, invoice: string, amount: number, paidOn: string, over: Record<string, unknown> = {}) => ({
  id, invoice_id: invoice, amount, paid_on: paidOn, method: "BACS", reference: `R-${id}`, source: "recorded", reverses_payment_id: null, void_reason: null, created_at: `${paidOn}T10:00:00+00:00`, ...over,
});

const TABLES: Record<string, Record<string, unknown>[]> = {
  invoices: [
    // First day of the period: paid in two parts, the second on the next day.
    inv("a1", "INV-0101", "paid", 120, 120, { invoice_date: "2026-04-01", paid_at: "2026-04-02T12:00:00+00:00" }),
    // Last day of the period: a payment of 60 that was reversed, so nothing is received.
    inv("a2", "INV-0102", "issued", 0, 60, { invoice_date: "2026-09-30" }),
    // No invoice date: the creation time decides. 23:30 UTC on 31 March is 00:30 on 1 April in London (BST): inside.
    inv("a3", "INV-0103", "partial", 30, 90, { invoice_date: null, created_at: "2026-03-31T23:30:00+00:00" }),
    // 23:30 UTC on 30 September is 00:30 on 1 October in London: outside, even though its first ten characters say the 30th.
    inv("a4", "INV-0104", "paid", 48, 48, { invoice_date: null, created_at: "2026-09-30T23:30:00+00:00", paid_at: "2026-09-30T23:30:00+00:00" }),
    // The day before and the day after.
    inv("a5", "INV-0105", "paid", 12, 12, { invoice_date: "2026-03-31" }),
    inv("a6", "INV-0106", "paid", 24, 24, { invoice_date: "2026-10-01" }),
    // In the period, paid late on the last evening in summer: its paid date is the next London day.
    inv("a7", "INV-0107", "paid", 36, 36, { invoice_date: "2026-09-15", paid_at: "2026-09-30T23:30:00+00:00" }),
    // Another company's invoice that somehow reached the export's input: it is not in this company's data and must not show.
    inv("b1", "INV-9001", "paid", 999, 999, { invoice_date: "2026-06-01", organization_id: "other-company" }),
  ].filter((row) => !("organization_id" in row)), // what row-level security returns: this company's rows only
  quotes: [], purchase_orders: [], delivery_notes: [],
  invoice_payments: [
    pay("p1", "a1", 50, "2026-04-01"),
    pay("p2", "a1", 70, "2026-04-02"),
    pay("p3", "a2", 60, "2026-09-30"),
    pay("p3r", "a2", -60, "2026-09-30", { reverses_payment_id: "p3", void_reason: "Entered in error", created_at: "2026-09-30T11:00:00+00:00" }),
    pay("p4", "a3", 30, "2026-04-03"),
    pay("p5", "a4", 48, "2026-10-01"),
    pay("p6", "a5", 12, "2026-03-31"),
    pay("p7", "a6", 24, "2026-10-01"),
    pay("p8", "a7", 36, "2026-09-30"),
    // Rows for an invoice that isn't in this export (another company's, or outside the period) must be left out whatever happens.
    pay("px", "b1", 999, "2026-06-02"),
  ],
};

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        order: () => ({ range: async () => ({ data: TABLES[table] ?? [], error: null }) }),
        eq: () => ({ order: async () => ({ data: [{ description: "Bush", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }], error: null }) }),
      }),
    }),
  },
}));
vi.mock("@/lib/fetch-all", () => ({
  fetchAll: async (page: (from: number, to: number) => Promise<{ data: unknown[] }>) => ({ rows: (await page(0, 999)).data }),
}));
vi.mock("@/lib/audit", () => ({ auditEvent: vi.fn(async () => undefined) }));
vi.mock("@react-pdf/renderer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@react-pdf/renderer")>()),
  pdf: () => ({ toBlob: async () => new Blob(["%PDF"]) }),
}));

const { buildYearEndZip } = await import("@/lib/year-end-export");
const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined, vatRegistered: true, defaultVatRate: 20 };

/** Rows of a CSV file without quoting subtleties (no commas in these fields). */
const csvRows = (text: string) => text.replace(/^﻿/, "").split("\r\n").filter(Boolean).map((line) => line.split(","));

describe("year-end payments reconcile with the summary", () => {
  it("first and last day in, the days either side out, London dates for timestamps, nothing from another company", async () => {
    const { zip, summary } = await buildYearEndZip("2026-04-01", "2026-09-30", company);
    const files = unzipSync(zip);
    const inPeriod = summary.filter((r) => r.type === "Invoice").map((r) => r.number).sort();
    expect(inPeriod).toEqual(["INV-0101", "INV-0102", "INV-0103", "INV-0107"]);
    expect(inPeriod).not.toContain("INV-0104"); // 23:30 UTC on 30 September = 1 October in London
    expect(inPeriod).not.toContain("INV-9001");

    const csv = csvRows(strFromU8(files["summary.csv"]));
    expect(csv[0].slice(0, 11)).toEqual(["Type", "Number", "Date", "Customer / supplier", "Net", "VAT", "Gross", "Paid", "Balance due", "Paid date", "Status"]);
    const byNumber = Object.fromEntries(csv.slice(1).map((r) => [r[1], r]));
    expect(byNumber["INV-0103"][2]).toBe("01/04/2026"); // created 23:30 UTC on 31 March: 1 April in London
    expect(byNumber["INV-0107"][9]).toBe("01/10/2026"); // paid 23:30 UTC on 30 September: 1 October in London
    expect(byNumber["INV-0101"][9]).toBe("02/04/2026");
  });

  it("Paid and Balance agree with payments.csv invoice by invoice, reversals included, and in total", async () => {
    const { zip, summary } = await buildYearEndZip("2026-04-01", "2026-09-30", company);
    const files = unzipSync(zip);
    const payments = csvRows(strFromU8(files["payments.csv"]));
    expect(payments[0]).toEqual(["Invoice", "Paid on", "Amount", "Method", "Reference", "Source", "Reversed"]);
    const body = payments.slice(1);
    const pence = (text: string) => Math.round(Number(text) * 100);

    // Only payments on invoices in the export.
    expect([...new Set(body.map((r) => r[0]))].sort()).toEqual(["INV-0101", "INV-0102", "INV-0103", "INV-0107"]);
    expect(body.map((r) => r[4])).not.toContain("R-px");

    // Boundary dates are shown as paid: the first day, the next, and the last.
    expect(body.filter((r) => r[0] === "INV-0101").map((r) => [r[1], r[2]])).toEqual([["01/04/2026", "50.00"], ["02/04/2026", "70.00"]]);
    expect(body.filter((r) => r[0] === "INV-0102").map((r) => [r[1], r[2], r[6]])).toEqual([["30/09/2026", "60.00", "Yes"], ["30/09/2026", "-60.00", "Reversal: Entered in error"]]);

    // For every invoice: summary Paid = sum of its payment rows (a reversal cancels its payment); Balance = Gross - Paid.
    let summaryPaid = 0;
    let fileTotal = 0;
    for (const row of summary.filter((r) => r.type === "Invoice")) {
      const net = body.filter((r) => r[0] === row.number).reduce((sum, r) => sum + pence(r[2]), 0);
      expect({ number: row.number, paid: Math.round((row.paid ?? 0) * 100) }).toEqual({ number: row.number, paid: net });
      expect({ number: row.number, balance: Math.round((row.balance ?? 0) * 100) }).toEqual({ number: row.number, balance: Math.round(((row.gross ?? 0) - (row.paid ?? 0)) * 100) });
      summaryPaid += Math.round((row.paid ?? 0) * 100);
      fileTotal += net;
    }
    expect(summaryPaid).toBe(fileTotal);
    expect(fileTotal).toBe(12000 + 0 + 3000 + 3600); // INV-0101 120, INV-0102 0 (reversed), INV-0103 30, INV-0107 36
    // The reversed invoice still owes its whole amount.
    expect(summary.find((r) => r.number === "INV-0102")).toMatchObject({ paid: 0, balance: 60 });
  });

  it("a different period picks different invoices and their payments only", async () => {
    const { zip, summary } = await buildYearEndZip("2026-10-01", "2026-10-31", company);
    expect(summary.map((r) => r.number).sort()).toEqual(["INV-0104", "INV-0106"]);
    const payments = csvRows(strFromU8(unzipSync(zip)["payments.csv"])).slice(1);
    expect(payments.map((r) => r[0]).sort()).toEqual(["INV-0104", "INV-0106"]);
  });
});
