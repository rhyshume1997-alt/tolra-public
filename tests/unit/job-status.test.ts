import { describe, expect, it } from "vitest";

import { formatAverageJobTime, jobStatus, requiredDate } from "@/lib/job-status";

describe("job lateness (audit D6, A4)", () => {
  const today = "2026-10-09";
  it("uses the worksheet date, falling back to the board date", () => {
    expect(requiredDate({ date_required: "2026-10-20", due_date: "2026-10-01" })).toBe("2026-10-20");
    expect(requiredDate({ date_required: null, due_date: "2026-10-01" })).toBe("2026-10-01");
    expect(requiredDate({})).toBe("");
  });
  it("yesterday is overdue, today and tomorrow are not", () => {
    expect(jobStatus({ status: "on_track", date_required: "2026-10-08" }, today)).toBe("overdue");
    expect(jobStatus({ status: "on_track", date_required: "2026-10-09" }, today)).toBe("on_track");
    expect(jobStatus({ status: "on_track", date_required: "2026-10-10" }, today)).toBe("on_track");
  });
  it("keeps manual at-risk, clears a stale overdue, ignores finished jobs and empty dates", () => {
    expect(jobStatus({ status: "at_risk", date_required: "2026-10-20" }, today)).toBe("at_risk");
    expect(jobStatus({ status: "overdue", date_required: "2026-10-20" }, today)).toBe("on_track");
    expect(jobStatus({ status: "on_track", date_required: "2026-10-01", finished_at: "2026-10-02T10:00:00Z" }, today)).toBe("on_track");
    expect(jobStatus({ status: "at_risk" }, today)).toBe("at_risk");
  });
});

describe("average job time honours the Hours / Days toggle (issue #3 item 3)", () => {
  it("shows a short average in the chosen unit, never silently in minutes", () => {
    const twelveMinutes = 12 / 60 / 24;
    expect(formatAverageJobTime(twelveMinutes, "hours")).toBe("0.2 h");
    expect(formatAverageJobTime(twelveMinutes, "days")).toBe("<0.1 d");
    expect(formatAverageJobTime(1.5, "days")).toBe("1.5 d");
    expect(formatAverageJobTime(1.5, "hours")).toBe("36.0 h");
    expect(formatAverageJobTime(0, "days")).toBe("0.0 d");
    expect(formatAverageJobTime(null, "days")).toBe("\u2014");
  });
});
