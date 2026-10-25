/**
 * Loading what the daily job sheet and the weekly hours need (migrations 050 to 052), and showing what is still on this device.
 *
 * Reads go through row-level security: a workshop member gets their own clock records and job time only; admin and office the company's.
 * Clock records and job time are read EDGE_MARGIN_HOURS either side of the window so a shift crossing its edge pairs up. Changes the
 * person made that are still in this device's outbox (offline, or not sent yet) are laid over what the server returned, marked pending
 * ("saved on this device"), so the sheet shows them straight away.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { OutboxEntry } from "@/lib/offline/outbox";
import { type AttendanceEvent, type LabourSession, type TimeSettings, EDGE_MARGIN_HOURS, addDays, localDateOf, settingsFromRow } from "@/lib/time-sheet";

export type JobInfo = { id: string; job_no: string; customer: string | null; description: string | null; finished_at: string | null };
export type TimeData = { events: AttendanceEvent[]; labour: LabourSession[]; settings: TimeSettings; bankHolidays: Map<string, string>; jobs: Record<string, JobInfo> };

export type Client = Pick<SupabaseClient, "from">;

const EVENT_COLUMNS = "id, user_id, action, at, source, supersedes, reason, device_at, received_at, recorded_by";
const SESSION_COLUMNS = "id, user_id, job_id, started_at, ended_at, voided_at, source, end_source, device_started_at, device_ended_at, original_started_at, original_ended_at, correction_reason, void_reason";
/** Who ended a session (051) and the admin's reason when a Release machine ended it (092's end_reason; read without it before 092). */
const SESSION_END_COLUMNS = `${SESSION_COLUMNS}, ended_by, end_reason`;

/** A failed read, with the server's code kept (so "the database doesn't have 050 to 052 yet" can be told apart: lib/time-features). */
export class TimeDataError extends Error {
  code: string | null;
  constructor(error: { message: string; code?: string | null }) {
    super(error.message);
    this.name = "TimeDataError";
    this.code = error.code ?? null;
  }
}

async function rows<T>(q: PromiseLike<{ data: unknown; error: { message: string; code?: string | null } | null }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new TimeDataError(error);
  return (data ?? []) as T[];
}

/** Clock records, job time, settings, bank holidays and job details for [from, to) and the person (null: everyone the caller may see). */
export async function loadTimeData(client: Client, opts: { userId: string | null; from: Date; to: Date }): Promise<TimeData> {
  const margin = EDGE_MARGIN_HOURS * 3_600_000;
  const lo = new Date(opts.from.getTime() - margin).toISOString();
  const hi = new Date(opts.to.getTime() + margin).toISOString();
  let eventsQ = client.from("attendance_events").select(EVENT_COLUMNS).gte("at", lo).lt("at", hi);
  const labourQ = (columns: string) => {
    const query = client.from("operator_sessions").select(columns).lt("started_at", hi).or(`ended_at.is.null,ended_at.gt."${lo}"`);
    return (opts.userId ? query.eq("user_id", opts.userId) : query).order("started_at").limit(5000);
  };
  if (opts.userId) eventsQ = eventsQ.eq("user_id", opts.userId);
  const [events, labour, settingsRow] = await Promise.all([
    rows<AttendanceEvent>(eventsQ.order("at").limit(5000)),
    rows<LabourSession>(labourQ(SESSION_END_COLUMNS)).catch((err: unknown) => {
      // Before 092 the end_reason column isn't there (42703): the same read without who ended it and why.
      if (err instanceof TimeDataError && err.code === "42703") return rows<LabourSession>(labourQ(SESSION_COLUMNS));
      throw err;
    }),
    client.from("time_settings").select("*").maybeSingle(),
  ]);
  if (settingsRow.error) throw new TimeDataError(settingsRow.error);
  const settings = settingsFromRow((settingsRow.data ?? null) as Record<string, unknown> | null);
  const dayLo = lo.slice(0, 10);
  const dayHi = hi.slice(0, 10);
  const holidays = await rows<{ day: string; name: string }>(client.from("bank_holidays").select("day, name").eq("region", settings.bankHolidayRegion).gte("day", dayLo).lte("day", dayHi));
  const jobIds = [...new Set(labour.map((l) => l.job_id))];
  const jobs: Record<string, JobInfo> = {};
  for (let i = 0; i < jobIds.length; i += 200) {
    for (const job of await rows<JobInfo>(client.from("jobs").select("id, job_no, customer, description, finished_at").in("id", jobIds.slice(i, i + 200)))) jobs[job.id] = job;
  }
  return { events, labour, settings, bankHolidays: new Map(holidays.map((h) => [h.day, h.name])), jobs };
}

/** Jobs a person can start time on: not finished, newest first (the caller's assigned jobs first). */
export async function loadStartableJobs(client: Client, userId: string | null): Promise<JobInfo[]> {
  const list = await rows<JobInfo & { assigned_to: string | null }>(client.from("jobs").select("id, job_no, customer, description, finished_at, assigned_to").is("finished_at", null).order("created_at", { ascending: false }).limit(300));
  return [...list.filter((j) => userId && j.assigned_to === userId), ...list.filter((j) => !userId || j.assigned_to !== userId)];
}

/**
 * The person's own clock actions and job Start/Stop still in this device's outbox, laid over the server's records (pending: true). Only
 * entries of `userId`'s own scope are passed in (the outbox is per person and company), so nobody else's appear.
 */
export function overlayPending(data: Pick<TimeData, "events" | "labour">, pending: OutboxEntry[], userId: string): Pick<TimeData, "events" | "labour"> {
  const events = [...data.events];
  const labour = data.labour.map((l) => ({ ...l }));
  for (const entry of pending) {
    const op = entry.op;
    if (op.kind === "clock") {
      events.push({ id: `pending:${op.clientOpId}`, user_id: userId, action: op.action, at: op.at, device_at: op.at, received_at: entry.queuedAt, source: "clock", pending: true });
    } else if (op.kind === "labour") {
      const open = labour.find((l) => l.job_id === op.jobRef && l.user_id === userId && !l.ended_at && !l.voided_at);
      if (op.action === "start" && !open) {
        labour.push({ id: `pending:${op.clientOpId}`, user_id: userId, job_id: op.jobRef, started_at: op.at, ended_at: null, source: "sheet", pending: true });
      } else if (op.action === "stop" && open) {
        open.ended_at = new Date(Math.max(new Date(op.at).getTime(), new Date(open.started_at).getTime())).toISOString();
        open.pending = true;
      }
    }
  }
  return { events, labour };
}

/**
 * This device's clock actions and job Start/Stop still waiting in the outbox for `personId` in the week starting `week` (Monday, YYYY-MM-DD).
 * The outbox is per signed-in person, so another person's week has none here (their own devices are not visible from this one).
 */
export function pendingForPersonWeek(pending: OutboxEntry[], signedInUserId: string | null, personId: string, week: string): OutboxEntry[] {
  if (!signedInUserId || signedInUserId !== personId) return [];
  const last = addDays(week, 6);
  return pending.filter((e) => {
    if (e.op.kind !== "clock" && e.op.kind !== "labour") return false;
    const day = localDateOf(e.op.at);
    return day >= week && day <= last;
  });
}

/** What the sheet says after a clock action or job Start/Stop was put in the outbox (components/time/day-sheet.tsx). */
export type SendNotice = { tone: "success" | "info" | "error"; message: string };
export type SendState = {
  /** The page showed offline when the action was taken: nothing was tried yet. */
  offline: boolean;
  /** The sync pass started straight after queueing finished within the wait, and the person and company are still the same. */
  settled: boolean;
  pending: Pick<OutboxEntry, "op" | "blocked">[];
  held: (Pick<OutboxEntry, "op"> & { reason: string })[];
};
const opKey = (op: OutboxEntry["op"]) => (op.kind === "clock" || op.kind === "labour" ? op.clientOpId : null);
/**
 * "Saved on this device" only while the entry is still on this device. Online, the outbox is sent at once: once the entry has left the
 * queue (and was not held as refused or in conflict) the server has it, and the sheet says "saved", as a direct send does.
 */
export function timeSendNotice(label: string, clientOpId: string, state: SendState): SendNotice {
  const waiting = `${label}: saved on this device. It will be sent as soon as the connection allows.`;
  if (state.offline) return { tone: "success", message: `${label}: saved on this device. It will sync when you're back online.` };
  // A refusal or a block is reported even when the wait ran out: it must never read as "saved on this device" or "saved".
  const held = state.held.find((e) => opKey(e.op) === clientOpId);
  if (held) return { tone: "error", message: `${label}: not recorded. ${held.reason}` };
  const queued = state.pending.find((e) => opKey(e.op) === clientOpId);
  if (queued?.blocked) return { tone: "info", message: `${label}: saved on this device, not sent yet. ${queued.blocked.reason}` };
  if (!state.settled || queued) return { tone: "success", message: waiting };
  return { tone: "success", message: `${label}: saved.` };
}

/**
 * Whether syncNow's pass really ran: it returns null when it sent nothing (no session, another person or company, support session,
 * switch under way). Only a pass that ran may let the sheet say "saved".
 */
export const syncPassRan = (result: unknown) => result !== null && result !== undefined;

/** A short name for this device, kept with each clock action ("iPad", "Android phone", "Windows PC"). */
export function deviceLabel(userAgent = typeof navigator !== "undefined" ? navigator.userAgent : ""): string | null {
  if (!userAgent) return null;
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/Android/i.test(userAgent)) return /Mobile/i.test(userAgent) ? "Android phone" : "Android tablet";
  if (/Windows/i.test(userAgent)) return "Windows PC";
  if (/Macintosh/i.test(userAgent)) return "Mac";
  return "Browser";
}
