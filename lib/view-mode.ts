"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { DESK_QUERY, effectiveViewMode } from "@/lib/shell-status";
import { useUser } from "@/lib/use-user";

/** How a list page shows its records: cards, compact one-line rows, or the full table. */
export type ViewMode = "cards" | "list" | "table";
export const VIEW_MODES: ViewMode[] = ["cards", "list", "table"];

/** True on screens wider than 1024px (the fixed-sidebar, dense-table layout). Wide while rendering on the server. */
export function useIsWide(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(DESK_QUERY);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(DESK_QUERY).matches,
    () => true,
  );
}

/** True below the md breakpoint (phones): the Job Board's pickers open as bottom sheets there. False while rendering on the server. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia("(max-width: 767px)");
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia("(max-width: 767px)").matches,
    () => false,
  );
}

/** localStorage key: per signed-in person and per page, on this device. */
export const viewModeKey = (userId: string | undefined, page: string) => `view-mode:${userId ?? "anon"}:${page}`;

export function readViewMode(key: string, fallback: ViewMode): ViewMode {
  try {
    const stored = window.localStorage.getItem(key);
    return VIEW_MODES.includes(stored as ViewMode) ? (stored as ViewMode) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The view chosen for a list page, remembered per person per page (this device). Phones always show cards: the
 * pages render their card layout below the md breakpoint whatever is chosen here. Up to 1024px a chosen "table" is
 * returned as "cards" (see effectiveViewMode).
 */
export function useViewMode(page: string, fallback: ViewMode): [ViewMode, (mode: ViewMode) => void] {
  const { user } = useUser();
  const key = viewModeKey(user?.id, page);
  const [mode, setMode] = useState<ViewMode>(fallback);
  const wide = useIsWide();
  useEffect(() => { setMode(readViewMode(key, fallback)); }, [key, fallback]);
  const choose = useCallback((next: ViewMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(key, next);
    } catch {
      // not remembered (private window); the choice still applies now
    }
  }, [key]);
  return [effectiveViewMode(mode, wide), choose];
}
