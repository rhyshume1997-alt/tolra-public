import { describe, expect, it } from "vitest";

import { pendingCostEntry } from "@/lib/rework";

const blank = { hours: "", material: "", materialCost: "", note: "" };

describe("pendingCostEntry (hours and material typed but not yet added)", () => {
  it("is none when nothing is typed", () => {
    expect(pendingCostEntry(blank)).toEqual({ kind: "none" });
    expect(pendingCostEntry({ ...blank, hours: "  " })).toEqual({ kind: "none" });
  });
  it("turns valid hours and material into an entry", () => {
    expect(pendingCostEntry({ ...blank, hours: "2.5", material: "1 off EN8 bar" })).toEqual({ kind: "entry", hours: 2.5, material: "1 off EN8 bar", materialCost: null, note: "" });
    expect(pendingCostEntry({ ...blank, material: "bar", materialCost: "12.5" })).toMatchObject({ kind: "entry", hours: null, materialCost: 12.5 });
  });
  it("never lets a half-valid entry through", () => {
    expect(pendingCostEntry({ ...blank, hours: "0", material: "bar" })).toMatchObject({ kind: "error" });
    expect(pendingCostEntry({ ...blank, hours: "1000" })).toMatchObject({ kind: "error" });
    expect(pendingCostEntry({ ...blank, note: "only a note" })).toMatchObject({ kind: "error" });
    expect(pendingCostEntry({ ...blank, hours: "1", materialCost: "5" })).toMatchObject({ kind: "error", message: "Say which material the cost is for." });
    expect(pendingCostEntry({ ...blank, material: "bar", materialCost: "-1" })).toMatchObject({ kind: "error" });
  });
});
