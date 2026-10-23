import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

import { JOB_TABLE_COLUMNS } from "@/lib/job-board-files";

const page = readFileSync(path.resolve(__dirname, "../../app/(dashboard)/jobs/page.tsx"), "utf8");

describe("Job Board table columns", () => {
  it("has one work column (Description) and no Specification column", () => {
    const labels = JOB_TABLE_COLUMNS.map((column) => column.label);
    expect(labels.filter((label) => label === "Description")).toHaveLength(1);
    expect(labels.map((label) => label.toLowerCase())).not.toContain("specification");
  });

  it("the table renders its headings from that list and no raw specification cell", () => {
    expect(page).toContain("JOB_TABLE_COLUMNS.map");
    expect(page).not.toMatch(/<TableHead[^>]*>Specification<\/TableHead>/);
    expect(page).not.toContain("title={job.specification}");
  });

  it("group rows span every column (columns + select + actions)", () => {
    expect(page).toContain("colSpan={JOB_TABLE_COLUMNS.length + 2}");
  });
});
