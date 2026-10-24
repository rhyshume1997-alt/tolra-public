import { describe, expect, it } from "vitest";

import { pickerSummaryText } from "@/lib/job-machine-plan";

const mill = { id: "m1", name: "TEST Mill", planned: true };
const lathe = { id: "m2", name: "TEST Lathe", planned: false };
const none = { machines: [] as string[], bench: false };

describe("pickerSummaryText (the Machine column's one line)", () => {
  it("a job planned on a machine that is not running: the bench ticked names the plan, not just \"No machine (bench)\"", () => {
    const text = pickerSummaryText({ running: false, pick: { machines: [], bench: true }, machines: [mill, lathe] });
    expect(text).toBe("Planned: TEST Mill (bench ticked)");
    expect(text).not.toBe("No machine (bench)");
  });

  it("no plan: the bench ticked is plainly \"No machine (bench)\"", () => {
    expect(pickerSummaryText({ running: false, pick: { machines: [], bench: true }, machines: [{ ...mill, planned: false }, lathe] })).toBe("No machine (bench)");
    expect(pickerSummaryText({ running: false, pick: { machines: [], bench: true }, machines: [] })).toBe("No machine (bench)");
  });

  it("machines ticked: their names; nothing ticked: Pick a machine; running: Add machine", () => {
    expect(pickerSummaryText({ running: false, pick: { machines: ["m1", "m2"], bench: false }, machines: [mill, lathe] })).toBe("TEST Mill, TEST Lathe");
    expect(pickerSummaryText({ running: false, pick: none, machines: [mill, lathe] })).toBe("Pick a machine");
    expect(pickerSummaryText({ running: false, pick: { machines: ["gone"], bench: false }, machines: [mill] })).toBe("Pick a machine");
    expect(pickerSummaryText({ running: true, pick: { machines: [], bench: true }, machines: [mill] })).toBe("Add machine");
  });
});
