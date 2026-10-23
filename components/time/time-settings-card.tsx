"use client";

import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { friendlyError } from "@/lib/friendly-error";
import { NeedsDatabaseUpdate } from "@/components/time/needs-update";
import { supabase } from "@/lib/supabase";
import { databaseHasTime, missingDbObject } from "@/lib/time-features";
import { type TimeSettings, DEFAULT_TIME_SETTINGS, settingsFromRow } from "@/lib/time-sheet";

/**
 * Settings > Hours (migration 050, admins): how the daily job sheet works out paid time. Hours only; no rates.
 * Defaults are the JNR controller's answers of Sun 18 Oct 2026: breaks are unpaid, and overtime is not worked out (a day tick, 074). The old overtime
 * settings (after N hours, Saturday / Sunday / bank holiday, rate) are hidden: they are not used for any figure, but the database still has
 * them, so they are loaded and saved back unchanged.
 */
export function TimeSettingsCard() {
  const [s, setS] = useState<TimeSettings>(DEFAULT_TIME_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [needsUpdate, setNeedsUpdate] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    void (async () => {
      if ((await databaseHasTime()) === false) {
        setNeedsUpdate(true);
        return;
      }
      const { data, error } = await supabase!.from("time_settings").select("*").maybeSingle();
      if (missingDbObject(error)) {
        setNeedsUpdate(true);
        return;
      }
      if (error) {
        setLoadError(friendlyError(error, "Couldn't load the hours settings. Reload the page to try again."));
        return;
      }
      setS(settingsFromRow(data as Record<string, unknown> | null));
      setLoaded(true);
    })();
  }, []);

  async function save() {
    if (!supabase) return;
    setSaving(true);
    const { error } = await supabase.rpc("save_time_settings", { p_settings: {
      breaks_paid: s.breaksPaid, lunch_minutes: s.lunchMinutes, break_minutes: s.breakMinutes, break_min_day_hours: s.breakMinDayHours,
      daily_overtime_hours: s.dailyOvertimeHours, saturday_overtime: s.saturdayOvertime, sunday_overtime: s.sundayOvertime,
      bank_holiday_overtime: s.bankHolidayOvertime, overtime_multiplier: s.overtimeMultiplier,
      approver_roles: s.approverRoles.includes("office") ? ["admin", "office"] : ["admin"], long_session_hours: s.longSessionHours,
    } });
    setSaving(false);
    if (error) toast.error(friendlyError(error, "Couldn't save the hours settings."));
    else toast.success("Hours settings saved.");
  }

  const num = (key: keyof TimeSettings, label: string, step = 1, hint?: string) => (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <Input type="number" step={step} min={0} value={String(s[key])} onChange={(e) => setS({ ...s, [key]: Number(e.target.value) })} className="w-32" />
      {hint ? <span className="text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
  const tick = (key: keyof TimeSettings, label: string, hint?: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={Boolean(s[key])} onChange={(e) => setS({ ...s, [key]: e.target.checked })} />
      <span>{label}{hint ? <span className="block text-xs text-amber-700">{hint}</span> : null}</span>
    </label>
  );

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Timer className="size-5 text-brand-accent" /> Hours</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {needsUpdate ? <NeedsDatabaseUpdate /> : <>
        <p className="text-sm text-slate-500">How Weekly hours works out paid time. Hours only: Tolra holds no pay rates. Overtime is not worked out: tick Overtime on the day.</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tick("breaksPaid", "Breaks are paid", "Off: breaks are unpaid and deducted (JNR, confirmed Sun 18 Oct).")}
          {num("lunchMinutes", "Lunch (minutes)")}
          {num("breakMinutes", "Break (minutes)")}
          {num("breakMinDayHours", "Deduct breaks on days of at least (hours)", 0.25, "On those days the greater of lunch + break and the clocked breaks is deducted; on shorter days only clocked breaks.")}
          {num("longSessionHours", "Flag clock-ins or job time left running after (hours)")}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={s.approverRoles.includes("office")} onChange={(e) => setS({ ...s, approverRoles: e.target.checked ? ["admin", "office"] : ["admin"] })} />
            <span>Office can approve weekly hours too<span className="block text-xs text-slate-500">Admins always can.</span></span>
          </label>
        </div>
        {loadError ? <p className="text-sm text-red-700" role="alert">{loadError}</p> : null}
        <Button disabled={!loaded || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save hours settings"}</Button>
        </>}
      </CardContent>
    </Card>
  );
}
