"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { friendlyError } from "@/lib/friendly-error";
import { newClientOpId } from "@/lib/machine-runs";
import { loadOnSiteOnly, setOnSiteOnly } from "@/lib/site-network";
import { supabase } from "@/lib/supabase";
import { useDatabaseHas075 } from "@/lib/use-database-has-075";

/**
 * Admin > Users (075, B40 phase 1): who is "On site only" (their clock actions are checked against the site network while the check is
 * on: flagged, never refused) and who "Can work off site" (the default: never checked). Hidden until the database has 075; while the
 * flags can't be read the toggle is not shown, so nobody's setting is guessed.
 */
export function useOnSiteOnly() {
  const has075 = useDatabaseHas075() === true;
  const [flags, setFlags] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!supabase || !has075) return;
    setFlags(await loadOnSiteOnly(supabase).catch(() => null));
  }, [has075]);
  useEffect(() => { void load(); }, [load]);

  async function set(userId: string, name: string, value: boolean) {
    if (!supabase) return;
    setSaving(userId);
    try {
      await setOnSiteOnly(supabase, newClientOpId(), userId, value);
      toast.success(value ? `${name}: on site only.` : `${name}: can work off site.`);
      await load();
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't save the on-site setting."));
    } finally {
      setSaving(null);
    }
  }
  return { available: has075 && flags !== null, flags, saving, set };
}

export function OnSiteOnlyToggle({ userId, name, state }: { userId: string; name: string; state: ReturnType<typeof useOnSiteOnly> }) {
  if (!state.available || !state.flags) return null;
  const on = state.flags.has(userId);
  return (
    <label className="mt-1 flex w-fit items-center gap-1.5 text-xs text-slate-600" data-testid="on-site-only" title="On site only: clock-ins from another network are flagged for the office (never refused) while the check is on in Settings.">
      <input type="checkbox" checked={on} disabled={state.saving === userId} onChange={(e) => void state.set(userId, name, e.target.checked)} />
      On site only
    </label>
  );
}
