import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InvoiceRefCell } from "@/components/invoice-ref-cell";
import { draftKey } from "@/lib/invoice-ref";

const draft = { reference: draftKey("148c8daa-aaaa-bbbb-cccc-000000000000"), unnumbered: true };
const html = (invoice: { reference: string; unnumbered?: boolean }, from?: string | null) => renderToStaticMarkup(createElement(InvoiceRefCell, { invoice, autoDraftedFrom: from }));

describe("Invoice column cell", () => {
  it("shows a draft as 'Draft, no number yet', never the DRAFT- key", () => {
    const out = html(draft);
    expect(out).toContain(">Draft, no number yet</span>");
    expect(out).not.toMatch(/DRAFT-/i);
  });

  it("puts 'Auto-drafted from DLN-0001' on its own secondary line, not on the number", () => {
    const out = html(draft, "DLN-0001");
    expect(out).toContain('<span data-testid="invoice-ref">Draft, no number yet</span>');
    expect(out).toMatch(/<span data-testid="auto-drafted" class="block [^"]*">Auto-drafted from DLN-0001<\/span>/);
    expect(out).not.toContain("yetAuto");
    expect(out).not.toMatch(/DRAFT-148C8DAA/i);
  });

  it("shows an issued invoice's number, with no note unless it was auto-drafted", () => {
    expect(html({ reference: "INV-0001" })).toBe('<span data-testid="invoice-ref">INV-0001</span>');
    expect(html({ reference: "INV-0001" }, null)).not.toContain("Auto-drafted");
  });

  it("the Invoices list uses this one cell (table, list and card views share it)", () => {
    const page = readFileSync(path.resolve(__dirname, "../../app/(dashboard)/invoices/page.tsx"), "utf8");
    expect(page).toContain("<InvoiceRefCell invoice={invoice}");
    expect(page).not.toMatch(/data-testid="auto-drafted"/);
  });
});
