/**
 * The app goes out before migration 068 is applied (and 068 needs 067 first). The 068 probe tells the quote screens whether the
 * database has quote versions, declined lines and part details; until it does they read and write only what existed before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ result: { error: null } as { error: { code?: string; message?: string } | null }, calls: 0, columns: [] as string[] }));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    self.select = (columns: string) => { probe.columns.push(`${table}:${columns}`); return self; };
    for (const name of ["eq", "in", "order", "limit"]) self[name] = () => self;
    self.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
      probe.calls += 1;
      return Promise.resolve(probe.result).then(resolve, reject);
    };
    return self;
  };
  return { supabase: { from: (table: string) => chain(table) } };
});

import { databaseHas068, resetDatabaseFeatureCache } from "@/lib/db-features";

describe("the 068 probe (revise, line choices and part details show only once it is applied)", () => {
  beforeEach(() => {
    resetDatabaseFeatureCache();
    probe.calls = 0;
    probe.columns = [];
  });

  it("asks for quote_line_items.declined, reading no rows", async () => {
    probe.result = { error: null };
    expect(await databaseHas068()).toBe(true);
    expect(probe.columns).toEqual(["quote_line_items:declined"]);
  });

  it("not applied (the column is missing): false, asked once", async () => {
    probe.result = { error: { code: "42703", message: "column quote_line_items.declined does not exist" } };
    expect(await databaseHas068()).toBe(false);
    expect(await databaseHas068()).toBe(false);
    expect(probe.calls).toBe(1);
  });

  it("PostgREST's schema-cache form of the same is also 'not yet'", async () => {
    probe.result = { error: { code: "PGRST204", message: "Could not find the 'declined' column of 'quote_line_items' in the schema cache" } };
    expect(await databaseHas068()).toBe(false);
  });

  it("offline or a refusal is no answer: the features aren't hidden for it, and the next call asks again", async () => {
    probe.result = { error: { message: "Failed to fetch" } };
    expect(await databaseHas068()).toBe(true);
    probe.result = { error: { code: "42703", message: "column does not exist" } };
    expect(await databaseHas068()).toBe(false);
    expect(probe.calls).toBe(2);
  });
});
