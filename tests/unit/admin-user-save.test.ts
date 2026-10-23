import { describe, expect, it, vi } from "vitest";

import { ApiError, apiErrorFrom, describePartial, inspectorFlags, saveMemberEdit } from "@/lib/admin-user-save";

const describeErr = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");

describe("inspectorFlags", () => {
  it("returns the ids that can inspect", () => {
    expect([...inspectorFlags([{ user_id: "a", can_inspect: true }, { user_id: "b", can_inspect: false }], null)!]).toEqual(["a"]);
  });
  it("returns null when the read failed, rather than treating everyone as non-inspector", () => {
    expect(inspectorFlags(null, { message: "denied" })).toBeNull();
    expect(inspectorFlags([{ user_id: "a", can_inspect: true }], { message: "denied" })).toBeNull();
    expect(inspectorFlags(undefined, null)).toBeNull();
  });
});

describe("saveMemberEdit", () => {
  it("updates the member first, then the inspector flag", async () => {
    const order: string[] = [];
    const result = await saveMemberEdit({ hasPatch: true, inspectorChange: true, patch: async () => { order.push("patch"); }, setInspector: async (v) => { order.push(`inspector:${v}`); }, describe: describeErr });
    expect(result).toEqual({ status: "ok" });
    expect(order).toEqual(["patch", "inspector:true"]);
  });

  it("does not touch the inspector flag when the member update fails", async () => {
    const setInspector = vi.fn();
    const result = await saveMemberEdit({ hasPatch: true, inspectorChange: false, patch: async () => { throw new Error("Username taken."); }, setInspector, describe: describeErr });
    expect(setInspector).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.status !== "ok" && result.message).toContain("Nothing was changed");
  });

  it("reports a partial save when only the inspector change fails", async () => {
    const result = await saveMemberEdit({ hasPatch: true, inspectorChange: true, patch: async () => {}, setInspector: async () => { throw new Error("Not allowed."); }, describe: describeErr });
    expect(result).toEqual({ status: "partial", message: 'Their details were saved, but "Can record inspections" was not changed: Not allowed.' });
  });

  it("reports a plain failure when only the inspector change was asked for", async () => {
    const patch = vi.fn();
    const result = await saveMemberEdit({ hasPatch: false, inspectorChange: true, patch, setInspector: async () => { throw new Error("Not allowed."); }, describe: describeErr });
    expect(patch).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "failed", message: '"Can record inspections" was not changed: Not allowed.' });
  });

  it("keeps the update's own message when no inspector change was asked for", async () => {
    const result = await saveMemberEdit({ hasPatch: true, inspectorChange: null, patch: async () => { throw new Error("Username taken."); }, setInspector: vi.fn(), describe: describeErr });
    expect(result).toEqual({ status: "failed", message: "Username taken." });
  });
});

describe("saveMemberEdit when the update was partly applied", () => {
  it("names what was saved and what was not, instead of saying nothing changed", async () => {
    const err = new ApiError("Could not save the name", ["access", "username"], "name");
    const result = await saveMemberEdit({ hasPatch: true, inspectorChange: null, patch: async () => { throw err; }, setInspector: vi.fn(), describe: describeErr });
    expect(result).toEqual({ status: "partial", message: "Saved: role and page access and username. Not saved: display name – Could not save the name" });
  });
  it("does not try the inspector change after a partial update, and says so", async () => {
    const setInspector = vi.fn();
    const result = await saveMemberEdit({ hasPatch: true, inspectorChange: true, patch: async () => { throw new ApiError("Taken", ["access"], "username"); }, setInspector, describe: describeErr });
    expect(setInspector).not.toHaveBeenCalled();
    expect(result.status).toBe("partial");
    expect(result.status !== "ok" && result.message).toContain("Who can record inspections was not changed");
    expect(result.status !== "ok" && result.message).not.toContain("Nothing was changed");
  });
  it("reads applied/failed from an error body, ignoring junk", () => {
    const err = apiErrorFrom({ error: "No.", applied: ["name", "bogus", 3], failed: "access" }, "fallback");
    expect(err).toMatchObject({ message: "No.", applied: ["name"], failed: "access" });
    expect(apiErrorFrom(null, "fallback")).toMatchObject({ message: "fallback", applied: [], failed: null });
  });
});

describe("uncertain outcomes", () => {
  it("are read from the response and kept out of applied/failed", () => {
    const err = apiErrorFrom({ error: "x", applied: ["access", "name"], failed: "access", uncertain: ["access", "bogus"] }, "fallback");
    expect(err).toMatchObject({ applied: ["name"], failed: null, uncertain: ["access"] });
  });
  it("are described as 'may not have saved, reload to check', never as saved or not saved", () => {
    const message = describePartial(new ApiError("x", [], null, ["access"]), "x") ?? "";
    expect(message).toMatch(/may not have saved: reload to check/);
    expect(message).not.toMatch(/Saved:|Not saved/);
  });
  it("sit beside what was saved", () => {
    expect(describePartial(new ApiError("x", ["name"], null, ["access"]), "x")).toBe("Saved: display name. role and page access may not have saved: reload to check.");
  });
});
