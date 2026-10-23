"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";

export type NavToggle = { key: string; href: string; label: string; section: string };

/** Hideable sidebar items. key = href without the leading slash. Dashboard and Settings are never hideable. */
export const NAV_TOGGLES: NavToggle[] = [
  { key: "email", href: "/email", label: "Email & Payment Automation", section: "Sales Pipeline" },
  { key: "rfq", href: "/rfq", label: "RFQ Control Centre", section: "Sales Pipeline" },
  { key: "quotes", href: "/quotes", label: "Quote Generator", section: "Sales Pipeline" },
  { key: "sales-orders", href: "/sales-orders", label: "Sales Orders", section: "Sales Pipeline" },
  { key: "jobs", href: "/jobs", label: "Job Board", section: "Operations" },
  { key: "schedule", href: "/schedule", label: "Machine Schedule", section: "Operations" },
  { key: "time", href: "/time", label: "Weekly hours", section: "Operations" },
  { key: "invoices", href: "/invoices", label: "Invoicing", section: "Operations" },
  { key: "approval", href: "/approval", label: "Approval Queue", section: "Operations" },
  { key: "purchase-orders", href: "/purchase-orders", label: "Purchase Orders", section: "Operations" },
  { key: "delivery-notes", href: "/delivery-notes", label: "Delivery Notes", section: "Operations" },
  { key: "customers", href: "/customers", label: "Customers", section: "Resources" },
  { key: "suppliers", href: "/suppliers", label: "Suppliers", section: "Resources" },
  { key: "admin/users", href: "/admin/users", label: "User Management", section: "Resources" },
  { key: "admin/activity", href: "/admin/activity", label: "Activity", section: "Resources" },
  { key: "admin/compliance", href: "/admin/compliance", label: "Security", section: "Resources" },
  { key: "admin/integrations", href: "/admin/integrations", label: "Integrations", section: "Resources" },
];

export const NEVER_HIDDEN_HREFS = ["/dashboard", "/settings"];

export type ColumnDef = { key: string; label: string };
export type TableDef = { key: string; label: string; columns: ColumnDef[] };

/** Selection checkbox and Actions columns are always shown, so they are not listed. */
export const COLUMN_TABLES: TableDef[] = [
  { key: "quotes", label: "Quotes", columns: [{ key: "ref", label: "Quote" }, { key: "date", label: "Date" }, { key: "customer", label: "Customer" }, { key: "description", label: "Description" }, { key: "status", label: "Status" }, { key: "value", label: "Value" }, { key: "valid", label: "Valid until" }] },
  { key: "sales-orders", label: "Sales Orders", columns: [{ key: "ref", label: "SO Ref" }, { key: "customer", label: "Customer" }, { key: "date", label: "Order Date" }, { key: "delivery", label: "Expected Delivery" }, { key: "value", label: "Value" }, { key: "status", label: "Status" }] },
  { key: "purchase-orders", label: "Purchase Orders", columns: [{ key: "ref", label: "PO Ref" }, { key: "supplier", label: "Supplier" }, { key: "date", label: "Order Date" }, { key: "delivery", label: "Expected Delivery" }, { key: "value", label: "Total (inc VAT)" }, { key: "status", label: "Status" }] },
  { key: "invoices", label: "Invoices", columns: [{ key: "invoice", label: "Invoice" }, { key: "customer", label: "Customer" }, { key: "status", label: "Status" }, { key: "amount", label: "Amount" }] },
  { key: "delivery-notes", label: "Delivery Notes", columns: [{ key: "ref", label: "DN Ref" }, { key: "customer", label: "Customer" }, { key: "job", label: "Job Ref" }, { key: "date", label: "Delivery Date" }, { key: "status", label: "Status" }, { key: "email", label: "Email" }] },
  { key: "customers", label: "Customers", columns: [{ key: "name", label: "Name" }, { key: "contact", label: "Contact" }, { key: "email", label: "Email" }, { key: "phone", label: "Phone" }, { key: "address", label: "Address" }] },
  { key: "suppliers", label: "Suppliers", columns: [{ key: "name", label: "Name" }, { key: "contact", label: "Contact" }, { key: "email", label: "Email" }, { key: "phone", label: "Phone" }, { key: "notes", label: "Notes" }] },
];

export type OrgSettings = {
  hiddenNav: string[];
  hiddenColumns: Record<string, string[]>;
  loaded: boolean;
  /** true when settings are only stored in this browser (Supabase unavailable). */
  localOnly: boolean;
};

const STORAGE_KEY = "quoteflow-org-settings";
/** Local fallback is keyed by user id so one person's settings never leak to the next sign-in on this browser. */
let currentUserId: string | null = null;

async function resolveUserId(): Promise<string | null> {
  if (currentUserId) return currentUserId;
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getUser();
    currentUserId = data.user?.id ?? null;
  } catch {
    currentUserId = null;
  }
  return currentUserId;
}

const storageKey = () => (currentUserId ? `${STORAGE_KEY}:${currentUserId}` : STORAGE_KEY);
const EMPTY: OrgSettings = { hiddenNav: [], hiddenColumns: {}, loaded: false, localOnly: false };

let state: OrgSettings = EMPTY;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(next: OrgSettings) {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function cleanColumns(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [table, cols] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(cols)) out[table] = cols.filter((col): col is string => typeof col === "string");
    }
  }
  return out;
}

function cleanNav(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Call on sign-out: clears the cached settings and forgets the user so the next sign-in reloads cleanly. */
export function resetOrgSettings() {
  currentUserId = null;
  loadPromise = null;
  setState(EMPTY);
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function readLocal(): { hiddenNav: string[]; hiddenColumns: Record<string, string[]> } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey()) || "{}");
    return { hiddenNav: cleanNav(parsed.hiddenNav), hiddenColumns: cleanColumns(parsed.hiddenColumns) };
  } catch {
    return { hiddenNav: [], hiddenColumns: {} };
  }
}

function writeLocal(hiddenNav: string[], hiddenColumns: Record<string, string[]>) {
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify({ hiddenNav, hiddenColumns }));
  } catch {
    // Storage unavailable (private window etc.): keep in-memory state only.
  }
}

async function fetchSettings() {
  await resolveUserId();
  try {
    if (!supabase) throw new Error("Supabase is not configured.");
    const organizationId = await getCurrentOrganizationId();
    const { data, error } = await supabase
      .from("organization_settings")
      .select("hidden_nav, hidden_columns")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error) throw error;
    setState({ hiddenNav: cleanNav(data?.hidden_nav), hiddenColumns: cleanColumns(data?.hidden_columns), loaded: true, localOnly: false });
  } catch {
    setState({ ...readLocal(), loaded: true, localOnly: true });
  }
}

export function loadOrgSettings(force = false) {
  if (typeof window === "undefined") return Promise.resolve();
  if (force || !loadPromise) loadPromise = fetchSettings();
  return loadPromise;
}

/** Saves a partial change, updating the cache immediately (so the sidebar and tables react without reload). */
export async function saveOrgSettings(patch: { hiddenNav?: string[]; hiddenColumns?: Record<string, string[]> }): Promise<{ localOnly: boolean }> {
  const hiddenNav = patch.hiddenNav ?? state.hiddenNav;
  const hiddenColumns = patch.hiddenColumns ?? state.hiddenColumns;
  await resolveUserId();
  setState({ ...state, hiddenNav, hiddenColumns, loaded: true });
  writeLocal(hiddenNav, hiddenColumns);
  try {
    if (!supabase) throw new Error("Supabase is not configured.");
    const organizationId = await getCurrentOrganizationId();
    const { error } = await supabase
      .from("organization_settings")
      .upsert({ organization_id: organizationId, hidden_nav: hiddenNav, hidden_columns: hiddenColumns, updated_at: new Date().toISOString() }, { onConflict: "organization_id" });
    if (error) throw error;
    setState({ ...state, localOnly: false });
    return { localOnly: false };
  } catch {
    setState({ ...state, localOnly: true });
    return { localOnly: true };
  }
}

export function useOrgSettings() {
  const settings = useSyncExternalStore(subscribe, () => state, () => EMPTY);
  useEffect(() => { void loadOrgSettings(); }, []);
  return settings;
}

export function isNavHidden(settings: Pick<OrgSettings, "hiddenNav">, href: string) {
  if (NEVER_HIDDEN_HREFS.includes(href)) return false;
  return settings.hiddenNav.includes(href.replace(/^\//, ""));
}

export function useColumnVisibility(tableKey: string) {
  const settings = useOrgSettings();
  const hidden = settings.hiddenColumns[tableKey];
  const isVisible = useCallback((columnKey: string) => !hidden?.includes(columnKey), [hidden]);
  const setColumnVisible = useCallback(async (columnKey: string, visible: boolean) => {
    const current = state.hiddenColumns[tableKey] ?? [];
    const next = visible ? current.filter((key) => key !== columnKey) : Array.from(new Set([...current, columnKey]));
    return saveOrgSettings({ hiddenColumns: { ...state.hiddenColumns, [tableKey]: next } });
  }, [tableKey]);
  return { isVisible, setColumnVisible, hidden: hidden ?? [], localOnly: settings.localOnly };
}
