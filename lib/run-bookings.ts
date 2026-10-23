/**
 * The bookings the Job Board's running jobs are working against (a run's booking_id: the plan row's job_machines.booking_id, else the
 * job's own booking on that machine, as 044 picks it), for the live "left" figure. Reads only; bookings are readable to the four roles.
 */
import { supabase } from "@/lib/supabase";

export type RunBooking = { estimatedHours: number; hoursDone: number; status: "booked" | "running" | "complete" };

const CHUNK = 100;

/** Booking id -> its hours. Null when they can't be read (the board then shows elapsed time only). */
export async function loadRunBookings(ids: string[]): Promise<Map<string, RunBooking> | null> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  if (!supabase) return null;
  const client = supabase;
  const map = new Map<string, RunBooking>();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const { data, error } = await client.from("machine_bookings").select("id, estimated_hours, hours_done, status").in("id", unique.slice(i, i + CHUNK));
    if (error) return null;
    for (const row of (data ?? []) as { id: string; estimated_hours: unknown; hours_done: unknown; status: unknown }[]) {
      const status = row.status === "running" || row.status === "complete" ? row.status : "booked";
      map.set(String(row.id), { estimatedHours: Number(row.estimated_hours) || 0, hoursDone: Number(row.hours_done) || 0, status });
    }
  }
  return map;
}
