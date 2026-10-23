/**
 * The Machine Schedule's live use (lib/schedule-live): the status card while a run is open (never "Free now"), the actual bars drawn from
 * machine_runs (open: to now; ended; out of hours clamped and marked; bench runs skipped), their label, and the "Running now (not
 * booked)" rows. Times are built in local time, as the schedule draws them.
 */
import { describe, expect, it } from "vitest";

import type { InUseRow } from "@/lib/machine-runs";
import type { Machine, MachineStatus, ScheduledBooking } from "@/lib/machine-schedule";
import { runBarLabel, runBarsFor, runKind, runRows, uncoveredParts, runWindowFilter, runningForText, sinceText, statusCardText, unbookedFinishText, unbookedLeftText, unbookedRunning, type RunRow } from "@/lib/schedule-live";
import { unbookedRunView } from "@/lib/run-plan";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m); // October 2026, local time; 12 Oct is a Monday
const mill: Machine = { id: "m1", name: "Mill", type: "", hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5], active: true };
const live = (over: Partial<InUseRow> = {}): InUseRow => ({
  run_id: "r1", machine_id: "m1", machine_name: "Mill", job_id: "j1", job_no: "J-1", booking_id: null, operator_id: "u1", operator_name: "Dave", started_at: at(14, 9, 12).toISOString(), stale: false, ...over,
});
const free: MachineStatus = { machine: mill, busy: false, current: null, nextFree: at(14, 8), next: null, nextStart: null };
const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: "r1", machine_id: "m1", job_id: "j1", job_no: "J-1", booking_id: null, operator_id: "u1", started_at: at(14, 10).toISOString(), ended_at: null, end_reason: null, ...over,
});

describe("status card while a run is open", () => {
  it("says who and since when, never Free now, and the next free is when it is paused or finished", () => {
    const text = statusCardText(free, live(), at(14, 11));
    expect(text).toEqual({ inUse: true, pill: "In use by Dave since 09:12", staleNote: null, body: "Job J-1 running", nextFree: "When paused or finished" });
    expect(JSON.stringify(text)).not.toMatch(/Free now|Nothing booked|Now"/);
  });

  it("the live audit case: no booking, no operator name (TEST Mill, J-0006, since 15:52) is red In use, never Free now or Next free: Now", () => {
    const text = statusCardText(free, live({ machine_name: "TEST Mill", job_no: "J-0006", operator_name: null, started_at: at(15, 15, 52).toISOString() }), at(15, 16, 5));
    expect(text).toEqual({ inUse: true, pill: "In use by — since 15:52", staleNote: null, body: "Job J-0006 running", nextFree: "When paused or finished" });
  });

  it("uses — for a missing or e-mail name, the day for an older start, flags 12 h+ and keeps the booked hours left", () => {
    expect(statusCardText(free, live({ operator_name: null }), at(14, 11)).pill).toBe("In use by — since 09:12");
    expect(statusCardText(free, live({ operator_name: "dave@example.test" }), at(14, 11)).pill).toBe("In use by — since 09:12");
    expect(statusCardText(free, live(), at(15, 8)).pill).toBe("In use by Dave since Wed 09:12");
    expect(statusCardText(free, live(), at(14, 21, 12)).staleNote).toBe("No Finish or Pause for 12 h+");
    const current = { jobNo: "J-1", hoursLeft: 3, finish: at(14, 16) } as ScheduledBooking;
    expect(statusCardText({ ...free, busy: true, current }, live(), at(14, 11)).body).toBe("Job J-1 running, 3h booked left");
  });

  it("falls back to the bookings when no run is open", () => {
    expect(statusCardText(free, undefined, at(14, 11))).toMatchObject({ inUse: false, pill: "Free now", body: "No job running", nextFree: "Now" });
    const current = { jobNo: "J-2", hoursLeft: 2, finish: at(14, 16) } as ScheduledBooking;
    expect(statusCardText({ ...free, busy: true, current, nextFree: at(14, 16) }, undefined, at(14, 11))).toMatchObject({ pill: "Busy until Wed 16:00", body: "Job J-2, 2h left", nextFree: "Wed 16:00" });
  });
});

describe("machine runs as the page reads them", () => {
  it("keeps machine runs, skips bench runs (no machine, 046) and malformed rows, and reads the job number", () => {
    const rows = runRows([
      { id: "a", machine_id: "m1", job_id: "j1", booking_id: null, operator_id: "u1", started_at: "2026-10-14T09:00:00Z", ended_at: null, jobs: { job_no: "J-1" } },
      { id: "b", machine_id: null, job_id: "j2", started_at: "2026-10-14T09:00:00Z", ended_at: null, jobs: { job_no: "J-2" } },
      { id: "c", machine_id: "m2", job_id: "j3", booking_id: "b3", operator_id: null, started_at: "2026-10-14T08:00:00Z", ended_at: "2026-10-14T09:00:00Z", jobs: [{ job_no: "J-3" }] },
      { id: "d", machine_id: "m1", job_id: "j4", started_at: "not a date" }, null, "x", { id: 5 },
    ]);
    expect(rows.map((r) => [r.id, r.job_no, r.booking_id, r.ended_at])).toEqual([["a", "J-1", null, null], ["c", "J-3", "b3", "2026-10-14T09:00:00Z"]]);
    expect(runRows(null)).toEqual([]);
  });

  it("asks for the runs that overlap the window, open ones included", () => {
    const f = runWindowFilter(new Date("2026-10-12T00:00:00Z"), new Date("2026-10-26T00:00:00Z"));
    expect(f).toEqual({ before: "2026-10-26T00:00:00.000Z", or: 'ended_at.is.null,ended_at.gt."2026-10-12T00:00:00.000Z"' });
  });
});

describe("actual bars", () => {
  it("draws an open run from its start to now, red (open), inside the working window", () => {
    const [bar, ...rest] = runBarsFor([run()], mill, at(14, 0), at(14, 12));
    expect(rest).toEqual([]);
    expect(bar).toMatchObject({ open: true, outOfHours: false, left: 25, width: 25 }); // 10:00-12:00 on 08:00-16:00
  });

  it("draws an ended run to its end, only on its machine and day, and a run over midnight on both days", () => {
    const ended = run({ ended_at: at(14, 14).toISOString() });
    expect(runBarsFor([ended], mill, at(14, 0), at(15, 9))[0]).toMatchObject({ open: false, left: 25, width: 50 });
    expect(runBarsFor([ended], { ...mill, id: "m2" }, at(14, 0), at(15, 9))).toEqual([]);
    expect(runBarsFor([ended], mill, at(15, 0), at(15, 9))).toEqual([]);
    const overnight = run({ started_at: at(14, 15).toISOString(), ended_at: at(15, 10).toISOString() });
    expect(runBarsFor([overnight], mill, at(14, 0), at(16, 9))[0]).toMatchObject({ outOfHours: true, left: 87.5, width: 12.5 });
    expect(runBarsFor([overnight], mill, at(15, 0), at(16, 9))[0]).toMatchObject({ outOfHours: true, left: 0, width: 25 });
  });

  it("clamps a run wholly outside the hours to the nearest edge, marked, with a hittable width; draws weekend runs too", () => {
    const evening = run({ started_at: at(14, 19).toISOString(), ended_at: at(14, 20).toISOString() });
    expect(runBarsFor([evening], mill, at(14, 0), at(15, 9))[0]).toMatchObject({ outOfHours: true, left: 88, width: 12 });
    const early = run({ started_at: at(14, 6).toISOString(), ended_at: at(14, 7).toISOString() });
    expect(runBarsFor([early], mill, at(14, 0), at(15, 9))[0]).toMatchObject({ outOfHours: true, left: 0, width: 12 });
    const saturday = run({ started_at: at(17, 9).toISOString(), ended_at: at(17, 10).toISOString() });
    expect(runBarsFor([saturday], mill, at(17, 0), at(18, 9))).toHaveLength(1);
  });

  it("is a full-height block per kind: running (open), paused or finished, covering the hours it ran hour by hour", () => {
    const now = at(14, 12);
    const [running] = runBarsFor([run()], mill, at(14, 0), now);
    expect(running).toMatchObject({ kind: "running", left: 25, width: 25 }); // 10:00-12:00 of 08:00-16:00
    expect(running.marks).toEqual([50]); // the 11:00 boundary, half way through the block
    const [paused] = runBarsFor([run({ started_at: at(14, 9).toISOString(), ended_at: at(14, 12).toISOString(), end_reason: "paused" })], mill, at(14, 0), now);
    expect(paused).toMatchObject({ kind: "paused", left: 12.5, width: 37.5, from: at(14, 9), to: at(14, 12) });
    expect(paused.marks.map((m) => Math.round(m * 10) / 10)).toEqual([33.3, 66.7]);
    const [finished] = runBarsFor([run({ ended_at: at(14, 14).toISOString(), end_reason: "finished" })], mill, at(14, 0), now);
    expect(finished).toMatchObject({ kind: "finished", left: 25, width: 50 });
    expect(runKind({ ended_at: "x", end_reason: "override" })).toBe("finished");
  });

  it("keeps the booked remainder: the booking is blue only for the hours without actual use", () => {
    const [use] = runBarsFor([run({ started_at: at(14, 10).toISOString(), ended_at: at(14, 12).toISOString(), end_reason: "paused" })], mill, at(14, 0), at(14, 13));
    // Booked 09:00-15:00 = left 12.5, width 75; use covers 25..50.
    expect(uncoveredParts(12.5, 75, [use])).toEqual([{ left: 12.5, width: 12.5 }, { left: 50, width: 37.5 }]);
    expect(uncoveredParts(25, 25, [use])).toEqual([]); // wholly used: only the use block shows
    expect(uncoveredParts(60, 20, [use])).toEqual([{ left: 60, width: 20 }]); // no overlap: unchanged
    expect(uncoveredParts(12.5, 75, [])).toEqual([{ left: 12.5, width: 75 }]);
  });

  it("takes only the run's real time off a booking: a 5-minute run is drawn at the minimum width but hides 5 minutes, not an hour", () => {
    const short = run({ started_at: at(14, 10).toISOString(), ended_at: at(14, 10, 5).toISOString(), end_reason: "paused" });
    const [bar] = runBarsFor([short], mill, at(14, 0), at(14, 13));
    expect(bar.width).toBe(12); // drawn at the minimum so it can be hit
    expect(bar.usedLeft).toBe(25);
    expect(bar.usedWidth).toBeCloseTo((5 / 480) * 100, 5); // 08:00-16:00 is 480 minutes
    const covers = [{ left: bar.usedLeft, width: bar.usedWidth }];
    // Booked 09:00-15:00 (left 12.5, width 75): loses 5 minutes (about 1.04%), not 12%.
    const parts = uncoveredParts(12.5, 75, covers);
    expect(parts).toHaveLength(2);
    expect(parts[0].width + parts[1].width).toBeCloseTo(75 - (5 / 480) * 100, 5);
    // A booking that is only the run's real span is covered; one wider than it is not.
    expect(uncoveredParts(25, (5 / 480) * 100, covers)).toEqual([]);
    expect(uncoveredParts(25, 12, covers)).toHaveLength(1);
  });

  it("labels a bar with job, machine, operator name (— when unknown) and times", () => {
    const now = at(14, 12);
    const [bar] = runBarsFor([run()], mill, at(14, 0), now);
    expect(runBarLabel(bar, "Mill", { u1: "Dave" }, now)).toBe("Actual: J-1 on Mill by Dave, 10:00 to now (running)");
    const [ended] = runBarsFor([run({ operator_id: "u9", ended_at: at(14, 11).toISOString() })], mill, at(14, 0), now);
    expect(runBarLabel(ended, "Mill", { u1: "Dave" }, now)).toBe("Actual: J-1 on Mill by —, 10:00 to 11:00 (ended)");
  });
});

describe("Running now (not booked)", () => {
  it("lists open runs with no booking, or with a booking the schedule doesn't hold, oldest first", () => {
    const rows = [live({ run_id: "a", started_at: at(14, 10).toISOString() }), live({ run_id: "b", booking_id: "bk1" }), live({ run_id: "c", booking_id: "gone", started_at: at(14, 8).toISOString() })];
    expect(unbookedRunning(rows, [{ id: "bk1" }]).map((r) => r.run_id)).toEqual(["c", "a"]);
  });

  it("prints since as HH:MM today and with the day otherwise", () => {
    expect(sinceText(at(14, 9, 5), at(14, 18))).toBe("09:05");
    expect(sinceText(at(13, 9, 5), at(14, 18))).toBe("Tue 09:05");
  });
});

describe("an unbooked run's plan figures (lib/run-plan)", () => {
  // Wed 14 Oct 09:12 start; "now" 10:37 = 1:25 into the run. The mill works Mon-Fri, 8 h from 08:00.
  const now = at(14, 10, 37);
  const view = (plan: { planHours: number; hoursDone: number } | null) => unbookedRunView(live().started_at, plan, mill, now);

  it("row words: running for, left against the plan, an Est. finish labelled (plan)", () => {
    const v = view({ planHours: 6.5, hoursDone: 0 });
    expect(runningForText(v.clock!.elapsedMinutes)).toBe("running for 1:25");
    expect(unbookedLeftText(v)).toBe("5:05 left (plan 6:30)");
    // 5:05 left from 10:37 fits in today's hours (to 16:00): 15:42.
    expect(unbookedFinishText(v)).toBe("about Wed 15:42 (plan)");
  });

  it("carries on the next working day when the day's hours run out", () => {
    expect(unbookedFinishText(view({ planHours: 10, hoursDone: 0 }))).toBe("about Thu 11:12 (plan)"); // 8:35 left: 5:23 more today (to 16:00), 3:12 on Thursday from 08:00
  });

  it("over the plan: the hours left read over, and there is no finish time", () => {
    const v = unbookedRunView(live().started_at, { planHours: 1, hoursDone: 0 }, mill, now);
    expect(unbookedLeftText(v)).toBe("0:25 over (plan 1:00)");
    expect(unbookedFinishText(v)).toBe("Past the plan");
  });

  it("no plan hours: No hours planned, and no finish time", () => {
    const v = view(null);
    expect(unbookedLeftText(v)).toBe("No hours planned");
    expect(unbookedFinishText(v)).toBe("-");
    expect(runningForText(v.clock!.elapsedMinutes)).toBe("running for 1:25");
  });

  it("the card: next free is the plan ETA, or sooner if paused; the body says running for; without a plan it is as before", () => {
    const withPlan = statusCardText(free, live(), now, view({ planHours: 6.5, hoursDone: 0 }));
    expect(withPlan.nextFree).toBe("About Wed 15:42 (plan), or sooner if paused");
    expect(withPlan.body).toBe("Job J-1 running, running for 1:25");
    expect(withPlan.pill).toBe("In use by Dave since 09:12");
    const noPlan = statusCardText(free, live(), now, view(null));
    expect(noPlan).toMatchObject({ body: "Job J-1 running, running for 1:25", nextFree: "When paused or finished" });
    const over = statusCardText(free, live(), now, unbookedRunView(live().started_at, { planHours: 1, hoursDone: 0 }, mill, now));
    expect(over.nextFree).toBe("When paused or finished");
    expect(statusCardText(free, live(), now).nextFree).toBe("When paused or finished");
    expect(statusCardText(free, live(), now).body).toBe("Job J-1 running");
  });
});
