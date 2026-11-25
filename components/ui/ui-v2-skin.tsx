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

/** Path -> the screen's own switch (the same markers the screens already use). `exact`: only that exact path (no nested URLs). `requires`: the second marker the screen's own hook also needs. */
export const UI_V2_SKIN_ROUTES: ReadonlyArray<{ prefix: string; marker: string; exact?: boolean; requires?: string }> = [
  { prefix: "/jobs", marker: "ui-jobs-v2:on" }, { prefix: "/quotes", marker: "ui-quotes-v2:on" }, { prefix: "/customers", marker: "ui-customers-v2:on" },
  { prefix: "/invoices", marker: "ui-invoices-v2:on" }, { prefix: "/settings", marker: "ui-settings-v2:on" },
  { prefix: "/dashboard", marker: "ui-dashboard-v2:on", exact: true },
  { prefix: "/reports", marker: "ui-reports-v2:on", requires: "reports:on" },
  { prefix: "/rfq", marker: "ui-rfq-v2:on" }, { prefix: "/purchase-orders", marker: "ui-purchase-orders-v2:on" },
  { prefix: "/suppliers", marker: "ui-suppliers-v2:on" }, { prefix: "/delivery-notes", marker: "ui-delivery-notes-v2:on" }, { prefix: "/approval", marker: "ui-approval-v2:on" },
  { prefix: "/time", marker: "ui-time-v2:on" }, { prefix: "/ai-helper", marker: "ui-ai-v2:on" }, { prefix: "/numbers", marker: "ui-numbers-v2:on" },
  { prefix: "/email", marker: "ui-email-v2:on" }, { prefix: "/sales-orders", marker: "ui-sales-orders-v2:on" }, { prefix: "/schedule", marker: "ui-schedule-v2:on" },
  { prefix: "/admin/activity", marker: "ui-admin-activity-v2:on" }, { prefix: "/admin/compliance", marker: "ui-admin-security-v2:on" },
  { prefix: "/admin/data", marker: "ui-admin-data-v2:on" }, { prefix: "/admin/integrations/xero-organisation", marker: "ui-admin-xero-v2:on" },
  { prefix: "/admin/integrations", marker: "ui-admin-integrations-v2:on" }, { prefix: "/admin/users", marker: "ui-admin-users-v2:on" }, { prefix: "/admin/iso", marker: "ui-admin-iso-v2:on" },
];

/** The route entry for a path, or undefined when the path is not a v2 screen. Pure, so it is unit-tested. */
export function uiV2SkinRoute(pathname: string | null) {
  if (!pathname) return undefined;
  return UI_V2_SKIN_ROUTES.find(({ prefix, exact }) => pathname === prefix || (!exact && pathname.startsWith(`${prefix}/`)));
}

/** The switch marker for a path, or "" when the path is not a v2 screen. */
export function uiV2SkinMarker(pathname: string | null): string {
  return uiV2SkinRoute(pathname)?.marker ?? "";
}

/** Adds or removes exactly the skin's own class names and attribute on a root element; returns whether it is now on. Pure DOM, unit-tested. */
export function applyUiV2Skin(root: Element, on: boolean): boolean {
  const classes = premiumTokens.split(" ").filter(Boolean);
  if (on) { root.classList.add(...classes); root.setAttribute("data-ui-v2", "on"); }
  else { root.classList.remove(...classes); root.removeAttribute("data-ui-v2"); }
  return on;
}

export function UiV2Skin() {
  const route = uiV2SkinRoute(usePathname());
  // The hook always runs; an unknown path asks for a marker no company has, so it is OFF. Unconfirmed or failed settings reads are OFF inside the hook.
  const confirmed = useCompanyUiSwitch(route?.marker ?? "ui-none-v2:on", route?.requires);
  const on = Boolean(route) && confirmed;
  useEffect(() => {
    if (!on) return;
    applyUiV2Skin(document.documentElement, true);
    return () => { applyUiV2Skin(document.documentElement, false); };
  }, [on]);
  return null;
}
