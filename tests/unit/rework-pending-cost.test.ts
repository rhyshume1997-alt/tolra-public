import { describe, expect, it } from "vitest";

import { finishWithPendingCost, pendingCostEntry } from "@/lib/rework";

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

describe("finishWithPendingCost (finish books a typed entry once)", () => {
  it("booking succeeds but the finish fails: the fields are cleared, so the retry finishes without booking again", async () => {
    let fields = { ...blank, hours: "1.5", material: "1 off EN8 bar" };
    const booked: unknown[] = [];
    let finishCalls = 0;
    const steps = {
      book: async (entry: unknown) => { booked.push(entry); },
      clear: () => { fields = { ...blank }; },
      finish: async () => { finishCalls += 1; if (finishCalls === 1) throw new Error("Can't reach the server."); },
    };
    await expect(finishWithPendingCost(pendingCostEntry(fields), steps)).rejects.toThrow("Can't reach the server.");
    expect(booked).toHaveLength(1);
    expect(fields).toEqual(blank);
    // Retry: the dialog recomputes from the (now empty) fields.
    await finishWithPendingCost(pendingCostEntry(fields), steps);
    expect(booked).toHaveLength(1);
    expect(finishCalls).toBe(2);
  });
  it("booking fails: nothing is cleared and the finish is not attempted", async () => {
    const fields = { ...blank, hours: "2" };
    let cleared = false;
    let finished = false;
    await expect(finishWithPendingCost(pendingCostEntry(fields), {
      book: async () => { throw new Error("Couldn't save."); }, clear: () => { cleared = true; }, finish: async () => { finished = true; },
    })).rejects.toThrow("Couldn't save.");
    expect(cleared).toBe(false);
    expect(finished).toBe(false);
  });
});
