// Settings > Email schedules: the pure part. The form's values to an email_schedules row (and back), the "Next run" line, and the
// friendly words for what can go wrong. The card (components/email-schedules/settings-card.tsx) only draws these.
import {
  type EmailScheduleFrequency, type EmailScheduleKind, type ScheduleTiming, DEFAULT_TIME_ZONE, describeInstant, localDate, localInstant, nextDailyPassAtOrAfter, nextRun, parseTimeOfDay, safeZone, weekdayName,
} from "@/lib/email/schedules/due";

/**
 * Production is on Vercel Hobby: one daily pass (vercel.json "0 5 * * *" runs app/api/cron/daily). On Pro, switch the cron to
 * every 15 minutes (see app/api/cron/daily/route.ts) and set this to true: schedules then send at their chosen time.
 */
export const EXACT_TIME_SENDING = false;
export const DAILY_RUN_NOTE = "Sent at the next daily run (about 05:00 UK) after the chosen time; exact-time sending needs the Pro plan.";

export const SCHEDULE_NOT_AVAILABLE = "Not available until database update 108 is applied";

export type ScheduleForm = {
  enabled: boolean;
  frequency: EmailScheduleFrequency;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  /** HH:MM. */
  time: string;
  /** YYYY-MM-DD, for "once". */
  onceDate: string;
  /** Timesheet only: one address per line or separated by commas; empty = every admin of the company. */
  recipients: string;
};

export const SCHEDULE_LABELS: Record<EmailScheduleKind, { title: string; blurb: string; frequencies: EmailScheduleFrequency[] }> = {
  invoice_reminder: {
    title: "Invoice reminders",
    blurb: "Reminds customers about invoices that are issued, unpaid and past their due date. Each invoice is reminded at most once per run, and never once it is paid.",
    frequencies: ["daily", "weekly", "once"],
  },
  timesheet: {
    title: "Timesheet e-mails",
    blurb: "E-mails each person's hours for the last full week (Monday to Sunday) to the company's admins, one e-mail per person, on the day you choose.",
    frequencies: ["weekly", "once"],
  },
};

export const FREQUENCY_LABEL: Record<EmailScheduleFrequency, string> = { daily: "Every day", weekly: "Every week", once: "Once, on a date" };

export function defaultForm(kind: EmailScheduleKind): ScheduleForm {
  return { enabled: false, frequency: kind === "timesheet" ? "weekly" : "daily", weekday: kind === "timesheet" ? 1 : 1, time: "08:00", onceDate: "", recipients: "" };
}

type StoredSchedule = Pick<ScheduleTiming, "enabled" | "frequency" | "weekday" | "time_of_day" | "run_at" | "timezone"> & { recipients?: string[] | null };

/** The form for a stored row (null: none saved yet, so the defaults: off). */
export function formFromRow(kind: EmailScheduleKind, row: StoredSchedule | null): ScheduleForm {
  const base = defaultForm(kind);
  if (!row) return base;
  const zone = safeZone(row.timezone);
  const frequency = SCHEDULE_LABELS[kind].frequencies.includes(row.frequency) ? row.frequency : base.frequency;
  const parsed = parseTimeOfDay(row.time_of_day);
  const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  let onceDate = "";
  let time = parsed ? hhmm(parsed[0], parsed[1]) : base.time;
  if (row.run_at && !Number.isNaN(Date.parse(row.run_at))) {
    const at = new Date(row.run_at);
    onceDate = localDate(at, zone);
    if (frequency === "once") {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
      time = `${parts.find((p) => p.type === "hour")?.value ?? "08"}:${parts.find((p) => p.type === "minute")?.value ?? "00"}`;
    }
  }
  return { enabled: row.enabled, frequency, weekday: Number.isInteger(row.weekday) ? (row.weekday as number) : base.weekday, time, onceDate, recipients: (row.recipients ?? []).join("\n") };
}

export function parseRecipients(text: string): { ok: true; list: string[] } | { ok: false; error: string } {
  const list = [...new Set(text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
  if (list.length > 20) return { ok: false, error: "Enter at most 20 e-mail addresses." };
  const bad = list.find((x) => !/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(x) || x.length > 254);
  return bad ? { ok: false, error: `"${bad}" isn't a valid e-mail address.` } : { ok: true, list };
}

export type SchedulePatch = Pick<ScheduleTiming, "enabled" | "frequency" | "weekday" | "time_of_day" | "run_at"> & { timezone: string; recipients: string[] | null };

/** The values to save, or the friendly reason they can't be. `now` only checks that a "once" is still ahead. */
export function patchFromForm(kind: EmailScheduleKind, form: ScheduleForm, now: Date, zone: string = DEFAULT_TIME_ZONE): { ok: true; patch: SchedulePatch } | { ok: false; error: string } {
  const time = parseTimeOfDay(form.time);
  if (!time) return { ok: false, error: "Choose a time of day." };
  if (!SCHEDULE_LABELS[kind].frequencies.includes(form.frequency)) return { ok: false, error: "Choose how often it should run." };
  if (form.frequency === "weekly" && !(Number.isInteger(form.weekday) && form.weekday >= 0 && form.weekday <= 6)) return { ok: false, error: "Choose a day of the week." };
  let run_at: string | null = null;
  if (form.frequency === "once") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.onceDate) || Number.isNaN(Date.parse(`${form.onceDate}T00:00:00Z`))) return { ok: false, error: "Choose the date it should run." };
    const at = localInstant(form.onceDate, time[0], time[1], zone);
    if (form.enabled && at.getTime() <= now.getTime()) return { ok: false, error: "Choose a date and time that haven't passed yet." };
    run_at = at.toISOString();
  }
  let recipients: string[] | null = null;
  if (kind === "timesheet") {
    const parsed = parseRecipients(form.recipients);
    if (!parsed.ok) return parsed;
    recipients = parsed.list.length ? parsed.list : null;
  }
  const hhmm = `${String(time[0]).padStart(2, "0")}:${String(time[1]).padStart(2, "0")}`;
  return { ok: true, patch: { enabled: form.enabled, frequency: form.frequency, weekday: form.frequency === "weekly" ? form.weekday : null, time_of_day: hhmm, run_at, timezone: safeZone(zone), recipients } };
}

/** The "Next run: ..." line, worked out by the same nextRun the cron uses (it does not look at what is saved, only at the form). With the daily pass it also says when that run is actually sent. */
export function nextRunLine(kind: EmailScheduleKind, form: ScheduleForm, now: Date, zone: string = DEFAULT_TIME_ZONE): string {
  if (!form.enabled) return "Off: nothing will be sent.";
  const made = patchFromForm(kind, { ...form, enabled: true }, new Date(0), zone);
  if (!made.ok) return made.error;
  const next = nextRun({ ...made.patch, enabled: true }, now);
  if (!next) return form.frequency === "once" ? "That date and time have passed: nothing will be sent." : "No run is coming up.";
  if (EXACT_TIME_SENDING) return `Next run: ${describeInstant(next, zone)}`;
  return `Chosen time: ${describeInstant(next, zone)}. Sent at the next daily run after it: ${describeInstant(nextDailyPassAtOrAfter(next), zone)}.`;
}

/** A line saying what the schedule does, for the card ("Every Monday at 09:30"). */
export function scheduleSummary(form: ScheduleForm): string {
  if (form.frequency === "daily") return `Every day at ${form.time}`;
  if (form.frequency === "weekly") return `Every ${weekdayName(form.weekday)} at ${form.time}`;
  return form.onceDate ? `Once, on ${form.onceDate} at ${form.time}` : "Once";
}

/** Friendly words for a failed load or save; never the database's own text. */
export function scheduleErrorMessage(error: { code?: string | null; message?: string | null; hint?: string | null } | null | undefined): string {
  if (!error) return "Couldn't save the schedule. Try again.";
  if (error.code && ["PGRST205", "PGRST204", "42P01", "42703"].includes(error.code)) return SCHEDULE_NOT_AVAILABLE;
  if (error.hint === "bad_recipient") return "One of the e-mail addresses isn't valid.";
  if (error.hint === "too_many_recipients") return "Enter at most 20 e-mail addresses.";
  if (error.hint === "bad_timezone") return "That time zone isn't recognised.";
  if (error.code === "42501") return "Only an admin can change e-mail schedules.";
  if (error.code === "23514") return "One of the values isn't allowed. Check the day, date and time.";
  return "Couldn't save the schedule. Try again.";
}
