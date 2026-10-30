"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarClock } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { weekdayName } from "@/lib/email/schedules/due";
import {
  type ScheduleForm, DAILY_RUN_NOTE, EXACT_TIME_SENDING, FREQUENCY_LABEL, SCHEDULE_LABELS, SCHEDULE_NOT_AVAILABLE, defaultForm, formFromRow, nextRunLine, patchFromForm, scheduleErrorMessage,
} from "@/lib/email/schedules/form";
import type { EmailScheduleFrequency, EmailScheduleKind } from "@/lib/email/schedules/due";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";
import { useUser } from "@/lib/use-user";

const KINDS: EmailScheduleKind[] = ["invoice_reminder", "timesheet"];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
const COLUMNS = "kind, enabled, frequency, weekday, time_of_day, run_at, timezone, recipients";

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-none transition disabled:cursor-not-allowed disabled:opacity-60 ${checked ? "bg-brand" : "bg-slate-300"}`}>
      <span className={`inline-block size-5 rounded-none bg-white shadow transition ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}

function ScheduleEditor({ kind, initial, zone, canEdit, organizationId }: { kind: EmailScheduleKind; initial: ScheduleForm; zone: string; canEdit: boolean; organizationId: string }) {
  const [form, setForm] = useState<ScheduleForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const labels = SCHEDULE_LABELS[kind];
  const set = (patch: Partial<ScheduleForm>) => { setForm((f) => ({ ...f, ...patch })); setError(null); };

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const preview = useMemo(() => nextRunLine(kind, form, now, zone), [kind, form, now, zone]);

  async function save() {
    if (!supabase || saving) return;
    const made = patchFromForm(kind, form, new Date(), zone);
    if (!made.ok) return void setError(made.error);
    setSaving(true);
    try {
      const { error: failure } = await supabase.from("email_schedules").upsert({ organization_id: organizationId, kind, ...made.patch }, { onConflict: "organization_id,kind" });
      if (failure) {
        const message = scheduleErrorMessage(failure);
        setError(message);
        toast.error(message);
      } else {
        setError(null);
        toast.success(`${labels.title} saved`);
      }
    } catch {
      const message = scheduleErrorMessage(null);
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  const id = (name: string) => `email-schedule-${kind}-${name}`;
  return (
    <section className="space-y-4 rounded-lg border p-4" aria-label={labels.title} data-testid={`email-schedule-${kind}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">{labels.title}</p>
          <p className="mt-1 text-xs text-slate-500">{labels.blurb}</p>
        </div>
        <Switch checked={form.enabled} label={`${labels.title}: ${form.enabled ? "on" : "off"}`} disabled={!canEdit} onChange={(enabled) => set({ enabled })} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm font-medium text-slate-700" htmlFor={id("frequency")}>
          How often
          <select id={id("frequency")} className="mt-1 h-10 w-full rounded-lg border border-input bg-surface px-3 text-sm text-ink disabled:opacity-50" disabled={!canEdit} value={form.frequency} onChange={(e) => set({ frequency: e.target.value as EmailScheduleFrequency })}>
            {labels.frequencies.map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
          </select>
        </label>
        {form.frequency === "weekly" ? (
          <label className="text-sm font-medium text-slate-700" htmlFor={id("weekday")}>
            Day
            <select id={id("weekday")} className="mt-1 h-10 w-full rounded-lg border border-input bg-surface px-3 text-sm text-ink disabled:opacity-50" disabled={!canEdit} value={form.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>
              {WEEKDAYS.map((d) => <option key={d} value={d}>{weekdayName(d)}</option>)}
            </select>
          </label>
        ) : null}
        {form.frequency === "once" ? (
          <label className="text-sm font-medium text-slate-700" htmlFor={id("date")}>
            Date
            <Input id={id("date")} type="date" className="mt-1" disabled={!canEdit} value={form.onceDate} onChange={(e) => set({ onceDate: e.target.value })} />
          </label>
        ) : null}
        <label className="text-sm font-medium text-slate-700" htmlFor={id("time")}>
          Time of day
          <Input id={id("time")} type="time" className="mt-1" disabled={!canEdit} value={form.time} onChange={(e) => set({ time: e.target.value })} />
        </label>
      </div>

      {kind === "timesheet" ? (
        <div>
          <label className="text-sm font-medium text-slate-700" htmlFor={id("recipients")}>Send to</label>
          <Textarea id={id("recipients")} className="mt-1" rows={2} disabled={!canEdit} placeholder="Leave empty to send to every admin of this company" value={form.recipients} onChange={(e) => set({ recipients: e.target.value })} />
          <p className="mt-1 text-xs text-slate-500">One address per line, or separated by commas. Each person&apos;s timesheet is sent as its own e-mail.</p>
        </div>
      ) : (
        <p className="text-xs text-slate-500">Each reminder goes to the invoice&apos;s customer, at the e-mail address on their customer record. Customers without one are skipped.</p>
      )}

      <p className="text-sm font-medium text-slate-800" data-testid={`email-schedule-${kind}-next`} role="status">{preview}</p>
      {error ? <p className="text-sm text-red-600" role="alert">{error}</p> : null}
      <Button className="bg-brand text-brand-ink" aria-label={`Save ${labels.title}`} disabled={!canEdit || saving} onClick={() => void save()}>{saving ? "Saving..." : "Save"}</Button>
    </section>
  );
}

/**
 * Settings > Email schedules (migration 108): invoice reminders and timesheet e-mails, each On/Off with Daily, Weekly (a day) or Once (a
 * date and time), a time of day and, for timesheets, who gets them. Everyone in the company can read these; only an admin can change
 * them. Every schedule starts Off. Times are in UK time. While 108 is not applied the card says so and offers nothing to save.
 */
export function EmailSchedulesCard() {
  const { activeRole } = useUser();
  const [state, setState] = useState<{ phase: "loading" } | { phase: "unavailable" } | { phase: "error"; message: string } | { phase: "ready"; organizationId: string; forms: Record<EmailScheduleKind, ScheduleForm>; zone: string }>({ phase: "loading" });

  useEffect(() => {
    if (!supabase) return void setState({ phase: "unavailable" });
    let cancelled = false;
    void (async () => {
      try {
        const organizationId = await getCurrentOrganizationId();
        const { data, error } = await supabase!.from("email_schedules").select(COLUMNS).eq("organization_id", organizationId);
        if (cancelled) return;
        if (error) {
          const message = scheduleErrorMessage(error);
          return void setState(message === SCHEDULE_NOT_AVAILABLE ? { phase: "unavailable" } : { phase: "error", message: "Couldn't load the e-mail schedules. Reload the page to try again." });
        }
        const rows = (data ?? []) as Array<Parameters<typeof formFromRow>[1] & { kind: EmailScheduleKind }>;
        const forms = Object.fromEntries(KINDS.map((kind) => [kind, rows.find((r) => r.kind === kind) ? formFromRow(kind, rows.find((r) => r.kind === kind)!) : defaultForm(kind)])) as Record<EmailScheduleKind, ScheduleForm>;
        setState({ phase: "ready", organizationId, forms, zone: rows[0]?.timezone || "Europe/London" });
      } catch {
        if (!cancelled) setState({ phase: "error", message: "Couldn't load the e-mail schedules. Reload the page to try again." });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <Card data-testid="email-schedules-card">
      <CardHeader><CardTitle className="flex items-center gap-2"><CalendarClock className="size-5 text-brand-accent" /> Email schedules</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        {state.phase === "loading" ? <p className="text-slate-500">Loading...</p> : null}
        {state.phase === "unavailable" ? <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950" role="status">{SCHEDULE_NOT_AVAILABLE}</div> : null}
        {state.phase === "error" ? <p className="text-red-600" role="alert">{state.message}</p> : null}
        {state.phase === "ready" ? (
          <>
            <p className="text-slate-500">Set when Tolra sends reminders and timesheets for you. All times are UK time. {EXACT_TIME_SENDING ? "" : DAILY_RUN_NOTE} Nothing is sent until you turn a schedule on{activeRole === "admin" ? "" : "; only an admin can change them"}.</p>
            {KINDS.map((kind) => <ScheduleEditor key={kind} kind={kind} initial={state.forms[kind]} zone={state.zone} canEdit={activeRole === "admin"} organizationId={state.organizationId} />)}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
