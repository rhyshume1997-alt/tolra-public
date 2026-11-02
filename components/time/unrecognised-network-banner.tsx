"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { loadUnrecognisedClockActions, unrecognisedBannerText, unrecognisedBatch } from "@/lib/site-network";
import { supabase } from "@/lib/supabase";
import { useDatabaseHas075 } from "@/lib/use-database-has-075";
import { useUser } from "@/lib/use-user";

const storageKey = (userId: string) => `tolra.unrecognised-network-dismissed.${userId}`;

/**
 * Warning for admins on the dashboard and Time pages: clock actions of the last 7 days came from a network that is not a saved
 * workshop network (075: recorded while the clock-in check is on), so a changed workshop internet address is noticed quickly. Links to
 * Settings > Workshop network. "Dismiss" hides this batch only: it is remembered in this browser as the time of the newest clock action
 * dismissed, so a later clock action from an unrecognised network shows the banner again. Read only: it never saves a network. Admin
 * only; hidden until the database has 075, when there is nothing to show, and on a read error.
 */
export function UnrecognisedNetworkBanner() {
  const { profile, activeRole } = useUser();
  const enabled = activeRole === "admin" && Boolean(profile);
  const has075 = useDatabaseHas075(enabled) === true;
  const userId = profile?.id ?? null;
  const [batch, setBatch] = useState<{ count: number; latest: string } | null>(null);

  useEffect(() => {
    if (!enabled || !has075 || !supabase || !userId) return;
    let active = true;
    void (async () => {
      try {
        const rows = await loadUnrecognisedClockActions(supabase!);
        let dismissed: string | null = null;
        try { dismissed = window.localStorage.getItem(storageKey(userId)); } catch { /* storage blocked: show the banner */ }
        if (active) setBatch(unrecognisedBatch(rows, dismissed));
      } catch {
        if (active) setBatch(null);
      }
    })();
    return () => { active = false; };
  }, [enabled, has075, userId]);

  const dismiss = useCallback(() => {
    if (batch && userId) {
      try { window.localStorage.setItem(storageKey(userId), batch.latest); } catch { /* the banner just comes back next visit */ }
    }
    setBatch(null);
  }, [batch, userId]);

  if (!enabled || !has075 || !batch) return null;
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="alert" data-testid="unrecognised-network-banner">
      <p className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span>
          {unrecognisedBannerText(batch.count)}{" "}
          <Link className="font-medium underline" href="/settings#workshop-network" data-testid="unrecognised-network-link">Open Settings &gt; Workshop network</Link>
        </span>
      </p>
      <Button size="sm" variant="outline" onClick={dismiss} aria-label="Dismiss this warning" data-testid="unrecognised-network-dismiss"><X className="size-4" /></Button>
    </div>
  );
}
