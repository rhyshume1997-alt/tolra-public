import { beforeEach, describe, expect, it, vi } from "vitest";
import { runClock } from "@/lib/machine-schedule";

const state = vi.hoisted(() => ({ result: { data: [] as unknown[], error: null as unknown }, calls: [] as string[][] }));
vi.mock("@/lib/supabase", () => ({
  supabase: { from: () => ({ select: () => ({ in: (_col: string, ids: string[]) => { state.calls.push(ids); return Promise.resolve(state.result); } }) }) },
}));

import { loadRunBookings } from "@/lib/run-bookings";

beforeEach(() => { state.calls = []; state.result = { data: [], error: null }; });

describe("loadRunBookings", () => {
  it("reads the bookings by id and maps their hours", async () => {
    state.result = { data: [{ id: "b1", estimated_hours: "6", hours_done: 1.5, status: "running" }, { id: "b2", estimated_hours: 2, hours_done: null, status: "weird" }], error: null };
    const map = await loadRunBookings(["b1", "b2", "b1"]);
    expect(state.calls).toEqual([["b1", "b2"]]);
    expect(map?.get("b1")).toEqual({ estimatedHours: 6, hoursDone: 1.5, status: "running" });
    expect(map?.get("b2")).toEqual({ estimatedHours: 2, hoursDone: 0, status: "booked" });
  });

  it("no ids: nothing to read", async () => {
    expect((await loadRunBookings([]))?.size).toBe(0);
    expect(state.calls).toEqual([]);
  });

  it("a read error gives null, so the board shows elapsed time only", async () => {
    state.result = { data: [], error: { message: "denied" } };
    const map = await loadRunBookings(["b1"]);
    expect(map).toBeNull();
    const clock = runClock("2026-10-21T08:00:00Z", map?.get("b1"), new Date("2026-10-21T09:00:00Z"));
    expect(clock).toEqual({ elapsedMinutes: 60, leftMinutes: null });
  });
});
