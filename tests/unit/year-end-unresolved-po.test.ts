/**
 * Audit A2 follow-up, whole export: a purchase order whose stored net doesn't match its lines is left out of the
 * reconciled figures and gets no PDF in the zip, while a valid PO exports £100 net + £20 VAT = £120 gross with its PDF.
 * Supabase is replaced by synthetic rows; nothing is read from or written to a database.
 */
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { JNR_PROFILE } from "@/lib/company";

const TABLES: Record<string, Record<string, unknown>[]> = {
  invoices: [],
  quotes: [],
  delivery_notes: [], invoice_payments: [],
  purchase_orders: [
    { id: "1", po_ref: "PO-0001", supplier: "Good Supplies Ltd", status: "sent", order_date: "2026-03-01", total_value: 100, vat_enabled: true,
      items: [{ description: "Steel plate", qty: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }] },
    { id: "2", po_ref: "PO-0042", supplier: "Odd Supplies Ltd", status: "sent", order_date: "2026-03-02", total_value: 90, vat_enabled: true,
      items: [{ description: "Steel plate", qty: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }] },
  ],
};

vi.mock("@/lib/supabase", () => ({
  supabase: { from: (table: string) => ({ select: () => ({ order: () => ({ range: async () => ({ data: TABLES[table] ?? [], error: null }) }) }) }) },
}));
vi.mock("@/lib/fetch-all", () => ({
  fetchAll: async (page: (from: number, to: number) => Promise<{ data: unknown[] }>) => ({ rows: (await page(0, 999)).data }),
}));
vi.mock("@/lib/audit", () => ({ auditEvent: vi.fn(async () => undefined) }));

const { buildYearEndZip } = await import("@/lib/year-end-export");
const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined, vatRegistered: true, defaultVatRate: 20 };

describe("year-end export with one valid and one mismatched purchase order", () => {
  it("valid PO: £100 / £20 / £120 with its PDF; mismatched PO: no amounts, no PDF, reported as unresolved", async () => {
    const { zip, summary, problems, unresolved } = await buildYearEndZip("2026-01-01", "2026-12-31", company);
    const files = unzipSync(zip);

    const good = summary.find((r) => r.number === "PO-0001")!;
    expect(good).toMatchObject({ net: 100, vat: 20, gross: 120, pdf: "purchase-orders/PO-0001.pdf" });
    expect(files["purchase-orders/PO-0001.pdf"]?.length).toBeGreaterThan(0);

    const bad = summary.find((r) => r.number === "PO-0042")!;
    expect(bad).toMatchObject({ net: null, vat: null, gross: null, pdf: "" });
    expect(Object.keys(files).some((name) => name.includes("PO-0042"))).toBe(false);
    // Only the valid PO contributes to any figure in the summary.
    const reconciledGross = summary.reduce((sum, r) => sum + (r.gross ?? 0), 0);
    expect(reconciledGross).toBe(120);

    expect(unresolved).toBe(1);
    expect(problems).toEqual([expect.stringMatching(/^Purchase order PO-0042: UNRESOLVED.*Stored net £90\.00, calculated net from its lines £100\.00, discrepancy £10\.00/)]);
    expect(strFromU8(files["problems.txt"])).toMatch(/PO-0042: UNRESOLVED/);
    expect(strFromU8(files["README.txt"])).toMatch(/^WARNING: THIS EXPORT CONTAINS 1 UNRESOLVED RECORD\./);
    const csv = strFromU8(files["summary.csv"]);
    expect(csv).toMatch(/Purchase order,PO-0001,[^\r\n]*,100\.00,20\.00,120\.00,/);
    expect(csv).toMatch(/Purchase order,PO-0042,[^\r\n]*Odd Supplies Ltd,,,,,,,UNRESOLVED/);
  });

  it("an export without mismatches has no warning and no unresolved count (valid exports unchanged)", async () => {
    const saved = TABLES.purchase_orders;
    TABLES.purchase_orders = [saved[0]];
    try {
      const { zip, unresolved, problems } = await buildYearEndZip("2026-01-01", "2026-12-31", company);
      const files = unzipSync(zip);
      expect(unresolved).toBe(0);
      expect(problems).toEqual([]);
      expect(files["problems.txt"]).toBeUndefined();
      expect(strFromU8(files["README.txt"])).not.toMatch(/UNRESOLVED|WARNING/);
    } finally {
      TABLES.purchase_orders = saved;
    }
  });
});
