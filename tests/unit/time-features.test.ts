/**
 * The app can be deployed before 050 to 052 are applied (lib/time-features.ts): "the database doesn't have it yet" is told apart from a
 * real error, the answer is asked once, and a clock action or job Start/Stop is only queued once the database is known to take it.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { TimeDataError, loadTimeData } from "@/lib/time-data";
import { TIME_NEEDS_DATABASE_UPDATE, TIME_NOT_CHECKED, databaseHasTime, featurePresent, missingDbObject, resetTimeFeatureCache, timeOpsAllowed } from "@/lib/time-features";

type Err = { code?: string; message: string } | null;
function probe(error: Err | "throw") {
  let calls = 0;
  return {
    get calls() { return calls; },
    from: () => ({ select: () => ({ limit: async () => { calls += 1; if (error === "throw") throw new TypeError("Failed to fetch"); return { error }; } }) }),
  };
}
const memory = new Map<string, string>();
beforeEach(() => {
  memory.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => memory.set(k, v), removeItem: (k: string) => memory.delete(k) };
  resetTimeFeatureCache();
});

describe("missing database objects", () => {
  it("recognises the PostgREST and Postgres codes and messages, not other errors", () => {
    for (const code of ["PGRST202", "PGRST204", "PGRST205", "42883", "42P01", "42703"]) expect(missingDbObject({ code, message: "x" })).toBe(true);
    expect(missingDbObject({ message: "Could not find the table 'public.time_week_approvals' in the schema cache" })).toBe(true);
    expect(missingDbObject({ code: "42501", message: "permission denied" })).toBe(false);
    expect(missingDbObject(null)).toBe(false);
    expect(featurePresent({ error: null })).toBe(true);
    expect(featurePresent({ error: { code: "PGRST205", message: "" } })).toBe(false);
    expect(featurePresent({ error: { code: "57014", message: "timeout" } })).toBeNull();
  });
});

describe("databaseHasTime and timeOpsAllowed", () => {
  it("before 050-052: false, asked once; nothing may be queued", async () => {
    const p = probe({ code: "PGRST205", message: "Could not find the table" });
    expect(await databaseHasTime(p)).toBe(false);
    expect(await databaseHasTime(p)).toBe(false);
    expect(p.calls).toBe(1);
    expect(await timeOpsAllowed(p)).toEqual({ ok: false, reason: TIME_NEEDS_DATABASE_UPDATE });
  });

  it("a 'not yet' answer is asked again after a minute (a page left open finds the SQL once applied)", async () => {
    const missing = probe({ code: "PGRST205", message: "missing" });
    const t0 = 1_000_000;
    expect(await databaseHasTime(missing, t0)).toBe(false);
    expect(await databaseHasTime(missing, t0 + 30_000)).toBe(false);
    expect(missing.calls).toBe(1);
    const present = probe(null);
    expect(await databaseHasTime(present, t0 + 61_000)).toBe(true);
    expect(present.calls).toBe(1);
    expect(await databaseHasTime(present, t0 + 10_000_000)).toBe(true);
    expect(present.calls).toBe(1); // "present" is kept
  });

  it("after: true, remembered on the device, so a later offline Clock in may be queued", async () => {
    expect(await timeOpsAllowed(probe(null))).toEqual({ ok: true });
    resetTimeFeatureCache();
    memory.set("tolra.db.time-050-052", "1"); // what the device remembered (reset clears it; put it back as a reload would find it)
    expect(await timeOpsAllowed(probe("throw"))).toEqual({ ok: true });
  });

  it("no answer (offline) on a device that never saw the database ready: not queued, with a reason", async () => {
    const p = probe("throw");
    expect(await databaseHasTime(p)).toBeNull();
    expect(await timeOpsAllowed(p)).toEqual({ ok: false, reason: TIME_NOT_CHECKED });
  });
});

describe("the loader keeps the server's code", () => {
  it("a missing table surfaces as TimeDataError with its code, so the page says 'needs a database update'", async () => {
    const chain: Record<string, unknown> = {};
    const answer = { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.attendance_events' in the schema cache" } };
    for (const m of ["select", "gte", "lt", "eq", "or", "order", "limit", "lte", "in", "is"]) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) => resolve(answer);
    chain.maybeSingle = async () => answer;
    const client = { from: () => chain } as unknown as Parameters<typeof loadTimeData>[0];
    const err = await loadTimeData(client, { userId: "u", from: new Date(), to: new Date() }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeDataError);
    expect(err.code).toBe("PGRST205");
    expect(missingDbObject(err)).toBe(true);
  });

  it("092: job time is read with who ended it and why; before 092 (no end_reason column, 42703) the same read without them", async () => {
    const selects: string[] = [];
    const chain = (table: string): Record<string, unknown> => {
      let columns = "";
      const c: Record<string, unknown> = {};
      for (const m of ["gte", "lt", "eq", "or", "order", "limit", "lte", "in", "is"]) c[m] = () => c;
      c.select = (cols: string) => { columns = cols; if (table === "operator_sessions") selects.push(cols); return c; };
      c.then = (resolve: (v: unknown) => unknown) => resolve(table === "operator_sessions" && columns.includes("end_reason")
        ? { data: null, error: { code: "42703", message: "column operator_sessions.end_reason does not exist" } }
        : { data: table === "operator_sessions" ? [{ id: "s1", user_id: "u", job_id: "j", started_at: "2026-10-22T13:00:00Z", ended_at: null }] : [], error: null });
      c.maybeSingle = async () => ({ data: null, error: null });
      return c;
    };
    const client = { from: (table: string) => chain(table) } as unknown as Parameters<typeof loadTimeData>[0];
    const data = await loadTimeData(client, { userId: "u", from: new Date(), to: new Date() });
    expect(data.labour.map((l) => l.id)).toEqual(["s1"]);
    expect(selects).toHaveLength(2);
    expect(selects[0]).toMatch(/, ended_by, end_reason$/);
    expect(selects[1]).not.toMatch(/end_reason|ended_by/);
    expect(selects[1]).toContain("end_source");
  });
});
