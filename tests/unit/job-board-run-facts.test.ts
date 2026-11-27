// Exercises the board read with synthetic capped API pages. No database writes.
import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";

import { MAX_LIST_ROWS } from "@/lib/fetch-all";
import { loadBoardRunFacts } from "@/lib/job-board-run-facts";

it.each([
  { size: 1_001, complete: true },
  { size: MAX_LIST_ROWS + 1, complete: false },
])("only returns board run facts when all $size rows can be read", async ({ size, complete }) => {
  const db = createClient("http://127.0.0.1:54321", "unit-test-key", {
    global: { fetch: async (input) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      expect(url.searchParams.get("jobs.finished_at")).toBe("is.null");
      return Response.json(Array.from({ length: Math.min(1_000, size - offset) }, (_, index) => ({
        id: String(offset + index), job_id: `job-${offset + index}`, jobs: { finished_at: null },
      })));
    } },
  });
  const facts = await loadBoardRunFacts(db);
  if (complete) {
    expect(facts).toHaveLength(size);
    expect(facts?.at(-1)).toEqual({ id: "1000", job_id: "job-1000" });
  } else {
    expect(facts === null).toBe(true);
  }
});
