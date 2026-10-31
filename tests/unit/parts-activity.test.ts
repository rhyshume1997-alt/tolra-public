import { describe, expect, it } from "vitest";

import { describeEntry, recordTypeLabel, type ActivityEntry } from "@/lib/activity";

const entry = (metadata: Record<string, unknown>): ActivityEntry => ({
  id: "1", created_at: "2026-10-30T10:00:00Z", actor_name: "Lee Operator", action: "LOG_JOB_PARTS", entity_table: "jobs", entity_id: "j1", changes: null, snapshot: null, metadata,
});

describe("the job's activity for parts logged (migration 118)", () => {
  it("an addition says how many, the count now and the note", () => {
    expect(describeEntry(entry({ quantity: 5, total_after: 12, quantity_required: 50, note: "Tray 4" }), {})).toEqual({
      title: "Parts logged",
      details: ["Added: 5", "Count now: 12 of 50", "Note: Tray 4"],
    });
  });
  it("a negative entry is titled as a correction and says why", () => {
    expect(describeEntry(entry({ quantity: -2, total_after: 10, quantity_required: 50, note: "Counted the wrong tray" }), {})).toEqual({
      title: "Parts taken off (correction)",
      details: ["Taken off: 2", "Count now: 10 of 50", "Note: Counted the wrong tray"],
    });
  });
  it("copes with an entry that carries less", () => {
    expect(describeEntry(entry({}), {})).toEqual({ title: "Parts logged", details: [] });
  });
  it("the table has a plain name, not the raw one", () => {
    expect(recordTypeLabel("job_part_logs")).toBe("Parts entry");
  });
});
