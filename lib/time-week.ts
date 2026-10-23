/**
 * The weekly review (migration 052): each person's week worked out from the records (lib/time-sheet.ts), with the server's revision and
 * approval state. The revision is read BEFORE the records, so an approval made from what is on screen is refused (stale_revision) if
 * anything changed after the revision was read: The JNR controller always approves exactly what he saw. The day ticks (074, lib/time-day-flags) are
 * read after the revision too (they are part of it); before 074 is applied there are none (dayFlags null) and nothing else changes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { type WeekDayFlags, loadDayFlags, weekDayFlags } from "@/lib/time-day-flags";
import { type TimeData, TimeDataError, loadTimeData } from "@/lib/time-data";
import { type WeekTotals, addDays, startOfLocalDay, weekTotals } from "@/lib/time-sheet";

export type WeekState = "not_approved" | "approved" | "changed_since_approval";
export type WeekStatusRow = {
  user_id: string; revision: string; state: WeekState; approved_revision: string | null; approved_at: string | null; approved_by: string | null;
  totals: Record<string, unknown> | null; note: string | null;
};
/** dayFlags: the week's day ticks and totals per type (null before 074 is applied). */
export type PersonWeek = { userId: string; status: WeekStatusRow | null; week: WeekTotals; dayFlags: WeekDayFlags | null };

export const WEEK_STATE_TEXT: Record<WeekState, string> = {
  not_approved: "Not approved",
  approved: "Approved",
  changed_since_approval: "Changed since approval",
};

/** Everyone the caller may see (or one person) for the week starting Monday `weekStart`. */
export async function loadWeek(client: Pick<SupabaseClient, "from" | "rpc">, weekStart: string, userId: string | null, now = Date.now()) {
  const { data: statusRows, error } = await client.rpc("time_week_status", { p_week: weekStart, p_user: userId });
  if (error) throw new TimeDataError(error);
  const [data, flags]: [TimeData, Awaited<ReturnType<typeof loadDayFlags>>] = await Promise.all([
    loadTimeData(client, { userId, from: startOfLocalDay(weekStart), to: startOfLocalDay(addDays(weekStart, 7)) }),
    loadDayFlags(client, { userId, from: weekStart, to: addDays(weekStart, 6) }),
  ]);
  const status = new Map(((statusRows ?? []) as WeekStatusRow[]).map((r) => [r.user_id, r]));
  const ids = new Set<string>([...status.keys(), ...data.events.map((e) => e.user_id), ...data.labour.map((l) => l.user_id), ...flags.rows.map((f) => f.user_id)]);
  if (userId) for (const id of [...ids]) if (id !== userId) ids.delete(id);
  const people: PersonWeek[] = [...ids].map((id) => {
    const week = weekTotals({ weekStart, events: data.events.filter((e) => e.user_id === id), labour: data.labour.filter((l) => l.user_id === id), settings: data.settings, bankHolidays: data.bankHolidays, now });
    return {
      userId: id,
      status: status.get(id) ?? null,
      week,
      dayFlags: flags.present ? weekDayFlags(week, flags.rows.filter((f) => f.user_id === id), data.bankHolidays) : null,
    };
  });
  return { data, people, dayFlagsPresent: flags.present };
}
