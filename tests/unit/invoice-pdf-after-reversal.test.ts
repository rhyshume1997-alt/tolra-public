/**
 * What the real year-end builder hands to the invoice PDF for Paid and Balance due after a part payment, after paying in full,
 * and after a payment is reversed (captured as year-end-unknown-payments.test.ts does). The printed text for the same inputs
 * is checked in invoice-pdf-print-after-reversal.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

import type { InvoicePdfData } from "@/components/pdf/InvoicePDF";
import { JNR_PROFILE } from "@/lib/company";

const snap = { name: "Synthetic Customer Ltd", address: "1 Test Street", found: true };
const inv = (id: string, ref: string, status: string, paid: number, over: Record<string, unknown> = {}) => ({
  id, invoice_ref: ref, customer: "Synthetic Customer Ltd", status, subtotal: 100, vat: 20, total: 120, amount_paid: paid, paid_at: null,
  invoice_date: "2026-05-01", created_at: "2026-05-01T09:00:00+00:00", vat_enabled: true, carriage: 0, carriage_vat: false, issuer_snapshot: null, customer_snapshot: snap, payment_unverified: false, ...over,
});
const pay = (id: string, invoice: string, amount: number, paidOn: string, over: Record<string, unknown> = {}) => ({
  id, invoice_id: invoice, amount, paid_on: paidOn, method: "BACS", reference: "", source: "recorded", reverses_payment_id: null, void_reason: null, created_at: `${paidOn}T10:00:00+00:00`, ...over,
});

const TABLES: Record<string, Record<string, unknown>[]> = {
  invoices: [
    inv("i1", "INV-0201", "partial", 50), // 50 paid so far
    inv("i2", "INV-0202", "paid", 120, { paid_at: "2026-05-12T12:00:00+00:00" }), // paid in two parts
    inv("i3", "INV-0203", "partial", 50), // paid in full, then the last 70 reversed
    inv("i4", "INV-0204", "issued", 0), // paid 120 and the whole payment reversed
  ],
  quotes: [], purchase_orders: [], delivery_notes: [],
  invoice_payments: [
    pay("a1", "i1", 50, "2026-05-02"),
    pay("b1", "i2", 50, "2026-05-02"), pay("b2", "i2", 70, "2026-05-12"),
    pay("c1", "i3", 50, "2026-05-02"), pay("c2", "i3", 70, "2026-05-12"),
    pay("c2r", "i3", -70, "2026-05-13", { reverses_payment_id: "c2", void_reason: "Wrong invoice" }),
    pay("d1", "i4", 120, "2026-05-02"),
    pay("d1r", "i4", -120, "2026-05-03", { reverses_payment_id: "d1", void_reason: "Bounced" }),
  ],
};
const pdfData: Record<string, InvoicePdfData> = {};

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
  pdf: (element: { props: { data?: InvoicePdfData } }) => {
    if (element.props.data?.number) pdfData[element.props.data.number] = element.props.data;
    return { toBlob: async () => new Blob(["%PDF"]) };
  },
}));

const { buildYearEndZip } = await import("@/lib/year-end-export");
const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined, vatRegistered: true, defaultVatRate: 20 };

describe("invoice PDF Paid and Balance due", () => {
  it("the data given to the PDF follows the recorded payments, reversals included", async () => {
    await buildYearEndZip("2026-01-01", "2026-12-31", company);
    expect(pdfData["INV-0201"]).toMatchObject({ payments: 50, paid: false, paymentUnknown: false });
    expect(pdfData["INV-0202"]).toMatchObject({ payments: 120, paid: true, paymentUnknown: false });
    // Paid in full and then partly reversed: 50 received, no PAID stamp.
    expect(pdfData["INV-0203"]).toMatchObject({ payments: 50, paid: false, paymentUnknown: false });
    // Everything reversed: nothing received, nothing stamped.
    expect(pdfData["INV-0204"]).toMatchObject({ payments: 0, paid: false, paymentUnknown: false });
  });
});
