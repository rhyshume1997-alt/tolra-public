import { describe, expect, it } from "vitest";
import { fetchAll, MAX_LIST_ROWS } from "@/lib/fetch-all";

describe("builder 6 independent default row-limit review", () => {
  it.each([19_999, 20_000, 20_001])("handles %i rows with the real default guard", async (size) => {
    const calls: number[] = [];
    const all = Array.from({ length: size }, (_, id) => ({ id }));
    const answer = await fetchAll(async (from, to) => {
      calls.push(from);
      return { data: all.slice(from, Math.min(to + 1, from + 400)), error: null };
    });
    expect(MAX_LIST_ROWS).toBe(20_000);
    expect(answer.rows).toEqual(all.slice(0, 20_000));
    expect(answer.truncated).toBe(size >= 20_000);
    expect(calls).toHaveLength(50);
    expect(calls.at(-1)).toBe(19_600);
  });
});
