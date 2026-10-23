import { describe, expect, it } from "vitest";

import { ATTENTION_RULES } from "@/lib/attention-items";
import { canOpenDestination } from "@/lib/destinations";
import {
  deliveryNoteMatchesFilter,
  draftInvoiceCounts,
  invoiceMatchesFilter,
  jobMatchesFilter,
  type ListFilterPage,
  parseListFilter,
  purchaseOrderMatchesFilter,
  QUOTE_FILTER_LABELS,
  quoteLegend,
  quoteMatchesFilter,
} from "@/lib/list-filter";

const TODAY = "2026-10-15";

describe("parseListFilter", () => {
  it("reads a known filter for its own page, from a string or URLSearchParams", () => {
    expect(parseListFilter("quotes", "?filter=expired")).toBe("expired");
    expect(parseListFilter("invoices", new URLSearchParams("filter=draft-old&x=1"))).toBe("draft-old");
    expect(parseListFilter("delivery-notes", "filter=not-invoiced")).toBe("not-invoiced");
  });
  it("is harmless when missing, empty, unknown, or meant for another page", () => {
    expect(parseListFilter("quotes", "")).toBeNull();
    expect(parseListFilter("quotes", null)).toBeNull();
    expect(parseListFilter("quotes", undefined)).toBeNull();
    expect(parseListFilter("quotes", "?filter=")).toBeNull();
    expect(parseListFilter("quotes", "?filter=bogus")).toBeNull();
    expect(parseListFilter("quotes", "?filter=overdue")).toBeNull();
    expect(parseListFilter("quotes", "?filter=__proto__")).toBeNull();
    expect(parseListFilter("nope" as ListFilterPage, "?filter=expired")).toBeNull();
  });
  it("every Needs attention rule's View all link names a filter its page accepts", () => {
    for (const rule of ATTENTION_RULES) {
      const [path, query] = rule.href.split("?");
      expect(parseListFilter(path.slice(1) as ListFilterPage, query ?? ""), rule.id).not.toBeNull();
    }
  });
  it("the dashboard can offer those links: access depends on the page, not the query", () => {
    expect(canOpenDestination("/quotes?filter=expired", { activeRole: "office", hiddenSections: [] })).toBe(true);
    expect(canOpenDestination("/quotes?filter=expired", { activeRole: "office", hiddenSections: ["quotes"] })).toBe(false);
    expect(canOpenDestination("/invoices?filter=overdue", { activeRole: "workshop", hiddenSections: [] })).toBe(false);
  });
});

describe("row tests match the attention rules", () => {
  it("quotes: expired is draft/sent past valid-until; no-decision is sent, in date, over 14 days", () => {
    expect(quoteMatchesFilter("expired", { rawStatus: "sent", validUntil: "2026-10-14" }, TODAY)).toBe(true);
    expect(quoteMatchesFilter("expired", { rawStatus: "sent", validUntil: TODAY }, TODAY)).toBe(false);
    expect(quoteMatchesFilter("expired", { rawStatus: "accepted", validUntil: "2026-10-01" }, TODAY)).toBe(false);
    expect(quoteMatchesFilter("no-decision", { rawStatus: "sent", validUntil: "2026-12-01", sentAt: "2026-09-30T10:00:00Z" }, TODAY)).toBe(true);
    expect(quoteMatchesFilter("no-decision", { rawStatus: "sent", validUntil: "2026-12-01", sentAt: "2026-10-01T10:00:00Z" }, TODAY)).toBe(false);
    expect(quoteMatchesFilter("no-decision", { rawStatus: "sent", validUntil: "2026-10-01", sentAt: "2026-09-01T10:00:00Z" }, TODAY)).toBe(false);
  });
  it("invoices: overdue is the displayed status; draft-old is a draft over 2 days old", () => {
    expect(invoiceMatchesFilter("overdue", { status: "overdue", rawStatus: "sent" }, TODAY)).toBe(true);
    expect(invoiceMatchesFilter("overdue", { status: "outstanding", rawStatus: "sent" }, TODAY)).toBe(false);
    expect(invoiceMatchesFilter("draft-old", { status: "closed", rawStatus: "draft", createdAt: "2026-10-12T09:00:00Z" }, TODAY)).toBe(true);
    expect(invoiceMatchesFilter("draft-old", { status: "closed", rawStatus: "draft", createdAt: "2026-10-13T09:00:00Z" }, TODAY)).toBe(false);
    expect(invoiceMatchesFilter("draft-old", { status: "overdue", rawStatus: "sent", createdAt: "2026-01-01T09:00:00Z" }, TODAY)).toBe(false);
  });
  it("purchase orders: late is ordered, not received, expected before today", () => {
    expect(purchaseOrderMatchesFilter("late", { status: "sent", delivery: "2026-10-14" }, TODAY)).toBe(true);
    expect(purchaseOrderMatchesFilter("late", { status: "sent", delivery: TODAY }, TODAY)).toBe(false);
    expect(purchaseOrderMatchesFilter("late", { status: "draft", delivery: "2026-10-01" }, TODAY)).toBe(false);
    expect(purchaseOrderMatchesFilter("late", { status: "sent", delivery: "2026-10-01", receivedAt: "2026-10-02T10:00:00Z" }, TODAY)).toBe(false);
    expect(purchaseOrderMatchesFilter("late", { status: "sent", delivery: "" }, TODAY)).toBe(false);
  });
  it("jobs: overdue is unfinished past its required date; awaiting-inspection is finished, not inspected, not in rework", () => {
    expect(jobMatchesFilter("overdue", { date_required: "2026-10-14" }, TODAY)).toBe(true);
    expect(jobMatchesFilter("overdue", { due_date: "2026-10-14" }, TODAY)).toBe(true);
    expect(jobMatchesFilter("overdue", { date_required: TODAY }, TODAY)).toBe(false);
    expect(jobMatchesFilter("overdue", { date_required: "2026-10-01", finished_at: "2026-10-10T10:00:00Z" }, TODAY)).toBe(false);
    expect(jobMatchesFilter("awaiting-inspection", { finished_at: "2026-10-10T10:00:00Z" }, TODAY)).toBe(true);
    expect(jobMatchesFilter("awaiting-inspection", { finished_at: "2026-10-10T10:00:00Z", inspected_at: "2026-10-11T10:00:00Z" }, TODAY)).toBe(false);
    expect(jobMatchesFilter("awaiting-inspection", { finished_at: "2026-10-10T10:00:00Z", stage: "rework" }, TODAY)).toBe(false);
    expect(jobMatchesFilter("awaiting-inspection", {}, TODAY)).toBe(false);
  });
  it("delivery notes: awaiting-old is awaiting over a day; not-invoiced is sent out with no invoice", () => {
    expect(deliveryNoteMatchesFilter("awaiting-old", { status: "awaiting", updatedAt: "2026-10-13T10:00:00Z" }, TODAY)).toBe(true);
    expect(deliveryNoteMatchesFilter("awaiting-old", { status: "awaiting", updatedAt: "2026-10-14T10:00:00Z" }, TODAY)).toBe(false);
    expect(deliveryNoteMatchesFilter("awaiting-old", { status: "awaiting", createdAt: "2026-10-10T10:00:00Z" }, TODAY)).toBe(true);
    expect(deliveryNoteMatchesFilter("awaiting-old", { status: "signed", createdAt: "2026-10-01T10:00:00Z" }, TODAY)).toBe(false);
    expect(deliveryNoteMatchesFilter("not-invoiced", { status: "despatched" }, TODAY)).toBe(true);
    expect(deliveryNoteMatchesFilter("not-invoiced", { status: "signed", invoiceId: "abc" }, TODAY)).toBe(false);
    expect(deliveryNoteMatchesFilter("not-invoiced", { status: "awaiting" }, TODAY)).toBe(false);
  });
  it("an unknown filter keeps every row", () => {
    expect(quoteMatchesFilter("x", { rawStatus: "draft" }, TODAY)).toBe(true);
    expect(jobMatchesFilter("x", {}, TODAY)).toBe(true);
  });
});

describe("Quotes status legend follows the dashboard link's filter", () => {
  type Q = { status: "draft" | "sent" | "accepted" | "rejected" | "expired" | "superseded"; rawStatus: string; validUntil?: string; sentAt?: string };
  // The dashboard's 4 expired quotes: stored draft or sent, past valid-until. Shown status is "expired", which is final (Done, not Open).
  const quotes: Q[] = [
    { status: "expired", rawStatus: "sent", validUntil: "2026-10-01" },
    { status: "expired", rawStatus: "sent", validUntil: "2026-10-02" },
    { status: "expired", rawStatus: "draft", validUntil: "2026-10-03" },
    { status: "expired", rawStatus: "draft", validUntil: "2026-10-04" },
    { status: "accepted", rawStatus: "accepted", validUntil: "2026-10-01" },
  ];
  const inOpen = (q: Q) => !["accepted", "rejected", "expired", "superseded"].includes(q.status);

  it("the Open tab (no filter) shows Expired (0), named as the Open tab", () => {
    const legend = quoteLegend(quotes, null, TODAY, inOpen, "Open");
    expect(legend.counts.expired).toBe(0);
    expect(legend.scope).toBe("In Open");
  });

  it("with ?filter=expired the legend counts what the link lists: Expired (4), the dashboard's number, and says what it is", () => {
    const legend = quoteLegend(quotes, "expired", TODAY, inOpen, "Open");
    expect(legend.counts).toMatchObject({ expired: 4, draft: 0, sent: 0, accepted: 0 });
    expect(legend.scope).toBe(QUOTE_FILTER_LABELS.expired);
    expect(legend.scope).toBe("Draft or sent quotes past their valid-until date");
  });

  it("the legend count equals the rows the filter lists", () => {
    const listed = quotes.filter((q) => quoteMatchesFilter("expired", q, TODAY));
    expect(listed).toHaveLength(4);
    expect(quoteLegend(quotes, "expired", TODAY, inOpen, "Open").counts.expired).toBe(listed.length);
  });
});

describe("Invoicing's drafts line against the dashboard's count", () => {
  const draft = (createdAt: string, rawStatus = "draft") => ({ status: "closed", rawStatus, createdAt });
  it("counts every draft, and how many are over 2 days old (the dashboard's number)", () => {
    const invoices = [draft("2026-10-01T09:00:00Z"), draft("2026-10-15T09:00:00Z"), draft("2026-10-01T09:00:00Z", "issued")];
    expect(draftInvoiceCounts(invoices, TODAY)).toEqual({ total: 2, old: 1 });
  });
  it("no drafts is 0 of 0", () => {
    expect(draftInvoiceCounts([], TODAY)).toEqual({ total: 0, old: 0 });
  });
});
