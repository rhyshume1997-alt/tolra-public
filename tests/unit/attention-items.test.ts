import { describe, expect, it } from "vitest";

import {
  ATTENTION_CUTOFF_DAYS,
  ATTENTION_TOP,
  type AttentionInput,
  type AttentionRuleId,
  buildAttention,
  daysBetween,
  rulesForRole,
} from "@/lib/attention-items";

const TODAY = "2026-10-15"; // British Summer Time (clocks go back on 25 October)
const ago = (days: number) => {
  const d = new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86_400_000);
  return d.toISOString().slice(0, 10);
};
const empty: AttentionInput = { quotes: [], rfqs: [], quotedRfqIds: [], purchaseOrders: [], lateJobs: [], finishedJobs: [], invoices: [], deliveryNotes: [] };
const run = (input: Partial<AttentionInput>, id: AttentionRuleId, role: "admin" | "office" | "workshop" | "viewer" = "admin") =>
  buildAttention({ ...empty, ...input }, role, TODAY).find((s) => s.id === id)!;

describe("daysBetween", () => {
  it("counts whole calendar days across the clock change", () => {
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetween("2026-10-15", "2026-10-15")).toBe(0);
  });
});

describe("quotes expired", () => {
  const q = (over: Record<string, unknown>) => ({ id: "q", quote_ref: "Q-1", customer: "Acme", status: "sent", valid_until: ago(1), ...over });
  it("flags draft and sent quotes whose date has passed, not one valid today", () => {
    const s = run({ quotes: [q({ id: "a" }), q({ id: "b", status: "draft" }), q({ id: "c", valid_until: TODAY })] }, "quotes-expired");
    expect(s.count).toBe(2);
    expect(s.items.map((i) => i.key).sort()).toEqual(["qx-a", "qx-b"]);
  });
  it("never flags accepted, rejected or already-expired stored quotes", () => {
    const s = run({ quotes: [q({ status: "accepted" }), q({ status: "rejected" }), q({ status: "expired" })] }, "quotes-expired");
    expect(s.count).toBe(0);
  });
  it("says how long ago the quote expired, in plain words", () => {
    const s = run({ quotes: [q({ id: "a", valid_until: ago(3) }), q({ id: "b", valid_until: ago(1), status: "draft" })] }, "quotes-expired");
    expect(s.items.find((i) => i.key === "qx-a")!.detail).toBe("Acme (sent, expired 3 days ago)");
    expect(s.items.find((i) => i.key === "qx-b")!.detail).toBe("Acme (draft, expired 1 day ago)");
    expect(s.items.map((i) => i.detail).join(" ")).not.toContain("past its date");
  });
  it("cutoff: exactly 365 days past shows, 366 does not", () => {
    expect(run({ quotes: [q({ valid_until: ago(ATTENTION_CUTOFF_DAYS) })] }, "quotes-expired").count).toBe(1);
    expect(run({ quotes: [q({ valid_until: ago(ATTENTION_CUTOFF_DAYS + 1) })] }, "quotes-expired").count).toBe(0);
  });
  it("lists the oldest first and caps the list but not the count", () => {
    const rows = Array.from({ length: 8 }, (_, i) => q({ id: `x${i}`, valid_until: ago(i + 1) }));
    const s = run({ quotes: rows }, "quotes-expired");
    expect(s.count).toBe(8);
    expect(s.items).toHaveLength(ATTENTION_TOP);
    expect(s.items.map((i) => i.ageDays)).toEqual([8, 7, 6, 5, 4]);
  });
});

describe("quotes sent with no decision", () => {
  const q = (over: Record<string, unknown>) => ({ id: "q", quote_ref: "Q-1", customer: "Acme", status: "sent", valid_until: ago(-30), sent_at: `${ago(20)}T10:00:00Z`, ...over });
  it("needs MORE than 14 days: 14 is not flagged, 15 is", () => {
    expect(run({ quotes: [q({ sent_at: `${ago(14)}T12:00:00Z` })] }, "quotes-no-decision").count).toBe(0);
    expect(run({ quotes: [q({ sent_at: `${ago(15)}T12:00:00Z` })] }, "quotes-no-decision").count).toBe(1);
  });
  it("uses the London date of sent_at: 23:30 UTC in summer is already the next London day", () => {
    // 2026-09-30T23:30Z is 1 October in London: 14 days before today, so not yet flagged (UTC date math would flag it).
    expect(run({ quotes: [q({ sent_at: "2026-09-30T23:30:00Z" })] }, "quotes-no-decision").count).toBe(0);
    expect(run({ quotes: [q({ sent_at: "2026-09-29T23:30:00Z" })] }, "quotes-no-decision").count).toBe(1);
  });
  it("excludes drafts, decided quotes, ones without sent_at, and expired ones (already in the other list)", () => {
    const rows = [q({ status: "draft" }), q({ status: "accepted" }), q({ status: "rejected" }), q({ sent_at: null }), q({ valid_until: ago(1) })];
    expect(run({ quotes: rows }, "quotes-no-decision").count).toBe(0);
  });
  it("cutoff at 365 days", () => {
    expect(run({ quotes: [q({ sent_at: `${ago(365)}T12:00:00Z`, valid_until: null })] }, "quotes-no-decision").count).toBe(1);
    expect(run({ quotes: [q({ sent_at: `${ago(366)}T12:00:00Z`, valid_until: null })] }, "quotes-no-decision").count).toBe(0);
  });
});

describe("RFQs awaiting clarification", () => {
  const r = (over: Record<string, unknown>) => ({ id: "r", customer: "Acme", description: "Bracket", status: "clarification", created_at: `${ago(3)}T09:00:00Z`, ...over });
  it("lists clarification RFQs with their age, oldest first", () => {
    const s = run({ rfqs: [r({ id: "new", created_at: `${ago(2)}T09:00:00Z` }), r({ id: "old", created_at: `${ago(9)}T09:00:00Z` })] }, "rfqs-clarification");
    expect(s.items.map((i) => i.key)).toEqual(["rfq-old", "rfq-new"]);
    expect(s.items[0].ageDays).toBe(9);
    expect(s.items[0].detail).toContain("9 days");
  });
  it("leaves out other statuses and RFQs that already have a quote", () => {
    const s = run({ rfqs: [r({ id: "a", status: "new" }), r({ id: "b" }), r({ id: "c" })], quotedRfqIds: ["b"] }, "rfqs-clarification");
    expect(s.items.map((i) => i.key)).toEqual(["rfq-c"]);
  });
  it("cutoff at 365 days", () => {
    expect(run({ rfqs: [r({ created_at: `${ago(365)}T12:00:00Z` })] }, "rfqs-clarification").count).toBe(1);
    expect(run({ rfqs: [r({ created_at: `${ago(366)}T12:00:00Z` })] }, "rfqs-clarification").count).toBe(0);
  });
  it("fails the section when the quote lookup failed", () => {
    expect(run({ rfqs: [r({})], quotedRfqIds: null }, "rfqs-clarification").failed).toBe(true);
  });
});

describe("purchase orders past expected delivery", () => {
  const p = (over: Record<string, unknown>) => ({ id: "p", po_ref: "PO-1", supplier: "Steel Ltd", status: "sent", expected_delivery: ago(1), received_at: null, ...over });
  it("flags ordered, unreceived orders whose date has passed; today is not late", () => {
    const s = run({ purchaseOrders: [p({ id: "a" }), p({ id: "b", status: "confirmed" }), p({ id: "c", status: "partial_received" }), p({ id: "d", expected_delivery: TODAY })] }, "pos-late");
    expect(s.items.map((i) => i.key).sort()).toEqual(["po-a", "po-b", "po-c"]);
  });
  it("excludes received, cancelled, draft, anything with received_at, and no date", () => {
    const rows = [p({ status: "received" }), p({ status: "cancelled" }), p({ status: "draft" }), p({ received_at: "2026-10-01T10:00:00Z" }), p({ expected_delivery: null })];
    expect(run({ purchaseOrders: rows }, "pos-late").count).toBe(0);
  });
  it("cutoff at 365 days", () => {
    expect(run({ purchaseOrders: [p({ expected_delivery: ago(365) })] }, "pos-late").count).toBe(1);
    expect(run({ purchaseOrders: [p({ expected_delivery: ago(366) })] }, "pos-late").count).toBe(0);
  });
});

describe("jobs past required date", () => {
  const j = (over: Record<string, unknown>) => ({ id: "j", job_no: "J-1", customer: "Acme", date_required: ago(2), due_date: null, finished_at: null, ...over });
  it("flags unfinished jobs before today, internal jobs (no customer) included", () => {
    const s = run({ lateJobs: [j({ id: "a" }), j({ id: "b", customer: null }), j({ id: "c", date_required: TODAY })] }, "jobs-late");
    expect(s.items.map((i) => i.key).sort()).toEqual(["jl-a", "jl-b"]);
    expect(s.items.find((i) => i.key === "jl-b")!.detail).toContain("Internal");
  });
  it("falls back to due_date and excludes finished jobs and jobs with no date", () => {
    const s = run({ lateJobs: [j({ id: "a", date_required: null, due_date: ago(3) }), j({ id: "b", finished_at: "2026-10-01T10:00:00Z" }), j({ id: "c", date_required: null, due_date: null })] }, "jobs-late");
    expect(s.items.map((i) => i.key)).toEqual(["jl-a"]);
  });
  it("cutoff at 365 days", () => {
    expect(run({ lateJobs: [j({ date_required: ago(365) })] }, "jobs-late").count).toBe(1);
    expect(run({ lateJobs: [j({ date_required: ago(366) })] }, "jobs-late").count).toBe(0);
  });
});

describe("overdue invoices", () => {
  const i = (over: Record<string, unknown>) => ({ id: "i", invoice_ref: "INV-1", customer: "Acme", total: 100, status: "sent", amount_paid: 0, due_date: ago(1), payment_unverified: false, ...over });
  it("counts every overdue invoice (not just 3), oldest first", () => {
    const rows = Array.from({ length: 7 }, (_, n) => i({ id: `n${n}`, due_date: ago(n + 1) }));
    const s = run({ invoices: rows }, "invoices-overdue");
    expect(s.count).toBe(7);
    expect(s.items[0].key).toBe("io-n6");
  });
  it("due today is not overdue; paid, draft, void, cancelled, credited and payment-to-confirm are excluded", () => {
    const rows = [i({ due_date: TODAY }), i({ status: "paid" }), i({ status: "draft" }), i({ status: "void" }), i({ status: "cancelled" }), i({ status: "credited" }), i({ payment_unverified: true }), i({ due_date: null })];
    expect(run({ invoices: rows }, "invoices-overdue").count).toBe(0);
  });
  it("a part-paid invoice is overdue, a fully settled balance is not", () => {
    expect(run({ invoices: [i({ status: "partial", amount_paid: 40 })] }, "invoices-overdue").count).toBe(1);
    expect(run({ invoices: [i({ status: "sent", amount_paid: 100 })] }, "invoices-overdue").count).toBe(0);
  });
  it("cutoff at 365 days", () => {
    expect(run({ invoices: [i({ due_date: ago(365) })] }, "invoices-overdue").count).toBe(1);
    expect(run({ invoices: [i({ due_date: ago(366) })] }, "invoices-overdue").count).toBe(0);
  });
});

describe("draft invoices not issued", () => {
  it("the dashboard says which drafts it counts: over 2 days old, newer ones are on Invoicing", () => {
    expect(run({}, "invoices-draft").title).toBe("Draft invoices over 2 days old (newer drafts are on Invoicing)");
  });
  it("quotes: the rule says it counts draft or sent quotes past their date", () => {
    expect(run({}, "quotes-expired").title).toBe("Draft or sent quotes past their valid-until date");
  });
  const d = (over: Record<string, unknown>) => ({ id: "d", invoice_ref: "INV-D", customer: "Acme", status: "draft", created_at: `${ago(5)}T10:00:00Z`, ...over });
  it("needs MORE than 2 days: 2 is not flagged, 3 is", () => {
    expect(run({ invoices: [d({ created_at: `${ago(2)}T12:00:00Z` })] }, "invoices-draft").count).toBe(0);
    expect(run({ invoices: [d({ created_at: `${ago(3)}T12:00:00Z` })] }, "invoices-draft").count).toBe(1);
  });
  it("treats a missing status as a draft, and excludes issued invoices", () => {
    const s = run({ invoices: [d({ id: "a", status: null }), d({ id: "b", status: "sent" }), d({ id: "c", status: "paid" })] }, "invoices-draft");
    expect(s.items.map((x) => x.key)).toEqual(["id-a"]);
  });
  it("uses the London date of created_at", () => {
    // 2026-10-12T23:30Z is 13 October in London: 2 days before today, so not flagged.
    expect(run({ invoices: [d({ created_at: "2026-10-12T23:30:00Z" })] }, "invoices-draft").count).toBe(0);
    expect(run({ invoices: [d({ created_at: "2026-10-11T23:30:00Z" })] }, "invoices-draft").count).toBe(1);
  });
  it("cutoff at 365 days", () => {
    expect(run({ invoices: [d({ created_at: `${ago(365)}T12:00:00Z` })] }, "invoices-draft").count).toBe(1);
    expect(run({ invoices: [d({ created_at: `${ago(366)}T12:00:00Z` })] }, "invoices-draft").count).toBe(0);
  });
});

describe("delivery notes awaiting", () => {
  const n = (over: Record<string, unknown>) => ({ id: "n", dn_number: "DLN-1", customer: "Acme", status: "awaiting", invoice_id: null, updated_at: `${ago(3)}T10:00:00Z`, created_at: `${ago(4)}T10:00:00Z`, ...over });
  it("needs MORE than 1 day: 1 is not flagged, 2 is", () => {
    expect(run({ deliveryNotes: [n({ updated_at: `${ago(1)}T12:00:00Z` })] }, "delivery-awaiting").count).toBe(0);
    expect(run({ deliveryNotes: [n({ updated_at: `${ago(2)}T12:00:00Z` })] }, "delivery-awaiting").count).toBe(1);
  });
  it("only the awaiting status; falls back to created_at without updated_at", () => {
    const rows = [n({ id: "a", status: "pending" }), n({ id: "b", status: "signed" }), n({ id: "c", updated_at: null })];
    expect(run({ deliveryNotes: rows }, "delivery-awaiting").items.map((i) => i.key)).toEqual(["da-c"]);
  });
  it("cutoff at 365 days", () => {
    expect(run({ deliveryNotes: [n({ updated_at: `${ago(365)}T12:00:00Z` })] }, "delivery-awaiting").count).toBe(1);
    expect(run({ deliveryNotes: [n({ updated_at: `${ago(366)}T12:00:00Z` })] }, "delivery-awaiting").count).toBe(0);
  });
});

describe("jobs awaiting inspection", () => {
  const j = (over: Record<string, unknown>) => ({ id: "j", job_no: "J-1", customer: "Acme", finished_at: `${ago(2)}T10:00:00Z`, inspected_at: null, stage: "inspection", ...over });
  it("flags finished, uninspected jobs (internal included), oldest first", () => {
    const s = run({ finishedJobs: [j({ id: "a" }), j({ id: "b", customer: null, finished_at: `${ago(6)}T10:00:00Z` })] }, "jobs-inspection");
    expect(s.items.map((i) => i.key)).toEqual(["ji-b", "ji-a"]);
  });
  it("excludes inspected jobs, jobs sent back to rework, and unfinished jobs", () => {
    const rows = [j({ inspected_at: "2026-10-14T10:00:00Z" }), j({ stage: "rework" }), j({ finished_at: null })];
    expect(run({ finishedJobs: rows }, "jobs-inspection").count).toBe(0);
  });
  it("cutoff at 365 days", () => {
    expect(run({ finishedJobs: [j({ finished_at: `${ago(365)}T12:00:00Z` })] }, "jobs-inspection").count).toBe(1);
    expect(run({ finishedJobs: [j({ finished_at: `${ago(366)}T12:00:00Z` })] }, "jobs-inspection").count).toBe(0);
  });
});

describe("delivery notes sent out with no invoice", () => {
  const n = (over: Record<string, unknown>) => ({ id: "n", dn_number: "DLN-1", customer: "Acme", status: "despatched", invoice_id: null, delivery_date: ago(4), created_at: `${ago(5)}T10:00:00Z`, ...over });
  it("flags despatched, delivered and signed notes with no invoice_id", () => {
    const s = run({ deliveryNotes: [n({ id: "a" }), n({ id: "b", status: "delivered" }), n({ id: "c", status: "signed" })] }, "delivery-uninvoiced");
    expect(s.count).toBe(3);
  });
  it("excludes invoiced, pending and awaiting notes", () => {
    const rows = [n({ invoice_id: "inv-1" }), n({ status: "pending" }), n({ status: "awaiting" })];
    expect(run({ deliveryNotes: rows }, "delivery-uninvoiced").count).toBe(0);
  });
  it("cutoff at 365 days", () => {
    expect(run({ deliveryNotes: [n({ delivery_date: ago(365) })] }, "delivery-uninvoiced").count).toBe(1);
    expect(run({ deliveryNotes: [n({ delivery_date: ago(366) })] }, "delivery-uninvoiced").count).toBe(0);
  });
});

describe("roles and failures", () => {
  const ids = (role: "admin" | "office" | "workshop" | "viewer") => rulesForRole(role).map((r) => r.id);
  it("admin sees every rule", () => {
    expect(ids("admin")).toHaveLength(10);
  });
  it("office sees no money rules", () => {
    expect(ids("office")).not.toContain("invoices-overdue");
    expect(ids("office")).not.toContain("invoices-draft");
    expect(ids("office")).not.toContain("delivery-uninvoiced");
    expect(ids("office")).toContain("quotes-expired");
  });
  it("workshop and viewer see only jobs, inspection and delivery notes awaiting", () => {
    for (const role of ["workshop", "viewer"] as const) {
      expect(ids(role).sort()).toEqual(["delivery-awaiting", "jobs-inspection", "jobs-late"]);
      const sections = buildAttention(empty, role, TODAY);
      expect(sections.map((s) => s.id).sort()).toEqual(["delivery-awaiting", "jobs-inspection", "jobs-late"]);
    }
  });
  it("money rows handed to a workshop user are still not shown", () => {
    const input = { ...empty, invoices: [{ id: "i", invoice_ref: "X", status: "sent", total: 10, due_date: ago(3) }], deliveryNotes: [{ id: "n", status: "signed", invoice_id: null, delivery_date: ago(3) }] };
    expect(buildAttention(input, "workshop", TODAY).find((s) => s.id === "invoices-overdue")).toBeUndefined();
    expect(buildAttention(input, "workshop", TODAY).find((s) => s.id === "delivery-uninvoiced")).toBeUndefined();
  });
  it("a failed read fails only its own sections", () => {
    const sections = buildAttention({ ...empty, purchaseOrders: null }, "admin", TODAY);
    expect(sections.filter((s) => s.failed).map((s) => s.id)).toEqual(["pos-late"]);
    expect(sections.find((s) => s.id === "jobs-late")!.failed).toBe(false);
  });
});
