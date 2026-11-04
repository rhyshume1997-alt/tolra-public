import { describe, expect, it } from "vitest";

import { fetchAll } from "@/lib/fetch-all";

const table = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));

describe("fetchAll (audit D10)", () => {
  it("pages past the server cap, even when the cap is smaller than the page size", async () => {
    const all = table(2_345);
    const calls: [number, number][] = [];
    const { rows, truncated } = await fetchAll(async (from, to) => {
      calls.push([from, to]);
      return { data: all.slice(from, Math.min(to + 1, from + 400)), error: null }; // server caps at 400
    });
    expect(rows).toHaveLength(2_345);
    expect(truncated).toBe(false);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2_345);
    expect(calls).toHaveLength(6);
    expect(calls.at(-1)?.[0]).toBe(2_000); // 345 is short relative to the observed 400-row cap
  });

  it("drops duplicates caused by rows shifting between pages", async () => {
    const all = table(1_500);
    let pages = 0;
    const { rows } = await fetchAll(async (from, to) => {
      pages += 1;
      if (pages === 2) all.unshift({ id: "new" }); // inserted at the top while paging
      return { data: all.slice(from, to + 1), error: null };
    });
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(table(1_500).map((r) => r.id)));
  });

  it("reports when the upper bound is reached and surfaces errors", async () => {
    const { rows, truncated } = await fetchAll(async (from, to) => ({ data: table(50_000).slice(from, to + 1), error: null }), { maxRows: 2_500 });
    expect([rows.length, truncated]).toEqual([2_500, true]);
    await expect(fetchAll(async () => ({ data: null, error: new Error("boom") }))).rejects.toThrow("boom");
  });
});

describe("fetchAll terminal request counts", () => {
  it.each([
    [0, 1000, 1], [500, 1000, 2], [1000, 1000, 2], [1500, 1000, 2],
    [2000, 1000, 3], [2345, 400, 6], [800, 400, 3], [450, 200, 3], [4, 1, 5],
  ])("returns all %i rows with server cap %i in %i requests", async (n, cap, expected) => {
    const all = table(n);
    let requests = 0;
    const answer = await fetchAll(async (from, to) => {
      requests++;
      return { data: all.slice(from, Math.min(to + 1, from + cap)), error: null };
    });
    expect(answer).toEqual({ rows: all, truncated: false });
    expect(requests).toBe(expected);
  });

  it("never infers exhaustion just from the first short response", async () => {
    const all = table(7);
    const answer = await fetchAll(async (from) => ({ data: all.slice(from, from + 3), error: null }));
    expect(answer.rows).toEqual(all);
  });

  it("keeps max-row reporting when the last nonempty page reaches the bound", async () => {
    const answer = await fetchAll(async (from, to) => ({ data: table(1500).slice(from, to + 1), error: null }), { maxRows: 1500 });
    expect(answer.rows).toHaveLength(1500);
    expect(answer.truncated).toBe(true);
  });

  it("still surfaces a failure after the first page rather than returning a partial list", async () => {
    await expect(fetchAll(async (from) => from === 0 ? { data: table(400), error: null } : { data: null, error: new Error("second page failed") })).rejects.toThrow("second page failed");
  });
});
