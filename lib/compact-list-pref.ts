"use client";

import { useCallback, useEffect, useState } from "react";

import { useUser } from "@/lib/use-user";
import { viewModeKey } from "@/lib/view-mode";

/** localStorage key for a page's Compact list switch: the view-mode key (per signed-in person, per page, this device). */
export const compactListKey = (userId: string | undefined, page: string) => viewModeKey(userId, `${page}-compact`);

export function readCompactList(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "on";
  } catch {
    return false;
  }
}

export function writeCompactList(key: string, on: boolean): void {
  try {
    window.localStorage.setItem(key, on ? "on" : "off");
  } catch {
    // not remembered (private window); the choice still applies now
  }
}

/** Whether a list page shows its dense one-line-per-record table, remembered per person per page like useViewMode. Off until chosen. */
export function useCompactList(page: string): [boolean, (on: boolean) => void] {
  const { user } = useUser();
  const key = compactListKey(user?.id, page);
  const [on, setOn] = useState(false);
  useEffect(() => { setOn(readCompactList(key)); }, [key]);
  const choose = useCallback((next: boolean) => {
    setOn(next);
    writeCompactList(key, next);
  }, [key]);
  return [on, choose];
}
