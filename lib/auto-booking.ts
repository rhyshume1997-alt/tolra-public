/**
 * What the database booked when machines were saved on a job (migration 061: a machine just picked goes on the Machine Schedule at its
 * next free slot; an order's planned machines too when it becomes a job). Pure helpers for the dialogs' messages. Times are UK time
 * (Europe/London), whatever the device's zone.
 */

/** One machine of set_job_machines' answer (043 keys; 061 adds auto_booked and finish_at). */
export type SavedJobMachine = {
  machine_id: string;
  machine?: string | null;
  hours: number;
  start_at: string | null;
  booking_id: string | null;
  auto_booked?: boolean;
  finish_at?: string | null;
};

/** "Tue 20 Oct 10:00" in UK time. */
export function ukDateTime(value: string | Date): string {
  const at = typeof value === "string" ? new Date(value) : value;
  const day = at.toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" });
  const time = at.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}

/** The database answered with 061's keys: it books a machine just picked by itself. An older database (before 061) does not. */
export function databaseAutoBooks(machines: unknown): boolean {
  return Array.isArray(machines) && machines.some((m) => m && typeof m === "object" && "auto_booked" in (m as object));
}

/** One line per machine the database booked at its next free slot: "Mill: Booked on the schedule from Tue 20 Oct 10:00 until Tue 20 Oct 14:00". */
export function autoBookedLines(machines: SavedJobMachine[], nameOf: (id: string) => string | undefined = () => undefined): string[] {
  return machines
    .filter((m) => m.auto_booked && m.booking_id && m.start_at)
    .map((m) => {
      const name = nameOf(m.machine_id) ?? m.machine ?? "Machine";
      const until = m.finish_at ? ` until ${ukDateTime(m.finish_at)}` : "";
      return `${name}: Booked on the schedule from ${ukDateTime(m.start_at!)}${until}`;
    });
}

/**
 * Machines saved with hours but no booking, that the person did not ask to keep off the schedule: on an older database (before 061)
 * these are plan rows only, so the dialog says how to book them.
 */
export function notBookedYet(machines: SavedJobMachine[], newlyPicked: Set<string>): SavedJobMachine[] {
  return machines.filter((m) => newlyPicked.has(m.machine_id) && !m.booking_id && Number(m.hours) > 0);
}
