import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLOUR_CLASSES, SCHEDULE_FREE_FILL, SCHEDULE_ORDER, SCHEDULE_STATES, scheduleBlockClass, scheduleColour, scheduleLegendText } from "@/lib/status-colours";

const gantt = readFileSync(path.resolve(__dirname, "../../components/machine-gantt.tsx"), "utf8");

describe("Machine Schedule colours come from the central map", () => {
  it("running is blue, booked is grey, complete is green; paused (yellow) and free (no fill) are the recommended extras", () => {
    expect(scheduleColour("running")).toBe("blue");
    expect(scheduleColour("booked")).toBe("grey");
    expect(scheduleColour("complete")).toBe("green");
    expect(scheduleColour("paused")).toBe("yellow");
    expect(scheduleColour("free")).toBeNull();
  });

  it("purple is nowhere on the schedule (rework only)", () => {
    for (const state of SCHEDULE_ORDER) expect(scheduleColour(state)).not.toBe("purple");
    expect(gantt).not.toMatch(/purple/);
    expect(gantt).not.toMatch(/bg-(emerald|green)-/);
  });

  it("blocks use the map's classes; a free slot has a plain fill, not a colour", () => {
    expect(scheduleBlockClass("running")).toBe(COLOUR_CLASSES.blue.badge);
    expect(scheduleBlockClass("paused")).toBe(COLOUR_CLASSES.yellow.badge);
    expect(scheduleBlockClass("paused")).toContain("text-slate-950");
    expect(scheduleBlockClass("free")).toBe(SCHEDULE_FREE_FILL);
    expect(SCHEDULE_FREE_FILL).not.toMatch(/emerald|green|#/);
  });

  it("the legend sentence matches the colours exactly, and every state has a word", () => {
    expect(scheduleLegendText()).toBe("No fill is free, grey is booked, blue is running, yellow is paused, green is complete.");
    expect(SCHEDULE_ORDER.map((state) => SCHEDULE_STATES[state].label)).toEqual(["Free", "Booked", "Running", "Paused", "Complete"]);
  });

  it("the timeline draws its blocks, run bars and legend from the map", () => {
    expect(gantt).toContain("{scheduleLegendText()}");
    expect(gantt).toContain("scheduleBlockClass(done ? \"complete\" : running ? \"running\" : \"booked\")");
    expect(gantt).toContain("SCHEDULE_ORDER.map");
    expect(gantt).not.toMatch(/bg-gray-500|bg-blue-600/);
  });
});
