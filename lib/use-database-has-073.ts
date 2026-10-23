"use client";

import { useEffect, useState } from "react";

import { databaseHas073 } from "@/lib/db-features";

/** null while asking; then whether migration 073 is applied (see databaseHas073). Void, £0 text lines, the invoice note, the delivery
 * address and the customer's mobile show only on true. */
export function useDatabaseHas073(enabled = true): boolean | null {
  const [present, setPresent] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void databaseHas073().then((value) => { if (active) setPresent(value); });
    return () => { active = false; };
  }, [enabled]);
  return present;
}
