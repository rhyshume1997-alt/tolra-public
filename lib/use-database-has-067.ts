"use client";

import { useEffect, useState } from "react";

import { databaseHas067 } from "@/lib/db-features";

/** null while asking; then whether migration 067 is applied (see databaseHas067). Features that need it show only on true. */
export function useDatabaseHas067(enabled = true): boolean | null {
  const [present, setPresent] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void databaseHas067().then((value) => { if (active) setPresent(value); });
    return () => { active = false; };
  }, [enabled]);
  return present;
}
