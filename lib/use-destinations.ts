"use client";

import { useCallback } from "react";

import { canOpenDestination } from "@/lib/destinations";
import { useOrgSettings } from "@/lib/org-settings";
import { useUser } from "@/lib/use-user";

/** `canOpen(href)`: true when that page opens for this person in the view they are working in (lib/destinations). */
export function useCanOpen() {
  const { activeRole, hiddenSections } = useUser();
  const { hiddenNav } = useOrgSettings();
  return useCallback((href: string) => canOpenDestination(href, { activeRole, hiddenSections, hiddenNav }), [activeRole, hiddenNav, hiddenSections]);
}
