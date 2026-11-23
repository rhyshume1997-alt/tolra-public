"use client";

/**
 * BOUNDARY (Purchase orders, Invoices module 4, PREVIEW ONLY). Inputs: none from the server. Everything shown is fictional sample data (12 purchase
 * orders, as of 20/11/2026) held in this file, plus the person's clicks. Outputs: a Purchase Orders list look-and-feel prototype (three figure tiles,
 * Show and status filters, selection with Export, Print Selected and Mark Selected Received, Columns, Cards / List / Table, row actions, the real
 * dialogs and the New PO form with live totals) whose only state is LOCAL UI state. It never reads or writes Supabase, calls no server action, API
 * route, e-mail, payment or accounting integration, and no action reports success: every action answers with the neutral "Preview only" toast.
 * Run-time imports from lib/ are pure modules only (money, vat, dates, purchase-order-total, status-colours, empty-hints, spreadsheet is not imported);
 * logic from modules that reach Supabase (archive phaseOf, list-filter) is mirrored here and pinned to the real functions by
 * tests/unit/purchaseOrdersPreview.test.ts. Money is exact: the Total (inc VAT) column is lib/purchase-order-total, the form totals are lib/money.
 * MUST NOT CHANGE: wording, defaults, column order, filter semantics and the role gate mirror today's page (app/(dashboard)/purchase-orders/page.tsx:
 * admin and office only; workshop and viewer see "Access Denied"). Do not wire to real data or actions, add no control the real page lacks, keep row
 * controls at a 48 px hit area.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import {
  Button, Checkbox, ChipGroup, Dialog, EmptyState, FailedState, Field, FilterChip, Input, LoadingState, Menu, Popover, ScrollTable, SegmentedControl, Select,
  SelectionBar, Sheet, StatTile, StatTiles, StatusBadge, Switch, Textarea, ToastProvider, cx, premiumTokens, tabularNumbers, useToast,
} from "@/components/ui/premium";
import type { MenuItem, StatusTone } from "@/components/ui/premium";
import { fmtDate } from "@/lib/dates";
import { purchaseOrdersEmptyHint } from "@/lib/empty-hints";
import { documentTotals, gbp, vatRowLabel } from "@/lib/money";
import { PO_TOTAL_LABEL, purchaseOrderTotalIncVat } from "@/lib/purchase-order-total";
import { purchaseOrderStatusKey } from "@/lib/status-colours";
import { VAT_CHOICES, VAT_CHOICE_LABELS, fromVatChoice } from "@/lib/vat";
import type { VatChoice } from "@/lib/vat";

import s from "./PurchaseOrdersPreview.module.css";

export type Role = "admin" | "office" | "workshop" | "viewer";
export type ViewMode = "cards" | "list" | "table";
export type PhaseValue = "open" | "done" | "archived" | "all";
export type Phase = "open" | "done" | "archived";
export type Screen = "ready" | "loading" | "error" | "empty";
export type ListFilterKey = "late";
export type ColumnKey = "ref" | "supplier" | "date" | "delivery" | "value" | "status";

/** The sample's "today": the overdue, month and archive rules are worked out against it. */
export const TODAY = "2026-11-20";
export const ARCHIVE_MONTHS = 12;
/** The company's VAT set-up in the sample: registered, standard rate 20%. */
export const VAT = { registered: true, standardRate: 20 };
export const OPEN_STATUSES = ["draft", "issued", "sent", "confirmed", "awaiting"];
export const PO_FILTER_LABELS: Record<ListFilterKey, string> = { late: "Purchase orders past their expected delivery" };
export const COLUMNS: Array<{ key: ColumnKey; label: string; locked?: boolean }> = [
  { key: "ref", label: "PO Ref", locked: true }, { key: "supplier", label: "Supplier" }, { key: "date", label: "Order Date" }, { key: "delivery", label: "Expected Delivery" }, { key: "value", label: PO_TOTAL_LABEL }, { key: "status", label: "Status" },
];
export const CHIPS: Array<{ v: string; label: string }> = [{ v: "all", label: "All" }, { v: "draft", label: "Draft" }, { v: "issued", label: "Issued" }, { v: "sent", label: "Sent" }, { v: "confirmed", label: "Confirmed" }, { v: "awaiting", label: "Awaiting Delivery" }, { v: "received", label: "Received" }];
export const SUPPLIERS = ["MetalSupplies Ltd", "Steel Supplies", "Aerospace Materials", "Midlands Tooling", "Anodising Services UK"];

export type SeedPo = {
  id: string; ref: string; supplier: string; date: string; delivery: string; value: number; vatEnabled?: boolean; status: string; sentAt?: string; receivedAt?: string;
  items?: Array<{ description: string; qty: number; unit_price: number; vat_pct?: number; vat_exempt?: boolean }>; notes?: string; link?: string; linkedNet?: number | null; manual?: "archived" | "active";
};
export const SEED_POS: SeedPo[] = [
  { id: "p12", ref: "PO-0112", supplier: "MetalSupplies Ltd", date: "2026-11-19", delivery: "2026-11-26", value: 3460, vatEnabled: true, status: "draft", items: [{ description: "6061-T6 plate 20 mm, 1000 x 500", qty: 10, unit_price: 346 }], link: "JOB-2211 Manifold blocks", linkedNet: null },
  { id: "p11", ref: "PO-0111", supplier: "Steel Supplies", date: "2026-11-17", delivery: "2026-11-24", value: 1296, vatEnabled: true, status: "issued", items: [{ description: "316 stainless bar 40 mm, 3 m", qty: 6, unit_price: 216 }], link: "QUO-0434 Guard frames", linkedNet: 800 },
  { id: "p10", ref: "PO-0110", supplier: "Anodising Services UK", date: "2026-11-12", delivery: "2026-11-19", value: 586.5, vatEnabled: true, status: "sent", sentAt: "2026-11-12T14:00:00Z", items: [{ description: "Black anodise, sensor housings", qty: 250, unit_price: 2.346 }] },
  { id: "p09", ref: "PO-0109", supplier: "Midlands Tooling", date: "2026-11-10", delivery: "2026-11-18", value: 742.4, vatEnabled: false, status: "awaiting", sentAt: "2026-11-10T10:00:00Z", items: [{ description: "Carbide inserts, box of 10", qty: 8, unit_price: 92.8 }] },
  { id: "p08", ref: "PO-0108", supplier: "Aerospace Materials", date: "2026-11-05", delivery: "2026-11-14", value: 3720, vatEnabled: true, status: "confirmed", sentAt: "2026-11-05T09:00:00Z", items: [{ description: "7075-T651 plate 25 mm", qty: 12, unit_price: 310 }] },
  { id: "p07", ref: "PO-0107", supplier: "Steel Supplies", date: "2026-11-02", delivery: "2026-11-09", value: 1300, vatEnabled: true, status: "awaiting", sentAt: "2026-11-02T09:00:00Z", items: [{ description: "Mild steel flat 50 x 10, 6 m", qty: 20, unit_price: 65 }] },
  { id: "p06", ref: "PO-0106", supplier: "MetalSupplies Ltd", date: "2026-10-28", delivery: "2026-11-04", value: 840, vatEnabled: true, status: "received", sentAt: "2026-10-28T09:00:00Z", receivedAt: "2026-11-04T10:00:00Z", items: [{ description: "Aluminium bronze bar 60 mm", qty: 5, unit_price: 168 }] },
  { id: "p05", ref: "PO-0105", supplier: "Midlands Tooling", date: "2026-10-20", delivery: "2026-10-27", value: 415, vatEnabled: true, status: "received", sentAt: "2026-10-20T09:00:00Z", receivedAt: "2026-11-02T10:00:00Z", items: [{ description: "Boring bar set", qty: 1, unit_price: 415 }] },
  { id: "p04", ref: "PO-0104", supplier: "Aerospace Materials", date: "2026-10-14", delivery: "2026-10-21", value: 2210, vatEnabled: true, status: "received", sentAt: "2026-10-14T09:00:00Z", receivedAt: "2026-10-21T10:00:00Z", items: [{ description: "Titanium bar 30 mm", qty: 5, unit_price: 442 }] },
  { id: "p03", ref: "PO-0103", supplier: "Steel Supplies", date: "2026-10-02", delivery: "2026-10-09", value: 520, vatEnabled: true, status: "cancelled", manual: "archived", items: [{ description: "Steel angle 50 x 50", qty: 10, unit_price: 52 }] },
  { id: "p02", ref: "PO-0050", supplier: "MetalSupplies Ltd", date: "2025-09-09", delivery: "2025-09-16", value: 960, vatEnabled: true, status: "received", sentAt: "2025-09-09T09:00:00Z", receivedAt: "2025-09-16T10:00:00Z", items: [{ description: "Aluminium plate 10 mm", qty: 12, unit_price: 80 }] },
  { id: "p01", ref: "PO-0113", supplier: "Anodising Services UK", date: "2026-11-20", delivery: "", value: 300, status: "draft", notes: "Waiting for the finishing spec." },
];

/* ---------- pure logic ---------- */
const dayMs = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const day = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "");
export const daysBetween = (from: string, to: string) => Math.round((dayMs(to) - dayMs(from)) / 86_400_000);
export function phaseOf(record: { final: boolean; finalDate?: string | null }, manual: "archived" | "active" | undefined, months: number, now: Date = new Date(`${TODAY}T12:00:00Z`)): Phase {
  if (manual === "archived") return "archived";
  if (!record.final) return "open";
  if (manual === "active" || !record.finalDate) return "done";
  const cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - months);
  const at = new Date(record.finalDate);
  return !Number.isNaN(at.getTime()) && at < cutoff ? "archived" : "done";
}
export const phaseFor = (p: Pick<SeedPo, "status" | "delivery" | "date" | "manual">): Phase => phaseOf({ final: ["received", "cancelled"].includes(p.status), finalDate: p.delivery || p.date }, p.manual, ARCHIVE_MONTHS);
/** lib/list-filter purchaseOrderMatchesFilter (mirrored). */
export function matchesListFilter(filter: string, po: { status: string; delivery?: string; receivedAt?: string }, today: string = TODAY): boolean {
  if (filter !== "late") return true;
  const due = day(po.delivery);
  return Boolean(due) && due < today && !po.receivedAt && !["draft", "received", "cancelled"].includes(po.status.toLowerCase());
}
export const totalOf = (p: SeedPo) => purchaseOrderTotalIncVat({ value: p.value, vatEnabled: p.vatEnabled, items: p.items }, VAT);
export type Filters = { phase: PhaseValue; chips: ReadonlySet<string>; listFilter: ListFilterKey | null };
export const DEFAULT_FILTERS: Filters = { phase: "open", chips: new Set(["all"]), listFilter: null };
export function visiblePos(pos: readonly SeedPo[], f: Filters, today: string = TODAY): SeedPo[] {
  return pos.filter((p) => (f.listFilter ? matchesListFilter(f.listFilter, p, today) : (f.phase === "all" || phaseFor(p) === f.phase) && (f.chips.has("all") || f.chips.has(p.status))));
}
export const phaseCounts = (pos: readonly SeedPo[]): Record<Phase, number> => ({ open: pos.filter((x) => phaseFor(x) === "open").length, done: pos.filter((x) => phaseFor(x) === "done").length, archived: pos.filter((x) => phaseFor(x) === "archived").length });
export function statsOf(pos: readonly SeedPo[], today: string = TODAY) {
  const open = pos.filter((p) => p.status !== "received");
  return { open: open.length, overdue: open.filter((p) => p.delivery && p.delivery < today).length, receivedMonth: pos.filter((p) => p.status === "received" && p.receivedAt && day(p.receivedAt).slice(0, 7) === today.slice(0, 7)).length };
}
export const canUsePurchaseOrders = (r: Role) => r === "admin" || r === "office";
const KEY_TONE: Record<string, StatusTone> = { draft: "neutral", issued: "info", sent: "info", waiting_on_supplier: "warn", delivered: "ok", cancelled: "neutral" };
export const toneOf = (status: string): StatusTone => { const k = purchaseOrderStatusKey(status); return k ? KEY_TONE[k] ?? "neutral" : "neutral"; };
export const canIssue = (p: Pick<SeedPo, "status">) => p.status === "draft";
export const canRecordSent = (p: Pick<SeedPo, "status" | "sentAt">) => p.status !== "draft" && !p.sentAt && p.status !== "received";
export const canMarkReceived = (p: Pick<SeedPo, "status">) => !(p.status === "received" || p.status === "draft");
export function scopeTitle(selected: number, inFilter: number): string {
  const plural = (n: number) => `${n} purchase order${n === 1 ? "" : "s"}`;
  return selected > 0 ? `Exports the ${plural(selected)} selected` : `Exports all ${plural(inFilter)} in the current filter (nothing is selected)`;
}

/* ---------- local pieces ---------- */
const VIEW_KEY = "purchase-orders-preview:view";
const ROLES: Array<{ value: Role; label: string }> = [{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" }];
const SCREENS: Array<{ v: Screen | ListFilterKey; label: string }> = [{ v: "ready", label: "Normal" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "empty", label: "No purchase orders yet" }, { v: "late", label: "Dashboard link: Late" }];
function useMedia(query: string, fallback: boolean): boolean {
  return useSyncExternalStore((cb) => { const m = window.matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); }, () => window.matchMedia(query).matches, () => fallback);
}
const Mono = ({ children }: { children: ReactNode }) => <span className={cx(s.ref, tabularNumbers)}>{children}</span>;
const Pill = ({ p }: { p: SeedPo }) => <StatusBadge tone={toneOf(p.status)}><span className={s.cap}>{p.status}</span></StatusBadge>;
const pounds = (n: number) => gbp(n, 2);

type Dlg = { k: "new" } | { k: "edit"; id: string } | { k: "issue"; id: string } | { k: "sent"; id: string };

export default function PurchaseOrdersPreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

function Inner() {
  const toast = useToast();
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
  const data = useMemo(() => (screen === "ready" ? SEED_POS : []), [screen]);
  const byId = useMemo(() => new Map(SEED_POS.map((p) => [p.id, p])), []);
  const visible = useMemo(() => visiblePos(data, filters), [data, filters]);
  const counts = useMemo(() => phaseCounts(data), [data]);
  const stats = useMemo(() => statsOf(data), [data]);
  const inView = (c: ColumnKey) => !hidden.includes(c);
  const nSel = selected.length;
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const denied = !canUsePurchaseOrders(role);
  const toggleChip = (value: string) => setFilters((f) => { const next = new Set(f.chips); if (value === "all") { next.clear(); next.add("all"); } else { next.delete("all"); if (next.has(value)) next.delete(value); else next.add(value); if (!next.size) next.add("all"); } return { ...f, chips: next }; });
  const toggleSel = (id: string) => setSelected((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const retry = () => { setScreen("loading"); setTimer(window.setTimeout(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample purchase orders shown again. No server was contacted." }); }, 700)); };
  const resetAll = () => { setScreen("ready"); setFilters(DEFAULT_FILTERS); setSelected([]); setHidden([]); setDlg(null); setViewId(null); toast.clear(); };
  const pickScreen = (v: Screen | ListFilterKey) => { toast.clear(); setSelected([]); if (v === "late") { setScreen("ready"); setFilters({ ...DEFAULT_FILTERS, listFilter: v }); return; } setFilters((f) => ({ ...f, listFilter: null })); setScreen(v); };
  const archive = (p: SeedPo) => preview(`${p.ref} would be ${phaseFor(p) === "archived" ? "moved out of the archive" : "archived"}.`);
  const receive = (ids: string[]) => preview(`${ids.length} purchase order${ids.length === 1 ? "" : "s"} would be marked received.`);
  const exportAs = (fmt: string) => preview(`The ${fmt} export would cover ${nSel ? `the ${nSel} selected purchase order${nSel === 1 ? "" : "s"}` : `all ${visible.length} purchase order${visible.length === 1 ? "" : "s"} in the current filter`}. No file was downloaded.`);
  const tiles: Array<[string, number, string[], string]> = [["Open POs", stats.open, OPEN_STATUSES, "open"], ["Overdue Delivery", stats.overdue, OPEN_STATUSES, "overdue"], ["Received This Month", stats.receivedMonth, ["received"], "received"]];

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="purchase-orders-preview" data-role={role} data-pview={shownView}>
      <header className={s.head}>
        <div className={s.titleBlock}>
          <div className={s.titleLine}>
            <h1 className={s.title}>Purchase Orders</h1>
            <span className={s.previewTag} title="Everything on this screen is fictional sample data. Nothing is read from or saved to your account.">Preview, sample data, nothing is saved</span>
            <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
              <div className={s.dock}>
                <p className={s.dockNote}>Not part of Tolra. Sample data; states are simulated and no request is made.</p>
                <p className={s.dockLabel}>Role</p>
                <SegmentedControl label="Role" value={role} options={ROLES} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
                <p className={s.dockLabel}>Screen state</p>
                <div className={s.dockStates} role="group" aria-label="Screen state">
                  {SCREENS.map((x) => <button key={x.v} type="button" aria-pressed={(filters.listFilter ?? screen) === x.v} className={s.dockBtn} onClick={() => pickScreen(x.v)}>{x.label}</button>)}
                </div>
                <Button size="sm" variant="secondary" onClick={resetAll}>Reset preview</Button>
              </div>
            </Popover>
          </div>
          <p className={s.subtitle}>Purchase orders are what we buy from suppliers.</p>
        </div>
        {denied ? null : <div className={s.headControls}><Button variant="primary" data-testid="new-po" onClick={() => setDlg({ k: "new" })}>New purchase order</Button></div>}
      </header>

      {denied ? (
        <section className={s.denied} data-testid="access-denied">
          <h2 className={s.deniedTitle}>Access Denied</h2><p className={s.deniedText}>Redirecting you back to the dashboard.</p>
          <p className={s.deniedNote}>Preview only: no redirect happens here. Purchase Orders are for Admin and Office; Workshop and Viewer cannot open them.</p>
        </section>
      ) : (
        <>
          <StatTiles label="Purchase order figures" columns={3}>
            {tiles.map(([label, value, chips, id]) => (
              <StatTile key={label} label={label} value={loaded ? value : "—"} loading={screen === "loading"} data-testid={`tile-${id}`}
                pressed={filters.chips.size === chips.length && chips.every((c) => filters.chips.has(c)) && !filters.listFilter} onPress={() => setFilters((f) => ({ ...f, chips: new Set(chips) }))} />
            ))}
          </StatTiles>

          <section className={s.panel} aria-label="Filters" aria-busy={screen === "loading" || undefined}>
            {filters.listFilter ? (
              <div className={s.notice} role="status" data-testid="list-filter-notice">
                <p>Showing only: <strong>{PO_FILTER_LABELS[filters.listFilter]}</strong></p>
                <Button size="sm" variant="secondary" onClick={() => setFilters((f) => ({ ...f, listFilter: null }))}>Show everything</Button>
              </div>
            ) : null}
            <div className={s.panelRow}>
              <span className={s.panelLabel}>Show</span>
              <SegmentedControl label="Show" value={filters.phase} size="sm" disabled={!loaded && screen !== "empty"} onChange={(v) => setFilters((f) => ({ ...f, phase: v }))} options={[
                { value: "open", label: `Open (${counts.open})`, testId: "show-open" }, { value: "done", label: `Done (${counts.done})`, testId: "show-done" }, { value: "archived", label: `Archived (${counts.archived})`, testId: "show-archived" }, { value: "all", label: "All", testId: "show-all" }]} />
            </div>
            <div className={s.panelRow}>
              <span className={s.panelLabel}>Filters</span>
              <ChipGroup label="Filters">{CHIPS.map((c) => <FilterChip key={c.v} selected={filters.chips.has(c.v)} disabled={screen === "loading"} onToggle={() => toggleChip(c.v)} data-testid={`chip-${c.v}`}>{c.label}</FilterChip>)}</ChipGroup>
            </div>
            <div className={cx(s.panelRow, s.viewRow)}>
              <Popover label="Columns" title="Purchase Orders columns" size="sm" variant="secondary" data-testid="columns-trigger">
                <p className={s.colScope}>Changes apply to everyone in this company. In this preview they change this screen only.</p>
                {COLUMNS.map((c) => (c.locked ? <p key={c.key} className={s.colLocked} data-testid={`col-${c.key}`}><span>{c.label}</span><span>Always shown</span></p>
                  : <Switch key={c.key} label={c.label} checked={inView(c.key)} onChange={(on) => setHidden((h) => (on ? h.filter((k) => k !== c.key) : [...h, c.key]))} data-testid={`col-${c.key}`} />))}
                <div className={s.colReset}><Button size="sm" variant="secondary" disabled={!hidden.length} onClick={() => setHidden([])}>Reset to default (show all columns)</Button></div>
              </Popover>
              {notPhone ? <SegmentedControl label="View" value={shownView} onChange={setView} size="sm" options={[
                { value: "cards", label: "Cards", testId: "view-cards-btn" }, { value: "list", label: "List", disabled: !wide, disabledReason: "Needs a screen wider than 1024px", testId: "view-list-btn" }, { value: "table", label: "Table", disabled: !wide, disabledReason: "Needs a screen wider than 1024px", testId: "view-table-btn" }]} /> : null}
            </div>
          </section>

          <SelectionBar count={nSel} filteredTotal={visible.length} noun="purchase order" selectAll="always" clear="always" onSelectAll={() => setSelected(visible.map((p) => p.id))} onClear={() => setSelected([])}
            idleNote={`0 selected of ${visible.length} filtered ${visible.length === 1 ? "record" : "records"}`}>
            <Button size="sm" variant="secondary" data-testid="print-selected" disabled={!nSel} title={nSel ? undefined : "Select at least one purchase order"} onClick={() => preview(`${nSel} purchase order${nSel === 1 ? "" : "s"} would open for printing. No print pack was made.`)}>Print Selected</Button>
            <Menu label="Export" size="sm" variant="secondary" data-testid="export-trigger" items={[{ id: "CSV", label: "CSV", onSelect: () => exportAs("CSV") }, { id: "Excel", label: "Excel", onSelect: () => exportAs("Excel") }]} />
            <Button size="sm" variant="secondary" data-testid="receive-selected" disabled={!nSel} title={nSel ? undefined : "Select at least one purchase order"} onClick={() => receive(selected)}>Mark Selected Received</Button>
          </SelectionBar>

          <h2 className={s.srOnly}>Purchase orders</h2>
          {screen === "loading" ? <LoadingState label="Loading purchase orders" rows={6} />
            : screen === "error" ? <FailedState title="Couldn’t load purchase orders." detail="The list could not be fetched. This is a simulated failure: no request was made and nothing was lost." onRetry={retry} retryLabel="Retry" />
            : visible.length === 0 ? (
              <EmptyState title={data.length ? "No purchase orders match this filter" : "No purchase orders yet"} detail={data.length ? "Try a different filter." : purchaseOrdersEmptyHint()}
                action={data.length ? <Button variant="secondary" onClick={() => setFilters((f) => ({ ...f, chips: new Set(["all"]) }))}>Show all</Button> : <Button variant="primary" onClick={() => setDlg({ k: "new" })}>New purchase order</Button>} />
            ) : shownView === "cards" ? (
              <div className={s.cards} data-testid="view-cards">
                {visible.map((p) => (
                  <article key={p.id} className={cx(s.card, p.status === "received" && s.cardSigned)} data-po={p.ref} data-selected={selected.includes(p.id) || undefined} aria-label={p.ref}>
                    <div className={s.cardTop}>
                      <Checkbox aria-label={`Select ${p.ref} for export`} data-testid="select-row" checked={selected.includes(p.id)} onChange={() => toggleSel(p.id)} />
                      <div className={s.cardRef}><Mono>{p.ref}</Mono></div>{inView("status") ? <Pill p={p} /> : null}
                    </div>
                    <dl className={s.dl}>
                      {inView("supplier") ? <div className={s.dlWide}><dt>Supplier</dt><dd className={s.dlStrong}>{p.supplier}</dd></div> : null}
                      {inView("date") ? <div><dt>Order Date</dt><dd className={tabularNumbers}>{fmtDate(p.date)}</dd></div> : null}
                      {inView("delivery") ? <div><dt>Expected Delivery</dt><dd className={tabularNumbers}>{fmtDate(p.delivery) || "Not set"}</dd></div> : null}
                      {inView("value") ? <div className={s.dlValue}><dt>{PO_TOTAL_LABEL}</dt><dd className={cx(s.cardValue, tabularNumbers)}>{pounds(totalOf(p))}</dd></div> : null}
                    </dl>
                    <div className={s.cardActions}><Actions p={p} setViewId={setViewId} setDlg={setDlg} preview={preview} archive={archive} receive={receive} /></div>
                  </article>
                ))}
              </div>
            ) : (
              <ScrollTable label="Purchase orders" className={shownView === "list" ? s.dense : undefined}>
                <thead><tr>
                  <th className={s.thFirst}><span className={s.firstCell}><Checkbox aria-label={`Select all ${visible.length} filtered purchase orders`} checked={visible.length > 0 && visible.every((p) => selected.includes(p.id))} onChange={(e) => setSelected(e.target.checked ? visible.map((p) => p.id) : [])} />PO Ref</span></th>
                  {inView("supplier") ? <th>Supplier</th> : null}{inView("date") ? <th>Order Date</th> : null}{inView("delivery") ? <th>Expected Delivery</th> : null}{inView("value") ? <th className={s.right}>{PO_TOTAL_LABEL}</th> : null}{inView("status") ? <th>Status</th> : null}<th className={s.right}>Actions</th>
                </tr></thead>
                <tbody>{visible.map((p) => (
                  <tr key={p.id} data-po={p.ref} data-selected={selected.includes(p.id) || undefined}>
                    <td className={s.tdFirst}><span className={s.firstCell}><Checkbox aria-label={`Select ${p.ref}`} data-testid="select-row" checked={selected.includes(p.id)} onChange={() => toggleSel(p.id)} /><Mono>{p.ref}</Mono></span></td>
                    {inView("supplier") ? <td><span className={s.clamp}>{p.supplier}</span></td> : null}
                    {inView("date") ? <td className={cx(s.nowrap, tabularNumbers)}>{fmtDate(p.date)}</td> : null}
                    {inView("delivery") ? <td className={cx(s.nowrap, tabularNumbers)}>{fmtDate(p.delivery) || "—"}</td> : null}
                    {inView("value") ? <td className={cx(s.right, s.money2, tabularNumbers)}>{pounds(totalOf(p))}</td> : null}
                    {inView("status") ? <td><Pill p={p} /></td> : null}
                    <td className={s.right}><div className={s.rowActions}><Actions p={p} setViewId={setViewId} setDlg={setDlg} preview={preview} archive={archive} receive={receive} /></div></td>
                  </tr>))}
                </tbody>
              </ScrollTable>
            )}
        </>
      )}
      <Dialogs dlg={dlg} viewId={viewId} setViewId={setViewId} close={() => setDlg(null)} byId={byId} preview={preview} />
    </div>
  );
}

function Actions({ p, setViewId, setDlg, preview, archive, receive }: { p: SeedPo; setViewId: (id: string) => void; setDlg: (d: Dlg) => void; preview: (d: string) => void; archive: (p: SeedPo) => void; receive: (ids: string[]) => void }) {
  // Print and Archive sit in one More menu so the row never scrolls sideways; every action the real row has is still here.
  const items: MenuItem[] = [
    { id: "print", label: `Print ${p.ref}`, onSelect: () => preview(`${p.ref} would open on the print page.`) },
    { id: "archive", label: `${phaseFor(p) === "archived" ? "Unarchive" : "Archive"} ${p.ref}`, onSelect: () => archive(p), separatorBefore: true },
  ];
  return (
    <>
      <Button size="sm" variant="secondary" data-action="View" aria-label={`View ${p.ref}`} onClick={() => setViewId(p.id)}>View</Button>
      <Button size="sm" variant="secondary" data-action="Edit" aria-label={`Edit ${p.ref}`} onClick={() => setDlg({ k: "edit", id: p.id })}>Edit</Button>
      {canIssue(p) ? <Button size="sm" variant="primary" data-action="Issue" aria-label={`Issue ${p.ref}`} onClick={() => setDlg({ k: "issue", id: p.id })}>Issue</Button> : null}
      {canRecordSent(p) ? <Button size="sm" variant="secondary" data-action="Record Sent" aria-label={`Record ${p.ref} as sent`} onClick={() => setDlg({ k: "sent", id: p.id })}>Record Sent</Button> : null}
      <Button size="sm" variant="secondary" data-action="Mark Received" aria-label={`Mark ${p.ref} received`} disabled={!canMarkReceived(p)} onClick={() => receive([p.id])}>Mark Received</Button>
      <Menu label="More" size="sm" variant="quiet" items={items} data-testid="more-trigger" />
    </>
  );
}

function Dialogs({ dlg, viewId, setViewId, close, byId, preview }: { dlg: Dlg | null; viewId: string | null; setViewId: (id: string | null) => void; close: () => void; byId: Map<string, SeedPo>; preview: (d: string) => void }) {
  const finish = (detail: string) => { close(); setViewId(null); preview(detail); };
  const v = viewId ? byId.get(viewId) ?? null : null;
  const p = dlg && "id" in dlg ? byId.get(dlg.id) ?? null : null;
  return (
    <>
      {v ? (
        <Sheet open size="md" title={v.ref} description="Purchase order detail" onClose={() => setViewId(null)} testId="dlg-view"
          footer={<><Button variant="secondary" onClick={() => preview(`${v.ref} would open on the print page.`)}>Print</Button><Button variant="secondary" onClick={() => preview(`The PDF for ${v.ref} is not generated.`)}>Download PDF</Button>{v.status !== "draft" ? <Button variant="primary" onClick={() => preview(`${v.ref} would be e-mailed to the supplier. No e-mail was sent.`)}>Email to supplier</Button> : null}</>}>
          <div className={s.facts}>
            <div><span className={s.factLabel}>Supplier</span><p className={s.factStrong}>{v.supplier}</p></div>
            <div><span className={s.factLabel}>Status</span><p><Pill p={v} /></p></div>
            <div><span className={s.factLabel}>Order date</span><p className={s.factStrong}>{fmtDate(v.date)}</p></div>
            <div><span className={s.factLabel}>Expected delivery</span><p className={s.factStrong}>{fmtDate(v.delivery) || "Not set"}</p></div>
            <div><span className={s.factLabel}>Value</span><p className={cx(s.factStrong, tabularNumbers)}>{pounds(v.value)}</p></div>
            <div><span className={s.factLabel}>{PO_TOTAL_LABEL}</span><p className={cx(s.factStrong, tabularNumbers)}>{pounds(totalOf(v))}</p></div>
            {v.link ? <div className={s.factWide} data-testid="po-view-link"><span className={s.factLabel}>For</span><p className={s.factStrong}>{v.link}{v.linkedNet != null ? ` (${pounds(v.linkedNet)} of this order, ex VAT)` : ""}</p></div> : null}
            {v.receivedAt ? <div><span className={s.factLabel}>Received</span><p className={s.factStrong}>{fmtDate(v.receivedAt)}</p></div> : null}
            {v.notes ? <div className={s.factWide}><span className={s.factLabel}>Notes</span><p className={s.factStrong}>{v.notes}</p></div> : null}
          </div>
          <p className={s.sheetNote}>Preview only. Attachments and the activity trail are not shown here.</p>
        </Sheet>
      ) : null}
      {dlg?.k === "new" ? <NewPoSheet onClose={close} finish={finish} /> : null}
      <Sheet open={dlg?.k === "edit" && !!p} size="md" title={p ? `Edit ${p.ref}` : ""} description="Update supplier order details." onClose={close} testId="dlg-edit" closeButton={false}
        footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button variant="primary" onClick={() => finish(`${p?.ref} would be updated.`)}>Save Changes</Button></>}>
        {p ? <div className={s.form}>
          {p.status !== "draft" ? <p className={s.mutedLine}>Issued: the supplier, items and value are fixed. You can still change the delivery date and notes.</p> : null}
          <Field label="Supplier"><Select defaultValue={p.supplier} disabled={p.status !== "draft"}>{SUPPLIERS.map((x) => <option key={x}>{x}</option>)}</Select></Field>
          <Field label="Expected delivery"><Input type="date" defaultValue={day(p.delivery)} /></Field>
          <Field label={`Order value (ex VAT)${p.items?.length ? " - set by the line items" : ""}`}><Input type="number" step="0.01" min="0" inputMode="decimal" defaultValue={p.value} disabled={Boolean(p.items?.length) || p.status !== "draft"} /></Field>
          <Field label="Notes" optional><Textarea maxLength={2000} defaultValue={p.notes ?? ""} /></Field>
        </div> : null}
      </Sheet>
      <Dialog open={dlg?.k === "issue" && !!p} onClose={close} confirmLabel="Issue Purchase Order" title={p ? `Issue ${p.ref}?` : ""} description="Issuing fixes the supplier, items and value. The delivery date and notes can still change."
        onConfirm={() => finish(`${p?.ref} would be issued.`)}><p className={s.sheetNote}>Preview only. The finance check is not run.</p></Dialog>
      <Dialog open={dlg?.k === "sent" && !!p} onClose={close} cancelLabel="Not yet" confirmLabel={"I’ve sent it"} title={p ? `Has ${p.ref} gone to the supplier?` : ""} description="Only confirm once it has actually been sent. This records the time."
        onConfirm={() => finish(`${p?.ref} would be recorded as sent.`)} />
    </>
  );
}

function NewPoSheet({ onClose, finish }: { onClose: () => void; finish: (d: string) => void }) {
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("");
  const [vatOn, setVatOn] = useState(true);
  const [choice, setChoice] = useState<VatChoice>("20");
  const [tried, setTried] = useState(false);
  const [supplier, setSupplier] = useState("");
  const totals = documentTotals([{ quantity: Number(qty) || 0, unitPrice: Number(unit) || 0, ...fromVatChoice(choice) }], 0, { vatEnabled: vatOn, standardRate: VAT.standardRate });
  const submit = () => { setTried(true); if (!supplier || !qty || !unit) return; finish(`A draft purchase order for ${supplier} totalling ${pounds(totals.total)} would be saved. No purchase order was created.`); };
  return (
    <Sheet open size="lg" title="New Purchase Order" description="Add supplier, item, expected delivery and notes. Prices are ex VAT; VAT is added when switched on." onClose={onClose} testId="dlg-new" closeButton={false}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save PO</Button></>}>
      <form className={s.form} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="Supplier" required error={tried && !supplier ? "Choose a supplier." : undefined}><Select value={supplier} onChange={(e) => setSupplier(e.target.value)}><option value="">Select supplier...</option>{SUPPLIERS.map((x) => <option key={x} value={x}>{x}</option>)}</Select></Field>
        <div className={s.formGrid3}>
          <Field label="Description" required><Input maxLength={500} placeholder="Description" /></Field>
          <Field label="Qty" required error={tried && !qty ? "Enter a quantity." : undefined}><Input type="number" step="0.001" min="0" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          <Field label="Unit price (ex VAT)" required error={tried && !unit ? "Enter a unit price." : undefined}><Input type="number" step="0.01" min="0" inputMode="decimal" value={unit} onChange={(e) => setUnit(e.target.value)} /></Field>
        </div>
        <div className={s.bFoot}>
          <div className={s.vatBox}><Switch label="Add VAT" checked={vatOn} onChange={setVatOn} /><Field label="Line VAT"><Select value={choice} disabled={!vatOn} onChange={(e) => setChoice(e.target.value as VatChoice)}>{VAT_CHOICES.map((c) => <option key={c} value={c}>{VAT_CHOICE_LABELS[c]}</option>)}</Select></Field></div>
          <dl className={s.totals} data-testid="new-totals">
            <div><dt>Subtotal</dt><dd className={tabularNumbers}>{pounds(totals.subtotal)}</dd></div>
            {vatOn ? (totals.vatBreakdown.filter((r) => !r.exempt).length ? totals.vatBreakdown.filter((r) => !r.exempt).map((r) => <div key={vatRowLabel(r)}><dt>{vatRowLabel(r)}</dt><dd className={tabularNumbers}>{pounds(r.vat)}</dd></div>) : <div><dt>VAT</dt><dd className={tabularNumbers}>{pounds(0)}</dd></div>) : <div><dt>No VAT</dt><dd>-</dd></div>}
            <div className={s.totalRow}><dt>PO total</dt><dd className={tabularNumbers}>{pounds(totals.total)}</dd></div>
          </dl>
        </div>
        <Field label="Expected delivery" optional><Input type="date" /></Field>
        <Field label="Notes" optional><Textarea maxLength={2000} /></Field>
        <Field label="For quote / job" optional hint="Internal: not on the supplier's PDF."><Select defaultValue=""><option value="">None</option><option>QUO-0434 Guard frames</option><option>JOB-2211 Manifold blocks</option></Select></Field>
        <p className={s.sheetNote}>Preview only. Saving does not create a purchase order.</p>
      </form>
    </Sheet>
  );
}
