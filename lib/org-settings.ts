"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { DASHBOARD_TILES } from "@/lib/dashboard-tiles";
import { JOB_TABLE_COLUMNS } from "@/lib/job-board-files";
import { supabase } from "@/lib/supabase";
import { RFQ_CARD_FIELDS, RFQ_DISPLAY_KEY } from "@/lib/rfq-display";
import { salesOrdersEnabled, salesOrdersSwitchChange, SALES_ORDERS_KEY } from "@/lib/sales-orders-switch";
import { getCurrentOrganizationId, getCurrentUserAndOrganization } from "@/lib/supabase-business";

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

/** `locked` items are always shown: the picker and Settings > Display show them ticked and disabled, and they can never be hidden. */
export type ColumnDef = { key: string; label: string; locked?: boolean };
/**
 * `kind: "elements"`: a screen that is not a table (the Machine Schedule timeline); its "columns" are the parts of the screen a person can hide.
 */
/** `group` and `description` are optional; Settings > Display falls back to DISPLAY_META, then to "Tables". */
export type TableDef = { key: string; label: string; columns: ColumnDef[]; kind?: "elements"; group?: DisplayGroup; description?: string };

export type DisplayGroup = "Tables" | "Cards" | "Timeline" | "Sheet" | "Dashboard";

/** Machine Schedule display definition: the one list the picker, Settings and the page all use (tests/unit/schedule-display.test.ts). */
const SCHEDULE_DISPLAY: TableDef = {
  key: "schedule",
  label: "Machine Schedule",
  kind: "elements",
  columns: [
    { key: "machine", label: "Machine name", locked: true },
    { key: "days", label: "Day headers (time axis)", locked: true },
    { key: "status-cards", label: "Machine status cards" },
    { key: "next-free", label: "Next free line (on the cards)" },
    { key: "machine-type", label: "Machine type under the name" },
    { key: "bar-labels", label: "Job numbers and times on the bars" },
    { key: "running-badge", label: "Running and Complete labels on the bars" },
    { key: "now-marker", label: "Now marker" },
    { key: "legend", label: "Colour legend" },
    { key: "jobs-table", label: "Jobs on machines table", locked: true },
    { key: "hours-left", label: "Hours left column (jobs table)" },
    { key: "machines-table", label: "Machines list", locked: true },
  ],
};

/** Selection checkbox and Actions columns are always shown, so they are not listed. Each table's reference column is locked. */
export const COLUMN_TABLES: TableDef[] = [
  // The Job Board's picker lists the board's one column definition (lib/job-board-files) in Astra's order. Job No and Actions are
  // locked on, and Due too (deliberate: List and Table show the job's status badges inside the Due cell, so hiding Due would hide
  // the status). Unticking hides the header and the cells together (Table, List) and the field (Cards).
  { key: "jobs", label: "Job Board", columns: JOB_TABLE_COLUMNS.map(({ key, label, locked }) => ({ key, label, locked })) },
  { key: "quotes", label: "Quotes", columns: [{ key: "ref", label: "Quote", locked: true }, { key: "date", label: "Date" }, { key: "customer", label: "Customer" }, { key: "description", label: "Description" }, { key: "status", label: "Status" }, { key: "value", label: "Value" }, { key: "valid", label: "Valid until" }] },
  { key: "sales-orders", label: "Sales Orders", columns: [{ key: "ref", label: "SO Ref", locked: true }, { key: "customer", label: "Customer" }, { key: "date", label: "Order Date" }, { key: "delivery", label: "Expected Delivery" }, { key: "value", label: "Value" }, { key: "status", label: "Status" }] },
  { key: "purchase-orders", label: "Purchase Orders", columns: [{ key: "ref", label: "PO Ref", locked: true }, { key: "supplier", label: "Supplier" }, { key: "date", label: "Order Date" }, { key: "delivery", label: "Expected Delivery" }, { key: "value", label: "Total (inc VAT)" }, { key: "status", label: "Status" }] },
  { key: "invoices", label: "Invoices", columns: [{ key: "invoice", label: "Invoice", locked: true }, { key: "customer", label: "Customer" }, { key: "status", label: "Status" }, { key: "amount", label: "Amount" }] },
  { key: "delivery-notes", label: "Delivery Notes", columns: [{ key: "ref", label: "DN Ref", locked: true }, { key: "customer", label: "Customer" }, { key: "job", label: "Job Ref" }, { key: "date", label: "Delivery Date" }, { key: "status", label: "Status" }, { key: "email", label: "Email" }] },
  { key: "customers", label: "Customers", columns: [{ key: "name", label: "Name", locked: true }, { key: "contact", label: "Contact" }, { key: "email", label: "Email" }, { key: "phone", label: "Phone" }, { key: "address", label: "Address" }] },
  { key: "suppliers", label: "Suppliers", columns: [{ key: "name", label: "Name", locked: true }, { key: "contact", label: "Contact" }, { key: "email", label: "Email" }, { key: "phone", label: "Phone" }, { key: "notes", label: "Notes" }, { key: "status", label: "Status" }] },
  /** Weekly hours, both tabs, in rendered order. The person / day and Paid (the daily and week total) are always shown, so they are not listed; "Not on a job" shows on Today only, "Days", "Day ticks", "Check" and "Approval" on This week only. Clocked (the context beside Person), Check and Approval (the warnings and the approval) are locked on. */
  { key: "hours", label: "Weekly hours", columns: [{ key: "days", label: "Days worked" }, { key: "clocked", label: "Clocked", locked: true }, { key: "breaks", label: "Breaks" }, { key: "jobs", label: "On jobs" }, { key: "unallocated", label: "Not on a job" }, { key: "ticks", label: "Day ticks" }, { key: "check", label: "Check", locked: true }, { key: "approval", label: "Approval", locked: true }] },
  /** The RFQ screen is a card list: its fields come from lib/rfq-display.ts (the one definition). */
  { key: RFQ_DISPLAY_KEY, label: "RFQ", columns: RFQ_CARD_FIELDS.map(({ key, label, locked }) => ({ key, label, ...(locked ? { locked } : {}) })) },
  SCHEDULE_DISPLAY,
  /** Approval Queue (cards): fields in rendered order. Recipient, To and Subject line identify the draft and Copy / Mark as Sent / Edit / Skip are actions, so all stay on. */
  { key: "approvals", label: "Approval Queue", columns: [{ key: "type", label: "Type" }, { key: "customer", label: "Recipient", locked: true }, { key: "detail", label: "Subject line", locked: true }, { key: "drafted", label: "Drafted date" }, { key: "to", label: "To address", locked: true }, { key: "subject", label: "Subject" }, { key: "preview", label: "Message preview" }] },
  /** The Dashboard's tiles and sections (lib/dashboard-tiles), in rendered order. Same storage and picker as the tables. */
  { key: "dashboard", label: "Dashboard", columns: DASHBOARD_TILES.map(({ key, label }) => ({ key, label })) },
];

/* ---- Settings > Display: every screen's show / hide choices in one place (built from COLUMN_TABLES) ---- */

export const DISPLAY_GROUPS: DisplayGroup[] = ["Tables", "Cards", "Timeline", "Sheet", "Dashboard"];

/** Per-screen group and description for entries that do not carry their own. Add a line here or set `group` / `description` on the COLUMN_TABLES entry. */
export const DISPLAY_META: Record<string, { group: DisplayGroup; description: string }> = {
  quotes: { group: "Tables", description: "The quotes list." },
  "sales-orders": { group: "Tables", description: "The sales orders list." },
  "purchase-orders": { group: "Tables", description: "The purchase orders list." },
  invoices: { group: "Tables", description: "The invoices list." },
  "delivery-notes": { group: "Tables", description: "The delivery notes list." },
  customers: { group: "Tables", description: "The customers list." },
  suppliers: { group: "Tables", description: "The suppliers list." },
  schedule: { group: "Timeline", description: "The schedule timeline." },
  hours: { group: "Sheet", description: "The weekly hours sheet." },
  dashboard: { group: "Dashboard", description: "The dashboard." },
  rfq: { group: "Cards", description: "Requests for quote." },
  approvals: { group: "Cards", description: "Approvals." },
};

export type DisplayScreen = TableDef & { group: DisplayGroup; description: string };

/** Every screen the Settings page lists, in COLUMN_TABLES order. Entries other branches add to COLUMN_TABLES appear here automatically. */
export function screensForSettings(): DisplayScreen[] {
  return COLUMN_TABLES.map((table) => {
    const meta = DISPLAY_META[table.key];
    return { ...table, group: table.group ?? meta?.group ?? "Tables", description: table.description ?? meta?.description ?? `The ${table.label} screen.` };
  });
}

export function screensByGroup(screens: DisplayScreen[] = screensForSettings()): { group: DisplayGroup; screens: DisplayScreen[] }[] {
  return DISPLAY_GROUPS.map((group) => ({ group, screens: screens.filter((screen) => screen.group === group) })).filter((entry) => entry.screens.length > 0);
}

/** "n of m shown" for one screen. Locked items always count as shown. */
export function shownCount(screen: TableDef, hidden: string[] = []) {
  const shown = screen.columns.filter((column) => column.locked || !hidden.includes(column.key)).length;
  return { shown, total: screen.columns.length };
}

/** Next hidden list for one screen after ticking or unticking an item. Locked items are never hidden. */
export function setItemShown(screen: TableDef, hidden: string[] = [], key: string, shown: boolean): string[] {
  if (screen.columns.find((column) => column.key === key)?.locked) return hidden.filter((item) => item !== key);
  return shown ? hidden.filter((item) => item !== key) : Array.from(new Set([...hidden, key]));
}

/** Reset to default = nothing hidden. Pass screen keys to reset those screens, or none to reset every registered screen. Other keys are kept. */
export function resetHiddenColumns(hiddenColumns: Record<string, string[]>, screenKeys?: string[]): Record<string, string[]> {
  const keys = new Set(screenKeys ?? COLUMN_TABLES.map((table) => table.key));
  return Object.fromEntries(Object.entries(hiddenColumns).filter(([key]) => !keys.has(key)));
}

export type OrgSettings = {
  hiddenNav: string[];
  hiddenColumns: Record<string, string[]>;
  loaded: boolean;
  /** true when settings are only stored in this browser (Supabase unavailable). */
  localOnly: boolean;
};

/**
 * The outcome of a save. localOnly: the server could not be reached, so the change is kept in this browser only. denied: the
 * server refused it (RLS, role, read-only support access): the change has been undone here and `message` says why. dropped:
 * abandoned because the person signed out or switched company first; nothing was saved and nothing should be announced.
 */
export type SaveResult = { localOnly: boolean; denied: boolean; message?: string; dropped?: boolean };

type Sets = { hiddenNav: string[]; hiddenColumns: Record<string, string[]> };
/** One toggle, as a delta: merged onto the row as it is on the server at save time, so it never overwrites other tables or the menu. */
type Change =
  | { kind: "columns"; table: string; add: string[]; remove: string[] }
  /** Reset one screen: removes only that screen's entry (all visible again); hidden_nav and other screens are untouched. */
  | { kind: "columns-reset"; table: string }
  | { kind: "nav"; add: string[]; remove: string[] };

const STORAGE_KEY = "quoteflow-org-settings";
/** The local copy is keyed by user AND company, so neither another sign-in nor this person's other company can read it. */
let currentUserId: string | null = null;
let currentOrgId: string | null = null;
/** Bumped by resetOrgSettings: a fetch or save that started before it drops its result (sign-out, company switch). */
let generation = 0;

async function resolveUserId(): Promise<string | null> {
  if (currentUserId) return currentUserId;
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getUser();
    currentUserId = data.user?.id ?? null;
  } catch {
    currentUserId = null;
  }
  if (!currentUserId) {
    // Offline getUser cannot reach the server; the stored session still names who is signed in on this device.
    try {
      const { data } = await supabase.auth.getSession();
      currentUserId = data.session?.user.id ?? null;
    } catch {
      currentUserId = null;
    }
  }
  return currentUserId;
}

/** This user's company at the last online load, kept so an offline reload can still find its local copy. */
const lastOrgKey = (userId: string) => `${STORAGE_KEY}:last-org:${userId}`;

function rememberOrg(organizationId: string) {
  currentOrgId = organizationId;
  if (!currentUserId) return;
  try {
    window.localStorage.setItem(lastOrgKey(currentUserId), organizationId);
  } catch {
    // ignore
  }
}

function recallOrg(): string | null {
  if (!currentUserId) return null;
  try {
    return window.localStorage.getItem(lastOrgKey(currentUserId));
  } catch {
    return null;
  }
}

/** null when the user or company is not known: then nothing is read from or written to this browser. */
export function orgSettingsStorageKey(userId: string | null, organizationId: string | null) {
  return userId && organizationId ? `${STORAGE_KEY}:${userId}:${organizationId}` : null;
}

const NO_SETS: Sets = { hiddenNav: [], hiddenColumns: {} };
const EMPTY: OrgSettings = { ...NO_SETS, loaded: false, localOnly: false };

let state: OrgSettings = EMPTY;
/** The last settled value (from the server, or kept locally while offline). */
let base: Sets = NO_SETS;
/** Changes shown at once but not yet settled; the visible state is base with these applied. */
let pending: Change[] = [];
let loadPromise: Promise<void> | null = null;
let saveChain: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function setState(next: OrgSettings) {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const tableDef = (tableKey: string) => COLUMN_TABLES.find((table) => table.key === tableKey);

export function isColumnLocked(tableKey: string, columnKey: string) {
  return Boolean(tableDef(tableKey)?.columns.find((column) => column.key === columnKey)?.locked);
}

/**
 * Hidden sets as stored, made safe to render: locked columns are never hidden, and a known table always keeps at least one
 * column. Keys this build does not know (another table or column) are kept, so a save never drops them from the row.
 */
export function cleanColumns(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [table, cols] of Object.entries(value as Record<string, unknown>)) {
      if (!Array.isArray(cols)) continue;
      let hidden = cols.filter((col, i): col is string => typeof col === "string" && cols.indexOf(col) === i && !isColumnLocked(table, col));
      const def = tableDef(table);
      if (def && def.columns.length && def.columns.every((column) => hidden.includes(column.key))) hidden = hidden.filter((key) => key !== def.columns[0].key);
      out[table] = hidden;
    }
  }
  return out;
}

function cleanNav(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item, i): item is string => typeof item === "string" && value.indexOf(item) === i) : [];
}

const applyDelta = (current: string[], change: { add: string[]; remove: string[] }) =>
  Array.from(new Set([...current.filter((key) => !change.remove.includes(key)), ...change.add]));

function applyChange(sets: Sets, change: Change): Sets {
  if (change.kind === "nav") return { ...sets, hiddenNav: applyDelta(sets.hiddenNav, change) };
  if (change.kind === "columns-reset") {
    const { [change.table]: _reset, ...rest } = sets.hiddenColumns;
    void _reset;
    return { ...sets, hiddenColumns: rest };
  }
  return { ...sets, hiddenColumns: cleanColumns({ ...sets.hiddenColumns, [change.table]: applyDelta(sets.hiddenColumns[change.table] ?? [], change) }) };
}

function publish(extra: Partial<OrgSettings> = {}) {
  const view = pending.reduce(applyChange, base);
  setState({ ...state, ...extra, hiddenNav: view.hiddenNav, hiddenColumns: cleanColumns(view.hiddenColumns) });
}

/** Call on sign-out and company switch: clears the cache and this company's local copy, and drops any fetch or save in flight. */
export function resetOrgSettings() {
  const key = orgSettingsStorageKey(currentUserId, currentOrgId);
  const legacyUserKey = currentUserId ? `${STORAGE_KEY}:${currentUserId}` : null;
  const orgPointer = currentUserId ? lastOrgKey(currentUserId) : null;
  generation += 1;
  currentUserId = null;
  currentOrgId = null;
  loadPromise = null;
  pending = [];
  base = NO_SETS;
  setState(EMPTY);
  try {
    if (key) window.localStorage.removeItem(key);
    if (orgPointer) window.localStorage.removeItem(orgPointer);
    // Copies written before the key named the company.
    if (legacyUserKey) window.localStorage.removeItem(legacyUserKey);
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function readLocal(): Sets {
  const key = orgSettingsStorageKey(currentUserId, currentOrgId);
  if (!key) return NO_SETS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "{}");
    return { hiddenNav: cleanNav(parsed.hiddenNav), hiddenColumns: cleanColumns(parsed.hiddenColumns) };
  } catch {
    return NO_SETS;
  }
}

function writeLocal(sets: Sets) {
  const key = orgSettingsStorageKey(currentUserId, currentOrgId);
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(sets));
  } catch {
    // Storage unavailable (private window etc.): keep in-memory state only.
  }
}

type DbError = { code?: unknown; status?: unknown; message?: unknown; hint?: unknown };

/** The server refused (as opposed to could not be reached): 401 / 403, 42501, a role guard, read-only support access. */
export function isSettingsDenial(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const { code, status, message, hint } = error as DbError;
  if (status === 401 || status === 403) return true;
  if (code === "42501" || code === "PGRST301") return true;
  if (hint === "support_read_only") return true;
  return typeof message === "string" && /permission denied|row-level security|support access|read-only|only admins can/i.test(message);
}

function deniedMessage(error: unknown) {
  const { message, hint } = (error ?? {}) as DbError;
  if (hint === "support_read_only" || (typeof message === "string" && /support access|read-only/i.test(message))) {
    return "You can't change this: support access is read-only. Nothing was saved.";
  }
  return "You can't change this setting. Nothing was saved.";
}

async function readRow(organizationId: string): Promise<Sets> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error, status } = await supabase
    .from("organization_settings")
    .select("hidden_nav, hidden_columns")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw { code: error.code, message: error.message, hint: error.hint, status };
  return { hiddenNav: cleanNav(data?.hidden_nav), hiddenColumns: cleanColumns(data?.hidden_columns) };
}

async function fetchSettings() {
  const gen = generation;
  try {
    if (!supabase) throw new Error("Supabase is not configured.");
    // One auth-server check names both the user and the session's company (it was asked twice in a row before: every auth-server
    // check holds supabase-js's auth lock for a round trip, and every database request waits on that lock).
    const { userId, organizationId } = await getCurrentUserAndOrganization();
    if (gen !== generation) return;
    if (!currentUserId) currentUserId = userId;
    rememberOrg(organizationId);
    const row = await readRow(organizationId);
    if (gen !== generation) return;
    base = row;
    writeLocal(base);
    publish({ loaded: true, localOnly: false });
  } catch {
    if (gen !== generation) return;
    // Offline: the stored session still names who is signed in on this device.
    await resolveUserId();
    if (gen !== generation) return;
    // Offline cold reload: the company of the last online load on this device (cleared on sign-out and company switch).
    if (!currentOrgId) currentOrgId = recallOrg();
    base = readLocal();
    publish({ loaded: true, localOnly: true });
  }
}

export function loadOrgSettings(force = false) {
  if (typeof window === "undefined") return Promise.resolve();
  if (force || !loadPromise) loadPromise = fetchSettings();
  return loadPromise;
}

const DROPPED: SaveResult = { localOnly: false, denied: false, dropped: true };

/**
 * Saves one change: re-reads the row, merges only the table (or the menu) being changed, and writes only that column, so this
 * browser's stale cache is never written back and a column change never sends hidden_nav (the guard_nav trigger).
 * Not atomic: the read and the upsert are two requests and the upsert sends the whole hidden_columns object, so if another
 * admin saves ANY table between them, that change is lost (last write wins for that window, typically well under a second).
 * The full fix is a database function that merges only the toggled table in one statement (SQL, after go-live).
 * pinnedOrg: the company the change was made in. If the session's company differs at save time (a company switch whose
 * reset has not run yet), the save is dropped, never written to the new company's row.
 */
async function persistChange(change: Change, gen: number, pinnedOrg: string | null): Promise<SaveResult> {
  const settle = () => { pending = pending.filter((item) => item !== change); };
  let fresh: Sets | null = null;
  try {
    await resolveUserId();
    if (!supabase) throw new Error("Supabase is not configured.");
    const organizationId = await getCurrentOrganizationId();
    if (gen !== generation) return DROPPED;
    if (pinnedOrg && organizationId !== pinnedOrg) {
      settle();
      publish();
      return DROPPED;
    }
    rememberOrg(organizationId);
    fresh = await readRow(organizationId);
    if (gen !== generation) return DROPPED;
    const merged = applyChange(fresh, change);
    const column = change.kind === "nav" ? { hidden_nav: merged.hiddenNav } : { hidden_columns: merged.hiddenColumns };
    const { error, status } = await supabase
      .from("organization_settings")
      .upsert({ organization_id: organizationId, ...column, updated_at: new Date().toISOString() }, { onConflict: "organization_id" });
    if (error) throw { code: error.code, message: error.message, hint: error.hint, status };
    if (gen !== generation) return DROPPED;
    settle();
    base = merged;
    writeLocal(base);
    publish({ loaded: true, localOnly: false });
    return { localOnly: false, denied: false };
  } catch (error) {
    if (gen !== generation) return DROPPED;
    settle();
    if (isSettingsDenial(error)) {
      // Undo it here; what the server holds now is the truth.
      if (fresh) base = fresh;
      publish({ loaded: true });
      return { localOnly: false, denied: true, message: deniedMessage(error) };
    }
    base = applyChange(base, change);
    writeLocal(base);
    publish({ loaded: true, localOnly: true });
    return { localOnly: true, denied: false };
  }
}

/** Shows the change at once, then saves it after any save already running (two quick toggles never interleave). */
function enqueue(change: Change): Promise<SaveResult> {
  const gen = generation;
  const pinnedOrg = currentOrgId;
  pending.push(change);
  publish({ loaded: true });
  const run = saveChain.then(() => persistChange(change, gen, pinnedOrg));
  saveChain = run.catch(() => undefined);
  return run;
}

/** Hides or shows one column of one table. A locked column cannot be hidden. */
export function setColumnHidden(tableKey: string, columnKey: string, hidden: boolean): Promise<SaveResult> {
  if (hidden && isColumnLocked(tableKey, columnKey)) return Promise.resolve({ localOnly: false, denied: true, message: "This column is always shown." });
  return enqueue({ kind: "columns", table: tableKey, add: hidden ? [columnKey] : [], remove: hidden ? [] : [columnKey] });
}

/** Shows every column of one screen again (that screen's entry only). */
export function resetColumns(tableKey: string): Promise<SaveResult> {
  return enqueue({ kind: "columns-reset", table: tableKey });
}

/** Hides or shows one menu item (key = href without the leading slash). */
export function setNavHidden(key: string, hidden: boolean): Promise<SaveResult> {
  if (key === SALES_ORDERS_KEY) return setSalesOrdersEnabled(!hidden);
  return enqueue({ kind: "nav", add: hidden ? [key] : [], remove: hidden ? [] : [key] });
}

/** Switches Sales Orders on or off for the company (off by default; see lib/sales-orders-switch). Admin only, like every menu change. */
export function setSalesOrdersEnabled(on: boolean): Promise<SaveResult> {
  return enqueue({ kind: "nav", ...salesOrdersSwitchChange(on) });
}

const combine = (results: SaveResult[]): SaveResult => {
  const denied = results.find((result) => result.denied);
  if (!denied && results.length && results.every((result) => result.dropped)) return DROPPED;
  return denied ?? { localOnly: results.some((result) => result.localOnly), denied: false };
};

/**
 * Saves a whole-set patch (kept for existing callers). It is turned into per-table deltas against the current cache, and each
 * is merged onto the server row at save time. Prefer setColumnHidden / setNavHidden.
 */
export async function saveOrgSettings(patch: { hiddenNav?: string[]; hiddenColumns?: Record<string, string[]> }): Promise<SaveResult> {
  const runs: Promise<SaveResult>[] = [];
  const delta = (before: string[], after: string[]) => ({ add: after.filter((key) => !before.includes(key)), remove: before.filter((key) => !after.includes(key)) });
  if (patch.hiddenNav) {
    const change = delta(state.hiddenNav, patch.hiddenNav);
    if (change.add.length || change.remove.length) runs.push(enqueue({ kind: "nav", ...change }));
  }
  for (const [table, after] of Object.entries(patch.hiddenColumns ?? {})) {
    const change = delta(state.hiddenColumns[table] ?? [], after);
    if (change.add.length || change.remove.length) runs.push(enqueue({ kind: "columns", table, ...change }));
  }
  return combine(await Promise.all(runs));
}

/** The current cached settings (outside React). */
export function getOrgSettingsSnapshot() {
  return state;
}

export function useOrgSettings() {
  const settings = useSyncExternalStore(subscribe, () => state, () => EMPTY);
  useEffect(() => { void loadOrgSettings(); }, []);
  return settings;
}

export function isNavHidden(settings: Pick<OrgSettings, "hiddenNav">, href: string) {
  if (NEVER_HIDDEN_HREFS.includes(href)) return false;
  if (href.replace(/^\//, "") === SALES_ORDERS_KEY) return !salesOrdersEnabled(settings.hiddenNav);
  return settings.hiddenNav.includes(href.replace(/^\//, ""));
}

/**
 * Visibility for one table given its hidden set: locked columns are always visible; a screen with no entry shows everything.
 * Pure, for pages and tests.
 *
 * Display prefs only ever narrow what a page already renders. Role restrictions run first: RoleGate wraps each page and the
 * data a person may see is limited by RLS and by each page's own role checks before any isVisible call; isVisible only decides
 * whether an already-permitted column is drawn. A locked column is forced visible within that, never beyond it: locking never
 * shows a field the role gate or the page would not render.
 */
export function columnVisibility(tableKey: string, hidden: string[] | undefined) {
  const safe = cleanColumns({ [tableKey]: hidden ?? [] })[tableKey] ?? [];
  return (columnKey: string) => !safe.includes(columnKey);
}

export function useColumnVisibility(tableKey: string) {
  const settings = useOrgSettings();
  const hidden = settings.hiddenColumns[tableKey];
  const isVisible = useMemo(() => columnVisibility(tableKey, hidden), [tableKey, hidden]);
  const isLocked = useCallback((columnKey: string) => isColumnLocked(tableKey, columnKey), [tableKey]);
  const setColumnVisible = useCallback((columnKey: string, visible: boolean) => setColumnHidden(tableKey, columnKey, !visible), [tableKey]);
  const reset = useCallback(() => resetColumns(tableKey), [tableKey]);
  return { isVisible, isLocked, setColumnVisible, resetColumns: reset, hidden: hidden ?? [], loaded: settings.loaded, localOnly: settings.localOnly };
}
