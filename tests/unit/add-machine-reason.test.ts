import { describe, expect, it } from "vitest";

import { addMachineReason } from "@/lib/add-machine-reason";

const base = { ready: true, loading: false, loadFailed: false, machineCount: 4, rowCount: 1, max: 3, role: "admin" };

describe("addMachineReason (why Add machine is disabled)", () => {
  it("is null when another machine can be added", () => {
    expect(addMachineReason(base)).toBeNull();
  });

  it("says the machines are loading, or failed to load", () => {
    expect(addMachineReason({ ...base, loading: true, ready: false, machineCount: 0 })?.code).toBe("loading");
    expect(addMachineReason({ ...base, ready: false })?.code).toBe("loading");
    expect(addMachineReason({ ...base, loadFailed: true, ready: false, machineCount: 0 })?.code).toBe("load_failed");
  });

  it("no machines set up: admin and office get the link, everyone else only the reason", () => {
    for (const role of ["admin", "office"]) expect(addMachineReason({ ...base, machineCount: 0, rowCount: 0, role })).toMatchObject({ code: "none", reason: "No machines set up yet.", link: true });
    for (const role of ["workshop", "viewer", null, undefined]) expect(addMachineReason({ ...base, machineCount: 0, rowCount: 0, role })).toMatchObject({ code: "none", link: false });
  });

  it("the job is on every machine, or at the most it may have", () => {
    expect(addMachineReason({ ...base, machineCount: 2, rowCount: 2 })).toMatchObject({ code: "on_every_machine", reason: "This job is already on every machine.", link: false });
    expect(addMachineReason({ ...base, machineCount: 6, rowCount: 3 })).toMatchObject({ code: "at_max", reason: "A job can have at most 3 machines." });
  });
});
