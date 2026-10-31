/**
 * The Whole floor's "Clocked in" count (migration 118 is NOT needed: it only reads attendance_events, as Weekly hours does).
 *
 * ONE RULE with Weekly hours: a person counts as clocked in exactly when Weekly hours would say "Clocked in since 08:05" for them today.
 * That is lib/time-sheet's pairAttendance (the clock actions that count, paired in time order, a session left open longer than the
 * company's long_session_hours is not clocked in) followed by clockStateOf, which components/time/day-sheet.tsx also calls. The clock
 * records are read over the same window Weekly hours reads for today (loadTimeData: the local day, 24 hours either side), so both see the
 * same events. A person on a break is counted as clocked in and again as "on a break", as the day sheet words it.
 *
 * Who may see it: attendance_events rows are readable by their owner, and every row by admin and office only (row rules, migration 050). A
 * workshop person's read would return only their own clock records and a count of 1 that means nothing, so the count is read and shown
 * to admin and office only; everyone else is told so, in words (components/workshop/clocked-in-figure). Fail closed: a read that failed, or
 * that hit the row limit, is null and shows as a dash, never as 0.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { type AttendanceEvent, type TimeSettings, EDGE_MARGIN_HOURS, clockStateOf, localDateOf, localDayBounds, pairAttendance, settingsFromRow } from "@/lib/time-sheet";

export type ClockedIn = { clockedIn: number; onBreak: number };

/** The roles whose row rules let them read everyone's clock records. */
export const attendanceReadable = (role: string | null | undefined) => role === "admin" || role === "office";

/** The window of clock records Weekly hours reads for the local day `now` falls on: that day, EDGE_MARGIN_HOURS either side (ISO instants). */
export function clockReadWindow(now: Date): { lo: string; hi: string } {
  const bounds = localDayBounds(localDateOf(now));
  const margin = EDGE_MARGIN_HOURS * 3_600_000;
  return { lo: new Date(bounds.start.getTime() - margin).toISOString(), hi: new Date(bounds.end.getTime() + margin).toISOString() };
}

/** Rows read at most. A read that fills it may be missing some, so it is not trusted (a dash, not a short count). */
export const CLOCK_ROW_LIMIT = 5000;

const EVENT_COLUMNS = "id, user_id, action, at, source, supersedes, reason, device_at, received_at, recorded_by";

/** Who is clocked in at `now`, from everyone's clock records (the rule above). Pure. */
export function clockedInNow(events: AttendanceEvent[], settings: TimeSettings, now: Date): ClockedIn {
  const byPerson = new Map<string, AttendanceEvent[]>();
  for (const event of events) byPerson.set(event.user_id, [...(byPerson.get(event.user_id) ?? []), event]);
  let clockedIn = 0;
  let onBreak = 0;
  for (const mine of byPerson.values()) {
    const state = clockStateOf(pairAttendance(mine, settings, now.getTime()).sessions);
    if (state.clockedIn) clockedIn += 1;
    if (state.onBreak) onBreak += 1;
  }
  return { clockedIn, onBreak };
}

/** The count for an admin or office person, or null when it could not be read in full. Never throws. */
export async function loadClockedIn(client: Pick<SupabaseClient, "from">, now = new Date()): Promise<ClockedIn | null> {
  try {
    const { lo, hi } = clockReadWindow(now);
    const [events, settings] = await Promise.all([
      client.from("attendance_events").select(EVENT_COLUMNS).gte("at", lo).lt("at", hi).order("at").limit(CLOCK_ROW_LIMIT),
      client.from("time_settings").select("*").maybeSingle(),
    ]);
    if (events.error || settings.error) return null;
    const rows = (events.data ?? []) as unknown as AttendanceEvent[];
    if (rows.length >= CLOCK_ROW_LIMIT) return null;
    return clockedInNow(rows, settingsFromRow((settings.data ?? null) as Record<string, unknown> | null), now);
  } catch {
    return null;
  }
}
