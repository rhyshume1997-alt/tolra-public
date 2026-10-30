"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { WifiOff } from "lucide-react";

import { type UnverifiedClockAction, UNVERIFIED_REASON_TEXT, databaseHas114, loadUnverifiedClockActions } from "@/lib/clock-in-lock";
import { supabase } from "@/lib/supabase";
import { ACTION_TEXT } from "@/lib/time-sync-rejections";
import { addDays, localDateOf, startOfLocalDay } from "@/lib/time-sheet";

/**
 * Week review (114, M27): the week's clock actions the clock-in network lock could NOT check (made while clock-in was locked, by someone
 * On site only, and synced later from an offline queue, or with no network address seen). They were kept; this lists them per person so
 * the office can ask about them. Office and admin only (row rules: a person would see only their own); hidden until the database has 114,
 * and when there are none. A read error hides it; the week review itself is unaffected.
 */
export function NetworkUnverifiedNotice({ enabled, week, nameOf }: { enabled: boolean; week: string; nameOf: (userId: string) => string }) {
  const [rows, setRows] = useState<UnverifiedClockAction[]>([]);

  useEffect(() => {
    if (!enabled || !supabase) return;
    let active = true;
    void (async () => {
      try {
        if (!(await databaseHas114(supabase))) return;
        const found = await loadUnverifiedClockActions(supabase!, startOfLocalDay(week), startOfLocalDay(addDays(week, 7)));
        if (active) setRows(found);
      } catch {
        if (active) setRows([]);
      }
    })();
    return () => { active = false; };
  }, [enabled, week]);

  if (!enabled || !rows.length) return null;
  const people = [...new Set(rows.map((r) => r.user_id))];
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="network-unverified">
      <p className="flex items-start gap-2 font-medium">
        <WifiOff className="mt-0.5 size-4 shrink-0" />
        {rows.length === 1 ? "1 clock action" : `${rows.length} clock actions`} this week {rows.length === 1 ? "was" : "were"} kept without a network check (clock-in is locked to the workshop network).
      </p>
      <ul className="mt-2 space-y-1">
        {people.map((userId) => (
          <li key={userId} data-testid="network-unverified-person">
            <span className="font-medium">{nameOf(userId)}</span>:{" "}
            {rows.filter((r) => r.user_id === userId).map((r, i) => (
              <span key={r.event_id}>
                {i ? "; " : ""}
                <Link className="underline" href={`/time?date=${localDateOf(r.at)}&user=${r.user_id}`}>
                  {ACTION_TEXT[r.action] ?? r.action} {new Date(r.at).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </Link>{" "}
                ({UNVERIFIED_REASON_TEXT[r.reason] ?? r.reason})
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
