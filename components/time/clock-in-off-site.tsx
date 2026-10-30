"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { databaseHas114, loadOffSiteAllowed, setOffSiteAllowed } from "@/lib/clock-in-lock";
import { friendlyError } from "@/lib/friendly-error";
import { supabase } from "@/lib/supabase";

/**
 * Admin > Users (114, M27): who "Can clock in off site (while the network lock is on)". The lock covers everyone by default; this is
 * the only exception, and it matters only while an admin has locked clock-in (Settings). Separate from 075's "On site only" (the Flag
 * check). Hidden until the database has 114; while the list can't be read the toggle is not shown, so nobody's setting is guessed.
 * Admin only (the database refuses anyone else, and an admin before the second step where the company requires it).
 */
export function useClockInOffSite() {
  const [has114, setHas114] = useState(false);
  const [allowed, setAllowed] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void databaseHas114(supabase).then((v) => { if (active) setHas114(v); });
    return () => { active = false; };
  }, []);
  const load = useCallback(async () => {
    if (!supabase || !has114) return;
    setAllowed(await loadOffSiteAllowed(supabase).catch(() => null));
  }, [has114]);
  useEffect(() => { void load(); }, [load]);

  async function set(userId: string, name: string, value: boolean) {
    if (!supabase) return;
    setSaving(userId);
    try {
      await setOffSiteAllowed(supabase, userId, value);
      toast.success(value ? `${name}: can clock in off site while the network lock is on.` : `${name}: clocks in from the locked network.`);
      await load();
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't save the off-site setting."));
    } finally {
      setSaving(null);
    }
  }
  return { available: has114 && allowed !== null, allowed, saving, set };
}

export function ClockInOffSiteToggle({ userId, name, state }: { userId: string; name: string; state: ReturnType<typeof useClockInOffSite> }) {
  if (!state.available || !state.allowed) return null;
  return (
    <label className="mt-1 flex w-fit items-center gap-1.5 text-xs text-slate-600" data-testid="clock-in-off-site" title="While clock-in is locked to the workshop network (Settings), only people ticked here can clock in from another network.">
      <input type="checkbox" checked={state.allowed.has(userId)} disabled={state.saving === userId} onChange={(e) => void state.set(userId, name, e.target.checked)} />
      Can clock in off site (while the network lock is on)
    </label>
  );
}
