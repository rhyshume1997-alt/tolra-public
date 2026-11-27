// A voided invoice is not owed: its detail view must not offer "Send to Customer" or "Pause chasing".
// Pins the two guards in app/(dashboard)/invoices/page.tsx to isVoid (lib/invoice-void.ts) and checks isVoid itself.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isVoid } from "@/lib/invoice-void";

const page = readFileSync("app/(dashboard)/invoices/page.tsx", "utf8");

describe("void invoice: no Send to Customer, no Pause chasing", () => {
  it("isVoid is true for void and false for the live statuses", () => {
    expect(isVoid("void")).toBe(true);
    for (const s of ["draft", "sent", "overdue", "paid", "part_paid", "written_off"]) expect(isVoid(s)).toBe(false);
    expect(isVoid(null)).toBe(false);
  });
  it("Pause chasing is only rendered for a non-draft, non-void invoice", () => {
    expect(page).toContain('viewingInvoice.rawStatus !== "draft" && !isVoid(viewingInvoice.rawStatus) ? <ChasePauseControl');
  });
  it("Send to Customer is only rendered when the invoice is not void", () => {
    const at = page.indexOf('"Send to Customer"}</Button>');
    expect(at).toBeGreaterThan(0);
    expect(page.slice(at - 260, at)).toContain("isVoid(viewingInvoice.rawStatus) ? null :");
  });
  it("Void invoices still show their Void note and Download PDF", () => {
    expect(page).toContain('isVoid(viewingInvoice.rawStatus) ? "Void: not owed."');
    expect(page).toContain("Download PDF");
  });
});
