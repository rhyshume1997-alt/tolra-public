/**
 * A job's machines as the Job Board, its Machines dialog and the worksheet show them: the plan (job_machines, migrations 042/043) joined
 * with the job's bookings on the schedule (machine_bookings) and its machine runs (machine_runs, 044).
 *
 * Why the join is needed: a booking made on the Machine Schedule for a job (save_machine_booking) is NOT linked to the job's plan row
 * (job_machines.booking_id stays empty; only set_job_machines and create_job link the bookings they make). A job converted from a sales
 * order carries its plan with 0 h when the order's lines had no hours, so a job booked on the schedule for 6.5 h showed "Mill 0 h" on the
 * board and an empty, unticked row in the dialog; saving that dialog with "Book on schedule" ticked would have made a SECOND booking.
 * Here a plan row with no linked booking takes the job's own unlinked booking on the same machine ("adopted"), and a booking of the job
 * on a machine the plan doesn't have yet is listed too, so the hours and the booking shown are the schedule's.
 *
 * Everything here is pure (no reads, no writes) except the two loaders at the end, which only read.
 */
import { fetchAll } from "@/lib/fetch-all";
import type { JobWorksheet } from "@/lib/job-worksheet";
import { type Booking, type BookingStatus, type Machine, fetchSchedule } from "@/lib/machine-schedule";
import { supabase } from "@/lib/supabase";

/** One plan row, as job_machines holds it. */
export type PlanLink = { machine_id: string; estimated_hours: number; booking_id: string | null; position: number };
/** One of the job's bookings on the schedule (the fields the plan needs). */
export type JobBooking = { id: string; machineId: string; jobId: string | null; estimatedHours: number; status: BookingStatus; startAt: string };
/** One machine on the job: its hours, its booking (linked by the plan, adopted, or none) and whether the plan has a row for it. */
export type JobMachineEntry<B extends JobBooking = JobBooking> = {
  machineId: string;
  hours: number;
  booking: B | null;
  /** The plan row names this booking (job_machines.booking_id). False for an adopted booking: set_job_machines doesn't know it. */
  linked: boolean;
  /** The plan (job_machines) has a row for this machine. False: only a booking on the schedule names the job on this machine. */
  planned: boolean;
};

const round2 = (value: number) => Math.round(value * 100) / 100;
const time = (iso: string) => new Date(iso).getTime();

/** Which of several unlinked bookings of the job on one machine to show: an active one (booked or running, earliest first), else the latest complete one. */
function pickBooking<B extends JobBooking>(candidates: B[]): B | null {
  const active = candidates.filter((b) => b.status !== "complete").sort((a, b) => time(a.startAt) - time(b.startAt) || a.id.localeCompare(b.id));
  if (active.length) return active[0];
  const done = candidates.filter((b) => b.status === "complete").sort((a, b) => time(b.startAt) - time(a.startAt) || a.id.localeCompare(b.id));
  return done[0] ?? null;
}

/**
 * The job's machines, in plan order, then any machine only the schedule names for the job. `bookings` may hold other jobs' bookings:
 * only those of `jobId` are used. A plan row's linked booking keeps the plan's hours (the database keeps the two equal: 042's
 * plan-follows-booking rule); an adopted booking gives its own hours (the schedule is the current plan, 042's lead decision).
 */
export function jobMachineEntries<B extends JobBooking>(jobId: string, links: PlanLink[], bookings: B[]): JobMachineEntry<B>[] {
  const mine = bookings.filter((b) => b.jobId === jobId);
  const byId = new Map(mine.map((b) => [b.id, b]));
  const linkedIds = new Set(links.map((l) => l.booking_id).filter((id): id is string => Boolean(id) && byId.has(id!)));
  const taken = new Set<string>(linkedIds);
  const unlinkedOn = (machineId: string) => mine.filter((b) => b.machineId === machineId && !taken.has(b.id));
  const entries: JobMachineEntry<B>[] = [];
  for (const link of [...links].sort((a, b) => a.position - b.position)) {
    const linked = link.booking_id ? byId.get(link.booking_id) : undefined;
    if (linked) {
      entries.push({ machineId: link.machine_id, hours: Number(link.estimated_hours) || 0, booking: linked, linked: true, planned: true });
      continue;
    }
    const adopted = pickBooking(unlinkedOn(link.machine_id));
    if (adopted) taken.add(adopted.id);
    entries.push({ machineId: link.machine_id, hours: adopted ? adopted.estimatedHours : Number(link.estimated_hours) || 0, booking: adopted, linked: false, planned: true });
  }
  const planned = new Set(entries.map((e) => e.machineId));
  const rest = mine.filter((b) => !taken.has(b.id) && !planned.has(b.machineId));
  const machinesInOrder = [...new Set([...rest].sort((a, b) => time(a.startAt) - time(b.startAt)).map((b) => b.machineId))];
  for (const machineId of machinesInOrder) {
    const booking = pickBooking(rest.filter((b) => b.machineId === machineId));
    if (booking) entries.push({ machineId, hours: booking.estimatedHours, booking, linked: false, planned: false });
  }
  return entries;
}

/**
 * Machine hours a job has run, from its machine runs (044): each run from its start to its end (an open run to `now`). Bench runs (046,
 * no machine) are not machine time and are left out. Two machines running at once both count: this is machine hours, not elapsed time.
 */
export function machineRunHours(runs: { machine_id: string | null; started_at: string; ended_at: string | null }[], now: Date = new Date()): number {
  let ms = 0;
  for (const run of runs) {
    if (!run.machine_id) continue;
    const start = time(run.started_at);
    const end = run.ended_at ? time(run.ended_at) : Math.max(now.getTime(), start);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) ms += end - start;
  }
  return round2(ms / 3_600_000);
}

/** What the worksheet can be prefilled from: the job's machines by name, their hours on the plan/schedule, and machine-run hours. */
export type WorksheetPrefillSource = { machineNames: string[]; plannedHours: number; runHours: number };
export type WorksheetPrefillKey = "machine_1" | "machine_2" | "machine_3" | "job_time_quoted_hr" | "run_time_hr";

const hoursText = (hours: number) => String(round2(hours));

/**
 * Fills only EMPTY worksheet fields (a value saved on the worksheet is never replaced): Machine #1-#3 from the job's machines (a machine
 * already written in any of the three is not repeated), Job Time Quoted from the hours planned/booked on its machines, Run Time from its
 * machine-run hours. Returns the worksheet and the fields filled.
 */
export function prefillWorksheet(ws: JobWorksheet, source: WorksheetPrefillSource): { worksheet: JobWorksheet; filled: WorksheetPrefillKey[] } {
  const next = { ...ws };
  const filled: WorksheetPrefillKey[] = [];
  const slots = ["machine_1", "machine_2", "machine_3"] as const;
  const present = new Set(slots.map((key) => ws[key].trim().toLowerCase()).filter(Boolean));
  const names = source.machineNames.map((name) => name.trim()).filter((name) => name && !present.has(name.toLowerCase()));
  const queue = [...new Set(names)];
  for (const key of slots) {
    if (next[key].trim() || !queue.length) continue;
    next[key] = queue.shift()!;
    filled.push(key);
  }
  if (!ws.job_time_quoted_hr.trim() && source.plannedHours > 0) { next.job_time_quoted_hr = hoursText(source.plannedHours); filled.push("job_time_quoted_hr"); }
  if (!ws.run_time_hr.trim() && source.runHours > 0) { next.run_time_hr = hoursText(source.runHours); filled.push("run_time_hr"); }
  return { worksheet: next, filled };
}

export const PREFILL_LABELS: Record<WorksheetPrefillKey, string> = {
  machine_1: "Machine #1", machine_2: "Machine #2", machine_3: "Machine #3", job_time_quoted_hr: "Job Time Quoted", run_time_hr: "Run Time",
};

// ---- Loaders (read only) ------------------------------------------------------------------------------------------------------------

/** The smallest client surface the loaders use: select reads only. Typed loosely so tests can pass a recording fake. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReadClient = { from: (table: string) => any };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bookingFromJobRow(row: any): JobBooking {
  return {
    id: String(row.id), machineId: String(row.machine_id), jobId: row.job_id ? String(row.job_id) : null, estimatedHours: Number(row.estimated_hours) || 0,
    status: (["booked", "running", "complete"].includes(row.status) ? row.status : "booked") as BookingStatus, startAt: String(row.start_at),
  };
}

/**
 * One job's machines with their names, and its machine-run hours, for the worksheet's prefill. Reads job_machines, machine_bookings,
 * machine_runs and machines; never writes. Null when the plan can't be read (the worksheet then shows what is saved, nothing more).
 */
export async function loadWorksheetPrefillSource(client: ReadClient, jobId: string, now: Date = new Date()): Promise<WorksheetPrefillSource | null> {
  const [plan, bookings, runs, machines] = await Promise.all([
    client.from("job_machines").select("machine_id, estimated_hours, booking_id, position").eq("job_id", jobId).order("position"),
    client.from("machine_bookings").select("id, machine_id, job_id, estimated_hours, status, start_at").eq("job_id", jobId),
    client.from("machine_runs").select("machine_id, started_at, ended_at").eq("job_id", jobId),
    client.from("machines").select("id, name"),
  ]);
  if (plan.error || bookings.error) return null;
  const names = new Map<string, string>(((machines.data ?? []) as { id: unknown; name: unknown }[]).map((m) => [String(m.id), String(m.name ?? "")]));
  const entries = jobMachineEntries(jobId, (plan.data ?? []) as PlanLink[], ((bookings.data ?? []) as unknown[]).map(bookingFromJobRow));
  return {
    machineNames: entries.map((e) => names.get(e.machineId) ?? "").filter(Boolean),
    plannedHours: round2(entries.reduce((sum, e) => sum + e.hours, 0)),
    runHours: runs.error ? 0 : machineRunHours((runs.data ?? []) as { machine_id: string | null; started_at: string; ended_at: string | null }[], now),
  };
}

/**
 * What the Machines dialog opens with: the company's schedule (for the default starts and the clash check) and the job's machines
 * (jobMachineEntries over the full bookings). READS ONLY: opening the dialog, or closing it with Cancel, writes nothing.
 */
export async function loadJobMachinesForDialog(jobId: string): Promise<{ machines: Machine[]; bookings: Booking[]; entries: JobMachineEntry<Booking>[] }> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const [schedule, plan] = await Promise.all([
    fetchSchedule(),
    supabase.from("job_machines").select("machine_id, estimated_hours, booking_id, position").eq("job_id", jobId).order("position"),
  ]);
  if (plan.error) throw plan.error;
  return { machines: schedule.machines, bookings: schedule.bookings, entries: jobMachineEntries(jobId, (plan.data ?? []) as PlanLink[], schedule.bookings) };
}

/** One machine on a job, as the board shows it: name, hours and whether it is booked on the schedule. */
export type JobMachineChip = { machine_id: string; name: string; hours: number; booked: boolean; /** The schedule booking's status; null when there is none. `booked` is true only for status "booked". */ state?: BookingStatus | null };

/** The chip's suffix: " (booked)" only for a still-booked booking on an open job; " (running)", " (done)" otherwise; nothing without a booking. */
export function chipBookingSuffix(chip: Pick<JobMachineChip, "state" | "booked">, jobFinished: boolean): string {
  // A snapshot cached before `state` existed carries only `booked`.
  const state = chip.state ?? (chip.booked ? "booked" : null);
  if (!state) return "";
  if (state === "complete" || jobFinished) return " (done)";
  return state === "running" ? " (running)" : " (booked)";
}

const nameOf = (raw: unknown) => {
  const machine = raw as { name?: string } | { name?: string }[] | null;
  return String((Array.isArray(machine) ? machine[0]?.name : machine?.name) ?? "Machine");
};

/**
 * Every job's machines for the Job Board, in two reads (the plan, and the bookings that name a job), joined by jobMachineEntries: a
 * machine booked on the schedule shows its booked hours and "(booked)" even when the plan row isn't linked to it. Null when the plan
 * can't be read; when only the bookings can't be read, the plan is shown as it is. Reads only.
 */
export async function loadBoardJobMachines(): Promise<Map<string, JobMachineChip[]> | null> {
  if (!supabase) return null;
  const client = supabase;
  const [plan, bookings] = await Promise.all([
    client.from("job_machines").select("job_id, machine_id, estimated_hours, booking_id, position, machines(name)").order("position"),
    fetchAll((from, to) => client.from("machine_bookings").select("id, job_id, machine_id, estimated_hours, status, start_at, machines(name)").not("job_id", "is", null).order("start_at").order("id").range(from, to))
      .then((result) => result.rows as Record<string, unknown>[], () => [] as Record<string, unknown>[]),
  ]);
  if (plan.error) { console.error(plan.error); return null; }
  const names = new Map<string, string>();
  const linksByJob = new Map<string, PlanLink[]>();
  for (const row of (plan.data ?? []) as Record<string, unknown>[]) {
    names.set(String(row.machine_id), nameOf(row.machines));
    const jobId = String(row.job_id);
    linksByJob.set(jobId, [...(linksByJob.get(jobId) ?? []), { machine_id: String(row.machine_id), estimated_hours: Number(row.estimated_hours) || 0, booking_id: row.booking_id ? String(row.booking_id) : null, position: Number(row.position) || 0 }]);
  }
  const bookingsByJob = new Map<string, JobBooking[]>();
  for (const row of bookings) {
    if (!names.has(String(row.machine_id))) names.set(String(row.machine_id), nameOf(row.machines));
    const booking = bookingFromJobRow(row);
    if (booking.jobId) bookingsByJob.set(booking.jobId, [...(bookingsByJob.get(booking.jobId) ?? []), booking]);
  }
  const map = new Map<string, JobMachineChip[]>();
  for (const jobId of new Set([...linksByJob.keys(), ...bookingsByJob.keys()])) {
    const entries = jobMachineEntries(jobId, linksByJob.get(jobId) ?? [], bookingsByJob.get(jobId) ?? []);
    if (entries.length) map.set(jobId, entries.map((e) => ({ machine_id: e.machineId, name: names.get(e.machineId) ?? "Machine", hours: e.hours, booked: e.booking?.status === "booked", state: e.booking?.status ?? null })));
  }
  return map;
}

// ---- The Machines dialog's save (pure) -----------------------------------------------------------------------------------------------

/** One row of the Machines dialog at save time. `start`: the ISO start to book or move to, when the row books (else null). */
export type DialogRow<B extends JobBooking = JobBooking> = {
  machineId: string;
  hours: number;
  book: boolean;
  start: string | null;
  /** The person changed the start of the row's existing booking (a booking is never moved just because the dialog was opened). */
  startChanged: boolean;
  /** The booking the row was loaded with (linked or adopted), or null. */
  booking: B | null;
  linked: boolean;
};
export type MachinesSavePlan<B extends JobBooking = JobBooking> = {
  /** Adopted bookings (not linked to the plan) moved or resized: written through save_machine_booking, as the schedule writes them. */
  bookingUpdates: { booking: B; machineId: string; hours: number; startAt: string }[];
  /** What set_job_machines takes. An adopted booking's row is sent WITHOUT start_at, so the database never makes a second booking for it. */
  payload: { machine_id: string; hours: number; start_at?: string }[];
  /** Adopted bookings whose machine was removed from the job (or changed), still only booked: removed, as set_job_machines removes a linked one. */
  removeBookings: B[];
  /** False when saving would change nothing: no request is made at all. */
  changed: boolean;
};

/**
 * Can the Machines dialog save? Only once THIS job's machines and bookings loaded successfully, with no load running and no load error.
 * Saving the empty rows left by a failed or unfinished load would remove the job's machines and their bookings.
 */
export function machinesSaveReady(state: { jobId: string | null; loadedFor: string | null; loading: boolean; loadError: string | null }): boolean {
  return Boolean(state.jobId) && state.loadedFor === state.jobId && !state.loading && !state.loadError;
}

/** Does the row keep the booking it was loaded with (same machine)? */
export const keepsBooking = (row: Pick<DialogRow, "machineId" | "booking">) => Boolean(row.booking && row.booking.machineId === row.machineId);

/**
 * What saving the dialog does, worked out from what was loaded and the rows as they are now. Nothing here writes: the dialog runs the
 * plan (bookingUpdates, then set_job_machines with payload, then removeBookings), and runs nothing when `changed` is false.
 */
export function planMachinesSave<B extends JobBooking>(loaded: JobMachineEntry<B>[], rows: DialogRow<B>[]): MachinesSavePlan<B> {
  const bookingUpdates: MachinesSavePlan<B>["bookingUpdates"] = [];
  const payload: MachinesSavePlan<B>["payload"] = [];
  for (const row of rows) {
    const hours = Number.isFinite(row.hours) ? row.hours : 0;
    if (keepsBooking(row)) {
      const booking = row.booking!;
      const movable = booking.status === "booked";
      const moveTo = movable && row.startChanged && row.start ? row.start : null;
      if (row.linked) {
        payload.push({ machine_id: row.machineId, hours, ...(moveTo ? { start_at: moveTo } : {}) });
      } else {
        payload.push({ machine_id: row.machineId, hours });
        if (movable && (moveTo || hours !== booking.estimatedHours)) bookingUpdates.push({ booking, machineId: row.machineId, hours, startAt: moveTo ?? booking.startAt });
      }
      continue;
    }
    payload.push({ machine_id: row.machineId, hours, ...(row.book && row.start ? { start_at: row.start } : {}) });
  }
  const kept = new Set(rows.filter(keepsBooking).map((row) => row.booking!.id));
  const removeBookings = loaded
    .filter((entry) => entry.booking && !entry.linked && entry.booking.status === "booked" && !kept.has(entry.booking.id))
    .map((entry) => entry.booking!);
  const before = JSON.stringify(loaded.map((e) => [e.machineId, round2(e.hours)]));
  const after = JSON.stringify(payload.map((p) => [p.machine_id, round2(p.hours)]));
  const changed = before !== after || payload.some((p) => p.start_at) || bookingUpdates.length > 0 || removeBookings.length > 0;
  return { bookingUpdates, payload, removeBookings, changed };
}
