/**
 * invoices.status is nullable (000_base_schema) and the server treats a missing status as a draft
 * (coalesce(status, 'draft') in issue_invoice, the issue lock and the reference check, migration 027). The app must
 * read it the same way everywhere: not owed, shown and printed with today's company settings, labelled a draft on
 * the invoices page, and left out of the year-end export. Synthetic data only; Supabase is mocked for the export.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { JNR_PROFILE } from "@/lib/company";
import { invoiceDisplayTotals, invoiceIssuer } from "@/lib/invoice-totals";
import { invoiceLifecycle, invoiceStatus, owed } from "@/lib/receivables";

const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined, vatRegistered: true, defaultVatRate: 17.5 };
const oldSnapshot = { documentName: "Example Engineering Ltd", vatRegistered: true, defaultVatRate: 20 };

const TABLES: Record<string, Record<string, unknown>[]> = {
  quotes: [], purchase_orders: [], delivery_notes: [], invoice_payments: [],
  invoices: [
    { id: "n1", invoice_ref: "INV-0900", status: null, customer: "Null Status Ltd", invoice_date: "2026-03-01", subtotal: 100, vat: 20, total: 120, issuer_snapshot: oldSnapshot },
    { id: "n2", invoice_ref: "INV-0901", status: "", customer: "Empty Status Ltd", invoice_date: "2026-03-01", subtotal: 100, vat: 20, total: 120 },
  ],
};
vi.mock("@/lib/supabase", () => ({
  supabase: { from: (table: string) => ({ select: () => ({ order: () => ({ range: async () => ({ data: TABLES[table] ?? [], error: null }) }) }) }) },
}));
vi.mock("@/lib/fetch-all", () => ({
  fetchAll: async (page: (from: number, to: number) => Promise<{ data: unknown[] }>) => ({ rows: (await page(0, 999)).data }),
}));
vi.mock("@/lib/audit", () => ({ auditEvent: vi.fn(async () => undefined) }));

describe("a missing invoice status means draft, as on the server", () => {
  it("receivables: null or empty status is a draft, so never owed", () => {
    expect(invoiceStatus(null)).toBe("draft");
    expect(invoiceStatus(undefined)).toBe("draft");
    expect(invoiceStatus("  ")).toBe("draft");
    expect(invoiceStatus("Sent")).toBe("sent");
    expect(invoiceLifecycle(null)).toBe("closed");
    expect(owed({ status: null, total: 120, amount_paid: 0 })).toBe(0);
    expect(owed({ status: "sent", total: 120, amount_paid: 0 })).toBe(120); // unchanged for real statuses
  });

  it("invoice details/PDF company: a null-status invoice uses today's settings, not its saved snapshot", () => {
    const invoice = { carriage: 20, vatEnabled: true, carriageVat: true, issuerSnapshot: oldSnapshot, rawStatus: null };
    expect(invoiceIssuer(invoice, company).defaultVatRate).toBe(17.5);
    expect(invoiceDisplayTotals(invoice, [{ description: "Part", quantity: 1, unitPrice: 100, vatPct: 20 }], company).totals).toMatchObject({ vat: 23.5, total: 143.5 });
    expect(invoiceIssuer({ ...invoice, rawStatus: "issued" }, company).defaultVatRate).toBe(20);
  });

  it("invoices page: loaded rows map a missing status to draft (not 'sent')", () => {
    const source = readFileSync(path.resolve(__dirname, "../../app/(dashboard)/invoices/page.tsx"), "utf8");
    expect(source).toMatch(/rawStatus: invoiceStatus\(invoice\.status as string \| null\),/);
    expect(source).not.toMatch(/invoice\.status \|\| "sent"/);
  });

  it("year-end export: invoices with a missing status are drafts and are left out", async () => {
    const { buildYearEndZip } = await import("@/lib/year-end-export");
    const { zip, summary } = await buildYearEndZip("2026-01-01", "2026-12-31", company);
    expect(summary.filter((r) => r.type === "Invoice")).toEqual([]);
    const files = unzipSync(zip);
    expect(Object.keys(files).some((name) => name.startsWith("invoices/"))).toBe(false);
    expect(strFromU8(files["README.txt"])).toMatch(/0 invoices/);
  });
});
