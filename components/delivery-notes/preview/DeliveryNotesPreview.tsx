"use client";

/**
 * BOUNDARY (Delivery notes, Invoices module 4, PREVIEW ONLY, v2 = shared UI v4 plus the owner-approved structural items 1, 2, 4, 7, 9, 10, 11).
 * Inputs: none from the server. Everything shown is fictional sample data (14 delivery notes, as of 20/11/2026) held in this file, plus the person's clicks.
 * Outputs: a Delivery Notes list look-and-feel prototype (three figure tiles, a one-row toolbar with Show, a Filters (n) popover, Columns and Cards / List / Table,
 * removable active-filter chips, the sticky selection bar with Print Selected and Mark Selected Signed once a row is ticked, one primary action plus More per row,
 * the real dialogs) whose only state is LOCAL UI state. It never reads or writes Supabase, calls no server action, API route, e-mail, payment or accounting
 * integration, and no action reports success: every action answers with the neutral "Preview only" toast and nothing changes.
 * Run-time imports from lib/ are pure modules only (dates, status-colours, empty-hints, list-card-counts); logic from modules that reach Supabase
 * (archive phaseOf, list-filter) is mirrored here and pinned to the real functions by tests/unit/deliveryNotesPreview.test.ts.
 * MUST NOT CHANGE: wording, defaults, column order, filter semantics and the role gate mirror today's page (app/(dashboard)/delivery-notes/page.tsx:
 * admin, office and workshop; viewer sees "Access Denied"; E-mail and Archive are admin and office only; "From a sales order" is not offered to
 * workshop). Every real control stays reachable (rowActionPlan proves the row ones). Do not wire to real data or actions, add no control the real page
 * lacks, keep row controls at a 48 px hit area. No !important and no override of a shared component's own classes: tune by token only.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import {
  Button, Callout, Checkbox, ChipGroup, EmptyState, FailedState, Field, FilterChip, Input, LoadingState, Menu, PageHeader, Popover, PreviewBar, ScrollTable, SegmentedControl,
  Select, SelectionBar, Sheet, StatTile, StatTiles, StatusBadge, Switch, Textarea, ToastProvider, cx, premiumTokens, srOnly, tabularNumbers, typeScale, useToast,
} from "@/components/ui/premium";
import type { MenuItem, StatusTone } from "@/components/ui/premium";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { deliveryNotesEmptyHint } from "@/lib/empty-hints";
import { AWAITING_SIGNATURE_LABEL, AWAITING_SIGNATURE_STATUSES, countAwaitingSignature } from "@/lib/list-card-counts";
import { deliveryNoteStatusKey } from "@/lib/status-colours";

import s from "./DeliveryNotesPreview.module.css";

export type Role = "admin" | "office" | "workshop" | "viewer";
export type ViewMode = "cards" | "list" | "table";
export type PhaseValue = "open" | "done" | "archived" | "all";
export type Phase = "open" | "done" | "archived";
export type Screen = "ready" | "loading" | "error" | "empty";
export type ListFilterKey = "awaiting-old" | "not-invoiced";
export type ColumnKey = "ref" | "customer" | "job" | "date" | "status" | "email";

/** The sample's "today": the week, month, archive and list-filter rules are worked out against it. */
export const TODAY = "2026-11-20";
export const ARCHIVE_MONTHS = 12;
export const DELIVERY_AWAITING_DAYS = 1;
export const DN_FILTER_LABELS: Record<ListFilterKey, string> = { "awaiting-old": "Delivery notes awaiting for over a day", "not-invoiced": "Delivery notes despatched with no invoice" };
export const COLUMNS: Array<{ key: ColumnKey; label: string; locked?: boolean }> = [
  { key: "ref", label: "DN Ref", locked: true }, { key: "customer", label: "Customer" }, { key: "job", label: "Job Ref" }, { key: "date", label: "Delivery Date" }, { key: "status", label: "Status" }, { key: "email", label: "Email" },
];
export const CHIPS: Array<{ v: string; label: string }> = [{ v: "all", label: "All" }, { v: "awaiting", label: "Awaiting" }, { v: "despatched", label: "Despatched" }, { v: "delivered", label: "Delivered" }, { v: "signed", label: "Signed" }];
export const CUSTOMERS = ["Kilbride Hydraulics", "Solway Marine Engineering", "Carronside Automation", "Ashby Rail Services", "Kestrel Components", "Pemberton Packaging", "Ardmore Precision", "Wren & Calder", "Brightwell Valves", "Northgate Fabrication"];

export type SeedNote = {
  id: string; ref: string; customer: string; email: string; job: string; date: string; status: string; signedBy?: string; signedAt?: string; signatureNotes?: string;
  emailedAt?: string; invoiceRef?: string; invoiceDraft?: boolean; uninvoiced?: string; createdAt: string; updatedAt: string; shipVia?: string; items: Array<{ description: string; quantity: number }>; manual?: "archived" | "active";
};
const I = (description: string, quantity: number) => ({ description, quantity });
export const SEED_NOTES: SeedNote[] = [
  { id: "n12", ref: "DLN-0212", customer: "Kilbride Hydraulics", email: "purchasing@kilbride-hydraulics.example", job: "JOB-2211", date: "2026-11-19", status: "despatched", createdAt: "2026-11-19T08:00:00Z", updatedAt: "2026-11-19T15:00:00Z", uninvoiced: "No draft yet", shipVia: "Own van", items: [I("Manifold block, anodised", 40)] },
  { id: "n11", ref: "DLN-0211", customer: "Solway Marine Engineering", email: "orders@solway-marine.example", job: "JOB-2204", date: "2026-11-16", status: "despatched", createdAt: "2026-11-16T08:00:00Z", updatedAt: "2026-11-16T15:00:00Z", invoiceRef: "Draft invoice created", invoiceDraft: true, emailedAt: "2026-11-16T15:10:00Z", shipVia: "Pallet carrier", items: [I("Deck cleat 250 mm", 24), I("Backing plate", 24)] },
  { id: "n10", ref: "DLN-0210", customer: "Pemberton Packaging", email: "", job: "", date: "2026-11-20", status: "awaiting", createdAt: "2026-11-20T07:30:00Z", updatedAt: "2026-11-20T07:30:00Z", items: [I("Sealing jaw bar", 16)] },
  { id: "n09", ref: "DLN-0209", customer: "Kestrel Components", email: "procurement@kestrel.example", job: "JOB-2199", date: "2026-11-18", status: "delivered", createdAt: "2026-11-17T08:00:00Z", updatedAt: "2026-11-18T12:00:00Z", invoiceRef: "Draft invoice created", invoiceDraft: true, emailedAt: "2026-11-18T12:20:00Z", items: [I("Sensor housing", 250)] },
  { id: "n08", ref: "DLN-0208", customer: "Ardmore Precision", email: "accounts@ardmore-precision.example", job: "JOB-2196", date: "2026-11-18", status: "awaiting", createdAt: "2026-11-17T09:00:00Z", updatedAt: "2026-11-17T09:00:00Z", items: [I("Calibration fixture", 4)] },
  { id: "n07", ref: "DLN-0207", customer: "Northgate Fabrication", email: "orders@northgate-fab.example", job: "JOB-2188", date: "2026-11-12", status: "signed", signedBy: "A. Buchanan", signedAt: "2026-11-13", signatureNotes: "Received complete, 2 cartons.", createdAt: "2026-11-11T08:00:00Z", updatedAt: "2026-11-13T09:00:00Z", invoiceRef: "Invoiced INV-1047", emailedAt: "2026-11-12T11:00:00Z", items: [I("Guard frame", 8)] },
  { id: "n06", ref: "DLN-0206", customer: "Ashby Rail Services", email: "supply@ashby-rail.example", job: "JOB-2180", date: "2026-11-16", status: "signed", signedBy: "R. Lennox", signedAt: "2026-11-17", createdAt: "2026-11-15T08:00:00Z", updatedAt: "2026-11-17T09:00:00Z", invoiceRef: "Invoiced INV-1048", items: [I("Brake bracket weldment", 120)] },
  { id: "n05", ref: "DLN-0205", customer: "Brightwell Valves", email: "buying@brightwell.example", job: "JOB-2170", date: "2026-11-06", status: "delivered", createdAt: "2026-11-05T08:00:00Z", updatedAt: "2026-11-06T12:00:00Z", invoiceRef: "Invoiced INV-1045", items: [I("Valve body, 316", 80)] },
  { id: "n04", ref: "DLN-0204", customer: "Pemberton Packaging", email: "", job: "JOB-2166", date: "2026-11-13", status: "delivered", createdAt: "2026-11-12T08:00:00Z", updatedAt: "2026-11-13T12:00:00Z", uninvoiced: "Automatic draft failed", items: [I("Sealing jaw bar", 8)] },
  { id: "n03", ref: "DLN-0203", customer: "Wren & Calder", email: "projects@wren-calder.example", job: "JOB-2150", date: "2026-10-20", status: "signed", signedBy: "T. Calder", signedAt: "2026-10-21", createdAt: "2026-10-19T08:00:00Z", updatedAt: "2026-10-21T09:00:00Z", invoiceRef: "Invoiced INV-1041", items: [I("Idler roller 89 mm", 90)] },
  { id: "n02", ref: "DLN-0198", customer: "Northgate Fabrication", email: "orders@northgate-fab.example", job: "", date: "2026-11-09", status: "signed", signedBy: "A. Buchanan", signedAt: "2026-11-10", createdAt: "2026-11-08T08:00:00Z", updatedAt: "2026-11-10T09:00:00Z", uninvoiced: "Invoice by hand", items: [I("Handrail post", 36)] },
  { id: "n01", ref: "DLN-0161", customer: "Solway Marine Engineering", email: "orders@solway-marine.example", job: "JOB-2001", date: "2025-09-10", status: "signed", signedBy: "P. Hamilton", signedAt: "2025-09-11", createdAt: "2025-09-09T08:00:00Z", updatedAt: "2025-09-11T09:00:00Z", invoiceRef: "Invoiced INV-0987", items: [I("Bush, aluminium bronze", 30)] },
  { id: "n00", ref: "DLN-0190", customer: "Kestrel Components", email: "procurement@kestrel.example", job: "JOB-2100", date: "2026-10-01", status: "signed", signedBy: "K. Dunn", signedAt: "2026-10-02", createdAt: "2026-09-30T08:00:00Z", updatedAt: "2026-10-02T09:00:00Z", invoiceRef: "Invoiced INV-1031", manual: "archived", items: [I("Test rig plates", 12)] },
  { id: "n13", ref: "DLN-0213", customer: "Carronside Automation", email: "buyer@carronside-automation.example", job: "JOB-2214", date: "2026-11-20", status: "awaiting", createdAt: "2026-11-20T08:10:00Z", updatedAt: "2026-11-20T08:10:00Z", items: [I("Gearbox housing, 5 axis machined", 6)] },
];

/* ---------- pure logic ---------- */
const dayMs = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
export const daysBetween = (from: string, to: string) => Math.round((dayMs(to) - dayMs(from)) / 86_400_000);
const day = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "");
export function phaseOf(record: { final: boolean; finalDate?: string | null }, manual: "archived" | "active" | undefined, months: number, now: Date = new Date(`${TODAY}T12:00:00Z`)): Phase {
  if (manual === "archived") return "archived";
  if (!record.final) return "open";
  if (manual === "active" || !record.finalDate) return "done";
  const cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - months);
  const at = new Date(record.finalDate);
  return !Number.isNaN(at.getTime()) && at < cutoff ? "archived" : "done";
}
export const phaseFor = (n: Pick<SeedNote, "status" | "signedAt" | "date" | "manual">): Phase => phaseOf({ final: ["delivered", "signed"].includes(n.status), finalDate: n.signedAt || n.date }, n.manual, ARCHIVE_MONTHS);
/** lib/list-filter deliveryNoteMatchesFilter (mirrored). */
export function matchesListFilter(filter: string, n: { status: string; invoiceId?: string | null; updatedAt?: string; createdAt?: string }, today: string = TODAY): boolean {
  if (filter === "awaiting-old") { const since = day(n.updatedAt) || day(n.createdAt); return n.status === "awaiting" && Boolean(since) && daysBetween(since, today) > DELIVERY_AWAITING_DAYS; }
  if (filter === "not-invoiced") return ["despatched", "delivered", "signed"].includes(n.status) && !n.invoiceId;
  return true;
}
/** The preview marks a note "invoiced" with invoiceId when it has an invoice or a draft. */
export const asRow = (n: SeedNote) => ({ ...n, invoiceId: n.invoiceRef ? `inv-${n.id}` : null });
export type Filters = { phase: PhaseValue; chips: ReadonlySet<string>; listFilter: ListFilterKey | null };
export const DEFAULT_FILTERS: Filters = { phase: "open", chips: new Set(["all"]), listFilter: null };
export function visibleNotes(notes: readonly SeedNote[], f: Filters, today: string = TODAY): SeedNote[] {
  return notes.filter((n) => (f.listFilter ? matchesListFilter(f.listFilter, asRow(n), today) : (f.phase === "all" || phaseFor(n) === f.phase) && (f.chips.has("all") || f.chips.has(n.status))));
}
export const phaseCounts = (notes: readonly SeedNote[]): Record<Phase, number> => ({ open: notes.filter((x) => phaseFor(x) === "open").length, done: notes.filter((x) => phaseFor(x) === "done").length, archived: notes.filter((x) => phaseFor(x) === "archived").length });
export function statsOf(notes: readonly SeedNote[], today: string = TODAY) {
  const weekAgo = new Date(dayMs(today) - 7 * 86_400_000).toISOString().slice(0, 10);
  const sentOut = (st: string) => st === "despatched" || st === "delivered" || st === "signed";
  return {
    week: notes.filter((n) => sentOut(n.status) && day(n.date) >= weekAgo && day(n.date) <= today).length,
    signedMonth: notes.filter((n) => n.status === "signed" && day(n.signedAt || n.date).slice(0, 7) === today.slice(0, 7)).length,
    awaitingSignature: countAwaitingSignature(notes),
  };
}
export const canUseDeliveryNotes = (r: Role) => r !== "viewer";
export const canEmail = (r: Role) => r === "admin" || r === "office";
export const canArchive = (r: Role) => r === "admin" || r === "office";
export const sourcesFor = (r: Role): Array<{ v: string; label: string }> => [{ v: "order", label: "From a sales order" }, { v: "job", label: "From a job" }, { v: "manual", label: "Without an order" }].filter((x) => x.v !== "order" || r !== "workshop");
export const canEdit = (status: string) => !["despatched", "delivered", "signed"].includes(status);
export const toneOf = (status: string): StatusTone => { const k = deliveryNoteStatusKey(status); return k === "sent" ? "info" : k === "delivered" ? "ok" : k === "draft" ? "neutral" : "neutral"; };


/* ---------- the row action plan (structural item 7): one primary action, everything else in More ---------- */
export type RowActionId = "view" | "edit" | "despatch" | "sign" | "print" | "email" | "archive";
export interface RowAction { id: RowActionId; label: string; disabled?: boolean; hint?: string }
export const EDIT_BLOCKED_HINT = "A delivery note that has been despatched can't be edited";
/** Every real row control, in the order the More menu shows them. */
export function allRowActions(n: Pick<SeedNote, "status" | "signedAt" | "date" | "manual">, role: Role): RowAction[] {
  return [
    { id: "view", label: "View" },
    { id: "edit", label: "Edit", disabled: !canEdit(n.status), hint: canEdit(n.status) ? undefined : EDIT_BLOCKED_HINT },
    ...(n.status === "awaiting" ? [{ id: "despatch" as const, label: "Mark Despatched" }] : []),
    ...(n.status === "signed" ? [] : [{ id: "sign" as const, label: "Mark Signed" }]),
    { id: "print", label: "Print" },
    ...(canEmail(role) ? [{ id: "email" as const, label: "Email Customer" }] : []),
    ...(canArchive(role) ? [{ id: "archive" as const, label: phaseFor(n) === "archived" ? "Unarchive" : "Archive" }] : []),
  ];
}
/** The next step for the row is its one visible button (a signed note has none left, so View); the rest go to More. */
export function rowActionPlan(n: Pick<SeedNote, "status" | "signedAt" | "date" | "manual">, role: Role): { primary: RowAction; more: RowAction[] } {
  const all = allRowActions(n, role);
  const primaryId: RowActionId = n.status === "awaiting" ? "despatch" : n.status === "signed" ? "view" : "sign";
  const primary = all.find((a) => a.id === primaryId) as RowAction;
  return { primary, more: all.filter((a) => a.id !== primaryId) };
}
export const DN_TITLE_TIP = "A delivery note goes with finished work. Despatch means sending finished work to the customer.";

/* ---------- local pieces ---------- */
const VIEW_KEY = "delivery-notes-preview:view";
const ROLES: Array<{ value: Role; label: string }> = [{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" }];
const SCREENS: Array<{ v: Screen | ListFilterKey; label: string }> = [{ v: "ready", label: "Normal" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "empty", label: "No delivery notes yet" }, { v: "awaiting-old", label: "Dashboard link: Awaiting over a day" }, { v: "not-invoiced", label: "Dashboard link: Not invoiced" }];
function useMedia(query: string, fallback: boolean): boolean {
  return useSyncExternalStore((cb) => { const m = window.matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); }, () => window.matchMedia(query).matches, () => fallback);
}
const Ref = ({ children }: { children: ReactNode }) => <span className={cx(typeScale.name, tabularNumbers, s.ref)}>{children}</span>;
const cap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
const Pill = ({ n, mode = "pill" }: { n: SeedNote; mode?: "pill" | "text" }) => <StatusBadge tone={toneOf(n.status)} mode={mode}>{cap(n.status)}</StatusBadge>;
/** The page title with its generic explainer moved into a tooltip and an accessible description (structural item 4). */
function TitleWithTip({ text, tip, describedBy }: { text: string; tip: string; describedBy: string }) {
  return <span title={tip} aria-describedby={describedBy}>{text}</span>;
}

type Dlg = { k: "new" } | { k: "edit"; id: string } | { k: "sign"; ids: string[] } | { k: "email"; id: string };

export default function DeliveryNotesPreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

function Inner() {
  const toast = useToast();
  const tipId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [view, setViewState] = useState<ViewMode>("table");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<string[]>([]);
  const [hidden, setHidden] = useState<ColumnKey[]>([]);
  const [dlg, setDlgState] = useState<Dlg | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [timer, setTimer] = useState<number | null>(null);
  const setDlg = useCallback((d: Dlg | null) => { setDlgState(d); if (d) toast.clear(); }, [toast]);
  const wide = useMedia("(min-width: 1024px)", true);
  const notPhone = useMedia("(min-width: 768px)", true);
  useEffect(() => { try { const v = window.localStorage.getItem(VIEW_KEY); if (v === "cards" || v === "list" || v === "table") setViewState(v); } catch { /* defaults */ } }, []);
  useEffect(() => () => { if (timer) window.clearTimeout(timer); }, [timer]);
  const setView = (v: ViewMode) => { setViewState(v); try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };
  const shownView: ViewMode = wide ? view : "cards";
  const loaded = screen === "ready";
  const data = useMemo(() => (screen === "ready" ? SEED_NOTES : []), [screen]);
  const byId = useMemo(() => new Map(SEED_NOTES.map((n) => [n.id, n])), []);
  const visible = useMemo(() => visibleNotes(data, filters), [data, filters]);
  const counts = useMemo(() => phaseCounts(data), [data]);
  const stats = useMemo(() => statsOf(data), [data]);
  const inView = (c: ColumnKey) => !hidden.includes(c);
  const nSel = selected.length;
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const denied = !canUseDeliveryNotes(role);
  const mayEmail = canEmail(role);
  const activeChips = CHIPS.filter((c) => c.v !== "all" && filters.chips.has(c.v));
  const toggleChip = (value: string) => setFilters((f) => { const next = new Set(f.chips); if (value === "all") { next.clear(); next.add("all"); } else { next.delete("all"); if (next.has(value)) next.delete(value); else next.add(value); if (!next.size) next.add("all"); } return { ...f, chips: next }; });
  const toggleSel = (id: string) => setSelected((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const focusFiltersTrigger = () => requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="filters-trigger"]')?.focus());
  const removeChip = (value: string, index: number) => {
    toggleChip(value);
    requestAnimationFrame(() => { const rest = activeRef.current?.querySelectorAll<HTMLElement>("[data-active-chip]"); if (rest && rest.length) rest[Math.min(index, rest.length - 1)].focus(); else document.querySelector<HTMLElement>('[data-testid="filters-trigger"]')?.focus(); });
  };
  const clearFilters = () => { setFilters((f) => ({ ...f, chips: new Set(["all"]) })); focusFiltersTrigger(); };
  const clearSelection = () => { setSelected([]); requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('input[type="checkbox"]')?.focus()); };
  const retry = () => { setScreen("loading"); setTimer(window.setTimeout(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample delivery notes shown again. No server was contacted." }); }, 700)); };
  const resetAll = () => { setScreen("ready"); setFilters(DEFAULT_FILTERS); setSelected([]); setHidden([]); setDlg(null); setViewId(null); toast.clear(); };
  const pickScreen = (v: Screen | ListFilterKey) => { toast.clear(); setSelected([]); if (v === "awaiting-old" || v === "not-invoiced") { setScreen("ready"); setFilters({ ...DEFAULT_FILTERS, listFilter: v }); return; } setFilters((f) => ({ ...f, listFilter: null })); setScreen(v); };
  const archive = (n: SeedNote) => preview(`${n.ref} would be ${phaseFor(n) === "archived" ? "moved out of the archive" : "archived"}.`);
  const runAction = (n: SeedNote, id: RowActionId) => {
    if (id === "view") setViewId(n.id);
    else if (id === "edit") setDlg({ k: "edit", id: n.id });
    else if (id === "sign") setDlg({ k: "sign", ids: [n.id] });
    else if (id === "despatch") preview(`${n.ref} would be marked despatched and its draft invoice made.`);
    else if (id === "print") preview(`${n.ref} would open on the print page.`);
    else if (id === "email") setDlg({ k: "email", id: n.id });
    else archive(n);
  };

  const tiles: Array<[string, number, string[], string]> = [
    ["Despatched This Week", stats.week, ["despatched", "delivered", "signed"], "week"], ["Signed This Month", stats.signedMonth, ["signed"], "signed"], [AWAITING_SIGNATURE_LABEL, stats.awaitingSignature, [...AWAITING_SIGNATURE_STATUSES], "awaiting"],
  ];
  const actions = (n: SeedNote) => <RowActions n={n} role={role} run={runAction} />;

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="delivery-notes-preview" data-role={role} data-pview={shownView}>
      <PreviewBar controls={
        <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
          <div className={s.dock}>
            <p className={typeScale.caption}>Not part of Tolra. Sample data; states are simulated and no request is made.</p>
            <p className={typeScale.label}>Role</p>
            <SegmentedControl label="Role" value={role} options={ROLES} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
            <p className={typeScale.label}>Screen state</p>
            <div className={s.dockStates} role="group" aria-label="Screen state">
              {SCREENS.map((x) => <Button key={x.v} size="sm" variant="secondary" fullWidth aria-pressed={(filters.listFilter ?? screen) === x.v} onClick={() => pickScreen(x.v)}>{x.label}</Button>)}
            </div>
            <Button size="sm" variant="secondary" onClick={resetAll}>Reset preview</Button>
          </div>
        </Popover>
      } />
      <PageHeader title={<TitleWithTip text="Delivery Notes" tip={DN_TITLE_TIP} describedBy={tipId} />}
        actions={denied ? null : <Button variant="primary" data-testid="new-note" onClick={() => setDlg({ k: "new" })}>New delivery note</Button>} />
      <p id={tipId} className={srOnly}>{DN_TITLE_TIP}</p>

      {denied ? (
        <div data-testid="access-denied">
          <EmptyState headingLevel={2} title="Access Denied" detail="Redirecting you back to the dashboard." />
          <p className={cx(typeScale.caption, s.deniedNote)}>Preview only: no redirect happens here. Delivery Notes are for Admin, Office and Workshop; Viewer cannot open them.</p>
        </div>
      ) : (
        <>
          <StatTiles label="Delivery note figures" columns={3}>
            {tiles.map(([label, value, chips, id]) => (
              <StatTile key={label} label={label} value={loaded ? value : "—"} loading={screen === "loading"} data-testid={`tile-${id}`}
                pressed={filters.chips.size === chips.length && chips.every((c) => filters.chips.has(c)) && !filters.listFilter} onPress={() => setFilters((f) => ({ ...f, chips: new Set(chips) }))} />
            ))}
          </StatTiles>

          {nSel > 0 ? (
            <SelectionBar count={nSel} filteredTotal={visible.length} noun="delivery note" onSelectAll={() => setSelected(visible.map((n) => n.id))} onClear={clearSelection}
              statusText={({ count, filteredTotal }) => `${count} selected of ${filteredTotal} filtered ${filteredTotal === 1 ? "record" : "records"}`}>
              <Button size="sm" variant="secondary" data-testid="print-selected" onClick={() => preview(`${nSel} delivery note${nSel === 1 ? "" : "s"} would open for printing. No print pack was made.`)}>Print Selected</Button>
              <Button size="sm" variant="secondary" data-testid="sign-selected" onClick={() => setDlg({ k: "sign", ids: selected })}>Mark Selected Signed</Button>
            </SelectionBar>
          ) : (
            <div className={s.toolbar} role="group" aria-label="List controls" aria-busy={screen === "loading" || undefined}>
              <div className={s.tbGroup}>
                <span className={typeScale.label}>Show</span>
                <SegmentedControl label="Show" value={filters.phase} size="sm" disabled={!loaded && screen !== "empty"} onChange={(v) => setFilters((f) => ({ ...f, phase: v }))} options={[
                  { value: "open", label: `Open (${counts.open})`, testId: "show-open" }, { value: "done", label: `Done (${counts.done})`, testId: "show-done" }, { value: "archived", label: `Archived (${counts.archived})`, testId: "show-archived" }, { value: "all", label: "All", testId: "show-all" }]} />
                <Popover label={activeChips.length ? `Filters (${activeChips.length})` : "Filters"} title="Filters" size="sm" variant="secondary" data-testid="filters-trigger">
                  <ChipGroup label="Filters">{CHIPS.map((c) => <FilterChip key={c.v} selected={filters.chips.has(c.v)} disabled={screen === "loading"} onToggle={() => toggleChip(c.v)} data-testid={`chip-${c.v}`}>{c.label}</FilterChip>)}</ChipGroup>
                </Popover>
              </div>
              <div className={s.tbGroup}>
                <Popover label="Columns" title="Delivery Notes columns" size="sm" variant="secondary" data-testid="columns-trigger">
                  <p className={cx(typeScale.caption, s.colScope)}>{mayEmail ? "Changes apply to everyone in this company. In this preview they change this screen only." : "Your own view on this device only. Everyone else, and the company setting, are not changed."}</p>
                  {COLUMNS.map((c) => (c.locked ? <p key={c.key} className={cx(typeScale.name, s.colLocked)} data-testid={`col-${c.key}`}><span>{c.label}</span><span className={typeScale.caption}>Always shown</span></p>
                    : <Switch key={c.key} label={c.label} checked={inView(c.key)} onChange={(on) => setHidden((h) => (on ? h.filter((k) => k !== c.key) : [...h, c.key]))} data-testid={`col-${c.key}`} />))}
                  <div className={s.colReset}><Button size="sm" variant="secondary" disabled={!hidden.length} onClick={() => setHidden([])}>{mayEmail ? "Reset to default (show all columns)" : "Reset to the company view"}</Button></div>
                </Popover>
                {notPhone ? <SegmentedControl label="View" value={shownView} onChange={setView} size="sm" options={[
                  { value: "cards", label: "Cards", testId: "view-cards-btn" }, { value: "list", label: "List", disabled: !wide, disabledReason: "Needs a screen wider than 1024px", testId: "view-list-btn" }, { value: "table", label: "Table", disabled: !wide, disabledReason: "Needs a screen wider than 1024px", testId: "view-table-btn" }]} /> : null}
              </div>
            </div>
          )}

          {filters.listFilter ? (
            <Callout tone="neutral" role="status" data-testid="list-filter-notice" action={<Button size="sm" variant="secondary" onClick={() => setFilters((f) => ({ ...f, listFilter: null }))}>Show everything</Button>}>
              Showing only: <strong>{DN_FILTER_LABELS[filters.listFilter]}</strong>
            </Callout>
          ) : null}
          {activeChips.length ? (
            <div ref={activeRef} className={s.activeRow} role="group" aria-label="Active filters" data-testid="active-filters">
              {activeChips.map((c, i) => (
                <Button key={c.v} size="sm" variant="secondary" className={s.activeChip} data-active-chip={c.v} aria-label={`Remove filter ${c.label}`} onClick={() => removeChip(c.v, i)}>
                  {c.label}<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2.5 2.5 7.5 7.5M7.5 2.5 2.5 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </Button>
              ))}
              <Button size="sm" variant="quiet" data-testid="clear-filters" onClick={clearFilters}>Clear filters</Button>
            </div>
          ) : null}

          <h2 className={srOnly}>Delivery notes</h2>
          <div ref={listRef}>
            {screen === "loading" ? <LoadingState label="Loading delivery notes" rows={6} />
              : screen === "error" ? <FailedState title="Couldn’t load delivery notes." detail="The list could not be fetched. This is a simulated failure: no request was made and nothing was lost." onRetry={retry} retryLabel="Retry" />
              : visible.length === 0 ? (
                <EmptyState title={data.length ? "No delivery notes match this filter" : "No delivery notes yet"} detail={data.length ? "Try a different filter." : deliveryNotesEmptyHint()}
                  action={data.length ? <Button variant="secondary" onClick={() => setFilters((f) => ({ ...f, chips: new Set(["all"]) }))}>Show all</Button> : <Button variant="primary" onClick={() => setDlg({ k: "new" })}>New delivery note</Button>} />
              ) : shownView === "cards" ? (
                <div className={s.cards} data-testid="view-cards">
                  {visible.map((n) => (
                    <article key={n.id} className={cx(s.card, selected.includes(n.id) && s.cardOn)} data-testid={`card-${n.ref}`} data-selected={selected.includes(n.id) || undefined} aria-label={n.ref}>
                      <div className={s.cardTop}>
                        <Checkbox aria-label={`Select ${n.ref} for printing`} data-testid="select-row" checked={selected.includes(n.id)} onChange={() => toggleSel(n.id)} />
                        <div className={s.cardRef}><Ref>{n.ref}</Ref></div>{inView("status") ? <Pill n={n} /> : null}
                      </div>
                      <dl className={s.dl}>
                        {inView("customer") ? <div className={s.dlWide}><dt className={typeScale.secondary}>Customer</dt><dd className={typeScale.name}>{n.customer || "Customer not linked"}</dd></div> : null}
                        {inView("job") ? <div><dt className={typeScale.secondary}>Job Ref</dt><dd className={typeScale.body}>{n.job || "No linked job"}</dd></div> : null}
                        {inView("date") ? <div><dt className={typeScale.secondary}>Delivery Date</dt><dd className={cx(typeScale.body, tabularNumbers)}>{fmtDate(n.date)}</dd></div> : null}
                        {inView("email") ? <div className={s.dlWide}><dt className={typeScale.secondary}>Email</dt><dd className={typeScale.body}>{n.emailedAt ? `Emailed ${fmtDateTime(n.emailedAt)}` : "Not emailed"}</dd></div> : null}
                      </dl>
                      {inView("status") ? <div className={s.cardNotes}><StateNotes n={n} /></div> : null}
                      <div className={s.cardActions}>{actions(n)}</div>
                    </article>
                  ))}
                </div>
              ) : (
                <ScrollTable label="Delivery notes" dense={shownView === "list"} pinLast>
                  <thead><tr>
                    <th><span className={s.firstCell}><Checkbox aria-label={`Select all ${visible.length} filtered delivery notes`} checked={visible.length > 0 && visible.every((n) => selected.includes(n.id))} onChange={(e) => setSelected(e.target.checked ? visible.map((n) => n.id) : [])} />DN Ref</span></th>
                    {inView("customer") ? <th>Customer</th> : null}{inView("job") ? <th>Job Ref</th> : null}{inView("date") ? <th>Delivery Date</th> : null}{inView("status") ? <th>Status</th> : null}{inView("email") ? <th>Email</th> : null}<th className={s.actionsHead}>Actions</th>
                  </tr></thead>
                  <tbody>{visible.map((n) => (
                    <tr key={n.id} data-note={n.ref} data-selected={selected.includes(n.id) || undefined}>
                      <td><span className={s.firstCell}><Checkbox aria-label={`Select ${n.ref}`} data-testid="select-row" checked={selected.includes(n.id)} onChange={() => toggleSel(n.id)} /><Ref>{n.ref}</Ref></span></td>
                      {inView("customer") ? <td><span className={cx(typeScale.name, s.clamp)}>{n.customer || "Customer not linked"}</span></td> : null}
                      {inView("job") ? <td className={cx(s.nowrap, tabularNumbers)}>{n.job || "No linked job"}</td> : null}
                      {inView("date") ? <td className={cx(s.nowrap, tabularNumbers)}>{fmtDate(n.date)}</td> : null}
                      {inView("status") ? <td><Pill n={n} mode="text" /><StateNotes n={n} /></td> : null}
                      {inView("email") ? <td>{n.emailedAt ? <StatusBadge tone="info-neutral" mode="text">Emailed {fmtDateTime(n.emailedAt)}</StatusBadge> : <span className={typeScale.secondary}>Not emailed</span>}</td> : null}
                      <td className={s.actionsCell}><div className={s.rowActions}>{actions(n)}</div></td>
                    </tr>))}
                  </tbody>
                </ScrollTable>
              )}
          </div>
        </>
      )}
      <Dialogs dlg={dlg} viewId={viewId} setViewId={setViewId} close={() => setDlg(null)} byId={byId} preview={preview} role={role} setDlg={setDlg} />
    </div>
  );
}

function StateNotes({ n }: { n: SeedNote }) {
  const label = n.uninvoiced ?? n.invoiceRef;
  return (
    <>
      {n.signedAt ? <span className={cx(typeScale.caption, s.cellNote)}>Signed {fmtDate(n.signedAt)}</span> : null}
      {label ? <span className={cx(typeScale.caption, s.cellNote, n.uninvoiced && s.attention)} data-testid="note-invoice-state">{label}</span> : null}
    </>
  );
}

/** One visible button (the next step) and a More menu with every other real action; the buttons never wrap. */
function RowActions({ n, role, run }: { n: SeedNote; role: Role; run: (n: SeedNote, id: RowActionId) => void }) {
  const plan = rowActionPlan(n, role);
  const items: MenuItem[] = plan.more.map((a) => ({ id: a.id, label: a.label, disabled: a.disabled, hint: a.hint, separatorBefore: a.id === "archive", onSelect: () => run(n, a.id) }));
  return (
    <>
      <Button size="sm" variant="secondary" data-action={plan.primary.label} aria-label={`${plan.primary.label} ${n.ref}`} onClick={() => run(n, plan.primary.id)}>{plan.primary.label}</Button>
      <Menu label="More" size="sm" variant="quiet" items={items} aria-label={`More actions for ${n.ref}`} data-testid="more-trigger" />
    </>
  );
}

function Dialogs({ dlg, viewId, setViewId, close, byId, preview, role, setDlg }: { dlg: Dlg | null; viewId: string | null; setViewId: (id: string | null) => void; close: () => void; byId: Map<string, SeedNote>; preview: (d: string) => void; role: Role; setDlg: (d: Dlg | null) => void }) {
  const finish = (detail: string) => { close(); setViewId(null); preview(detail); };
  const v = viewId ? byId.get(viewId) ?? null : null;
  const n = dlg && "id" in dlg ? byId.get(dlg.id) ?? null : null;
  const signing = dlg?.k === "sign" ? dlg.ids.map((id) => byId.get(id)).filter(Boolean) as SeedNote[] : [];
  const [source, setSource] = useState("manual");
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { setSource(sourcesFor(role).some((x) => x.v === "job") ? "job" : "manual"); setConfirming(false); }, [dlg?.k, role]);
  const fact = (label: string, value: ReactNode, wide?: boolean) => <div className={wide ? s.factWide : undefined}><dt className={typeScale.secondary}>{label}</dt><dd className={typeScale.name}>{value}</dd></div>;
  return (
    <>
      {v ? (
        <Sheet open size="md" title={v.ref} description="Delivery note detail" onClose={() => setViewId(null)} testId="dlg-view"
          footer={<><Button variant="secondary" onClick={() => preview(`${v.ref} would open on the print page.`)}>Print</Button><Button variant="secondary" onClick={() => preview(`The PDF for ${v.ref} is not generated.`)}>Download PDF</Button>{canEmail(role) ? <Button variant="primary" onClick={() => setDlg({ k: "email", id: v.id })}>Email Customer</Button> : null}</>}>
          <div className={s.sheetStack}>
            <dl className={s.facts}>
              {fact("Customer", v.customer)}
              {fact("Job", v.job || "No linked job")}
              {fact("Delivery date", fmtDate(v.date))}
              {fact("Status", <Pill n={v} />)}
              {v.signedBy ? fact("Signed by", `${v.signedBy} on ${fmtDate(v.signedAt)}`) : null}
              {v.signatureNotes ? fact("Signature notes", v.signatureNotes, true) : null}
              {v.emailedAt ? fact("Email history", `Sent ${fmtDateTime(v.emailedAt)}`, true) : null}
            </dl>
            <ScrollTable label="Items" dense flush>
              <thead><tr><th>Item</th><th className={s.right}>Qty</th></tr></thead>
              <tbody>{v.items.map((it) => <tr key={it.description}><td>{it.description}</td><td className={cx(s.right, tabularNumbers)}>{it.quantity}</td></tr>)}</tbody>
            </ScrollTable>
            <p className={typeScale.caption}>Preview only. Certificates, attachments and the activity trail are not shown here.</p>
          </div>
        </Sheet>
      ) : null}

      <Sheet open={dlg?.k === "new"} size="md" title="New Delivery Note" description="Make it from a sales order or a job, with the quantity despatched on each line, or by hand. No invoice is needed first." onClose={close} testId="dlg-new" closeButton={false}
        footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button variant="primary" onClick={() => finish("A delivery note would be saved. No delivery note was created.")}>{source === "manual" ? "Save Delivery Note" : "Make delivery note"}</Button></>}>
        <div className={s.sheetStack}>
          <SegmentedControl label="Where the delivery note comes from" value={source} onChange={setSource} size="sm" options={sourcesFor(role).map((x) => ({ value: x.v, label: x.label }))} />
          {source === "manual" ? (
            <div className={s.form}>
              <Field label="Invoice number" optional hint="If there is one (for example INV-0456)."><Input maxLength={20} /></Field>
              <Field label="Job" optional><Select defaultValue=""><option value="">No job (optional)</option><option>JOB-2211</option><option>JOB-2204</option></Select></Field>
              <Field label="Customer" required><Select defaultValue=""><option value="">Select customer...</option>{CUSTOMERS.map((c) => <option key={c}>{c}</option>)}</Select></Field>
              <div className={s.formGrid}><Field label="Ship date"><Input type="date" defaultValue={TODAY} /></Field><Field label="Tax date"><Input type="date" defaultValue={TODAY} /></Field></div>
              <Field label="Items" required hint="One per line: description x quantity."><Textarea placeholder={"Spacer, 25 mm x 10"} /></Field>
              <Field label="Notes" optional><Textarea maxLength={2000} /></Field>
            </div>
          ) : (
            <div className={s.form}><Field label={source === "order" ? "Sales order" : "Job"}><Select defaultValue=""><option value="">{source === "order" ? "Choose a sales order..." : "Choose a job..."}</option><option>{source === "order" ? "SO-0891 Kilbride Hydraulics" : "JOB-2211 Manifold blocks"}</option></Select></Field><p className={typeScale.secondary}>The quantity despatched on each line is entered after choosing.</p></div>
          )}
          <p className={typeScale.caption}>Preview only. Nothing is read from your orders or jobs.</p>
        </div>
      </Sheet>

      <Sheet open={dlg?.k === "edit" && !!n} size="md" title={n ? `Edit ${n.ref}` : ""} description="Update delivery note details." onClose={close} testId="dlg-edit" closeButton={false}
        footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button variant="primary" onClick={() => finish(`${n?.ref} would be updated.`)}>Save Changes</Button></>}>
        {n ? <div className={s.form}>
          <Field label="Customer"><Select defaultValue={n.customer}>{CUSTOMERS.map((c) => <option key={c}>{c}</option>)}</Select></Field>
          <Field label="Job reference"><Input defaultValue={n.job} maxLength={50} /></Field>
          <div className={s.formGrid3}><Field label="Delivery date"><Input type="date" defaultValue={day(n.date)} /></Field><Field label="Ship date"><Input type="date" defaultValue={day(n.date)} /></Field><Field label="Tax date"><Input type="date" defaultValue={day(n.date)} /></Field></div>
          <Field label="Ship via"><Input defaultValue={n.shipVia ?? ""} maxLength={100} /></Field>
        </div> : null}
      </Sheet>

      <Sheet open={dlg?.k === "sign" && signing.length > 0} size="sm" title={signing.length === 1 ? `Mark ${signing[0].ref} as signed` : `Mark ${signing.length} delivery notes as signed`} description={`Record signature details for the delivery note${signing.length === 1 ? "" : "s"}.`} onClose={close} testId="dlg-sign" closeButton={false}
        footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button variant="primary" onClick={() => finish(`${signing.length} delivery note${signing.length === 1 ? "" : "s"} would be marked signed.`)}>Confirm Signed</Button></>}>
        <div className={s.form}><Field label="Signed by" required><Input maxLength={200} /></Field><Field label="Date signed" required><Input type="date" defaultValue={TODAY} /></Field><Field label="Signature notes" optional><Textarea maxLength={2000} /></Field></div>
      </Sheet>

      <Sheet open={dlg?.k === "email" && !!n} size="md" title="Email delivery note" description="Send it from here with the PDF attached, or copy the text or open it in your email app, send it, then mark it as sent." onClose={close} testId="dlg-email" closeButton={false}
        footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button variant="secondary" onClick={() => finish("The e-mail text would be copied.")}>Copy Email Body</Button><Button variant="secondary" onClick={() => finish("Your e-mail app would open.")}>Open in email app</Button><Button variant="secondary" onClick={() => setConfirming(true)}>Mark as Sent</Button><Button variant="primary" onClick={() => finish(`${n?.ref} would be e-mailed with the PDF attached. No e-mail was sent.`)}>Send now</Button></>}>
        {n ? <div className={s.form}>
          <Field label="To"><Input readOnly value={n.email} placeholder="No email address saved for this customer" /></Field>
          <Field label="Subject"><Input defaultValue={`Delivery note ${n.ref}`} /></Field>
          <Field label="Message"><Textarea rows={8} defaultValue={`Hello ${n.customer},\n\nDelivery note ${n.ref} for job ${n.job || "No linked job"}, delivery date ${fmtDate(n.date)}, status ${n.status}.\n\nKind regards`} /></Field>
          {confirming ? <Callout tone="warn" lead="" role="status" action={<><Button size="sm" variant="primary" onClick={() => finish(`${n.ref} would be recorded as e-mailed.`)}>I’ve sent it</Button>{" "}<Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>Not yet</Button></>}>Only confirm once the e-mail has actually gone from your mailbox. This records it as sent to {n.email || "the customer"}.</Callout> : null}
          <p className={typeScale.caption}>Preview only. Nothing is e-mailed.</p>
        </div> : null}
      </Sheet>
    </>
  );
}
