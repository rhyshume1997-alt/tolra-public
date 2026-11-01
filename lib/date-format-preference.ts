"use client";

/**
 * The signed-in person's date format (migration 109: public.user_preferences, one row per login, row-level security: their own row
 * only; nobody else, admins included, reads or changes it). Read once by the dashboard shell and applied to every date the app
 * formats (lib/dates). This browser keeps a copy per person so the next page load shows their format straight away, offline too.
 * Before 109 is applied (or offline with no copy) dates show in the default, DD/MM/YYYY, as before.
 */
import { useEffect, useSyncExternalStore } from "react";

import { missingDbObject } from "@/lib/db-features";
import { DEFAULT_DATE_FORMAT, type DateFormat, getDateFormat, isDateFormat, parseDateFormat, primeDateFormat, setDateFormat, subscribeDateFormat } from "@/lib/dates";
import { supabase } from "@/lib/supabase";

const KEY_PREFIX = "tolra-date-format:";

function readCopy(userId: string): DateFormat | null {
  try {
    const value = window.localStorage.getItem(KEY_PREFIX + userId);
    return isDateFormat(value) ? value : null;
  } catch {
    return null;
  }
}

function writeCopy(userId: string, format: DateFormat) {
  try {
    if (format === DEFAULT_DATE_FORMAT) window.localStorage.removeItem(KEY_PREFIX + userId);
    else window.localStorage.setItem(KEY_PREFIX + userId, format);
  } catch {
    // Storage unavailable: the format still applies to this page load.
  }
}

/** The format dates show in now; re-renders the caller when it changes. */
export function useDateFormat(): DateFormat {
  return useSyncExternalStore(subscribeDateFormat, getDateFormat, () => DEFAULT_DATE_FORMAT);
}

/** null: the database has no 109 yet (the setting can't be saved). Otherwise the stored format (the default when none is stored). */
export async function loadDateFormat(userId: string): Promise<DateFormat | null> {
  if (!supabase) return DEFAULT_DATE_FORMAT;
  const { data, error } = await supabase.from("user_preferences").select("date_format").eq("user_id", userId).maybeSingle();
  if (error) {
    if (missingDbObject(error)) return null;
    throw error;
  }
  return parseDateFormat((data as { date_format?: unknown } | null)?.date_format);
}

/** Saves the person's own format (their row only, under RLS) and applies it. Throws on failure; nothing changes then. */
export async function saveDateFormat(userId: string, format: DateFormat) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { error } = await supabase.from("user_preferences").upsert({ user_id: userId, date_format: format }, { onConflict: "user_id" });
  if (error) throw error;
  writeCopy(userId, format);
  setDateFormat(format);
}

/** The person the format was last primed for in this tab (undefined: nobody yet). */
let primedFor: string | null | undefined;

/**
 * Before anything dated renders for a (new) person: their copy from this browser, or the default when they have none, when nobody is
 * signed in, or when the person changed without a page reload (sign-in after sign-out moves pages with router.replace). Only when the
 * person changes; returns whether it primed. Never notifies (it runs during the shell's render).
 */
export function primeForUser(userId: string | null | undefined): boolean {
  if (typeof window === "undefined" || userId === primedFor) return false;
  primedFor = userId;
  primeDateFormat((userId ? readCopy(userId) : null) ?? DEFAULT_DATE_FORMAT);
  return true;
}

/**
 * Applies the signed-in person's format: this browser's copy (or the default) before the first page renders, then the stored one when
 * the database answers. A change is applied without redrawing the page: the shell (sidebar, top bar, offline banner) re-renders at
 * once and the page content picks it up on its next render or navigation, so an open dialog or an unsaved edit is never lost.
 */
export function useDateFormatPreference(userId: string | null | undefined): DateFormat {
  primeForUser(userId);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    loadDateFormat(userId).then(
      (format) => {
        if (!live) return;
        // No 109 (not applied yet, or rolled back): nothing can be stored, so the default, and this browser's copy goes.
        const next = format ?? DEFAULT_DATE_FORMAT;
        writeCopy(userId, next);
        setDateFormat(next);
      },
      () => {
        // Offline or a failed read: keep the copy (or the default) until the next page load asks again.
      },
    );
    return () => {
      live = false;
    };
  }, [userId]);
  return useDateFormat();
}
