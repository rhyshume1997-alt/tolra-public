import { beforeEach, describe, expect, it, vi } from "vitest";

type Answer = { error: { code?: string; message?: string } | null } | "throw";
let answer: Answer = { error: null };
const asked = vi.fn();
vi.mock("@/lib/supabase", () => ({
  supabase: { from: (table: string) => ({ select: (column: string) => ({ limit: async () => { asked(table, column); if (answer === "throw") throw new Error("network down"); return answer; } }) }) },
}));

import { databaseHas067, databaseHas068, databaseHas073, databaseHas075, databaseHas084, databaseHas124, resetDatabaseFeatureCache } from "@/lib/db-features";

const FAIL_OPEN = { databaseHas067, databaseHas068, databaseHas084 };
const FAIL_CLOSED = { databaseHas073, databaseHas075, databaseHas124 };
const TRANSIENT: Array<[string, Answer]> = [
  ["a statement timeout (57014)", { error: { code: "57014", message: "canceling statement due to statement timeout" } }],
  ["a gateway error with no code", { error: { message: "FetchError: 503" } }],
  ["a thrown network error", "throw"],
];

beforeEach(() => { answer = { error: null }; asked.mockReset(); resetDatabaseFeatureCache(); });

describe("feature probes: a transient error is not an answer", () => {
  describe.each(TRANSIENT)("%s", (_name, transient) => {
    it.each(Object.entries(FAIL_OPEN))("%s FAILS OPEN (true: the new path is taken even on an old schema) but is not cached", async (_n, probe) => {
      answer = transient;
      expect(await probe()).toBe(true);
      answer = { error: { code: "42703", message: "column does not exist" } };
      expect(await probe()).toBe(false); // the next call asks again and learns the truth
    });
    it.each(Object.entries(FAIL_CLOSED))("%s fails closed (false) and is not cached", async (_n, probe) => {
      answer = transient;
      expect(await probe()).toBe(false);
      answer = { error: null };
      expect(await probe()).toBe(true);
    });
  });

  it.each([...Object.entries(FAIL_OPEN), ...Object.entries(FAIL_CLOSED)])("%s: a definite missing object is cached as false; present as true", async (_n, probe) => {
    answer = { error: { code: "PGRST205", message: "Could not find the table in the schema cache" } };
    expect(await probe()).toBe(false);
    answer = { error: null };
    expect(await probe()).toBe(false); // cached: no second question
    expect(asked).toHaveBeenCalledTimes(1);
    resetDatabaseFeatureCache();
    expect(await probe()).toBe(true);
    expect(await probe()).toBe(true);
    expect(asked).toHaveBeenCalledTimes(2);
  });

  it("a permission error (42501) is not 'missing': fail-open probes answer true, fail-closed false", async () => {
    answer = { error: { code: "42501", message: "permission denied" } };
    expect(await databaseHas068()).toBe(true);
    expect(await databaseHas124()).toBe(false);
  });
});
