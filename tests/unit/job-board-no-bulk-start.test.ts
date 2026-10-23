import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { bulkDisabledReason, planBulk } from "@/lib/job-actions";

const page = readFileSync(path.resolve(__dirname, "../../app/(dashboard)/jobs/page.tsx"), "utf8");

describe("the Job Board has no bulk Start", () => {
  it("renders no Start Selected button; Finish Selected stays", () => {
    expect(page).not.toContain("Start Selected");
    expect(page).not.toContain('setBulkKind("start")');
    expect(page).toContain("Finish Selected (");
  });

  it("keeps the per-job Start timer for jobs started (not timed)", () => {
    expect(readFileSync(path.resolve(__dirname, "../../lib/job-actions.ts"), "utf8")).toContain('label: "Start timer"');
  });

  it("the shared bulk planner is unchanged and still exported", () => {
    expect(typeof planBulk).toBe("function");
    expect(typeof bulkDisabledReason).toBe("function");
  });
});
