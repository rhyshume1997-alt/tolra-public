/**
 * The workshop's Whole floor (lib/whole-floor): every machine shaped from the existing reads, a word for every state, and a read
 * that failed shown as dashes, never as 0 or an idle floor.
 */
import { describe, expect, it } from "vitest";

import { COLOUR_CLASSES, STATUS_MAP } from "@/lib/status-colours";
import { FLOOR_FAILED, FLOOR_WORDS, countText, dueText, elapsedText, floorDotClass, floorJobIds, sinceText, wholeFloor, type FloorReads } from "@/lib/whole-floor";

const TODAY = "2026-10-30";
const NOW = new Date("2026-10-30T14:30:00Z"); // 14:30 in London (GMT from 25 Oct)

const machines = [
  { id: "m-mill", name: "Mill", active: true },
  { id: "m-lathe", name: "Lathe", active: true },
  { id: "m-haas", name: "Haas VF-2", active: true },
  { id: "m-old", name: "Old drill", active: false },
];
const inUse = [{ run_id: "r1", machine_id: "m-mill", machine_name: "Mill", job_id: "j1", job_no: "J-2409", booking_id: null, operator_id: "u1", operator_name: "Lee Barker", started_at: "2026-10-30T08:05:00Z", stale: false }];
const paused = [{ machine_id: "m-lathe", paused_run_id: "r2", job_id: "j2", job_no: "J-2421", operator_name: "Charlie Hughes", paused_by_name: null, paused_at: "2026-10-30T12:05:00Z" }];
const bench = [
  { job_id: "j3", run_id: "b1", is_open: true, started_at: "2026-10-30T09:10:00Z", ended_at: null, end_reason: null, operator_id: "u3", operator_name: "Ian Price", on_machine: false, state: "on_bench" },
  { job_id: "j4", run_id: "b2", is_open: false, started_at: "2026-10-29T09:10:00Z", ended_at: "2026-10-29T10:00:00Z", end_reason: "paused", operator_id: "u3", operator_name: "Ian Price", on_machine: false, state: "paused" },
];
const jobs = [
  { id: "j1", job_no: "J-2409", customer: "Severn Valve Co", description: "Valve body", date_required: "2026-10-26", due_date: null, finished_at: null },
  { id: "j2", job_no: "J-2421", customer: "Precision Engineering Group", description: "Drive shaft", date_required: "2026-11-05", due_date: null, finished_at: null },
  { id: "j3", job_no: "J-2415", customer: "Midland Fluid Power", description: "End cap", date_required: null, due_date: null, finished_at: null },
];
const bookings = [
  { id: "b-1", job_id: "j1", job_no: "J-2409", machine_id: "m-mill", start_at: "2026-10-31T08:00:00Z", status: "booked" },
  { id: "b-2", job_id: "j9", job_no: "J-2427", machine_id: "m-mill", start_at: "2026-11-02T08:00:00Z", status: "booked" },
  { id: "b-3", job_id: "j8", job_no: "J-2431", machine_id: "m-haas", start_at: "2026-11-03T08:00:00Z", status: "booked" },
];
const reads = (over: Partial<FloorReads> = {}): FloorReads => ({ machines, inUse, paused, bench, jobs, bookings, ...over });

describe("whole floor: shaping", () => {
  it("one row per machine by name (retired and idle left out), then the bench", () => {
    const floor = wholeFloor(reads(), TODAY, NOW);
    expect(floor.failed).toBe(false);
    expect(floor.rows.map((r) => [r.place, r.state])).toEqual([["Haas VF-2", "idle"], ["Lathe", "paused"], ["Mill", "running"], ["Bench", "running"]]);
    expect(floor.counts).toEqual({ running: 2, paused: 1, idle: 1, late: 1 });
  });

  it("a running machine carries its job, who, since when, and the next booking that isn't the job on it", () => {
    const mill = wholeFloor(reads(), TODAY, NOW).rows.find((r) => r.place === "Mill")!;
    expect(mill.job).toEqual({ id: "j1", jobNo: "J-2409", customer: "Severn Valve Co", description: "Valve body", due: "2026-10-26", late: true });
    expect(mill.operator).toBe("Lee Barker");
    expect(mill.next).toBe("J-2427");
    expect(sinceText(mill, NOW)).toBe("Since 08:05");
    expect(elapsedText(mill, NOW)).toBe("6h 25m");
    expect(dueText(mill.job!, false)).toBe("Due Mon 26 Oct");
  });

  it("a paused machine says when it was paused; an idle one has nothing on it and its next booking", () => {
    const floor = wholeFloor(reads(), TODAY, NOW);
    const lathe = floor.rows.find((r) => r.place === "Lathe")!;
    expect(sinceText(lathe, NOW)).toBe("Paused at 12:05");
    expect(elapsedText(lathe, NOW)).toBe("");
    expect(lathe.job?.late).toBe(false);
    expect(lathe.next).toBeNull();
    const haas = floor.rows.find((r) => r.place === "Haas VF-2")!;
    expect(haas.job).toBeNull();
    expect(haas.next).toBe("J-2431");
  });

  it("an open run wins over an older pause on the same machine, and a run 12 h+ old is flagged", () => {
    const old = [{ ...inUse[0], started_at: "2026-10-29T20:00:00Z" }];
    const floor = wholeFloor(reads({ inUse: old, paused: [{ ...paused[0], machine_id: "m-mill" }] }), TODAY, NOW);
    const mill = floor.rows.find((r) => r.place === "Mill")!;
    expect(mill.state).toBe("running");
    expect(mill.stale).toBe(true);
    expect(sinceText(mill, NOW)).toBe("Since 29/10 20:00");
  });

  it("asks for the jobs on machines, paused on one, or on the bench now (not a bench pause)", () => {
    expect(floorJobIds(inUse, paused, bench).sort()).toEqual(["j1", "j2", "j3"]);
    expect(floorJobIds(null, null, null)).toEqual([]);
  });
});

describe("whole floor: every state has a word", () => {
  it("running, paused, idle and late each have a word and a dot from the one status map", () => {
    for (const word of ["running", "paused", "idle", "late"] as const) {
      expect(FLOOR_WORDS[word].label.trim().length).toBeGreaterThan(0);
      expect(floorDotClass(word)).toBe(COLOUR_CLASSES[STATUS_MAP[FLOOR_WORDS[word].status].colour].dot);
    }
    expect(FLOOR_WORDS.running.label).toBe("Running");
    expect(FLOOR_WORDS.paused.label).toBe("Paused");
    expect(FLOOR_WORDS.idle.label).toBe("Idle");
    expect(FLOOR_WORDS.late.label).toBe("Late");
    // Running blue, paused as on the schedule (yellow), idle grey, late red.
    expect(["running", "paused", "idle", "late"].map((w) => STATUS_MAP[FLOOR_WORDS[w as "running"].status].colour)).toEqual(["blue", "yellow", "grey", "red"]);
  });

  it("every row it shapes is in one of the worded states", () => {
    for (const row of wholeFloor(reads(), TODAY, NOW).rows) expect(FLOOR_WORDS[row.state]).toBeDefined();
  });
});

describe("whole floor: fails closed", () => {
  it.each(["machines", "inUse", "paused"] as const)("%s failed: the whole floor failed, every count a dash, no row says idle", (key) => {
    const floor = wholeFloor(reads({ [key]: null }), TODAY, NOW);
    expect(floor).toEqual(FLOOR_FAILED);
    expect(floor.rows).toEqual([]);
    expect(Object.values(floor.counts).map(countText)).toEqual(["—", "—", "—", "—"]);
  });

  it("the jobs read failed: details and late are unknown (dash), not on time and not 0", () => {
    const floor = wholeFloor(reads({ jobs: null }), TODAY, NOW);
    expect(floor.detailsFailed).toBe(true);
    expect(floor.counts.late).toBeNull();
    expect(countText(floor.counts.late)).toBe("—");
    const mill = floor.rows.find((r) => r.place === "Mill")!;
    expect(mill.job).toMatchObject({ jobNo: "J-2409", customer: null, late: null });
    expect(dueText(mill.job!, true)).toBe("Due —");
    // The live state still comes from the runs.
    expect(floor.counts.running).toBe(2);
  });

  it("the bookings read failed: Next is unknown (undefined, shown as a dash), not 'nothing booked'", () => {
    const floor = wholeFloor(reads({ bookings: null }), TODAY, NOW);
    expect(floor.nextFailed).toBe(true);
    expect(floor.rows.filter((r) => !r.bench).every((r) => r.next === undefined)).toBe(true);
  });

  it("the bench read failed: said so, machines still shown", () => {
    const floor = wholeFloor(reads({ bench: null }), TODAY, NOW);
    expect(floor.benchFailed).toBe(true);
    expect(floor.rows.some((r) => r.bench)).toBe(false);
    expect(floor.rows.map((r) => r.place)).toEqual(["Haas VF-2", "Lathe", "Mill"]);
  });

  it("an empty floor that was read is 0, not a dash", () => {
    const floor = wholeFloor(reads({ machines: [], inUse: [], paused: [], bench: [], jobs: [], bookings: [] }), TODAY, NOW);
    expect(floor.failed).toBe(false);
    expect(floor.counts).toEqual({ running: 0, paused: 0, idle: 0, late: 0 });
  });
});
