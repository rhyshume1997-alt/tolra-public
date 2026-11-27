// Exercises the timesheet job selector's read with a response-capped API fixture.
import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";

import { loadStartableJobs } from "@/lib/time-data";

it("keeps an older assigned job selectable and places it first", async () => {
  const jobs = Array.from({ length: 1_001 }, (_, index) => ({
    id: String(index), job_no: `J-${index}`, assigned_to: index === 1_000 ? "worker" : null,
  }));
  const client = createClient("http://127.0.0.1:54321", "test-key", {
    global: { fetch: async (input) => {
      const query = new URL(String(input)).searchParams;
      const offset = Number(query.get("offset") ?? 0);
      const limit = Math.min(1_000, Number(query.get("limit") ?? 1_000));
      expect(query.get("finished_at")).toBe("is.null");
      return Response.json(jobs.slice(offset, offset + limit));
    } },
  });
  const result = await loadStartableJobs(client, "worker");
  expect(result).toHaveLength(1_001);
  expect(result.slice(0, 2).map(({ id }) => id)).toEqual(["1000", "0"]);
});
