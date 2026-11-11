import { describe, expect, it } from "vitest";

import type { GapEvidence } from "@/lib/iso/gap-checklist";
import { buildGapChecklist } from "@/lib/iso/gap-checklist";
import { openConfirmedCount, overdueNcrs, REVIEW_DAYS_DEFAULT, reviewDays } from "@/lib/iso/ncr-review-reminder";
import type { NcrRow } from "@/lib/jobs/ncr-register";

const row = (key: string, over: Partial<NcrRow> = {}): NcrRow => ({
  key, jobNo: "J-1", customer: "C", type: "Rework", record: key, raisedAt: "2026-11-01T09:00:00Z", raisedDate: "2026-11-01", reason: "r", action: "",
  quantityAffected: 1, affectsAll: false, scrapped: null, remade: null, statusText: "Open", open: true, notLinked: false, recordClass: "Confirmed NCR",
  concessionKeys: [], closedAt: null, closedDate: "", closedHow: "", daysOpen: null, replacements: 0, hours: null, materialCost: null, ...over,
});

describe("NCR review reminder", () => {
  it("the default is 7 calendar days", () => {
    expect(REVIEW_DAYS_DEFAULT).toBe(7);
    expect(reviewDays("")).toBe(7);
    expect(reviewDays("abc")).toBe(7);
    expect(reviewDays("0")).toBe(7);
    expect(reviewDays("2.5")).toBe(7);
    expect(reviewDays("14")).toBe(14);
  });
  it("lists confirmed open NCRs open longer than 7 days, by London date, oldest first", () => {
    const now = "2026-11-11T12:00:00Z";
    const rows = [
      row("exactly7", { raisedDate: "2026-11-04" }),
      row("8days", { raisedDate: "2026-11-03" }),
      row("20days", { raisedDate: "2026-10-22" }),
      row("closed", { raisedDate: "2026-10-01", open: false }),
      row("legacy", { raisedDate: "2026-10-01", recordClass: "Not linked", notLinked: true }),
    ];
    expect(overdueNcrs(rows, now).map((o) => o.row.key)).toEqual(["20days", "8days"]);
    expect(overdueNcrs(rows, now, 30)).toEqual([]);
    expect(overdueNcrs(rows, now, 3).map((o) => o.row.key)).toEqual(["20days", "8days", "exactly7"]);
  });
  it("uses the London date: just after midnight UTC in summer is already the next day", () => {
    // 2026-07-08T23:30Z is 00:30 on 9 July in London, so a record raised 1 July is 8 days open.
    expect(overdueNcrs([row("a", { raisedDate: "2026-07-01" })], "2026-07-08T23:30:00Z").length).toBe(1);
    expect(overdueNcrs([row("a", { raisedDate: "2026-07-01" })], "2026-07-08T22:30:00Z").length).toBe(0);
  });
  it("counts open confirmed NCRs", () => {
    expect(openConfirmedCount([row("a"), row("b", { open: false }), row("c", { recordClass: "Not linked", notLinked: true, open: false })])).toBe(1);
  });
  it("never changes a clause status: the checklist is identical with and without overdue NCRs", () => {
    const evidence: GapEvidence = {
      inspectors: { current: 1, withReason: 1 }, changeHistoryPresent: true,
      drawingRevision: { flagged: 1, finished: 1, finishedMissing: 0, truncated: false },
      suppliers: { total: 2, approved: 2, conditional: 0, blocked: 0, truncated: false },
      traceability: { flagged: 1, finished: 1, finishedMissing: 0, truncated: false },
    };
    const before = buildGapChecklist(evidence);
    const overdue = overdueNcrs([row("old", { raisedDate: "2026-01-01" }), row("older", { raisedDate: "2025-01-01" })], "2026-11-11T12:00:00Z");
    expect(overdue.length).toBe(2);
    const after = buildGapChecklist(evidence);
    expect(after).toEqual(before);
    expect(buildGapChecklist.length).toBe(1); // its only input is the company's evidence: no reminder can reach it
  });
});
