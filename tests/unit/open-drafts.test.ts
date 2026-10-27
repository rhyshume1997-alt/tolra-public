import { describe, expect, it } from "vitest";

import { buildAttention } from "@/lib/attention-items";
import { withoutArchivedDrafts } from "@/lib/attention-load";
import { draftInvoiceCounts } from "@/lib/list-filter";
import { isOpenDraft } from "@/lib/open-drafts";

describe("isOpenDraft: the one rule for open drafts", () => {
  it("counts an active, unissued draft (a missing status is a draft)", () => {
    expect(isOpenDraft("draft", false)).toBe(true);
    expect(isOpenDraft(" Draft ", false)).toBe(true);
    expect(isOpenDraft(null, false)).toBe(true);
  });
  it("does not count issued, sent, paid, void or cancelled invoices", () => {
    for (const status of ["issued", "sent", "paid", "partial", "void", "voided", "cancelled", "canceled"]) expect(isOpenDraft(status, false)).toBe(false);
  });
  it("does not count an archived draft", () => {
    expect(isOpenDraft("draft", true)).toBe(false);
  });
});

describe("every open-drafts count agrees", () => {
  const TODAY = "2026-10-20";
  const old = "2026-10-01T09:00:00Z";
  const rows = [
    { id: "1", status: "draft" }, { id: "2", status: null }, { id: "3", status: "issued" },
    { id: "4", status: "void" }, { id: "5", status: "draft" }, // 5 is archived
  ].map((row) => ({ ...row, invoice_ref: `R${row.id}`, customer: "C", created_at: old }));
  const archived = new Set(["5"]);

  it("Invoicing's line and the dashboard item count the same drafts", () => {
    const list = rows.map((row) => ({ id: row.id, status: "x", rawStatus: String(row.status ?? "draft").toLowerCase(), createdAt: row.created_at }));
    const counts = draftInvoiceCounts(list, TODAY, (invoice) => archived.has(invoice.id));
    const dash = buildAttention({ quotes: [], rfqs: [], purchaseOrders: [], lateJobs: [], finishedJobs: [], invoices: withoutArchivedDrafts(rows, archived), deliveryNotes: [], quotedRfqIds: [] }, "admin", TODAY);
    const item = dash.find((section) => section.id === "invoices-draft");
    expect(counts).toEqual({ total: 2, old: 2 });
    expect(item?.items).toHaveLength(counts.old);
  });
});
