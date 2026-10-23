import { describe, expect, it } from "vitest";
import { myJobs } from "@/lib/my-jobs";

const rows = [
  { id: "1", job_no: "J-1", description: "A", stage: "setup", date_required: "2026-10-20", assigned_to: "u1" },
  { id: "2", job_no: "J-2", description: "B", stage: "machining", date_required: "2026-10-18", assigned_to: "u1", finished_at: "2026-10-17" },
  { id: "3", job_no: "J-3", description: "C", stage: "material", due_date: "2026-10-19", assigned_to: "u1" },
  { id: "4", job_no: "J-4", description: "D", stage: "setup", date_required: "2026-10-17", assigned_to: "u2" },
  { id: "5", job_no: "J-5", description: "E", stage: "setup", assigned_to: "u1" },
];

describe("myJobs", () => {
  it("returns only unfinished jobs assigned to the user, soonest due first", () => {
    expect(myJobs(rows, "u1").map((j) => j.id)).toEqual(["3", "1", "5"]);
  });
  it("returns empty when there is no user", () => {
    expect(myJobs(rows, null)).toEqual([]);
    expect(myJobs(rows, undefined)).toEqual([]);
  });
  it("ignores other users and finished jobs", () => {
    expect(myJobs(rows, "u2")).toEqual([{ id: "4", jobNo: "J-4", description: "D", stage: "setup", due: "2026-10-17" }]);
  });
  it("keeps a due_date-only job when 20+ dated jobs exist, capping display at 20", () => {
    const dated = Array.from({ length: 25 }, (_, i) => ({ id: `d${i}`, date_required: `2026-11-${String(i + 1).padStart(2, "0")}`, assigned_to: "u1" }));
    const out = myJobs([...dated, { id: "only-due", due_date: "2026-10-01", assigned_to: "u1" }], "u1");
    expect(out).toHaveLength(20);
    expect(out[0].id).toBe("only-due");
  });
});
