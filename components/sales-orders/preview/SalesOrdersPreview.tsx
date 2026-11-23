"use client";

/**
 * BOUNDARY (Sales Orders, Quotes / RFQ / Sales Orders module 3, PREVIEW ONLY, v3 on the shared premium set v4). Inputs: none from the server. Everything shown is fictional sample data (made-up
 * companies, as of 23/11/2026) held in this file, plus the person's clicks. Outputs: a Sales Orders list look-and-feel prototype (the three tiles, Show by phase, status filters, selection with Print
 * and Export, Convert Selected to Jobs and Despatch Selected, Cards / List / Table, Columns, the row actions, and the real sheets: order detail, New sales order, Edit, Add customer PO and Machines)
 * whose only state is LOCAL UI state. It reads and writes no Supabase table, calls no server action, RPC or API route, makes no job, prints and downloads nothing, and no action ever reports success:
 * everything that would save, convert, despatch, archive or export answers with the neutral "Preview only ... Nothing was saved." toast (or an inline preview note while a sheet is open) and nothing changes.
 * Run-time imports from lib/ are pure leaf modules only (sales-order-convert, list-card-counts, accept-quote, so-machines, order-from-quote, quote-status, status-colours, spreadsheet, money, vat, dates,
 * shell-status, empty-hints) and types: the convert, despatch, edit-block, card-count, machine-sum, order-terms and status-colour rules are the REAL functions. The rules that live inline in
 * app/(dashboard)/sales-orders/page.tsx or in lib/archive.ts (which pulls in the browser client and so cannot be imported here), the open-phase rule, the list filter, the toolbar's disabled reasons and the
 * form's checks, are mirrored here and pinned by tests/unit/salesOrdersPreview.test.ts (to the real functions where they exist, to the page's source text where they do not).
 * v3 (owner-approved structural items 1, 2, 4, 7, 10, 11 of STRUCTURAL-CHANGES-BRIEF): Show is the inline quick filter and the status chips live under one "Filters (n)" popover with removable chips and one
 * "Clear filters"; the bulk bar (Select all, Clear, Print Selected, Export, Convert Selected to Jobs, Despatch Selected) shows only while a row is ticked, and Export of all rows is a toolbar menu; every row has
 * ONE primary action (Convert to Job, otherwise View) and a shared "More" menu holding the rest; one PreviewBar strip; the generic page sentence is a tooltip and a screen-reader description of the title;
 * the v4 type scale. The local row menu is gone: the shared Menu now names its trigger and shows a disabled item's reason.
 * MUST NOT CHANGE: wording, defaults (Table view, Show Open, status All), column order, filter semantics, the role gate (admin and office only) and which action each row offers mirror today's Sales Orders
 * page. Do not wire this file to real data or real actions, add no control the real page lacks (no search box, no sort, no icons), and keep row controls at a 48 px hit area. The "Add customer PO" and
 * "Machines" sheets are drawn from the real dialogs; the real Activity trail needs the audit log and is drawn here with sample entries only. Delete the four preview files to remove it completely.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Button, Checkbox, ChipGroup, EmptyState, FailedState, Field, FilterChip, Input, LoadingState, Menu, PageHeader, Popover, PreviewBar, SegmentedControl, SelectionBar, Select, Sheet, StatTile, StatTiles,
  StatusBadge, Switch, Textarea, ToastProvider, cx, premiumTokens, srOnly, tabularNumbers, typeScale, useToast, ScrollTable,
} from "@/components/ui/premium";
import type { StatusMode, StatusTone } from "@/components/ui/premium";
import { awaitsCustomerPo, customerPoInput } from "@/lib/accept-quote";
import { fmtDate as realFmtDate } from "@/lib/dates";
import { salesOrdersEmptyHint } from "@/lib/empty-hints";
import { documentTotals, gbp } from "@/lib/money";
import { type OrderTerms, type QuoteLineRow, orderTermsFromQuote } from "@/lib/order-from-quote";
import { quoteAcceptBlock } from "@/lib/quote-status";
import { canDespatch, editBlockedReason, isConverted, ordersToConvert, ordersToDespatch } from "@/lib/sales-order-convert";
import { SALES_ORDER_OPEN_CARD_NOTE, SALES_ORDER_OPEN_CARD_STATUSES, countPhases, salesOrderCardCounts } from "@/lib/list-card-counts";
import { DESK_QUERY, effectiveViewMode } from "@/lib/shell-status";
import { MAX_MACHINES, MAX_MACHINE_HOURS, type OrderPlanRow, describeMachines, formatHours, sumMachineHours, totalHours } from "@/lib/so-machines";
import { exportScopeTitle } from "@/lib/spreadsheet";
import { STATUS_MAP, salesOrderStatusKey } from "@/lib/status-colours";
import { VAT_CHOICES, VAT_CHOICE_LABELS, type VatChoice, fromVatChoice } from "@/lib/vat";

import s from "./SalesOrdersPreview.module.css";

/* ================================================================== */
/* 1. Types and constants                                              */
/* ================================================================== */

export type Role = "admin" | "office" | "workshop" | "viewer";
export type ViewMode = "cards" | "list" | "table";
export type Screen = "ready" | "loading" | "error" | "empty";
export type Phase = "open" | "done" | "archived";
export type PhaseValue = Phase | "all";
export type ColumnKey = "ref" | "customer" | "date" | "delivery" | "value" | "status";
export type SoStatus = "open" | "confirmed" | "in_production" | "despatched" | "converted" | "closed";

/** The sample's "today" (kept fixed so the archive rule never drifts). */
export const TODAY = "2026-11-23";
export const ARCHIVE_MONTHS = 12;

export const COLUMNS: Array<{ key: ColumnKey; label: string; locked?: boolean }> = [
  { key: "ref", label: "SO Ref", locked: true }, { key: "customer", label: "Customer" }, { key: "date", label: "Order Date" }, { key: "delivery", label: "Expected Delivery" },
  { key: "value", label: "Value" }, { key: "status", label: "Status" },
];
export const STATUS_CHIPS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All" }, { value: "open", label: "Open" }, { value: "confirmed", label: "Confirmed" }, { value: "in_production", label: "In Production" },
  { value: "despatched", label: "Despatched" }, { value: "converted", label: "Converted" }, { value: "closed", label: "Closed" },
];
export const TILES: Array<{ label: string; filter: "open" | "confirmed" | "despatched" }> = [
  { label: "Open", filter: "open" }, { label: "Confirmed", filter: "confirmed" }, { label: "Despatched", filter: "despatched" },
];
export const PHASE_LABEL: Record<Phase, string> = { open: "Open", done: "Done", archived: "Archived" };
export const EMPTY_HINT = salesOrdersEmptyHint();
export const NOTE_OPEN_CARD = SALES_ORDER_OPEN_CARD_NOTE;
/** What the page's customer picker offers (sample customers). */
export const CUSTOMERS = ["Ashby Rail Services", "Brightwell Valves", "Coldharbour Automation", "Halden Precision", "Kestrel Components", "Marlow Hydraulics", "Northgate Fabrication", "Pemberton Packaging", "Tern Marine Engineering", "Wren & Calder"];
export const PICKER_LOAD_FAILED = "Couldn't load the customer list, so no customer can be picked. Nothing was changed.";

export type SeedLine = { id: string; description: string; quantity: number; machines: Array<{ machineId: string; hours: number }> };
export type SeedOrder = {
  id: string; ref: string; customer: string; date: string; delivery: string; value: number; vatEnabled: boolean; vat: VatChoice; status: SoStatus; convertedJob: string;
  quoteRef?: string; customerPo: string; manual?: "archived" | "active"; notes?: string; lines: SeedLine[];
};
export type Machine = { id: string; name: string; active: boolean };
export const MACHINES: Machine[] = [
  { id: "m1", name: "Haas VF-2 mill", active: true }, { id: "m2", name: "Doosan Lynx lathe", active: true }, { id: "m3", name: "Mazak 5-axis", active: true },
  { id: "m4", name: "Bandsaw 1", active: true }, { id: "m5", name: "Old Bridgeport (retired)", active: false },
];

/* ================================================================== */
/* 2. Sample data (fictional)                                          */
/* ================================================================== */

const ln = (id: string, description: string, quantity: number, machines: Array<{ machineId: string; hours: number }> = []): SeedLine => ({ id, description, quantity, machines });

export const SEED_ORDERS: SeedOrder[] = [
  { id: "so21", ref: "BW-5530", customer: "Brightwell Valves", date: "2026-11-21", delivery: "", value: 4184, vatEnabled: true, vat: "20", status: "open", convertedJob: "", customerPo: "BW-5530", notes: "Delivery date to be agreed once castings are confirmed.",
    lines: [ln("l1", "Valve body, 316 investment cast, finish machined", 80)] },
  { id: "so20", ref: "SO-0158", customer: "Wren & Calder", date: "2026-11-20", delivery: "2026-12-18", value: 2990, vatEnabled: true, vat: "20", status: "open", convertedJob: "", customerPo: "",
    lines: [ln("l1", "Idler roller 89 mm, galvanised", 50), ln("l2", "Bearing set", 50)] },
  { id: "so19", ref: "NF-88213", customer: "Northgate Fabrication", date: "2026-11-17", delivery: "2026-12-14", value: 3436, vatEnabled: true, vat: "20", status: "confirmed", convertedJob: "", quoteRef: "QUO-0434", customerPo: "NF-88213",
    lines: [ln("l1", "Guard frame, 40 x 40 box section", 8, [{ machineId: "m4", hours: 2 }]), ln("l2", "Fixings and finishing", 1)] },
  { id: "so18", ref: "HP-7710", customer: "Halden Precision", date: "2026-11-12", delivery: "2026-12-01", value: 2560, vatEnabled: true, vat: "20", status: "confirmed", convertedJob: "", customerPo: "HP-7710",
    lines: [ln("l1", "Calibration fixture, ground", 4, [{ machineId: "m1", hours: 6 }, { machineId: "m3", hours: 4.5 }])] },
  { id: "so17", ref: "TM/5521", customer: "Tern Marine Engineering", date: "2026-11-10", delivery: "2026-11-28", value: 731, vatEnabled: true, vat: "20", status: "in_production", convertedJob: "", quoteRef: "QUO-0432", customerPo: "TM/5521",
    lines: [ln("l1", "Bush, aluminium bronze, bored", 12, [{ machineId: "m2", hours: 6 }, { machineId: "m1", hours: 2.5 }]), ln("l2", "Material certificates", 1)] },
  { id: "so16", ref: "SO-0149", customer: "Pemberton Packaging", date: "2026-11-04", delivery: "2026-12-04", value: 1512, vatEnabled: true, vat: "20", status: "converted", convertedJob: "J-1041", customerPo: "",
    lines: [ln("l1", "Sealing jaw bar, hardened", 16, [{ machineId: "m2", hours: 5 }])] },
  { id: "so15", ref: "ARS-20771", customer: "Ashby Rail Services", date: "2026-11-02", delivery: "2026-12-05", value: 1668, vatEnabled: true, vat: "20", status: "converted", convertedJob: "J-1043", quoteRef: "QUO-0428", customerPo: "ARS-20771",
    lines: [ln("l1", "Pivot pin, hardened", 60, [{ machineId: "m2", hours: 7 }]), ln("l2", "Pin carrier, machined", 60, [{ machineId: "m1", hours: 9.25 }, { machineId: "m2", hours: 1 }])] },
  { id: "so14", ref: "CA-3311", customer: "Coldharbour Automation", date: "2026-11-05", delivery: "2026-11-18", value: 1872, vatEnabled: true, vat: "20", status: "despatched", convertedJob: "", customerPo: "CA-3311",
    lines: [ln("l1", "Gearbox housing, 5 axis machined", 6, [{ machineId: "m3", hours: 11 }])] },
  { id: "so13", ref: "MH-40918", customer: "Marlow Hydraulics", date: "2026-10-14", delivery: "2026-11-12", value: 3840, vatEnabled: true, vat: "20", status: "despatched", convertedJob: "", quoteRef: "QUO-0421", customerPo: "MH-40918",
    lines: [ln("l1", "Cylinder gland, turned", 100), ln("l2", "Rod end, turned and threaded", 100)] },
  { id: "so12", ref: "KC-2290", customer: "Kestrel Components", date: "2026-10-10", delivery: "2026-11-20", value: 4770, vatEnabled: true, vat: "20", status: "converted", convertedJob: "J-1038", quoteRef: "QUO-0405 v2", customerPo: "KC-2290",
    lines: [ln("l1", "Gimbal bracket, 7075-T651", 150, [{ machineId: "m3", hours: 24 }])] },
  { id: "so11", ref: "WC-4400", customer: "Wren & Calder", date: "2026-09-30", delivery: "2026-10-28", value: 3150, vatEnabled: false, vat: "20", status: "despatched", convertedJob: "", customerPo: "WC-4400",
    lines: [ln("l1", "Conveyor frame sections", 14)] },
  { id: "so10", ref: "KC-1980", customer: "Kestrel Components", date: "2026-02-03", delivery: "2026-03-20", value: 2210, vatEnabled: true, vat: "20", status: "closed", convertedJob: "", customerPo: "KC-1980",
    lines: [ln("l1", "Test rig plates", 12)] },
  { id: "so09", ref: "NF-77102", customer: "Northgate Fabrication", date: "2026-05-06", delivery: "2026-06-02", value: 980, vatEnabled: true, vat: "5", status: "closed", convertedJob: "", customerPo: "NF-77102", manual: "archived",
    lines: [ln("l1", "Handrail posts", 20)] },
  { id: "so08", ref: "SO-0140", customer: "", date: "2026-10-01", delivery: "", value: 450, vatEnabled: false, vat: "exempt", status: "open", convertedJob: "", customerPo: "",
    lines: [ln("l1", "Sample part run", 5)] },
  { id: "so07", ref: "PP-1182", customer: "Pemberton Packaging", date: "2025-09-12", delivery: "2025-10-20", value: 3720, vatEnabled: true, vat: "20", status: "closed", convertedJob: "", quoteRef: "QUO-0310", customerPo: "PP-1182",
    lines: [ln("l1", "Cutter holder, hardened", 300)] },
  { id: "so06", ref: "MH-40204", customer: "Marlow Hydraulics", date: "2026-08-12", delivery: "2026-09-10", value: 5290, vatEnabled: true, vat: "20", status: "despatched", convertedJob: "", customerPo: "MH-40204", manual: "active",
    lines: [ln("l1", "Manifold block prototypes", 10)] },
];

/** Accepted quotes the New sales order sheet offers, with their stored lines (quote_line_items) so the REAL orderTermsFromQuote decides what carries over. */
export type AcceptedQuote = { id: string; ref: string; customer: string; total: number; vatEnabled: boolean; lines: QuoteLineRow[] };
const ql = (quantity: number, unit_price: number, vat_pct = 20, extra: Partial<QuoteLineRow> = {}): QuoteLineRow => ({ quantity, unit_price, vat_pct, vat_exempt: false, ...extra });
export const ACCEPTED_QUOTES: AcceptedQuote[] = [
  { id: "aq1", ref: "QUO-0434", customer: "Northgate Fabrication", total: 4123.2, vatEnabled: true, lines: [ql(8, 412), ql(1, 140)] },
  { id: "aq2", ref: "QUO-0441", customer: "Halden Precision", total: 1008, vatEnabled: true, lines: [ql(4, 120), ql(4, 0, 20), ql(2, 180, 5)] },
  { id: "aq3", ref: "QUO-0428", customer: "Ashby Rail Services", total: 2001.6, vatEnabled: true, lines: [ql(60, 9.6), ql(60, 18.2), ql(20, 9.6, 20, { declined: true })] },
  { id: "aq4", ref: "QUO-0443", customer: "Kestrel Components", total: 0, vatEnabled: true, lines: [ql(10, 0)] },
];

/* ================================================================== */
/* 3. Logic (real lib functions where pure; the rest mirrors the page) */
/* ================================================================== */

export { awaitsCustomerPo, canDespatch, editBlockedReason, isConverted, ordersToConvert, ordersToDespatch, salesOrderCardCounts, countPhases, customerPoInput, orderTermsFromQuote };

export const fmtDate = (iso: string) => realFmtDate(iso);
export const money = (value: number) => gbp(value, 2);
export const canUseSalesOrders = (role: Role) => role === "admin" || role === "office";
/** The archive controls show to admin and office (lib/archive useArchive canManage). */
export const canArchive = canUseSalesOrders;

/** Open / Done / Archived (lib/archive phaseOf): a manual choice beats the age rule. Mirrored: lib/archive.ts imports the browser client. */
export function phaseOf(record: { final: boolean; finalDate?: string | null }, manual: "archived" | "active" | undefined, months: number = ARCHIVE_MONTHS, today: string = TODAY): Phase {
  if (manual === "archived") return "archived";
  if (!record.final) return "open";
  if (manual === "active" || !record.finalDate) return "done";
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const at = new Date(`${record.finalDate.slice(0, 10)}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at < cutoff ? "archived" : "done";
}
/** The page's phaseFor: finished = despatched, converted or closed, except an order still waiting for its customer PO (that stays Open). */
export function phaseFor(order: Pick<SeedOrder, "status" | "ref" | "customerPo" | "delivery" | "date" | "manual">, today: string = TODAY): Phase {
  return phaseOf({ final: ["despatched", "converted", "closed"].includes(order.status) && !awaitsCustomerPo(order), finalDate: order.delivery || order.date }, order.manual, ARCHIVE_MONTHS, today);
}

export type Filters = { phase: PhaseValue; statuses: ReadonlySet<string> };
export const DEFAULT_FILTERS: Filters = { phase: "open", statuses: new Set(["all"]) };
/** The page's visible rows: the Show phase, then the status chips. Newest first (the page reads order_date descending). */
export function visibleOrders(rows: readonly SeedOrder[], f: Filters, today: string = TODAY): SeedOrder[] {
  return [...rows].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
    .filter((o) => (f.phase === "all" || phaseFor(o, today) === f.phase) && (f.statuses.has("all") || f.statuses.has(o.status)));
}
export const OPEN_CARD_FILTER: ReadonlySet<string> = new Set<string>(SALES_ORDER_OPEN_CARD_STATUSES);
export const statusLabel = (status: string) => status.replaceAll("_", " ");
/** Status colour from the REAL map (salesOrderStatusKey > STATUS_MAP): blue and green read as info and ok, an unmapped status is plain. */
export function statusTone(status: string): StatusTone {
  const key = salesOrderStatusKey(status);
  const colour = key ? STATUS_MAP[key].colour : null;
  return colour === "blue" ? "info" : colour === "green" ? "ok" : "neutral";
}
export const keyOf = (o: Pick<SeedOrder, "id" | "ref">) => o.id ?? o.ref;

/* ---------- v3 structure (owner-approved items 1, 2, 4, 7): pure so the tests can pin it ---------- */

/** The one-line explainer that moved from under the page title to a tooltip and a screen-reader description on it (item 4). */
export const SO_INTRO = "A sales order is a customer's confirmed order. Turn it into a job when work starts.";

export type ActiveChip = { id: string; label: string };
/** The status filters that live under "Filters (n)" and are active right now, each removable. Show is always visible, so it is not a chip. */
export function activeChips(f: Filters): ActiveChip[] {
  if (f.statuses.has("all")) return [];
  return STATUS_CHIPS.filter((c) => c.value !== "all" && f.statuses.has(c.value)).map((c) => ({ id: c.value, label: `Status: ${c.label}` }));
}
/** The n in "Filters (n)". */
export const popoverFilterCount = (f: Filters) => activeChips(f).length;
/** True when anything differs from the default view (Show Open, status All): then, and only then, "Clear filters" shows. */
export const isFiltered = (f: Filters) => f.phase !== "open" || !f.statuses.has("all");
/** The status chip rule of the real page: All clears the rest, picking one drops All, and an empty choice goes back to All. */
export function toggleStatusIn(current: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(current);
  if (value === "all") { next.clear(); next.add("all"); } else { next.delete("all"); if (next.has(value)) next.delete(value); else next.add(value); if (next.size === 0) next.add("all"); }
  return next;
}

export type SoActionId = "view" | "convert" | "despatch" | "edit" | "po" | "machines" | "archive";
/**
 * Every real row control, split into the ONE visible button and the More menu. Convert to Job is the next step while the order has no job; otherwise View. The rest keep the real order
 * (View, Despatch, Edit, Add customer PO, Machines, Archive).
 */
export function rowActionPlan(o: SeedOrder, role: Role): { primary: SoActionId; more: SoActionId[] } {
  const all: SoActionId[] = [
    "view", ...(isConverted(o) ? [] : (["convert"] as const)), ...(canDespatch(o) ? (["despatch"] as const) : []), "edit",
    ...(o.id && !o.customerPo ? (["po"] as const) : []), ...(o.id ? (["machines"] as const) : []), ...(canArchive(role) && o.id ? (["archive"] as const) : []),
  ];
  const primary: SoActionId = isConverted(o) ? "view" : "convert";
  return { primary, more: all.filter((a) => a !== primary) };
}

/** The toolbar's disabled reasons (page: title on Convert Selected, Despatch Selected, Print Selected). */
export function convertReason(selected: readonly SeedOrder[], keys: number): string | undefined {
  return ordersToConvert(selected).length ? undefined : keys ? "The selected orders already have jobs" : "Select at least one sales order";
}
export function despatchReason(selected: readonly SeedOrder[], keys: number): string | undefined {
  return ordersToDespatch(selected).length ? undefined : keys ? "None of the selected orders can be despatched (already converted, despatched or closed)" : "Select at least one sales order";
}
export const printReason = (keys: number): string | undefined => (keys ? undefined : "Select at least one sales order");
export const scopeTitle = (selected: number, inFilter: number) => exportScopeTitle("sales order", selected, inFilter);

/** The machines planned on one order, summed per machine as the job will hold it (the page's planByOrder), or "" when none. */
export function planText(order: SeedOrder): string {
  const rows: OrderPlanRow[] = order.lines.flatMap((l, li) => l.machines.map((m, i): OrderPlanRow => ({ machine_id: m.machineId, estimated_hours: m.hours, line_key: li + 1, sales_order_line_id: l.id, position: i })));
  if (!rows.length) return "";
  const names = new Map(MACHINES.map((m) => [m.id, m.name]));
  return describeMachines(sumMachineHours(rows).map((m) => ({ name: names.get(m.machine_id) ?? "Machine", hours: m.hours })));
}
/** "carried 2 machines (7.5 h)" for the convert toast (page: convertOne). */
export function carriedText(order: SeedOrder): string {
  const per = new Map<string, number>();
  for (const l of order.lines) for (const m of l.machines) per.set(m.machineId, (per.get(m.machineId) ?? 0) + m.hours);
  if (!per.size) return "";
  return `; carried ${per.size} machine${per.size === 1 ? "" : "s"} (${totalHours([...per.values()].map((hours) => ({ hours })))} h)`;
}

/** The order form's checks (lib/validation/schemas salesOrderSaveSchema wording, one message per field). */
export type OrderForm = { quoteId: string; customer: string; customerPo: string; orderDate: string; deliveryDate: string; value: string; notes: string; vatOn: boolean | null; vat: VatChoice | null };
export const EMPTY_ORDER_FORM: OrderForm = { quoteId: "", customer: "", customerPo: "", orderDate: TODAY, deliveryDate: "", value: "", notes: "", vatOn: null, vat: null };
export type OrderErrors = Partial<Record<"customer" | "customerPo" | "orderDate" | "deliveryDate" | "value", string>>;
export function orderErrors(f: Pick<OrderForm, "customer" | "customerPo" | "orderDate" | "deliveryDate" | "value">): OrderErrors {
  const e: OrderErrors = {};
  if (!f.customer.trim()) e.customer = "Customer is required";
  else if (f.customer.trim().length > 200) e.customer = "Customer name is too long";
  if (f.customerPo.trim().length > 100) e.customerPo = "Order number is too long";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.orderDate)) e.orderDate = "Enter a valid order date";
  if (f.deliveryDate !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(f.deliveryDate)) e.deliveryDate = "Enter a valid delivery date";
  if (f.value.trim() === "" || !Number.isFinite(Number(f.value))) e.value = "Value must be a number";
  else if (Number(f.value) < 0) e.value = "Value can't be negative";
  else if (Math.round(Number(f.value) * 100) / 100 !== Number(f.value)) e.value = "Value is in pounds and pence (at most 2 decimal places)";
  return e;
}
export const ORDER_FIELD_ORDER = ["customer", "customerPo", "orderDate", "deliveryDate", "value"] as const;
export const ORDER_FIELD_LABEL: Record<(typeof ORDER_FIELD_ORDER)[number], string> = { customer: "Customer", customerPo: "Customer PO", orderDate: "Order date", deliveryDate: "Delivery date", value: "Order value" };
/** One line per problem, naming its field, in form order (the summary above the form). */
export const orderSummary = (e: OrderErrors) => ORDER_FIELD_ORDER.filter((k) => e[k]).map((k) => ({ key: k, message: `${ORDER_FIELD_LABEL[k]}: ${e[k]}` }));
export const toDateInputValue = (iso: string) => (iso ? iso.slice(0, 10) : "");

/** The picker's reaction to an accepted quote (page: pickQuote): the REAL orderTermsFromQuote on the quote's lines. */
export function termsFor(q: AcceptedQuote, vatRegistered: boolean): OrderTerms {
  return orderTermsFromQuote({ vat_enabled: q.vatEnabled, total_value: q.total }, q.lines, vatRegistered);
}

/* ================================================================== */
/* 4. Small local pieces (gaps in the shared set, see the report)       */
/* ================================================================== */

const VIEW_KEY = "sales-orders-preview:view";
const ROLES: Array<{ value: Role; label: string }> = [{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" }];
const SCREENS: Array<{ v: Screen; label: string }> = [{ v: "ready", label: "Normal" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "empty", label: "No sales orders yet" }];

function useMedia(query: string, fallback: boolean): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia(query).matches,
    () => fallback,
  );
}

function StatusPill({ status, mode = "pill" }: { status: string; mode?: StatusMode }) {
  return <StatusBadge mode={mode} tone={statusTone(status)} plain={statusTone(status) === "neutral" && status === "closed"}><span className={s.cap}>{statusLabel(status)}</span></StatusBadge>;
}

type Dlg =
  | { k: "view"; id: string }
  | { k: "create" }
  | { k: "edit"; id: string }
  | { k: "po"; id: string }
  | { k: "machines"; id: string };

/* ================================================================== */
/* 5. The page                                                         */
/* ================================================================== */

export default function SalesOrdersPreview() {
  return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>;
}

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [view, setViewState] = useState<ViewMode>("table");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<string[]>([]);
  const [hidden, setHidden] = useState<ColumnKey[]>([]);
  const [dlg, setDlgState] = useState<Dlg | null>(null);
  const [vatRegistered, setVatRegistered] = useState(true);
  const [customersFail, setCustomersFail] = useState(false);
  const [quotesMode, setQuotesMode] = useState<"ok" | "list" | "lines">("ok");
  const timers = useRef<number[]>([]);
  const setDlg = useCallback((d: Dlg | null) => { setDlgState(d); if (d) toast.clear(); }, [toast]);
  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); }, []);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };
  const wide = useMedia(DESK_QUERY, true);
  const notPhone = useMedia("(min-width: 768px)", true);
  useEffect(() => {
    try { const v = window.localStorage.getItem(VIEW_KEY); if (v === "cards" || v === "list" || v === "table") setViewState(v); } catch { /* storage unavailable: Table stays */ }
  }, []);
  const setView = (v: ViewMode) => { setViewState(v); try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };
  const shownView: ViewMode = notPhone ? effectiveViewMode(view, wide, false) : "cards";

  const seed = SEED_ORDERS;
  const byId = useMemo(() => new Map(seed.map((o) => [o.id, o])), [seed]);
  const loading = screen === "loading";
  const failed = screen === "error";
  const data = useMemo(() => (screen === "ready" ? seed : []), [screen, seed]);
  const visible = useMemo(() => visibleOrders(data, filters), [data, filters]);
  const phaseCounts = useMemo(() => countPhases(data, (o) => phaseFor(o)), [data]);
  const counts = useMemo(() => salesOrderCardCounts(data, (o) => phaseFor(o)), [data]);
  const selectedOrders = useMemo(() => data.filter((o) => selected.includes(keyOf(o))), [data, selected]);
  const inView = (c: ColumnKey) => !hidden.includes(c);
  const nSel = selected.length;
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const denied = !canUseSalesOrders(role);

  const resetAll = () => { setScreen("ready"); setFilters(DEFAULT_FILTERS); setSelected([]); setHidden([]); setDlg(null); setVatRegistered(true); setCustomersFail(false); setQuotesMode("ok"); setRole("admin"); toast.clear(); };
  const pickScreen = (v: Screen) => { toast.clear(); setSelected([]); setScreen(v); };
  const retry = () => {
    setScreen("loading");
    later(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample sales orders shown again. No server was contacted." }); }, 700);
  };
  const toggleStatus = (value: string) => setFilters((f) => ({ ...f, statuses: toggleStatusIn(f.statuses, value) }));
  const toggleSel = (key: string) => setSelected((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]));
  const tilePressed = (f: "open" | "confirmed" | "despatched") => (f === "open" ? filters.phase === "open" && filters.statuses.size === OPEN_CARD_FILTER.size && [...OPEN_CARD_FILTER].every((x) => filters.statuses.has(x)) : filters.statuses.size === 1 && filters.statuses.has(f));
  const pressTile = (f: "open" | "confirmed" | "despatched") => setFilters((c) => (f === "open" ? { phase: "open", statuses: OPEN_CARD_FILTER } : { ...c, statuses: new Set([f]) }));

  /* ---------- actions: every one is a preview ---------- */
  const convert = (targets: SeedOrder[]) => {
    if (!targets.length) return;
    const first = targets[0];
    preview(targets.length === 1 ? `A job would be created from sales order ${first.ref}${carriedText(first)}.` : `${targets.length} jobs would be created, one per selected sales order.`);
  };
  const despatch = (targets: SeedOrder[]) => { if (targets.length) preview(`${targets.length} sales order(s) would move to Despatched.`); };
  const archive = (o: SeedOrder) => preview(`${o.ref} would be ${phaseFor(o) === "archived" ? "moved out of the archive" : "archived"} (nothing is deleted: see Show > Archived).`);
  const exportAs = (fmt: string) => preview(`The ${fmt} export would cover ${nSel ? `the ${nSel} selected sales order${nSel === 1 ? "" : "s"}` : `all ${visible.length} sales order${visible.length === 1 ? "" : "s"} in the current filter`}. No file was downloaded.`);

  const rowActions = (o: SeedOrder) => {
    const blocked = editBlockedReason(o);
    const plan = rowActionPlan(o, role);
    const archived = phaseFor(o) === "archived";
    const label: Record<SoActionId, string> = { view: "View", convert: "Convert to Job", despatch: "Despatch", edit: "Edit", po: "Add customer PO", machines: "Machines", archive: archived ? "Unarchive" : "Archive" };
    const aria: Partial<Record<SoActionId, string>> = { view: `View ${o.ref}`, convert: `Convert to Job: ${o.ref}`, despatch: `Despatch ${o.ref}` };
    const run: Record<SoActionId, () => void> = {
      view: () => setDlg({ k: "view", id: o.id }), convert: () => convert([o]), despatch: () => despatch([o]), edit: () => setDlg({ k: "edit", id: o.id }),
      po: () => setDlg({ k: "po", id: o.id }), machines: () => setDlg({ k: "machines", id: o.id }), archive: () => archive(o),
    };
    return (
      <div className={s.actions}>
        <span className={s.primarySlot}>
          <Button size="sm" variant="secondary" aria-label={aria[plan.primary] ?? label[plan.primary]} data-testid="row-primary" data-action={label[plan.primary]} onClick={run[plan.primary]}>{label[plan.primary]}</Button>
        </span>
        {plan.more.length ? (
          <Menu label="More" size="sm" variant="quiet" aria-label={`More actions for ${o.ref}`} data-testid="row-more"
            items={plan.more.map((id) => ({ id, label: label[id], onSelect: run[id], ...(id === "edit" && blocked ? { disabled: true, hint: blocked } : {}) }))} />
        ) : null}
      </div>
    );
  };

  const allSelected = visible.length > 0 && visible.every((o) => selected.includes(keyOf(o)));
  const noMatch = data.length > 0 && visible.length === 0;
  const chips = activeChips(filters);
  /** A count is an em dash while the list is loading or failed, never a stale number. */
  const n = (v: number) => (loading || failed ? "—" : v);
  const idleNote = loading ? "Loading sales orders" : `${visible.length} sales order${visible.length === 1 ? "" : "s"} shown`;

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="sales-orders-preview" data-role={role} data-pview={shownView}>
      <PreviewBar data-testid="preview-bar" controls={
        <Popover label="Preview controls" title="Preview controls" size="sm" data-testid="dock-toggle">
          <div className={s.dock}>
            <SegmentedControl label="Role" value={role} options={ROLES} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
            <p className={typeScale.label}>Screen state</p>
            <ChipGroup label="Screen state">
              {SCREENS.map((x) => <FilterChip key={x.v} selected={screen === x.v} onToggle={() => pickScreen(x.v)}>{x.label}</FilterChip>)}
            </ChipGroup>
            <p className={typeScale.label}>Company VAT</p>
            <SegmentedControl label="Company VAT" value={vatRegistered ? "yes" : "no"} size="sm" onChange={(v) => setVatRegistered(v === "yes")} options={[{ value: "yes", label: "Registered" }, { value: "no", label: "Not registered" }]} />
            <p className={typeScale.label}>New order: customer list</p>
            <SegmentedControl label="Customer list" value={customersFail ? "fail" : "ok"} size="sm" onChange={(v) => setCustomersFail(v === "fail")} options={[{ value: "ok", label: "Loads" }, { value: "fail", label: "Fails" }]} />
            <p className={typeScale.label}>New order: accepted quotes</p>
            <SegmentedControl label="Accepted quotes" value={quotesMode} size="sm" onChange={setQuotesMode} options={[{ value: "ok", label: "Load" }, { value: "list", label: "List fails" }, { value: "lines", label: "Lines fail" }]} />
            <Button variant="secondary" onClick={resetAll}>Reset preview data</Button>
            <p className={typeScale.caption}>Sample data. States are simulated; no request is made.</p>
          </div>
        </Popover>
      } />
      <PageHeader
        title={<span title={SO_INTRO} data-testid="so-title">Sales Orders</span>}
        description={<span className={srOnly}>{SO_INTRO}</span>}
        actions={denied ? undefined : (
          <>
            <Popover label="Columns" title="Sales Orders columns" data-testid="columns-trigger">
              <div className={s.colsBody}>
                {COLUMNS.map((c) => (c.locked ? (
                  <p key={c.key} className={s.colLocked} data-testid={`col-${c.key}`}><span>{c.label}</span><span>Always shown</span></p>
                ) : (
                  <Switch key={c.key} label={c.label} checked={inView(c.key)} data-testid={`col-${c.key}`} onChange={(on) => setHidden((h) => (on ? h.filter((k) => k !== c.key) : [...h, c.key]))} />
                )))}
                <Button variant="quiet" disabled={!hidden.length} onClick={() => setHidden([])}>Reset to default (show all columns)</Button>
                <p className={typeScale.caption}>Changes apply to everyone in this company. In this preview they change this screen only.</p>
              </div>
            </Popover>
            {notPhone ? (
              <SegmentedControl label="View" value={shownView} onChange={setView} options={[
                { value: "cards", label: "Cards", testId: "view-cards-btn" },
                { value: "list", label: "List", testId: "view-list-btn" },
                { value: "table", label: "Table", disabled: !wide, disabledReason: wide ? undefined : "Needs a screen wider than 1024px", testId: "view-table-btn" },
              ]} />
            ) : null}
            <ExportMenu nSel={nSel} total={visible.length} onExport={exportAs} testId="export-trigger" />
            <Button variant="primary" data-testid="new-order" onClick={() => setDlg({ k: "create" })}>New sales order</Button>
          </>
        )}
      />

      {denied ? (
        <section className={s.denied} data-testid="access-denied">
          <h2 className={typeScale.section}>Access Denied</h2>
          <p className={typeScale.body}>Redirecting you back to the dashboard.</p>
          <p className={cx(typeScale.caption, s.deniedNote)}>Preview only: no redirect happens here. The real Sales Orders screen is for Admin and Office; Workshop and Viewer cannot open it.</p>
        </section>
      ) : (
        <>
          <StatTiles label="Sales order figures" columns={3} className={s.tiles3}>
            {TILES.map((t) => (
              <StatTile key={t.label} label={t.label} value={loading || failed ? "—" : String(counts[t.filter])} loading={loading || failed}
                hint={t.filter === "open" ? NOTE_OPEN_CARD : undefined} data-testid={`tile-${t.filter}`} pressed={tilePressed(t.filter)} onPress={() => pressTile(t.filter)} />
            ))}
          </StatTiles>

          <section className={s.fbar} aria-label="Filters" aria-busy={loading || undefined} data-testid="filters">
            <div className={s.fRow}>
              <div className={s.fGroup}>
                <span className={typeScale.label} aria-hidden="true">Show</span>
                <SegmentedControl label="Show" value={filters.phase} disabled={loading} onChange={(v) => setFilters((f) => ({ ...f, phase: v }))} options={[
                  { value: "open", label: `Open (${n(phaseCounts.open)})`, testId: "show-open" }, { value: "done", label: `Done (${n(phaseCounts.done)})`, testId: "show-done" },
                  { value: "archived", label: `Archived (${n(phaseCounts.archived)})`, testId: "show-archived" }, { value: "all", label: "All", testId: "show-all" },
                ]} />
              </div>
              <Popover label={chips.length ? `Filters (${chips.length})` : "Filters"} title="Filters" data-testid="filters-trigger">
                <div className={s.filterBody} data-testid="filters-panel">
                  <ChipGroup label="Filters">
                    {STATUS_CHIPS.map((c) => <FilterChip key={c.value} selected={filters.statuses.has(c.value)} disabled={loading} onToggle={() => toggleStatus(c.value)} data-testid={`chip-${c.value}`}>{c.label}</FilterChip>)}
                  </ChipGroup>
                </div>
              </Popover>
              {isFiltered(filters) ? <Button variant="quiet" data-testid="clear-filters" onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</Button> : null}
            </div>
            {chips.length ? (
              <ul className={s.chipRow} aria-label="Active filters" data-testid="active-chips">
                {chips.map((c) => (
                  <li key={c.id}>
                    <Button size="sm" variant="secondary" aria-label={`Remove filter ${c.label}`} data-chip={c.id} onClick={() => toggleStatus(c.id)}>
                      {c.label}
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <SelectionBar count={nSel} filteredTotal={visible.length} noun="sales order" idleNote={idleNote}
            onSelectAll={() => setSelected(visible.map(keyOf))} onClear={() => setSelected([])}
            statusText={({ count }) => `${count} selected of ${visible.length} filtered ${visible.length === 1 ? "record" : "records"}`}>
            {nSel > 0 ? (
              <>
                <Button size="sm" variant="secondary" disabled={!nSel} title={printReason(nSel)} data-testid="print-selected" onClick={() => preview(`A print pack for ${nSel} sales order${nSel === 1 ? "" : "s"} would open in a new tab.`)}>Print Selected</Button>
                <ExportMenu nSel={nSel} total={visible.length} onExport={exportAs} testId="export-selected-trigger" size="sm" />
                <Button size="sm" variant="primary" disabled={!ordersToConvert(selectedOrders).length} title={convertReason(selectedOrders, nSel)} data-testid="convert-selected" onClick={() => convert(ordersToConvert(selectedOrders))}>Convert Selected to Jobs</Button>
                <Button size="sm" variant="secondary" disabled={!ordersToDespatch(selectedOrders).length} title={despatchReason(selectedOrders, nSel)} data-testid="despatch-selected" onClick={() => despatch(ordersToDespatch(selectedOrders))}>Despatch Selected</Button>
              </>
            ) : null}
          </SelectionBar>

          <h2 className={srOnly}>Sales orders</h2>
          {loading ? <LoadingState label="Loading sales orders" rows={6} />
            : failed ? <FailedState title="Couldn’t load sales orders." detail="The list could not be fetched. This is a simulated failure: no request was made and nothing was lost." onRetry={retry} retryLabel="Retry" />
            : visible.length === 0 ? (
              <EmptyState title={noMatch ? "No sales orders match this filter" : "No sales orders yet"} detail={noMatch ? "Try a different filter." : EMPTY_HINT}
                action={noMatch ? <Button variant="secondary" onClick={() => setFilters((f) => ({ ...f, statuses: new Set(["all"]) }))}>Show all</Button> : <Button variant="primary" onClick={() => setDlg({ k: "create" })}>New sales order</Button>} />
            ) : shownView === "cards" ? (
              <div className={s.cards} data-testid="view-cards">
                {visible.map((o) => {
                  const k = keyOf(o);
                  return (
                    <article key={o.id} className={s.card} data-order={o.ref} data-selected={selected.includes(k) || undefined} aria-label={o.ref}>
                      <div className={s.cardTop}>
                        <Checkbox aria-label={`Select ${o.ref}`} data-testid="select-row" checked={selected.includes(k)} onChange={() => toggleSel(k)} />
                        <div className={s.cardRef}><span className={cx(typeScale.card, tabularNumbers)}>{o.ref}</span>{!o.customerPo && o.id ? <span className={typeScale.caption}>No customer PO</span> : null}</div>
                        {inView("status") ? <StatusPill status={o.status} /> : null}
                      </div>
                      <dl className={s.dl}>
                        {inView("customer") ? <div className={s.dlWide}><dt>Customer</dt><dd className={typeScale.name}>{o.customer || "Customer not linked"}</dd></div> : null}
                        {inView("date") ? <div><dt>Order Date</dt><dd className={tabularNumbers}>{fmtDate(o.date)}</dd></div> : null}
                        {inView("delivery") ? <div><dt>Expected Delivery</dt><dd className={tabularNumbers}>{o.delivery ? fmtDate(o.delivery) : "—"}</dd></div> : null}
                        {inView("value") ? <div className={s.dlValue}><dt>Value</dt><dd className={cx(s.cardValue, tabularNumbers)}>{money(o.value)}</dd></div> : null}
                      </dl>
                      <div className={s.cardActions}>{rowActions(o)}</div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <ScrollTable label="Sales orders" pinLast>
                <thead>
                  <tr>
                    <th className={s.thFirst}>
                      <span className={s.firstCell}>
                        <Checkbox aria-label={`Select all ${visible.length} filtered orders`} checked={allSelected} onChange={(e) => setSelected(e.target.checked ? visible.map(keyOf) : [])} />
                        SO Ref
                      </span>
                    </th>
                    {inView("customer") ? <th>Customer</th> : null}
                    {inView("date") ? <th>Order Date</th> : null}
                    {inView("delivery") ? <th>Expected Delivery</th> : null}
                    {inView("value") ? <th className={s.right}>Value</th> : null}
                    {inView("status") ? <th>Status</th> : null}
                    <th className={cx(s.right, s.cActions)}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((o) => {
                    const k = keyOf(o);
                    return (
                      <tr key={o.id} data-order={o.ref} data-selected={selected.includes(k) || undefined}>
                        <td className={s.tdFirst}>
                          <span className={s.firstCell}>
                            <Checkbox aria-label={`Select ${o.ref}`} data-testid="select-row" checked={selected.includes(k)} onChange={() => toggleSel(k)} />
                            <span className={s.refCell}><span className={cx(typeScale.name, tabularNumbers)}>{o.ref}</span>{!o.customerPo && o.id ? <span className={typeScale.caption}>No customer PO</span> : null}</span>
                          </span>
                        </td>
                        {inView("customer") ? <td><span className={s.clamp} title={o.customer || undefined}>{o.customer || <span className={s.muted}>Customer not linked</span>}</span></td> : null}
                        {inView("date") ? <td className={cx(s.nowrap, tabularNumbers)}>{fmtDate(o.date)}</td> : null}
                        {inView("delivery") ? <td className={cx(s.nowrap, tabularNumbers)}>{o.delivery ? fmtDate(o.delivery) : <span className={s.muted}>{"—"}</span>}</td> : null}
                        {inView("value") ? <td className={cx(s.right, s.money, tabularNumbers)}>{money(o.value)}</td> : null}
                        {inView("status") ? <td><StatusPill status={o.status} mode="text" /></td> : null}
                        <td className={cx(s.right, s.cActions)}>{rowActions(o)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </ScrollTable>
            )}
        </>
      )}

      <Dialogs dlg={dlg} close={() => setDlg(null)} setDlg={setDlg} byId={byId} preview={preview} vatRegistered={vatRegistered} customersFail={customersFail} quotesMode={quotesMode} convert={convert} despatch={despatch} role={role} />
    </div>
  );
}

/* ---------------- toolbar Export (all rows) and the same menu inside the selection bar ---------------- */

function ExportMenu({ nSel, total, onExport, testId, size }: { nSel: number; total: number; onExport: (fmt: string) => void; testId: string; size?: "sm" | "md" }) {
  return <Menu label="Export" size={size} aria-label={`Export. ${scopeTitle(nSel, total)}`} data-testid={testId} items={["CSV", "Excel"].map((f) => ({ id: f, label: f, onSelect: () => onExport(f) }))} />;
}

/* ================================================================== */
/* 6. Sheets (the real dialogs, none of them saves anything)           */
/* ================================================================== */

type DialogsProps = {
  dlg: Dlg | null; close: () => void; setDlg: (d: Dlg | null) => void; byId: Map<string, SeedOrder>; preview: (detail: string) => void;
  vatRegistered: boolean; customersFail: boolean; quotesMode: "ok" | "list" | "lines"; convert: (t: SeedOrder[]) => void; despatch: (t: SeedOrder[]) => void; role: Role;
};

function Dialogs({ dlg, close, setDlg, byId, preview, vatRegistered, customersFail, quotesMode, convert, despatch }: DialogsProps) {
  const o = dlg && "id" in dlg ? byId.get(dlg.id) ?? null : null;
  // A toast sits under an open modal, so a finished action closes the sheet first and the toast follows.
  const finish = (detail: string) => { close(); preview(detail); };
  return (
    <>
      {dlg?.k === "view" && o ? <ViewSheet o={o} onClose={close} setDlg={setDlg} onConvert={() => { close(); convert([o]); }} onDespatch={() => { close(); despatch([o]); }} onPrint={() => { close(); preview(`The print page for ${o.ref} would open in a new tab (/sales-orders/${o.id}/print).`); }} /> : null}
      {dlg?.k === "create" ? <CreateSheet onClose={close} vatRegistered={vatRegistered} customersFail={customersFail} quotesMode={quotesMode} onSave={(f, quote) => finish(quote ? `Sales order from ${quote.ref} would be created (one order per quote${f.customerPo.trim() ? "" : "; with no customer PO it takes a provisional SO number"}).` : `A sales order for ${f.customer} would be created${f.customerPo.trim() ? "" : " with a provisional SO number. Add the customer PO when it arrives"}.`)} /> : null}
      {dlg?.k === "edit" && o ? <EditSheet o={o} onClose={close} vatRegistered={vatRegistered} customersFail={customersFail} onSave={() => finish(`${o.ref} would be updated.`)} /> : null}
      {dlg?.k === "po" && o ? <PoSheet o={o} onClose={close} onSave={(po) => finish(`Customer PO ${po} would be added to ${o.ref}.`)} /> : null}
      {dlg?.k === "machines" && o ? <MachinesSheet o={o} onClose={close} onSave={() => finish(`The machines on ${o.ref} would be updated.`)} /> : null}
    </>
  );
}

/* ---------------- customer picker (components/customer-select) ---------------- */

function CustomerPicker({ label = "Customer", value, onChange, failed, required, error, name, selectRef }: { label?: string; value: string; onChange: (v: string) => void; failed: boolean; required?: boolean; error?: string; name: string; selectRef?: React.Ref<HTMLSelectElement> }) {
  const [adding, setAdding] = useState(false);
  const [retried, setRetried] = useState(false);
  const bad = failed && !retried;
  const [nameDraft, setNameDraft] = useState("");
  const [note, setNote] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (adding) requestAnimationFrame(() => nameRef.current?.focus()); }, [adding]);
  const options = bad ? [] : CUSTOMERS;
  const shown = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <>
      <Field label={label} required={required} error={error}>
        <Select ref={selectRef} name={name} value={value} onChange={(e) => { if (e.target.value === "__add__") { setAdding(true); return; } onChange(e.target.value); }}>
          <option value="">{bad ? "Couldn't load customers" : "Select customer..."}</option>
          {shown.map((c) => <option key={c} value={c}>{c}</option>)}
          {bad ? null : <option value="__add__">+ Add new customer</option>}
        </Select>
      </Field>
      {bad ? <p role="alert" className={s.blockMsg} data-testid="customer-picker-error">{PICKER_LOAD_FAILED} <button type="button" className={s.textLink} onClick={() => setRetried(true)}>Retry</button></p> : null}
      {adding ? (
        // The shared Sheet is not nesting-aware: the browser's cancel (Escape) and Tab keydown of an inner dialog also reach the outer sheet's handlers through the React tree
        // (gap, see the report). This wrapper keeps them on the inner sheet, so Escape closes only the add-customer sheet and Tab stays inside it.
        <div className={s.contents} {...({ onCancel: (e: { stopPropagation: () => void }) => e.stopPropagation() } as object)} onKeyDown={(e) => e.stopPropagation()}>
          <Sheet open size="sm" onClose={() => { setAdding(false); setNote(""); }} testId="dlg-add-customer" title="Add new customer" description="Saved to your customer list and selected automatically."
            footer={<><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" disabled={!nameDraft.trim()} onClick={() => { setNote("Preview only. The customer is not added and nothing is saved."); }}>Add customer</Button></>}>
            <Field label="Customer name" required><Input ref={nameRef} value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} /></Field>
            <Field label="Contact name" optional><Input /></Field>
            <div className={s.formGrid}><Field label="Email" optional><Input type="email" /></Field><Field label="Phone" optional><Input type="tel" /></Field></div>
            <p role="status" aria-live="polite" className={cx(s.sheetNote, s.sheetStatus)}>{note}</p>
          </Sheet>
        </div>
      ) : null}
    </>
  );
}

/* ---------------- VAT block shared by New and Edit ---------------- */

function VatBlock({ registered, on, onToggle, rate, onRate, value }: { registered: boolean; on: boolean; onToggle: (v: boolean) => void; rate: VatChoice; onRate: (v: VatChoice) => void; value: string }) {
  const totals = documentTotals([{ quantity: 1, unitPrice: Number(value) || 0, ...fromVatChoice(rate) }], 0, { vatEnabled: on, standardRate: 20 });
  const rows = totals.vatBreakdown.filter((r) => !r.exempt);
  const exempt = totals.vatBreakdown.find((r) => r.exempt);
  return (
    <div className={s.vatBlock}>
      <div className={s.vatControls}>
        {registered ? (<>
          <Switch label="Add VAT" checked={on} onChange={onToggle} />
          <Field label="VAT rate" className={s.vatRate}><Select value={rate} disabled={!on} onChange={(e) => onRate(e.target.value as VatChoice)}>{VAT_CHOICES.map((c) => <option key={c} value={c}>{VAT_CHOICE_LABELS[c]}</option>)}</Select></Field>
        </>) : <p className={s.sheetNote}>Not VAT registered: no VAT is added (Settings &gt; Company details).</p>}
      </div>
      <dl className={cx(s.totals, tabularNumbers)} data-testid="vat-totals">
        <div><dt>Subtotal</dt><dd>{money(totals.subtotal)}</dd></div>
        {on ? (rows.length ? rows.map((r) => <div key={r.rate}><dt>VAT {r.rate}%</dt><dd>{money(r.vat)}</dd></div>) : <div><dt>VAT</dt><dd>{money(0)}</dd></div>) : <div className={s.muted}><dt>No VAT</dt><dd>-</dd></div>}
        {on && exempt ? <div className={s.muted}><dt>Exempt items</dt><dd>{money(exempt.net)}</dd></div> : null}
        <div className={s.totalRow}><dt>Order total</dt><dd>{money(totals.total)}</dd></div>
      </dl>
    </div>
  );
}

/* ---------------- New sales order ---------------- */

function CreateSheet({ onClose, onSave, vatRegistered, customersFail, quotesMode }: { onClose: () => void; onSave: (f: OrderForm, quote: AcceptedQuote | null) => void; vatRegistered: boolean; customersFail: boolean; quotesMode: "ok" | "list" | "lines" }) {
  const [f, setF] = useState<OrderForm>(EMPTY_ORDER_FORM);
  const [tried, setTried] = useState(false);
  const [link, setLink] = useState<{ state: "none" | "loading" | "ready" | "error"; quoteId?: string; message?: string }>({ state: "none" });
  const timer = useRef<number | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLSelectElement>(null);
  const base = useId();
  const quotes = quotesMode === "list" ? [] : ACCEPTED_QUOTES;
  const errors = tried ? orderErrors(f) : {};
  const list = orderSummary(errors);
  const vatOn = vatRegistered && (f.vatOn ?? true);
  const vatChoice: VatChoice = f.vat ?? "20";
  useEffect(() => { requestAnimationFrame(() => firstRef.current?.focus()); return () => { if (timer.current) window.clearTimeout(timer.current); }; }, []);
  const set = (k: keyof OrderForm) => (e: { target: { value: string } }) => setF((c) => ({ ...c, [k]: e.target.value }));
  const quote = quotes.find((q) => q.id === f.quoteId) ?? null;

  const pick = (quoteId: string) => {
    const q = quotes.find((x) => x.id === quoteId);
    setF((c) => ({ ...c, quoteId, customer: q?.customer ?? c.customer, ...(quoteId !== c.quoteId ? { value: "", vatOn: null, vat: null } : {}) }));
    if (timer.current) window.clearTimeout(timer.current);
    if (!quoteId) { setLink({ state: "none" }); return; }
    setLink({ state: "loading", quoteId });
    timer.current = window.setTimeout(() => {
      if (!q || quotesMode === "lines") { setLink({ state: "error", quoteId, message: "Couldn't load that quote's lines. Choose it again, or choose \"No linked quote\" and enter the order by hand." }); return; }
      const terms = termsFor(q, vatRegistered);
      if (!terms.ok) { setLink({ state: "error", quoteId, message: terms.reason }); return; }
      setF((c) => (c.quoteId === quoteId ? { ...c, value: String(terms.value), vatOn: terms.vatOn, vat: terms.vat } : c));
      setLink({ state: "ready", quoteId });
    }, 600);
  };
  const submit = () => {
    if (f.quoteId && !(link.quoteId === f.quoteId && link.state === "ready")) { setTried(true); return; }
    const e = orderErrors(f);
    if (Object.keys(e).length) { setTried(true); requestAnimationFrame(() => summaryRef.current?.focus()); return; }
    if (quote) { const block = quoteAcceptBlock(quote.total); if (block) { setLink({ state: "error", quoteId: quote.id, message: block }); return; } }
    onSave(f, quote);
  };
  const jump = (key: string) => { document.querySelector<HTMLElement>(`[data-form="${base}"] [name="${key}"]`)?.focus(); };
  const wait = link.state === "loading";
  return (
    <Sheet open size="md" onClose={onClose} testId="dlg-create" title="New Sales Order" description="Create from an accepted quote, or enter the customer's order by hand."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={Boolean(f.quoteId) && link.state !== "ready"} onClick={submit}>Save Sales Order</Button></>}>
      <form className={s.form} data-form={base} noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {list.length ? (
          <div ref={summaryRef} tabIndex={-1} role="alert" className={s.summary} data-testid="error-summary">
            <p className={s.summaryTitle}>{list.length === 1 ? "There is 1 problem with this sales order" : `There are ${list.length} problems with this sales order`}</p>
            <ul>{list.map((x) => <li key={x.key}><button type="button" className={s.textLink} onClick={() => jump(x.key)}>{x.message}</button></li>)}</ul>
          </div>
        ) : null}
        <Field label="Accepted quote" optional>
          <Select ref={firstRef} name="quote" value={f.quoteId} onChange={(e) => pick(e.target.value)}>
            <option value="">{quotes.length ? "No linked quote" : "No accepted quotes"}</option>
            {quotes.map((q) => <option key={q.id} value={q.id}>{q.ref} - {q.customer}</option>)}
          </Select>
        </Field>
        {quotesMode === "list" ? <p className={s.warnMsg}>Couldn&apos;t load accepted quotes. You can still enter the order by hand.</p> : null}
        {f.quoteId && link.state === "loading" ? <p role="status" className={s.sheetNote}>Loading the quote&apos;s lines...</p> : null}
        {f.quoteId && link.state === "error" ? <p role="alert" className={s.blockMsg}>{link.message}</p> : null}
        <CustomerPicker name="customer" value={f.customer} onChange={(customer) => setF((c) => ({ ...c, customer }))} failed={customersFail} required error={errors.customer} />
        <Field label="Customer PO" optional hint="Not received yet? Leave it empty: the order gets a provisional number and you add the PO later." error={errors.customerPo}>
          <Input name="customerPo" placeholder="Customer order number (their PO)" maxLength={100} value={f.customerPo} onChange={set("customerPo")} />
        </Field>
        <div className={s.formGrid}>
          <Field label="Order date" required error={errors.orderDate}><Input name="orderDate" type="date" value={f.orderDate} onChange={set("orderDate")} /></Field>
          <Field label="Delivery date" optional error={errors.deliveryDate}><Input name="deliveryDate" type="date" value={f.deliveryDate} onChange={set("deliveryDate")} /></Field>
        </div>
        <Field label="Order value (ex VAT)" required error={errors.value}><Input name="value" type="number" step="0.01" min="0" inputMode="decimal" placeholder="0.00" value={f.value} disabled={wait} onChange={set("value")} /></Field>
        <VatBlock registered={vatRegistered} on={vatOn} onToggle={(v) => setF((c) => ({ ...c, vatOn: v }))} rate={vatChoice} onRate={(v) => setF((c) => ({ ...c, vat: v }))} value={f.value} />
        <Field label="Notes" optional><Textarea name="notes" maxLength={2000} value={f.notes} onChange={set("notes")} /></Field>
      </form>
    </Sheet>
  );
}

/* ---------------- Edit ---------------- */

function EditSheet({ o, onClose, onSave, vatRegistered, customersFail }: { o: SeedOrder; onClose: () => void; onSave: () => void; vatRegistered: boolean; customersFail: boolean }) {
  const [d, setD] = useState({ customer: o.customer, delivery: toDateInputValue(o.delivery), value: String(o.value), vatOn: o.vatEnabled && vatRegistered, vat: o.vat });
  const [tried, setTried] = useState(false);
  const errors = tried ? orderErrors({ customer: d.customer, customerPo: "", orderDate: o.date || TODAY, deliveryDate: d.delivery, value: d.value }) : {};
  const summaryRef = useRef<HTMLDivElement>(null);
  const base = useId();
  const list = orderSummary(errors);
  const submit = () => {
    const e = orderErrors({ customer: d.customer, customerPo: "", orderDate: o.date || TODAY, deliveryDate: d.delivery, value: d.value });
    if (Object.keys(e).length) { setTried(true); requestAnimationFrame(() => summaryRef.current?.focus()); return; }
    onSave();
  };
  return (
    <Sheet open size="md" onClose={onClose} testId="dlg-edit" title={`Edit ${o.ref}`} description="Update customer order information."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save Changes</Button></>}>
      <div className={s.form} data-form={base}>
        {list.length ? (
          <div ref={summaryRef} tabIndex={-1} role="alert" className={s.summary} data-testid="error-summary">
            <p className={s.summaryTitle}>{list.length === 1 ? "There is 1 problem with this sales order" : `There are ${list.length} problems with this sales order`}</p>
            <ul>{list.map((x) => <li key={x.key}><button type="button" className={s.textLink} onClick={() => document.querySelector<HTMLElement>(`[data-form="${base}"] [name="${x.key}"]`)?.focus()}>{x.message}</button></li>)}</ul>
          </div>
        ) : null}
        <CustomerPicker name="customer" value={d.customer} onChange={(customer) => setD((c) => ({ ...c, customer }))} failed={customersFail} error={errors.customer} />
        <Field label="Delivery date" optional error={errors.deliveryDate}><Input name="deliveryDate" type="date" value={d.delivery} onChange={(e) => setD((c) => ({ ...c, delivery: e.target.value }))} /></Field>
        <Field label="Order value (ex VAT)" required error={errors.value}><Input name="value" type="number" step="0.01" min="0" inputMode="decimal" value={d.value} onChange={(e) => setD((c) => ({ ...c, value: e.target.value }))} /></Field>
        <VatBlock registered={vatRegistered} on={d.vatOn && vatRegistered} onToggle={(v) => setD((c) => ({ ...c, vatOn: v }))} rate={d.vat} onRate={(v) => setD((c) => ({ ...c, vat: v }))} value={d.value} />
      </div>
    </Sheet>
  );
}

/* ---------------- Add customer PO ---------------- */

function PoSheet({ o, onClose, onSave }: { o: SeedOrder; onClose: () => void; onSave: (po: string) => void }) {
  const [po, setPo] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { requestAnimationFrame(() => ref.current?.focus()); }, []);
  const clean = customerPoInput(po);
  return (
    <Sheet open size="sm" onClose={onClose} testId="dlg-po" title={`Add customer PO to ${o.ref}`}
      description="The customer's order number. A provisional SO number is replaced by it, and a job made from this order that isn't finished gets it on its worksheet."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!po.trim()} onClick={() => { if (clean) onSave(clean); }}>Save customer PO</Button></>}>
      <Field label="Customer PO" required><Input ref={ref} placeholder="Customer order number (their PO)" maxLength={100} value={po} onChange={(e) => setPo(e.target.value)} /></Field>
    </Sheet>
  );
}

/* ---------------- Machines (components/so-machines-dialog) ---------------- */

type MRow = { key: number; machineId: string; hours: string };
function MachinesSheet({ o, onClose, onSave }: { o: SeedOrder; onClose: () => void; onSave: () => void }) {
  const readOnly = isConverted(o);
  const keyN = useRef(100);
  const initial = useMemo(() => Object.fromEntries(o.lines.map((l) => [l.id, l.machines.map((m, i): MRow => ({ key: i + 1, machineId: m.machineId, hours: String(m.hours) }))])) as Record<string, MRow[]>, [o]);
  const [rows, setRows] = useState<Record<string, MRow[]>>(initial);
  const fp = (r: MRow[]) => JSON.stringify(r.map((x) => [x.machineId, Number(x.hours)]));
  const nameOf = new Map(MACHINES.map((m) => [m.id, m.name]));
  const live = MACHINES.filter((m) => m.active);
  const allRows = Object.values(rows).flat();
  const changed = o.lines.filter((l) => fp(rows[l.id] ?? []) !== fp(initial[l.id] ?? []));
  const onJob = sumMachineHours(o.lines.flatMap((l, li) => (rows[l.id] ?? []).filter((r) => r.machineId).map((r, i): OrderPlanRow => ({ machine_id: r.machineId, estimated_hours: Number(r.hours) || 0, line_key: li + 1, sales_order_line_id: l.id, position: i }))));
  const overHours = onJob.filter((m) => m.hours > MAX_MACHINE_HOURS);
  const badRow = allRows.some((r) => !r.machineId || r.hours === "" || !(Number(r.hours) >= 0 && Number(r.hours) <= MAX_MACHINE_HOURS)) || overHours.length > 0;
  const setRow = (lid: string, key: number, patch: Partial<MRow>) => setRows((c) => ({ ...c, [lid]: (c[lid] ?? []).map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const addRow = (lid: string) => setRows((c) => { const used = new Set((c[lid] ?? []).map((r) => r.machineId)); const free = live.find((m) => !used.has(m.id)); return { ...c, [lid]: [...(c[lid] ?? []), { key: ++keyN.current, machineId: free?.id ?? "", hours: "" }] }; });
  const removeRow = (lid: string, key: number) => setRows((c) => ({ ...c, [lid]: (c[lid] ?? []).filter((r) => r.key !== key) }));
  return (
    <Sheet open size="lg" onClose={onClose} testId="dlg-machines" title={`Machines - ${o.ref}`} closeButton={false}
      description={readOnly ? "As ordered. This order has been converted: the job holds the plan now, and it is changed on the Job Board." : "The machine(s) each line will run on and the hours it needs. When the order converts, they carry to the job (summed per machine) and stay editable there. Nothing is booked on the schedule until you book it from the job."}
      footer={<><Button variant="secondary" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>{readOnly ? null : <Button variant="primary" disabled={badRow || changed.length === 0} onClick={onSave}>Save machines</Button>}</>}>
      <div className={s.mLines} data-testid="so-machines">
        {o.lines.map((l, li) => {
          const lr = rows[l.id] ?? [];
          const used = new Set(lr.map((r) => r.machineId));
          return (
            <div key={l.id} role="group" aria-label={`Line ${li + 1}: ${l.description}`} className={s.mLine} data-testid="so-machines-line">
              <p className={s.mLegend}>Line {li + 1}: {l.description}{l.quantity !== 1 ? ` x ${l.quantity}` : ""}</p>
              {lr.length === 0 ? <p className={s.sheetNote}>No machine yet.</p> : null}
              {lr.map((r, i) => (
                <div key={r.key} className={s.mRow}>
                  <Field label={`Machine ${i + 1}`}>
                    <Select aria-label={`Line ${li + 1} machine ${i + 1}`} disabled={readOnly} value={r.machineId} onChange={(e) => setRow(l.id, r.key, { machineId: e.target.value })}>
                      <option value="">Choose a machine</option>
                      {MACHINES.filter((m) => m.id === r.machineId || (m.active && !used.has(m.id))).map((m) => <option key={m.id} value={m.id}>{m.name}{m.active ? "" : " (inactive)"}</option>)}
                    </Select>
                  </Field>
                  <Field label="Hours"><Input aria-label={`Line ${li + 1} hours on machine ${i + 1}`} disabled={readOnly} type="number" min={0} max={MAX_MACHINE_HOURS} step="0.25" value={r.hours} onChange={(e) => setRow(l.id, r.key, { hours: e.target.value })} /></Field>
                  {readOnly ? null : <Button size="sm" variant="quiet" className={s.mRemove} aria-label={`Remove line ${li + 1} machine ${i + 1}`} onClick={() => removeRow(l.id, r.key)}>Remove</Button>}
                </div>
              ))}
              {readOnly ? null : <div><Button size="sm" variant="secondary" disabled={lr.length >= MAX_MACHINES || lr.length >= live.length} onClick={() => addRow(l.id)}>Add machine</Button></div>}
            </div>
          );
        })}
      </div>
      <p className={cx(s.mSummary, onJob.length ? undefined : s.muted)} data-testid="so-machines-summary"><b>On the job:</b> {onJob.length ? `${describeMachines(onJob.map((m) => ({ name: nameOf.get(m.machine_id) ?? "Machine", hours: m.hours })))} (${formatHours(onJob.reduce((n, m) => n + m.hours, 0))} in all)` : "no machines"}</p>
      {overHours.length ? <p role="alert" className={s.blockMsg}>A machine can carry at most 1000 hours across the order&apos;s lines: {describeMachines(overHours.map((m) => ({ name: nameOf.get(m.machine_id) ?? "Machine", hours: m.hours })))}. Lower the hours.</p> : null}
    </Sheet>
  );
}

/* ---------------- The order's own sheet ---------------- */

const ACTIVITY: Array<{ title: string; details: string[]; who: string; when: string }> = [
  { title: "Sales order created", details: ["Customer PO and delivery date set"], who: "Sam Okoro", when: "20/11/2026, 09:14" },
  { title: "Delivery date changed", details: ["Delivery date: 05/12/2026 to 12/12/2026"], who: "Priya Naidoo", when: "21/11/2026, 14:02" },
];

function ViewSheet({ o, onClose, setDlg, onConvert, onDespatch, onPrint }: { o: SeedOrder; onClose: () => void; setDlg: (d: Dlg | null) => void; onConvert: () => void; onDespatch: () => void; onPrint: () => void }) {
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const blocked = editBlockedReason(o);
  const plan = planText(o);
  return (
    <Sheet open size="md" onClose={onClose} testId="dlg-view" title={<span className={tabularNumbers}>{o.ref}</span>} description="Sales order detail"
      footer={(
        <div className={s.viewFoot}>
          <div className={s.footGroup}>
            <Button variant="secondary" onClick={() => setDlg({ k: "machines", id: o.id })}>Machines</Button>
            <Button variant="secondary" onClick={onPrint}>Print</Button>
            <Button variant="secondary" onClick={() => setNote(`Preview only. The PDF for ${o.ref} is not generated. Nothing was saved.`)}>Download PDF</Button>
          </div>
          <div className={s.footGroup}>
            {canDespatch(o) ? <Button variant="secondary" onClick={onDespatch}>Despatch</Button> : null}
            {isConverted(o) ? null : <Button variant="primary" onClick={onConvert}>Convert to Job</Button>}
          </div>
        </div>
      )}>
      <dl className={s.facts}>
        <div><dt>Customer</dt><dd>{o.customer || "Customer not linked"}</dd></div>
        <div><dt>Status</dt><dd><StatusPill status={o.status} /></dd></div>
        <div><dt>Order date</dt><dd className={tabularNumbers}>{fmtDate(o.date)}</dd></div>
        <div><dt>Expected delivery</dt><dd className={tabularNumbers}>{fmtDate(o.delivery) || "Not set"}</dd></div>
        <div><dt>Value</dt><dd className={tabularNumbers}>{money(o.value)}</dd></div>
        {o.quoteRef ? <div><dt>Quote</dt><dd className={tabularNumbers}>{o.quoteRef}</dd></div> : null}
        <div className={s.factWide} data-testid="so-customer-po"><dt>Customer PO</dt>
          <dd className={s.poRow}><span className={tabularNumbers}>{o.customerPo || "Not received yet"}</span>
            {o.id && !o.customerPo ? <Button size="sm" variant="secondary" onClick={() => setDlg({ k: "po", id: o.id })}>Add customer PO</Button> : null}</dd></div>
        {o.convertedJob ? <div><dt>Linked job</dt><dd className={tabularNumbers}>{o.convertedJob}</dd></div> : null}
        <div className={s.factWide} data-testid="so-machines-chips"><dt>Machines</dt><dd className={s.plain}>{(o.id && plan) || "None planned"}{o.convertedJob && plan ? " (as ordered; the job holds the plan now)" : ""}</dd></div>
      </dl>
      {blocked ? <p className={s.callout} data-testid="so-edit-blocked">{blocked}</p> : null}
      <section className={s.activity} aria-label="Activity">
        <button type="button" className={s.activityBtn} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span>Activity <span className={s.muted}>({ACTIVITY.length})</span></span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className={cx(s.chev, open && s.chevOpen)}><path d="M2 3.6 5 6.6 8 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {open ? (
          <ol className={s.timeline}>
            {ACTIVITY.map((a) => (
              <li key={a.title}><p className={s.tlTitle}>{a.title}</p>{a.details.map((d) => <p key={d} className={s.tlDetail}>{d}</p>)}<p className={s.tlWho}>{a.who} {"·"} <span className={tabularNumbers}>{a.when}</span></p></li>
            ))}
            <li className={s.muted}><p className={s.tlDetail}>Sample entries only: the real trail is read from the audit log.</p></li>
          </ol>
        ) : null}
      </section>
      <p role="status" aria-live="polite" className={cx(s.sheetNote, s.sheetStatus)} data-testid="sheet-status">{note}</p>
    </Sheet>
  );
}

