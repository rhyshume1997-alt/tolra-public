/**
 * Unknown payments are never turned into receipts (migration 032). The real year-end export function runs over synthetic
 * invoices: one marked paid with no amount recorded, one still to be confirmed, one part paid, one paid in full. Its summary,
 * payments.csv, problems.txt and the data handed to the invoice PDF must show only what is known: no invented receipt and
 * no invented balance. The PDF itself is the shared InvoicePDF; its element is captured before rendering.
 */
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { JNR_PROFILE } from "@/lib/company";

const snap = { name: "Synthetic Customer Ltd", address: "1 Test Street", found: true };
const inv = (id: string, ref: string, status: string, paid: number, over: Record<string, unknown> = {}) => ({
  id, invoice_ref: ref, customer: "Synthetic Customer Ltd", status, subtotal: 100, vat: 20, total: 120, amount_paid: paid, paid_at: null,
  invoice_date: "2026-03-01", created_at: "2026-03-01", vat_enabled: true, carriage: 0, carriage_vat: false, issuer_snapshot: null, customer_snapshot: snap, payment_unverified: false, ...over,
});
const TABLES: Record<string, Record<string, unknown>[]> = {
  invoices: [
    inv("i1", "INV-0001", "paid", 0, { paid_at: "2026-03-10T12:00:00Z" }),
    inv("i2", "INV-0002", "sent", 0, { payment_unverified: true }),
    inv("i3", "INV-0003", "partial", 50),
    inv("i4", "INV-0004", "paid", 120, { paid_at: "2026-03-12T12:00:00Z" }),
  ],
  quotes: [], purchase_orders: [], delivery_notes: [],
  invoice_payments: [
    { id: "p3", invoice_id: "i3", amount: 50, paid_on: "2026-03-05", method: "BACS", reference: "R3", source: "recorded", created_at: "2026-03-05T10:00:00Z" },
    { id: "p4", invoice_id: "i4", amount: 120, paid_on: "2026-03-12", method: "cheque", reference: "C4", source: "recorded", created_at: "2026-03-12T10:00:00Z" },
  ],
};
const pdfData: Record<string, Record<string, unknown>> = {};

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
// Capture what the invoice PDF is given, and skip the rendering itself.
vi.mock("@react-pdf/renderer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@react-pdf/renderer")>()),
  pdf: (element: { props: { data?: { number?: string } } }) => {
    if (element.props.data?.number) pdfData[element.props.data.number] = element.props.data as Record<string, unknown>;
    return { toBlob: async () => new Blob(["%PDF"]) };
  },
}));

const { buildYearEndZip } = await import("@/lib/year-end-export");
const { invoicePdfPayments } = await import("@/lib/invoice-pdf-data");
const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined, vatRegistered: true, defaultVatRate: 20 };

describe("year-end export with payments of unknown amount", () => {
  it("summary, payments.csv, problems.txt and the PDF data show only what is known", async () => {
    const { zip, summary, problems } = await buildYearEndZip("2026-01-01", "2026-12-31", company);
    const files = unzipSync(zip);
    const row = (ref: string) => summary.find((r) => r.number === ref)!;

    // Marked paid, no amount ever recorded: blank, not £120.
    expect(row("INV-0001")).toMatchObject({ paid: null, balance: null });
    expect(pdfData["INV-0001"]).toMatchObject({ paymentUnknown: true, paid: false });
    expect(pdfData["INV-0001"].payments).toBeUndefined();
    // Payment to confirm: blank, not £0 paid and £120 owed.
    expect(row("INV-0002")).toMatchObject({ paid: null, balance: null });
    expect(pdfData["INV-0002"]).toMatchObject({ paymentUnknown: true, paid: false });
    expect(pdfData["INV-0002"].payments).toBeUndefined();
    // Known amounts.
    expect(row("INV-0003")).toMatchObject({ paid: 50, balance: 70 });
    expect(pdfData["INV-0003"]).toMatchObject({ payments: 50, paid: false, paymentUnknown: false });
    expect(row("INV-0004")).toMatchObject({ paid: 120, balance: 0 });
    expect(pdfData["INV-0004"]).toMatchObject({ payments: 120, paid: true, paymentUnknown: false });

    expect(problems.filter((p) => /payment unknown/.test(p))).toHaveLength(2);
    expect(strFromU8(files["problems.txt"])).toMatch(/Invoice INV-0001: payment unknown[^\r\n]*no payment amount was ever recorded/);
    expect(strFromU8(files["problems.txt"])).toMatch(/Invoice INV-0002: payment unknown[^\r\n]*still to be confirmed/);
    const csv = strFromU8(files["summary.csv"]);
    expect(csv).toMatch(/Invoice,INV-0001,[^\r\n]*,100\.00,20\.00,120\.00,,,2026-03-10,paid,/);
    const payments = strFromU8(files["payments.csv"]);
    expect(payments).not.toMatch(/INV-0001|INV-0002/);
    expect(payments).toContain("INV-0003,2026-03-05,50.00,BACS,R3,recorded,No");
  });

  it("the shared rule: only a known amount is printed", () => {
    expect(invoicePdfPayments({ status: "paid", amount_paid: 0 })).toEqual({ paid: false, paymentUnknown: true });
    expect(invoicePdfPayments({ status: "sent", amount_paid: 40, payment_unverified: true })).toEqual({ paid: false, paymentUnknown: true });
    expect(invoicePdfPayments({ status: "issued", amount_paid: 0 })).toEqual({ payments: 0, paid: false, paymentUnknown: false });
    expect(invoicePdfPayments({ status: "partial", amount_paid: 50 })).toEqual({ payments: 50, paid: false, paymentUnknown: false });
    expect(invoicePdfPayments({ status: "paid", amount_paid: 120 })).toEqual({ payments: 120, paid: true, paymentUnknown: false });
  });
});
