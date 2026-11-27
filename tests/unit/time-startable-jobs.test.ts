/**
 * Regression tests for CR-025 (Module 2 — Time recording):
 * Older unfinished jobs past the old 300-row cap and PostgREST's 1,000-row page cap must remain selectable,
 * with assigned jobs sorted first across all pages and a truncation flag if the hard upper bound is reached.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Client, STARTABLE_JOBS_TRUNCATED, TimeDataError, loadStartableJobs, loadStartableJobsResult } from "@/lib/time-data";

type FakeJob = {
  id: string;
  job_no: string;
  customer: string | null;
  description: string | null;
  finished_at: string | null;
  assigned_to: string | null;
};

function jobsClient(allJobs: FakeJob[], serverCap = 1_000, error: { message: string; code?: string } | null = null) {
  const ranges: Array<[number, number]> = [];
  const orders: Array<{ col: string; ascending: boolean }> = [];
  const client = {
    from: (table: string) => {
      expect(table).toBe("jobs");
      const query = {
        select: () => query,
        is: (col: string, val: unknown) => {
          expect(col).toBe("finished_at");
          expect(val).toBeNull();
          return query;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          orders.push({ col, ascending: opts?.ascending !== false });
          return query;
        },
        range: async (from: number, to: number) => {
          ranges.push([from, to]);
          if (error) return { data: null, error };
          const end = Math.min(to + 1, from + serverCap);
          return { data: allJobs.slice(from, end), error: null };
        },
      };
      return query;
    },
  };
  return { client: client as unknown as Client, ranges, orders };
}

function makeJob(index: number, assigned_to: string | null = null): FakeJob {
  return {
    id: `job-${index}`,
    job_no: `J-${String(index).padStart(4, "0")}`,
    customer: "Acme Ltd",
    description: `Part ${index}`,
    finished_at: null,
    assigned_to,
  };
}

describe("CR-025: loadStartableJobsResult paginates all unfinished jobs", () => {
  it("loads older unfinished jobs past 300 and past PostgREST's 1,000-row cap, placing assigned jobs first", async () => {
    const dataset = Array.from({ length: 1_250 }, (_, i) => makeJob(i + 1, i === 1_249 ? "op-1" : null));
    const { client, ranges, orders } = jobsClient(dataset, 1_000);

    const result = await loadStartableJobsResult(client, "op-1");

    expect(result.truncated).toBe(false);
    expect(result.jobs).toHaveLength(1_250);
    // Older job #1250 assigned to op-1 is no longer lost behind a 300-row cap and sorts first.
    expect(result.jobs[0].id).toBe("job-1250");
    expect(result.jobs.some((j) => j.id === "job-450")).toBe(true);
    expect(ranges).toEqual([
      [0, 999],
      [1_000, 1_999],
      [1_250, 2_249],
    ]);
    expect(orders.slice(0, 2)).toEqual([
      { col: "created_at", ascending: false },
      { col: "id", ascending: false },
    ]);
  });

  it("keeps loadStartableJobs returning all unfinished jobs", async () => {
    const dataset = Array.from({ length: 420 }, (_, i) => makeJob(i + 1));
    const { client } = jobsClient(dataset, 200);
    const jobs = await loadStartableJobs(client, null);
    expect(jobs).toHaveLength(420);
    expect(jobs[419].id).toBe("job-420");
  });

  it("reports truncated: true if the unfinished job list reaches the hard upper bound", async () => {
    const dataset = Array.from({ length: 15 }, (_, i) => makeJob(i + 1));
    const { client } = jobsClient(dataset, 5);
    const result = await loadStartableJobsResult(client, null, { pageSize: 5, maxRows: 10 });
    expect(result.truncated).toBe(true);
    expect(result.jobs).toHaveLength(10);
    expect(STARTABLE_JOBS_TRUNCATED).toContain("older unfinished jobs");
  });

  it("wraps database errors in TimeDataError with code preserved", async () => {
    const { client } = jobsClient([], 1_000, { message: "db error", code: "42P01" });
    await expect(loadStartableJobsResult(client, "op-1")).rejects.toMatchObject({
      name: "TimeDataError",
      code: "42P01",
    });
    await expect(loadStartableJobsResult(client, "op-1")).rejects.toBeInstanceOf(TimeDataError);
  });

  it("wires loadStartableJobsResult and truncation warning into components/time/day-sheet.tsx", () => {
    const sheet = readFileSync("components/time/day-sheet.tsx", "utf8");
    expect(sheet).toContain("loadStartableJobsResult(supabase, personId)");
    expect(sheet).toContain('data-testid="startable-jobs-truncated"');
    expect(sheet).toContain("STARTABLE_JOBS_TRUNCATED");
  });
});
