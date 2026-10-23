/**
 * Year-end export, quotes: a quote whose stored total doesn't equal the total its lines add up to (under the quote's
 * VAT switch and the registration/rate it was issued with) is UNRESOLVED: blank Net/VAT/Gross, no PDF, stored and
 * calculated totals in problems.txt, README warning. Stored amounts are never changed. A quote whose totals agree
 * exports normally with its PDF. Supabase is replaced by synthetic rows; nothing touches a database.
 */
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { JNR_PROFILE } from "@/lib/company";

const billTo = { name: "Synthetic Customer Ltd", addressLines: ["1 Test Street"] };
const QUOTES = [
  // Legacy quote stored before VAT: lines £8,400 at 20% = £8,400 + £1,680, stored total £8,400.
  { id: "q1", quote_ref: "JNR-Q-001", customer: "Synthetic Customer Ltd", status: "sent", sent_at: "2026-03-01", created_at: "2026-03-01", total_value: 8400, vat_enabled: true, issuer_snapshot: null, customer_snapshot: billTo },
  // Valid: £100 at 20% = £120, stored £120, issued while registered.
  { id: "q2", quote_ref: "QUO-0002", customer: "Synthetic Customer Ltd", status: "sent", sent_at: "2026-03-02", created_at: "2026-03-02", total_value: 120, vat_enabled: true, issuer_snapshot: { vatRegistered: true, defaultVatRate: 20 }, customer_snapshot: billTo },
  // Issued while NOT registered (snapshot): £100 with no VAT, stored £100. Valid even though the company is registered today.
  { id: "q3", quote_ref: "QUO-0003", customer: "Synthetic Customer Ltd", status: "sent", sent_at: "2026-03-03", created_at: "2026-03-03", total_value: 100, vat_enabled: true, issuer_snapshot: { vatRegistered: false, defaultVatRate: 20 }, customer_snapshot: billTo },
];
const LINES: Record<string, Record<string, unknown>[]> = {
  q1: [{ description: "Machined housings", quantity: 1, unit_price: 8400, vat_pct: 20, vat_exempt: false }],
  q2: [{ description: "Bracket", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }],
  q3: [{ description: "Bracket", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }],
};
const TABLES: Record<string, Record<string, unknown>[]> = { invoices: [], quotes: QUOTES, delivery_notes: [], purchase_orders: [], invoice_payments: [] };

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        order: () => ({ range: async () => ({ data: TABLES[table] ?? [], error: null }) }),
        eq: (_fk: string, id: string) => ({ order: async () => ({ data: table === "quote_line_items" ? LINES[id] ?? [] : [], error: null }) }),
      }),
    }),
  },
}));
vi.mock("@/lib/fetch-all", () => ({
  fetchAll: async (page: (from: number, to: number) => Promise<{ data: unknown[] }>) => ({ rows: (await page(0, 999)).data }),
}));
vi.mock("@/lib/audit", () => ({ auditEvent: vi.fn(async () => undefined) }));

const { buildYearEndZip, quoteExportTotals } = await import("@/lib/year-end-export");
const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined, vatRegistered: true, defaultVatRate: 20 };

describe("year-end export: quotes whose stored total doesn't match their lines", () => {
  it("£8,400 net + £1,680 VAT against £8,400 stored: UNRESOLVED, blank amounts, no PDF, explained; valid quotes export with PDFs", async () => {
    const { zip, summary, problems, unresolved } = await buildYearEndZip("2026-01-01", "2026-12-31", company);
    const files = unzipSync(zip);

    const legacy = summary.find((r) => r.number === "JNR-Q-001")!;
    expect(legacy).toMatchObject({ type: "Quote", net: null, vat: null, gross: null, pdf: "" });
    expect(legacy.status).toMatch(/^UNRESOLVED/);
    expect(Object.keys(files).some((name) => name.includes("JNR-Q-001"))).toBe(false);
    expect(problems).toContainEqual(expect.stringMatching(
      /^Quote JNR-Q-001: UNRESOLVED, not reconciled\. Stored \(as saved\) total £8400\.00, calculated net £8400\.00 \+ VAT £1680\.00 = calculated gross £10080\.00, difference £1680\.00 \(calculated gross minus stored\)\..*stored total is unchanged/));
    // The stored amount itself is untouched.
    expect(QUOTES[0].total_value).toBe(8400);

    const valid = summary.find((r) => r.number === "QUO-0002")!;
    expect(valid).toMatchObject({ net: 100, vat: 20, gross: 120, pdf: "quotes/QUO-0002.pdf" });
    expect(files["quotes/QUO-0002.pdf"]?.length).toBeGreaterThan(0);

    // Calculated under the issue-time snapshot (not registered then): £100, no VAT, matches its stored £100.
    const issuedUnregistered = summary.find((r) => r.number === "QUO-0003")!;
    expect(issuedUnregistered).toMatchObject({ net: 100, vat: 0, gross: 100, pdf: "quotes/QUO-0003.pdf" });

    expect(unresolved).toBe(1);
    expect(problems).toHaveLength(1);
    expect(strFromU8(files["README.txt"])).toMatch(/^WARNING: THIS EXPORT CONTAINS 1 UNRESOLVED RECORD\./);
    const csv = strFromU8(files["summary.csv"]);
    expect(csv).toMatch(/Quote,JNR-Q-001,[^\r\n]*Synthetic Customer Ltd,,,,,,,UNRESOLVED/);
    expect(csv).toMatch(/Quote,QUO-0002,[^\r\n]*,100\.00,20\.00,120\.00,/);
    expect(summary.reduce((sum, r) => sum + (r.gross ?? 0), 0)).toBe(220);
  });

  it("a quote with no stored total is unresolved too (nothing is guessed)", () => {
    const out = quoteExportTotals({ quote_ref: "Q-X", total_value: null, vat_enabled: true }, [{ description: "x", quantity: 1, unitPrice: 50, vatPct: 20 }], company);
    expect(out.unresolved).toMatchObject({ storedTotal: null, calculatedTotal: 60 });
    expect(out.problem).toMatch(/Stored \(as saved\) total missing, calculated net £50\.00 \+ VAT £10\.00 = calculated gross £60\.00/);
  });
});
