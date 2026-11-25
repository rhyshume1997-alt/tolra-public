"use client";
/**
 * BOUNDARY (module 7, shared UI). Inputs: the current path and the company's confirmed ui-<screen>-v2:on switch (useCompanyUiSwitch, unchanged).
 * Output: while a screen whose switch is ON is open, puts the premium tokens class and data-ui-v2="on" on <html>, so the old shared controls
 * (Button, Input, Textarea, Select, Card, Tabs, Badge, Table, Dialog, Sheet, menus) that these screens still render, including portalled dialogs,
 * are drawn with the premium look by the "UI V2 SKIN" block in app/globals.css. Renders nothing.
 * Must not change: no behaviour, data, permission or route logic; switch OFF or unconfirmed removes both again; it never reads or writes settings.
 */
import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { premiumTokens } from "@/components/ui/premium";
import { useCompanyUiSwitch } from "@/lib/use-company-ui-switch";

/** Path prefix -> the screen's own switch (the same markers the screens already use). */
export const UI_V2_SKIN_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["/jobs", "ui-jobs-v2:on"], ["/quotes", "ui-quotes-v2:on"], ["/customers", "ui-customers-v2:on"], ["/invoices", "ui-invoices-v2:on"],
  ["/settings", "ui-settings-v2:on"], ["/dashboard", "ui-dashboard-v2:on"], ["/rfq", "ui-rfq-v2:on"], ["/purchase-orders", "ui-purchase-orders-v2:on"],
  ["/suppliers", "ui-suppliers-v2:on"], ["/delivery-notes", "ui-delivery-notes-v2:on"], ["/approval", "ui-approval-v2:on"], ["/time", "ui-time-v2:on"],
  ["/ai-helper", "ui-ai-v2:on"], ["/numbers", "ui-numbers-v2:on"], ["/email", "ui-email-v2:on"], ["/sales-orders", "ui-sales-orders-v2:on"],
  ["/schedule", "ui-schedule-v2:on"], ["/admin/activity", "ui-admin-activity-v2:on"], ["/admin/compliance", "ui-admin-security-v2:on"],
  ["/admin/data", "ui-admin-data-v2:on"], ["/admin/integrations/xero-organisation", "ui-admin-xero-v2:on"], ["/admin/integrations", "ui-admin-integrations-v2:on"],
  ["/admin/users", "ui-admin-users-v2:on"], ["/admin/iso", "ui-admin-iso-v2:on"],
];

/** The switch marker for a path, or "" when the path is not a v2 screen. Pure, so it is unit-tested. */
export function uiV2SkinMarker(pathname: string | null): string {
  if (!pathname) return "";
  const hit = UI_V2_SKIN_ROUTES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  return hit ? hit[1] : "";
}

export function UiV2Skin() {
  const marker = uiV2SkinMarker(usePathname());
  // The hook always runs; an unknown path asks for a marker that no company has, so it is OFF.
  const on = useCompanyUiSwitch(marker || "ui-none-v2:on") && marker !== "";
  useEffect(() => {
    if (!on) return;
    const root = document.documentElement;
    const classes = premiumTokens.split(" ").filter(Boolean);
    root.classList.add(...classes);
    root.setAttribute("data-ui-v2", "on");
    return () => { root.classList.remove(...classes); root.removeAttribute("data-ui-v2"); };
  }, [on]);
  return null;
}
