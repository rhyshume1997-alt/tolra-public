/**
 * The Job Board's machines (lib/job-machine-plan): the plan joined with the job's own bookings, the Machines dialog's save plan, the
 * worksheet prefill, and the guarantee that opening the dialog (and Cancel) only reads.
 *
 * The case from the live sweep (N4/N5): J-0006 converted from a sales order carries "TEST Mill 0 h" (job_machines, no booking linked),
 * and was booked on the Machine Schedule for 6.5 h (machine_bookings, job_id set, not linked to the plan row).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const calls: string[] = [];
  let tables: Record<string, Record<string, unknown>[]> = {};
  let failing = new Set<string>();
  /** A query builder that records every method called and answers reads from `tables` (range honoured, so paging ends). */
  const builder = (table: string) => {
    let slice: [number, number] | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proxy: any = new Proxy({}, {
      get(_target, prop) {
        if (prop === "then") {
          const rows = tables[table] ?? [];
          const data = slice ? rows.slice(slice[0], slice[1] + 1) : rows;
          const answer = failing.has(table) ? { data: null, error: { message: `${table} unavailable` } } : { data, error: null };
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(answer).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          calls.push(`${table}.${String(prop)}`);
          if (prop === "range") slice = [Number(args[0]), Number(args[1])];
          return proxy;
        };
      },
    });
    return proxy;
  };
  const client = {
    from: (table: string) => { calls.push(`from:${table}`); return builder(table); },
    rpc: (fn: string) => { calls.push(`rpc:${fn}`); return Promise.resolve({ data: null, error: null }); },
  };
  return { calls, client, setTables: (next: Record<string, Record<string, unknown>[]>) => { tables = next; }, setFailing: (next: string[]) => { failing = new Set(next); } };
});
vi.mock("@/lib/supabase", () => ({ supabase: fake.client }));

import {
  type JobBooking, jobMachineEntries, keepsBooking, loadJobMachinesForDialog, machinesSaveReady, loadWorksheetPrefillSource, machineRunHours, planMachinesSave, prefillWorksheet,
} from "@/lib/job-machine-plan";
import { emptyWorksheet } from "@/lib/job-worksheet";
import { stageAfterStart, stagesBeforeStart } from "@/lib/job-actions";

const JOB = "job-0006";
const MILL = "mill";
const LATHE = "lathe";
const booking = (over: Partial<JobBooking> = {}): JobBooking => ({ id: "b1", machineId: MILL, jobId: JOB, estimatedHours: 6.5, status: "booked", startAt: "2026-10-15T07:00:00.000Z", ...over });
const WRITES = /\.(insert|update|upsert|delete)$|^rpc:/;

describe("jobMachineEntries: the plan joined with the job's bookings", () => {
  it("adopts the job's unlinked schedule booking on the planned machine: 6.5 h booked, not 0 h (N5)", () => {
    const entries = jobMachineEntries(JOB, [{ machine_id: MILL, estimated_hours: 0, booking_id: null, position: 0 }], [booking()]);
    expect(entries).toEqual([{ machineId: MILL, hours: 6.5, booking: booking(), linked: false, planned: true }]);
  });

  it("keeps a linked booking with the plan's hours, and ignores other jobs' bookings", () => {
    const linked = booking({ id: "b2", estimatedHours: 4 });
    const other = booking({ id: "b9", jobId: "another-job", machineId: LATHE });
    const entries = jobMachineEntries(JOB, [{ machine_id: MILL, estimated_hours: 4, booking_id: "b2", position: 0 }], [linked, other]);
    expect(entries).toEqual([{ machineId: MILL, hours: 4, booking: linked, linked: true, planned: true }]);
  });

  it("lists a booking on a machine the plan doesn't have, after the plan", () => {
    const lathe = booking({ id: "b3", machineId: LATHE, estimatedHours: 2 });
    const entries = jobMachineEntries(JOB, [{ machine_id: MILL, estimated_hours: 1, booking_id: null, position: 0 }], [lathe]);
    expect(entries.map((e) => [e.machineId, e.hours, e.booking?.id ?? null, e.planned])).toEqual([[MILL, 1, null, true], [LATHE, 2, "b3", false]]);
  });

  it("prefers an active booking over a complete one, and never adopts a booking twice", () => {
    const done = booking({ id: "old", status: "complete", startAt: "2026-10-01T07:00:00.000Z" });
    const active = booking({ id: "new", status: "booked", startAt: "2026-10-20T07:00:00.000Z" });
    const entries = jobMachineEntries(JOB, [{ machine_id: MILL, estimated_hours: 0, booking_id: null, position: 0 }], [done, active]);
    expect(entries).toHaveLength(1);
    expect(entries[0].booking?.id).toBe("new");
  });
});

describe("planMachinesSave: what Save does (never on open or Cancel)", () => {
  const loaded = jobMachineEntries(JOB, [{ machine_id: MILL, estimated_hours: 0, booking_id: null, position: 0 }], [booking()]);
  const asLoaded = () => loaded.map((e) => ({ machineId: e.machineId, hours: e.hours, book: Boolean(e.booking), start: e.booking?.startAt ?? null, startChanged: false, booking: e.booking, linked: e.linked }));

  it("an unchanged dialog has nothing to save: no request at all (N4)", () => {
    const plan = planMachinesSave(loaded, asLoaded());
    expect(plan.changed).toBe(false);
    expect(plan.bookingUpdates).toEqual([]);
    expect(plan.removeBookings).toEqual([]);
  });

  it("an adopted booking is never booked a second time: its row goes to set_job_machines without a start (N5)", () => {
    const rows = asLoaded().map((r) => ({ ...r, hours: 7 }));
    const plan = planMachinesSave(loaded, rows);
    expect(plan.changed).toBe(true);
    expect(plan.payload).toEqual([{ machine_id: MILL, hours: 7 }]);
    expect(plan.bookingUpdates).toEqual([{ booking: booking(), machineId: MILL, hours: 7, startAt: booking().startAt }]);
  });

  it("moves an adopted booking only when its start was changed", () => {
    const rows = asLoaded().map((r) => ({ ...r, start: "2026-10-16T07:00:00.000Z", startChanged: true }));
    const plan = planMachinesSave(loaded, rows);
    expect(plan.payload).toEqual([{ machine_id: MILL, hours: 6.5 }]);
    expect(plan.bookingUpdates).toEqual([{ booking: booking(), machineId: MILL, hours: 6.5, startAt: "2026-10-16T07:00:00.000Z" }]);
  });

  it("a running booking is left alone (only the plan's hours change)", () => {
    const running = jobMachineEntries(JOB, [{ machine_id: MILL, estimated_hours: 0, booking_id: null, position: 0 }], [booking({ status: "running" })]);
    const plan = planMachinesSave(running, running.map((e) => ({ machineId: e.machineId, hours: 8, book: true, start: "2026-10-18T07:00:00.000Z", startChanged: true, booking: e.booking, linked: false })));
    expect(plan.bookingUpdates).toEqual([]);
    expect(plan.payload).toEqual([{ machine_id: MILL, hours: 8 }]);
  });

  it("removing the machine removes its adopted booking, as set_job_machines does for a linked one", () => {
    const plan = planMachinesSave(loaded, []);
    expect(plan.changed).toBe(true);
    expect(plan.payload).toEqual([]);
    expect(plan.removeBookings.map((b) => b.id)).toEqual(["b1"]);
  });

  it("a linked booking sends a start only when it was moved; a new row with Book ticked books", () => {
    const linked = jobMachineEntries(JOB, [{ machine_id: MILL, estimated_hours: 6.5, booking_id: "b1", position: 0 }], [booking()]);
    const base = linked.map((e) => ({ machineId: e.machineId, hours: e.hours, book: true, start: e.booking!.startAt, startChanged: false, booking: e.booking, linked: true }));
    expect(planMachinesSave(linked, base)).toMatchObject({ changed: false, payload: [{ machine_id: MILL, hours: 6.5 }] });
    const moved = planMachinesSave(linked, base.map((r) => ({ ...r, start: "2026-10-16T07:00:00.000Z", startChanged: true })));
    expect(moved.payload).toEqual([{ machine_id: MILL, hours: 6.5, start_at: "2026-10-16T07:00:00.000Z" }]);
    const added = planMachinesSave(linked, [...base, { machineId: LATHE, hours: 2, book: true, start: "2026-10-17T07:00:00.000Z", startChanged: false, booking: null, linked: false }]);
    expect(added.payload[1]).toEqual({ machine_id: LATHE, hours: 2, start_at: "2026-10-17T07:00:00.000Z" });
  });

  it("keepsBooking: a row moved to another machine no longer carries its booking", () => {
    expect(keepsBooking({ machineId: MILL, booking: booking() })).toBe(true);
    expect(keepsBooking({ machineId: LATHE, booking: booking() })).toBe(false);
  });
});

describe("opening the Machines dialog only reads (N4)", () => {
  beforeEach(() => {
    fake.calls.length = 0;
    fake.setFailing([]);
    fake.setTables({
      machines: [{ id: MILL, name: "TEST Mill", hours_per_day: 8, working_days: [1, 2, 3, 4, 5], active: true }],
      machine_bookings: [{ id: "b1", machine_id: MILL, job_id: JOB, job_no: "J-0006", start_at: "2026-10-15T07:00:00.000Z", estimated_hours: 6.5, hours_done: 0, status: "booked" }],
      jobs: [{ id: JOB, job_no: "J-0006" }],
      job_machines: [{ machine_id: MILL, estimated_hours: 0, booking_id: null, position: 0 }],
      machine_runs: [],
    });
  });

  it("loads the job's machines with the booking and makes no write request", async () => {
    const { entries } = await loadJobMachinesForDialog(JOB);
    expect(entries.map((e) => [e.machineId, e.hours, e.booking?.id, e.linked])).toEqual([[MILL, 6.5, "b1", false]]);
    expect(fake.calls.filter((call) => WRITES.test(call))).toEqual([]);
    expect(fake.calls.filter((call) => call.startsWith("from:"))).toEqual(expect.arrayContaining(["from:machines", "from:machine_bookings", "from:job_machines"]));
  });

  it("a failed read rejects (the dialog shows the error with Retry) and writes nothing", async () => {
    fake.setFailing(["job_machines"]);
    await expect(loadJobMachinesForDialog(JOB)).rejects.toMatchObject({ message: "job_machines unavailable" });
    fake.setFailing(["machine_bookings"]);
    await expect(loadJobMachinesForDialog(JOB)).rejects.toBeTruthy();
    expect(fake.calls.filter((call) => WRITES.test(call))).toEqual([]);
  });

  it("the worksheet's prefill source reads only, too", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const source = await loadWorksheetPrefillSource(fake.client as any, JOB);
    expect(source).toEqual({ machineNames: ["TEST Mill"], plannedHours: 6.5, runHours: 0 });
    expect(fake.calls.filter((call) => WRITES.test(call))).toEqual([]);
  });
});

describe("machinesSaveReady: Save waits for a successful load (audit blocker)", () => {
  it("is false before the load, while loading, after a failure, and for another job's load", () => {
    expect(machinesSaveReady({ jobId: JOB, loadedFor: null, loading: false, loadError: null })).toBe(false); // first render, load not started
    expect(machinesSaveReady({ jobId: JOB, loadedFor: null, loading: true, loadError: null })).toBe(false);
    expect(machinesSaveReady({ jobId: JOB, loadedFor: null, loading: false, loadError: "Couldn't load the job's machines." })).toBe(false);
    expect(machinesSaveReady({ jobId: JOB, loadedFor: JOB, loading: false, loadError: "Retry failed" })).toBe(false);
    expect(machinesSaveReady({ jobId: JOB, loadedFor: "another-job", loading: false, loadError: null })).toBe(false);
    expect(machinesSaveReady({ jobId: JOB, loadedFor: JOB, loading: true, loadError: null })).toBe(false); // Retry running
    expect(machinesSaveReady({ jobId: null, loadedFor: null, loading: false, loadError: null })).toBe(false);
  });

  it("is true only once this job loaded successfully", () => {
    expect(machinesSaveReady({ jobId: JOB, loadedFor: JOB, loading: false, loadError: null })).toBe(true);
  });
});

describe("worksheet prefill (N7): only empty fields, never a saved value", () => {
  const source = { machineNames: ["TEST Mill", "Lathe"], plannedHours: 6.5, runHours: 1.25 };

  it("fills Machine #1, Job Time Quoted and Run Time on an empty worksheet", () => {
    const { worksheet, filled } = prefillWorksheet(emptyWorksheet({ job_no: "J-0006" }), source);
    expect([worksheet.machine_1, worksheet.machine_2, worksheet.machine_3]).toEqual(["TEST Mill", "Lathe", ""]);
    expect(worksheet.job_time_quoted_hr).toBe("6.5");
    expect(worksheet.run_time_hr).toBe("1.25");
    expect(filled).toEqual(["machine_1", "machine_2", "job_time_quoted_hr", "run_time_hr"]);
  });

  it("keeps every saved value and doesn't repeat a machine already written", () => {
    const saved = { ...emptyWorksheet(), machine_1: "test mill", job_time_quoted_hr: "5", run_time_hr: "0" };
    const { worksheet, filled } = prefillWorksheet(saved, source);
    expect([worksheet.machine_1, worksheet.machine_2]).toEqual(["test mill", "Lathe"]);
    expect(worksheet.job_time_quoted_hr).toBe("5");
    expect(worksheet.run_time_hr).toBe("0");
    expect(filled).toEqual(["machine_2"]);
  });

  it("fills nothing from zero hours", () => {
    expect(prefillWorksheet(emptyWorksheet(), { machineNames: [], plannedHours: 0, runHours: 0 }).filled).toEqual([]);
  });

  it("machine-run hours: closed runs, an open run to now, bench runs left out", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    expect(machineRunHours([
      { machine_id: MILL, started_at: "2026-10-15T07:00:00.000Z", ended_at: "2026-10-15T08:30:00.000Z" },
      { machine_id: LATHE, started_at: "2026-10-15T11:00:00.000Z", ended_at: null },
      { machine_id: null, started_at: "2026-10-15T06:00:00.000Z", ended_at: "2026-10-15T12:00:00.000Z" },
    ], now)).toBe(2.5);
  });
});

describe("Start moves the job's stage (N6)", () => {
  it("Material or Setup moves to Machining by default; Setup when chosen", () => {
    expect(stageAfterStart("material")).toBe("machining");
    expect(stageAfterStart("setup")).toBe("machining");
    expect(stageAfterStart(null)).toBe("machining");
    expect(stageAfterStart("material", "setup")).toBe("setup");
  });

  it("never moves a job back, or out of inspection or rework", () => {
    expect(stageAfterStart("setup", "setup")).toBeNull();
    expect(stageAfterStart("machining")).toBeNull();
    expect(stageAfterStart("inspection")).toBeNull();
    expect(stageAfterStart("rework")).toBeNull();
    expect(stageAfterStart("complete")).toBeNull();
    expect(stagesBeforeStart("machining")).toEqual(["material", "setup"]);
  });
});
