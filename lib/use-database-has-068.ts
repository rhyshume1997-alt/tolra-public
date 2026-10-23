"use client";

import { useEffect, useState } from "react";

import { databaseHas068 } from "@/lib/db-features";

/** null while asking; then whether migration 068 is applied (see databaseHas068). Quote versions and line choices show only on true. */
export function useDatabaseHas068(enabled = true): boolean | null {
  const [present, setPresent] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void databaseHas068().then((value) => { if (active) setPresent(value); });
    return () => { active = false; };
  }, [enabled]);
  return present;
}
