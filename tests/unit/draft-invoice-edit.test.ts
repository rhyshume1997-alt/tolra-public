import { describe, expect, it } from "vitest";

import { balanceText, buildDraftReplace, draftEditable, draftFormFrom, draftTotals, overBalanceProblem, type DraftForm, type LineBalance } from "@/lib/draft-invoice-edit";

const VAT = { vatEnabled: true, carriageVat: true, registered: true, standardRate: 20 };
const form = (patch: Partial<DraftForm> = {}): DraftForm => ({
  invoiceDate: "2026-10-18", dueDate: "2026-11-17", terms: "30 days", customerPo: "PO-1", carriage: "0",
  lines: [{ description: "Part A", qty: "2", unit: "50.00", vat: "20" }, { description: "Part B", qty: "1", unit: "100", vat: "20" }],
  ...patch,
});

describe("draft invoice correction (067)", () => {
  it("only a draft can be edited", () => {
    expect(draftEditable("draft")).toBe(true);
    expect(draftEditable(null)).toBe(true);
    expect(draftEditable("issued")).toBe(false);
    expect(draftEditable("paid")).toBe(false);
  });

  it("fills the form from the stored invoice and lines", () => {
    const filled = draftFormFrom({ date: "2026-10-18", dueDate: "2026-11-17", terms: "30 days", customerPo: "PO-1", carriage: 12.5 }, [
      { description: "Part A", quantity: 2, unitPrice: 50, vatPct: 20 }, { description: "Fixings", quantity: 1, unitPrice: 3, vatPct: 0, vatExempt: true },
    ]);
    expect(filled.carriage).toBe("12.5");
    expect(filled.lines).toEqual([{ description: "Part A", qty: "2", unit: "50.00", vat: "20" }, { description: "Fixings", qty: "1", unit: "3.00", vat: "exempt" }]);
  });

  it("a line removed and one changed: header from the first line, totals as the database checks them", () => {
    const built = buildDraftReplace(form({ lines: [{ description: " Part A ", qty: "3", unit: "45", vat: "20" }], carriage: "10" }), VAT);
    if (!built.ok) throw new Error(built.error);
    expect(built.value.lines).toEqual([{ description: "Part A", quantity: 3, unit_price: 45, vat_pct: 20, vat_exempt: false }]);
    // 135 net + 10 carriage; VAT 27 on the line + 2 on carriage (carriage VAT at the standard rate).
    expect(built.value.header).toMatchObject({ description: "Part A", quantity: 3, unit_price: 45, subtotal: 135, carriage: 10, vat: 29, total: 174, customer_po: "PO-1" });
  });

  it("no VAT when the invoice's own VAT is off or the company isn't registered", () => {
    expect(draftTotals(form(), { ...VAT, vatEnabled: false }).vat).toBe(0);
    expect(draftTotals(form(), { ...VAT, registered: false }).total).toBe(200);
    expect(draftTotals(form({ carriage: "10" }), { ...VAT, carriageVat: false })).toMatchObject({ vat: 40, total: 250 });
  });

  it("refuses what the database would refuse, before sending", () => {
    expect(buildDraftReplace(form({ lines: [] }), VAT)).toMatchObject({ ok: false, error: expect.stringMatching(/at least one line/) });
    expect(buildDraftReplace(form({ lines: [{ description: " ", qty: "1", unit: "1", vat: "20" }] }), VAT)).toMatchObject({ ok: false });
    expect(buildDraftReplace(form({ lines: [{ description: "x", qty: "0", unit: "1", vat: "20" }] }), VAT)).toMatchObject({ ok: false });
    expect(buildDraftReplace(form({ lines: [{ description: "x", qty: "1.2345", unit: "1", vat: "20" }] }), VAT)).toMatchObject({ ok: false });
    expect(buildDraftReplace(form({ lines: [{ description: "x", qty: "1", unit: "1.005", vat: "20" }] }), VAT)).toMatchObject({ ok: false });
    expect(buildDraftReplace(form({ lines: [{ description: "x", qty: "1", unit: "-1", vat: "20" }] }), VAT)).toMatchObject({ ok: false });
    expect(buildDraftReplace(form({ carriage: "-5" }), VAT)).toMatchObject({ ok: false });
    expect(buildDraftReplace(form({ dueDate: "2026-10-01" }), VAT)).toMatchObject({ ok: false, error: expect.stringMatching(/due date/) });
    expect(buildDraftReplace(form({ invoiceDate: "" }), VAT)).toMatchObject({ ok: false });
  });
});

describe("a draft bills no more than was despatched (099)", () => {
  const FLANGE = "11111111-1111-4111-8111-111111111111";
  const balances = new Map<string, LineBalance>([[FLANGE, { ordered: 12, despatched: 8, onOtherInvoices: 5, available: 3 }]]);
  const linked = (qty: string) => form({ lines: [{ description: "Flange 80mm", qty, unit: "150.00", vat: "20", orderLine: FLANGE }, { description: "Carriage pallet", qty: "1", unit: "35", vat: "20" }] });

  it("keeps each stored line's order-line link in the form", () => {
    const filled = draftFormFrom({ carriage: 0 }, [{ description: "Flange 80mm", quantity: 3, unitPrice: 150, vatPct: 20, salesOrderLineId: FLANGE }, { description: "Typed", quantity: 1, unitPrice: 5, vatPct: 20, salesOrderLineId: null }]);
    expect(filled.lines.map((l) => l.orderLine)).toEqual([FLANGE, undefined]);
  });

  it("sends every line's link (null for a typed line) once the database has 099, and none before", () => {
    const built = buildDraftReplace(linked("3"), VAT, { links: true, balances });
    if (!built.ok) throw new Error(built.error);
    expect(built.value.lines.map((l) => l.sales_order_line_id)).toEqual([FLANGE, null]);
    const before = buildDraftReplace(linked("3"), VAT);
    if (!before.ok) throw new Error(before.error);
    expect(before.value.lines.every((l) => !("sales_order_line_id" in l))).toBe(true);
  });

  it("refuses more than the balance, adding up every line that bills the order line, with a clear message", () => {
    expect(buildDraftReplace(linked("3.001"), VAT, { links: true, balances })).toEqual({
      ok: false, error: 'Line 1: only 3 of "Flange 80mm" can be billed on this draft (8 despatched, 5 on other invoices). The rest is billed when it is despatched.',
    });
    const split = form({ lines: [{ description: "Flange 80mm", qty: "2", unit: "150", vat: "20", orderLine: FLANGE }, { description: "Flange 80mm (rest)", qty: "1.5", unit: "150", vat: "20", orderLine: FLANGE }] });
    expect(overBalanceProblem(split.lines, balances)).toMatch(/^Line 2: only 3 of "Flange 80mm \(rest\)"/);
    expect(overBalanceProblem(linked("3").lines, balances)).toBeNull();
    expect(overBalanceProblem(linked("2").lines, balances)).toBeNull();
    // A typed line has no balance; without balances nothing is held here (the database still holds it).
    expect(overBalanceProblem(linked("99").lines, undefined)).toBeNull();
    expect(balanceText(balances.get(FLANGE)!)).toBe("Despatched 8 of 12, 5 on other invoices: up to 3 on this draft.");
  });
});
