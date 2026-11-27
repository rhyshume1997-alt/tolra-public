import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

import { type MachineNameReader, loadMachineNamesResult } from "@/lib/job-worksheet";
import { loadWorksheetPrefillSource } from "@/lib/job-machine-plan";

describe("loadMachineNamesResult (CR-024)", () => {
  it("returns unavailable when the machines table read fails instead of looking like an empty list", async () => {
    const client: MachineNameReader = {
      from: () => ({
        select: () => Promise.resolve({ data: null, error: { code: "500", message: "db error" } }),
      }),
    };
    expect(await loadMachineNamesResult(client, false)).toEqual({ status: "unavailable" });
  });

  it("returns unavailable when the machines query throws", async () => {
    const client: MachineNameReader = {
      from: () => ({
        select: () => Promise.reject(new Error("network down")),
      }),
    };
    expect(await loadMachineNamesResult(client, false)).toEqual({ status: "unavailable" });
  });

  it("returns loaded with an empty array only when the database explicitly succeeds with zero machines", async () => {
    const client: MachineNameReader = {
      from: () => ({
        select: () => Promise.resolve({ data: [], error: null }),
      }),
    };
    expect(await loadMachineNamesResult(client, false)).toEqual({ status: "loaded", names: [] });
  });

  it("returns loaded machine names on success", async () => {
    const client: MachineNameReader = {
      from: () => ({
        select: () => Promise.resolve({ data: [{ name: "Haas VF-2" }, { machine_name: "Doosan Puma" }], error: null }),
      }),
    };
    expect(await loadMachineNamesResult(client, false)).toEqual({
      status: "loaded",
      names: ["Haas VF-2", "Doosan Puma"],
    });
  });
});

describe("loadWorksheetPrefillSource (CR-024)", () => {
  it("returns null instead of empty machineNames when the machines query fails", async () => {
    const tableResponses: Record<string, { data: unknown; error: unknown }> = {
      job_machines: { data: [{ machine_id: "m1", estimated_hours: 2, booking_id: null, position: 0 }], error: null },
      machine_bookings: { data: [], error: null },
      machine_runs: { data: [], error: null },
      machines: { data: null, error: { message: "machines unavailable" } },
    };
    const makeQuery = (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) q[m] = () => q;
      q.then = (resolve: (v: unknown) => unknown) => resolve(tableResponses[table]);
      return q;
    };
    const client = { from: (table: string) => makeQuery(table) };

    const result = await loadWorksheetPrefillSource(client as never, "job-1");
    expect(result).toBeNull();
  });
});
