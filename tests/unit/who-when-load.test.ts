import { describe, expect, it, vi } from "vitest";

import { loadWhoWhen, withRetries } from "@/lib/who-when-load";

type Reply = { data: unknown; error: unknown };
const ok = (data: unknown): Reply => ({ data, error: null });
const failed: Reply = { data: null, error: { message: "boom" } };

/** A stand-in for the Supabase client: each table query ends in the reply `tables[name]` or throws when it is "throw". */
function fakeClient(tables: Record<string, Reply | "throw">, people: Reply | "throw") {
  const query = (name: string) => {
    const q: Record<string, unknown> = {};
    const chain = () => q;
    for (const m of ["select", "eq", "order"]) q[m] = chain;
    const settle = () => { const r = tables[name]; if (r === "throw") throw new Error("Failed to fetch"); return Promise.resolve(r ?? ok([])); };
    q.maybeSingle = settle;
    q.then = (resolve: (v: Reply) => unknown, reject: (e: unknown) => unknown) => { try { return settle().then(resolve, reject); } catch (e) { return Promise.reject(e).then(resolve, reject); } };
    return q;
  };
  return {
    from: (name: string) => query(name),
    rpc: () => { if (people === "throw") throw new Error("Failed to fetch"); return Promise.resolve(people); },
  } as never;
}

const JOB = { created_by: "u1", created_at: "2026-10-01T08:00:00Z", started_by: "u2", started_at: "2026-10-01T08:30:00Z" };
const PEOPLE = ok([{ user_id: "u1", display_name: "Admin alpha" }, { user_id: "u2", display_name: "Workshop alpha" }]);
const id = "00000000-0000-4000-8000-000000000001";

describe("loadWhoWhen", () => {
  it("gives the record and the people", async () => {
    const data = await loadWhoWhen(fakeClient({ jobs: ok(JOB) }, PEOPLE), "jobs", id, null, false);
    expect(data?.record).toEqual(JOB);
    expect(data?.people.u2).toBe("Workshop alpha");
  });
  it("is null (not partial) when the people list or the record couldn't be read", async () => {
    expect(await loadWhoWhen(fakeClient({ jobs: ok(JOB) }, failed), "jobs", id, null, false)).toBeNull();
    expect(await loadWhoWhen(fakeClient({ jobs: failed }, PEOPLE), "jobs", id, null, false)).toBeNull();
    expect(await loadWhoWhen(fakeClient({ jobs: ok(null) }, PEOPLE), "jobs", id, null, false)).toBeNull();
  });
  it("leaves out rework lines when those tables can't be read, but still shows the rest", async () => {
    const data = await loadWhoWhen(fakeClient({ jobs: ok(JOB), job_rework: failed, job_rework_entries: failed }, PEOPLE), "jobs", id, null, false);
    expect(data?.extras).toEqual({ reworks: [], scrap: [] });
  });
});

describe("withRetries", () => {
  const wait = () => Promise.resolve();
  it("keeps asking after a failed read and a thrown one, then shows the lines (the lost-request case)", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce("lines");
    expect(await withRetries(load, () => true, [1, 1, 1], wait)).toBe("lines");
    expect(load).toHaveBeenCalledTimes(3);
  });
  it("does not retry after a first success", async () => {
    const load = vi.fn().mockResolvedValue("lines");
    expect(await withRetries(load, () => true, [1, 1], wait)).toBe("lines");
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("gives up after the last delay instead of asking forever", async () => {
    const load = vi.fn().mockResolvedValue(null);
    expect(await withRetries(load, () => true, [1, 1], wait)).toBeNull();
    expect(load).toHaveBeenCalledTimes(3);
  });
  it("stops as soon as the screen has moved on", async () => {
    let alive = true;
    const load = vi.fn(async () => { alive = false; return null; });
    expect(await withRetries(load, () => alive, [1, 1], wait)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("uses the waits in order", async () => {
    const waits: number[] = [];
    await withRetries(async () => null, () => true, [5, 7], async (ms) => { waits.push(ms); });
    expect(waits).toEqual([5, 7]);
  });
});
