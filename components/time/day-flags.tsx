"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { friendlyError } from "@/lib/friendly-error";
import { newClientOpId } from "@/lib/machine-runs";
import { supabase } from "@/lib/supabase";
import {
  DAY_FLAGS_FUTURE, DAY_FLAGS_LOADING, DAY_FLAGS_NEED_CONNECTION, DAY_FLAG_KEYS, DAY_FLAG_LABEL, type DayFlagKey, type DayFlags,
  type DayFlagsLoadState, createDayFlagsLoader, databaseHasDayFlags, dayFlagsEditable, effectiveDayFlags, loadDayFlags, pickFlags, saveDayFlags,
} from "@/lib/time-day-flags";
import { type DayTotals, localDateOf } from "@/lib/time-sheet";

type Probe = Parameters<typeof databaseHasDayFlags>[0];

/**
 * The day line's four tick boxes (migration 074): Overtime, Saturday, Sunday, Bank holiday. Shown only once the database has 074 (a
 * GET probe); before that nothing at all. With nothing saved for the day the boxes show the suggestions (Saturday, Sunday and Bank
 * holiday from the date and the company's bank holidays; never Overtime, which only a person ticks), marked "suggested": ticking or unticking saves all four, Confirm saves them as shown. Saving needs
 * a connection (not queued on the device) and a day that has started. An approved week is refused by the server for everyone but an
 * admin; its message is shown. Loads are latest-only (lib/time-day-flags createDayFlagsLoader): one day's ticks never show on another.
 */
export function DayFlagsCard({ date, personId, day, bankHolidays, offline }: {
  date: string; personId: string; day: DayTotals; bankHolidays: Map<string, string>; offline: boolean;
}) {
  const [state, setState] = useState<DayFlagsLoadState>(DAY_FLAGS_LOADING);
  const [busy, setBusy] = useState(false);
  const loader = useMemo(() => createDayFlagsLoader({
    probe: () => databaseHasDayFlags(supabase as unknown as Probe),
    read: (opts) => (supabase ? loadDayFlags(supabase, opts) : Promise.resolve({ present: false, rows: [] })),
    onState: setState,
    onError: (err) => friendlyError(err, "Couldn't load the day's ticks."),
  }), []);
  useEffect(() => { void loader.load(personId, date); }, [loader, personId, date]);

  const { present, saved, loaded, error } = state;
  const shown = useMemo(() => effectiveDayFlags(day, saved, bankHolidays, true), [day, saved, bankHolidays]);
  const editable = dayFlagsEditable(date, localDateOf(new Date()));

  async function save(flags: DayFlags) {
    if (!supabase || !editable) return;
    if (offline || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      toast.error(DAY_FLAGS_NEED_CONNECTION);
      return;
    }
    const token = loader.token();
    setBusy(true);
    try {
      const row = await saveDayFlags(supabase, { clientOpId: newClientOpId(), userId: personId, day: date, flags });
      // The person or day changed while saving: the sheet now shows another day, so this answer isn't shown on it.
      if (loader.isCurrent(token)) setState({ present: true, saved: row, loaded: true, error: null });
      toast.success("Day ticks saved.");
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't save the day's ticks. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }
  const toggle = (k: DayFlagKey, on: boolean) => void save({ ...pickFlags(shown.flags), [k]: on });
  const disabled = !loaded || busy || offline || !editable;

  if (present !== true) return null;
  return (
    <Card data-testid="day-flags">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">Day ticks</CardTitle>
        {loaded && !saved ? (
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => void save(pickFlags(shown.flags))} data-testid="day-flags-confirm">Confirm</Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-2">
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {DAY_FLAG_KEYS.map((k) => (
            <label key={k} className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" className="size-5" checked={shown.flags[k]} disabled={disabled}
                onChange={(e) => toggle(k, e.target.checked)} data-testid={`day-flag-${k}`} />
              {DAY_FLAG_LABEL[k]}
            </label>
          ))}
        </div>
        <p className="text-xs text-slate-500" data-testid="day-flags-state">
          {!editable ? `${DAY_FLAGS_FUTURE} ` : offline ? `${DAY_FLAGS_NEED_CONNECTION} ` : ""}
          {saved
            ? "Saved. Flags only: no rates or pay are worked out here."
            : "Suggested from the date (not saved yet, not counted on the weekly hours): untick what doesn't apply, or press Confirm."}
        </p>
      </CardContent>
    </Card>
  );
}
