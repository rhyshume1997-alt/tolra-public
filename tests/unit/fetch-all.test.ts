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
    expect(calls.at(-1)?.[0]).toBe(2_345);
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
