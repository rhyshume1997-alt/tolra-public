import { describe, expect, it } from "vitest";

import { pickerEmptyReason } from "@/lib/machine-picker-empty";
import type { InUseRow } from "@/lib/machine-runs";

const mill = { id: "m1", name: "TEST Mill" };
const lathe = { id: "m2", name: "TEST Lathe" };
const live = (machine: { id: string; name: string }, job: string): [string, InUseRow] => [machine.id, { run_id: `r-${machine.id}`, machine_id: machine.id, machine_name: machine.name, job_id: job, job_no: job, booking_id: null, operator_id: null, operator_name: null, started_at: "2026-10-22T09:00:00Z" } as InUseRow];
const running = { running: true };

describe("pickerEmptyReason", () => {
  it("is null while something can be ticked", () => {
    expect(pickerEmptyReason([mill, lathe], new Map([live(mill, "J1")]), "office", "J1", false, running)).toBeNull();
    expect(pickerEmptyReason([mill], new Map(), "workshop", "J1", false, running)).toBeNull();
  });

  it("no machines at all", () => {
    expect(pickerEmptyReason([], new Map(), "office", "J1", false, { running: true, canAdd: true })).toEqual({ code: "none", reason: "No machines set up yet.", next: "link" });
    // Also when the job is not running (Start: only the bench is left).
    expect(pickerEmptyReason([], new Map(), "workshop", "J1", false)?.code).toBe("none");
  });

  it("a failed read says so and offers no link", () => {
    expect(pickerEmptyReason([], new Map(), "admin", "J1", true, { running: true, canAdd: true })).toEqual({ code: "load_failed", reason: "Couldn't load the machines. Reload and try again.", next: null });
  });

  it("still loading: \"Loading machines…\", never \"No machines set up yet\"", () => {
    const result = pickerEmptyReason([], new Map(), "office", "J1", false, { running: true, canAdd: true, loading: true });
    expect(result).toEqual({ code: "loading", reason: "Loading machines…", next: null });
    expect(pickerEmptyReason([], new Map(), "workshop", "J1", false, { loading: true })?.code).toBe("loading");
    // Once loaded and still empty, it is the real "none"; a failed read wins over loading.
    expect(pickerEmptyReason([], new Map(), "office", "J1", false, { running: true, loading: false })?.code).toBe("none");
    expect(pickerEmptyReason([], new Map(), "office", "J1", true, { running: true, loading: true })?.code).toBe("load_failed");
    // A list that has arrived is never "loading".
    expect(pickerEmptyReason([mill], new Map(), "office", "J1", false, { running: true, loading: true })).toBeNull();
  });

  it("a failed read after a list was loaded keeps the list", () => {
    expect(pickerEmptyReason([mill, lathe], new Map(), "office", "J1", true, running)).toBeNull();
  });

  it("only the machine this job is running on", () => {
    const inUse = new Map([live(mill, "J1")]);
    expect(pickerEmptyReason([mill], inUse, "office", "J1", false, { running: true, canAdd: true })).toEqual({ code: "only_this_job", reason: "TEST Mill is the only machine, and this job is already on it.", next: "link" });
    // An admin cannot add the machine the job is already on either.
    expect(pickerEmptyReason([mill], inUse, "admin", "J1", false, { running: true, canAdd: true })?.code).toBe("only_this_job");
    expect(pickerEmptyReason([mill, lathe], new Map([live(mill, "J1"), live(lathe, "J1")]), "office", "J1", false, running)?.reason).toBe("This job is already on every machine.");
  });

  it("every other machine is in use by another job: office and workshop, never admin", () => {
    const inUse = new Map([live(mill, "J1"), live(lathe, "J2")]);
    expect(pickerEmptyReason([mill, lathe], inUse, "office", "J1", false, running)).toEqual({ code: "all_busy", reason: "Every other machine is in use by another job.", next: null });
    expect(pickerEmptyReason([mill, lathe], inUse, "workshop", "J1", false, running)?.code).toBe("all_busy");
    expect(pickerEmptyReason([mill, lathe], inUse, "admin", "J1", false, running)).toBeNull();
  });

  it("the link is for admin and office with the page open; workshop is told to ask; otherwise the reason only", () => {
    const inUse = new Map([live(mill, "J1")]);
    expect(pickerEmptyReason([mill], inUse, "admin", "J1", false, { running: true, canAdd: true })?.next).toBe("link");
    expect(pickerEmptyReason([mill], inUse, "office", "J1", false, { running: true, canAdd: true })?.next).toBe("link");
    expect(pickerEmptyReason([mill], inUse, "workshop", "J1", false, { running: true, canAdd: false })?.next).toBe("ask");
    // Schedule section off for an admin or office: the reason only.
    expect(pickerEmptyReason([mill], inUse, "office", "J1", false, { running: true, canAdd: false })?.next).toBeNull();
    expect(pickerEmptyReason([mill], inUse, "admin", "J1", false, { running: true, canAdd: false })?.next).toBeNull();
  });

  it("start mode: the bench is always a choice, so a busy or occupied list is not an empty picker", () => {
    expect(pickerEmptyReason([mill], new Map([live(mill, "J2")]), "office", "J1", false)).toBeNull();
  });
});
