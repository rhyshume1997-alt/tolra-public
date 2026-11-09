import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { invoiceLive } from "@/lib/delivery-note-invoice-link";
import { isVoid } from "@/lib/invoice-void";
import { isInvoiced } from "@/lib/overview-metrics";
import { invoiceCounts } from "@/lib/purchase-order-link";
import { isIssuedForXero } from "@/lib/integrations/xero/batch";
import { customerCredit, invoiceLifecycle } from "@/lib/receivables";

const read = (p: string) => readFileSync(p, "utf8");
/** The string literals of the first `[...]`/`new Set([...])` that follows `anchor` in a source file. */
function listAfter(file: string, anchor: string): Set<string> {
  const src = read(file); const at = src.indexOf(anchor); if (at < 0) throw new Error(`${anchor} not found in ${file}`);
  const open = src.indexOf("[", at); const close = src.indexOf("]", open);
  return new Set([...src.slice(open, close).matchAll(/"([a-z_]*)"/g)].map((m) => m[1]));
}
const lit = (file: string, anchor: string) => { const s = listAfter(file, anchor); return (v: string | null) => s.has(String(v ?? "").trim().toLowerCase() || "draft"); };

const SPELLINGS: (string | null)[] = ["draft", "issued", "sent", "partial", "paid", "credited", "void", "voided", "cancelled", "canceled", "written_off", null, "mystery"];
// "Dead" = taken back (void family). Every copy that means "void" must agree on this.
const VOID_FAMILY = new Set(["void", "voided", "cancelled", "canceled"]);
const copies: Record<string, (v: string | null) => boolean> = {
  "receivables lifecycle==closed": (v) => invoiceLifecycle(v) === "closed",
  "receivables customerCredit==0": (v) => customerCredit({ status: v, total: 100, amount_paid: 150 }) === 0,
  "invoice-void isVoid": (v) => isVoid(v),
  "delivery-note-invoice-link !live": (v) => !invoiceLive(v),
  "overview-metrics !invoiced": (v) => !isInvoiced({ status: v }),
  "xero !issued": (v) => !isIssuedForXero(v),
  "purchase-order-link !counts": (v) => !invoiceCounts(v),
  "finance-check VOID": lit("lib/ai/finance-check/load.ts", "const VOID ="),
  "delivery-notes page void": lit("app/(dashboard)/delivery-notes/page.tsx", '["void", "voided"'),
  "credit-notes-panel !canMake": lit("components/credit-notes-panel.tsx", "const canMake ="),
};

describe("sm-c: invoice 'dead' status copies", () => {
  it("prints the disagreement table", () => {
    const rows = SPELLINGS.map((s) => [String(s), ...Object.values(copies).map((f) => (f(s) ? "X" : "."))].join(" | "));
    console.log(["status", ...Object.keys(copies).map((k, i) => `#${i}`)].join(" | ") + "\n" + rows.join("\n") + "\n" + Object.keys(copies).map((k, i) => `#${i}=${k}`).join("\n"));
    expect(rows.length).toBe(SPELLINGS.length);
  });
  it("every copy treats all four void spellings as dead", () => {
    for (const [name, f] of Object.entries(copies)) for (const s of VOID_FAMILY) expect(f(s), `${name} / ${s}`).toBe(true);
  });
  it("no copy treats a live status (issued, sent, partial, paid, unknown) as dead", () => {
    for (const [name, f] of Object.entries(copies)) for (const s of ["issued", "sent", "partial", "paid", "mystery"]) expect(f(s), `${name} / ${s}`).toBe(false);
  });
  it("the pure-void copies agree exactly (draft / null / credited / written_off are not void)", () => {
    const pure = ["invoice-void isVoid", "delivery-note-invoice-link !live", "finance-check VOID", "delivery-notes page void"];
    for (const s of SPELLINGS) { const v = pure.map((n) => copies[n](s)); expect(new Set(v).size, String(s)).toBe(1); }
  });
});
