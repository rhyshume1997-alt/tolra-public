"use client";

import { useEffect, useState } from "react";

import { databaseHas075 } from "@/lib/db-features";

/** null while asking; then whether migration 075 is applied (see databaseHas075). The site network settings, the On site only
 * toggle and the refused-time notice show only on true. */
export function useDatabaseHas075(enabled = true): boolean | null {
  const [present, setPresent] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void databaseHas075().then((value) => { if (active) setPresent(value); });
    return () => { active = false; };
  }, [enabled]);
  return present;
}
