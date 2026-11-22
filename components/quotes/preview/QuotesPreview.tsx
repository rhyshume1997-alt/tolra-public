"use client";

/**
 * BOUNDARY (Quotes module 3, PREVIEW ONLY). Inputs: none from the server. Everything shown is fictional sample data (22 quotes, as of
 * 20/11/2026) held in this file, plus the person's clicks. Outputs: a Quote Generator list look-and-feel prototype (stat tiles, status
 * legend, Show and status filters, selection and Export, Cards / List / Table, Columns, row actions and the real confirmation dialogs)
 * whose only state is LOCAL UI state (filters, selection, view, columns). It never reads or writes Supabase, calls no server action or
 * API route, imports no lib/ business module at run time (type imports only), and no action ever reports success: every action that
 * would send, accept, reject, revise, archive, save or export answers with the neutral "Preview only" toast, and nothing is saved.
 * The pure logic (first half) is exported and tests/unit/quotesPreview.test.ts pins it to the real lib/quote-status, lib/list-filter,
 * lib/quote-expiry, lib/money and lib/spreadsheet functions.
 * MUST NOT CHANGE: wording, defaults, column order, filter semantics and the role gate mirror today's Quote Generator
 * (app/(dashboard)/quotes/page.tsx: admin and office only, workshop and viewer see "Access Denied"). Do not wire this file to real data
 * or real actions, add no control the real page lacks (no search box, no sort), and keep row controls at a 48 px hit area.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import {
  Button, Checkbox, ChipGroup, Dialog, EmptyState, FailedState, FilterChip, LoadingState, Menu, Popover, SelectionBar, StatusBadge,
  ScrollTable, Switch, ToastProvider, cx, premiumTokens, tabularNumbers, useToast,
} from "@/components/ui/premium";
import type { StatusTone } from "@/components/ui/premium";
import type { QuoteStatus } from "@/lib/quote-status";

import s from "./QuotesPreview.module.css";

/* ================================================================== */
/* 1. Types and constants                                              */
/* ================================================================== */

export type Role = "admin" | "office" | "workshop" | "viewer";
export type ViewMode = "cards" | "list" | "table";
export type PhaseValue = "open" | "done" | "archived" | "all";
export type Screen = "ready" | "loading" | "error" | "empty";
export type ListFilterKey = "expired" | "no-decision";
export type ColumnKey = "ref" | "date" | "customer" | "description" | "status" | "value" | "valid";
export type { QuoteStatus };

/** The sample's "today" (kept fixed so the figures never drift): the expiry rules and the archive rule are worked out against it. */
export const TODAY = "2026-11-20";
export const ARCHIVE_MONTHS = 12;
export const NO_DECISION_DAYS = 14;

export const STATUS_ORDER: QuoteStatus[] = ["draft", "sent", "accepted", "rejected", "expired", "superseded"];
export const STATUS_LABEL: Record<QuoteStatus, string> = { draft: "Draft", sent: "Sent", accepted: "Accepted", rejected: "Rejected", expired: "Expired", superseded: "Superseded" };
const STATUS_TONE: Record<QuoteStatus, StatusTone> = { draft: "neutral", sent: "info", accepted: "ok", rejected: "danger", expired: "warn", superseded: "neutral" };
const GROUP_HEAD: Record<QuoteStatus, string> = { draft: "Drafts", sent: "Sent", accepted: "Accepted", rejected: "Rejected", expired: "Expired", superseded: "Superseded" };

export const COLUMNS: Array<{ key: ColumnKey; label: string; locked?: boolean }> = [
  { key: "ref", label: "Quote", locked: true }, { key: "date", label: "Date" }, { key: "customer", label: "Customer" }, { key: "description", label: "Description" },
  { key: "status", label: "Status" }, { key: "value", label: "Value" }, { key: "valid", label: "Valid until" },
];

export const QUOTE_FILTER_LABELS: Record<ListFilterKey, string> = { expired: "Draft or sent quotes past their valid-until date", "no-decision": "Sent quotes with no decision" };

type SeedLine = { description: string; quantity: number; unitPrice: number; partNumber?: string; drawingNumber?: string; drawingRevision?: string; declined?: boolean };
export type SeedQuote = {
  id: string; ref: string; customer: string; description: string; rawStatus: QuoteStatus; date: string; validUntil: string; sentAt?: string;
  vatEnabled: boolean; version: number; previousVersionId?: string | null; customerPo: string; internalNotes?: string; customerNotes?: string;
  manual?: "archived" | "active"; lines: SeedLine[];
};
export type QuoteRow = SeedQuote & { value: number; declinedValue: number; status: QuoteStatus };

/** Customers and whether the sample has an e-mail address for them (the send question changes when there is none). */
export const CUSTOMER_EMAIL: Record<string, string | null> = {
  "Marlow Hydraulics": "purchasing@marlow-hydraulics.example", "Tern Marine Engineering": "orders@tern-marine.example", "Coldharbour Automation": "buyer@coldharbour.example",
  "Ashby Rail Services": "supply@ashby-rail.example", "Kestrel Components": "procurement@kestrel.example", "Pemberton Packaging": null,
  "Halden Precision": "accounts@halden-precision.example", "Wren & Calder": "projects@wren-calder.example", "Brightwell Valves": "buying@brightwell.example", "Northgate Fabrication": "orders@northgate-fab.example",
};

/* ================================================================== */
/* 2. Sample data (fictional)                                          */
/* ================================================================== */

const L = (description: string, quantity: number, unitPrice: number, extra: Partial<SeedLine> = {}): SeedLine => ({ description, quantity, unitPrice, ...extra });

export const SEED_QUOTES: SeedQuote[] = [
  { id: "q38", ref: "QUO-0438", customer: "Marlow Hydraulics", description: "Hydraulic manifold blocks, 6061-T6, run of 40", rawStatus: "draft", date: "2026-11-19", validUntil: "2026-12-19", vatEnabled: true, version: 1, customerPo: "",
    lines: [L("Manifold block, machined and anodised", 40, 86.5, { partNumber: "MB-2210", drawingNumber: "D-5521", drawingRevision: "B" }), L("First-off inspection report", 1, 120)] },
  { id: "q37", ref: "QUO-0437", customer: "Tern Marine Engineering", description: "Stainless deck cleats, 316, with backing plates", rawStatus: "draft", date: "2026-11-18", validUntil: "", vatEnabled: true, version: 1, customerPo: "",
    lines: [L("Deck cleat 250 mm, 316 stainless", 24, 64), L("Backing plate, laser cut", 24, 11.75)] },
  { id: "q36", ref: "QUO-0436", customer: "Ashby Rail Services", description: "Brake bracket weldments, batch of 120", rawStatus: "sent", date: "2026-11-17", validUntil: "2026-12-17", sentAt: "2026-11-17", vatEnabled: true, version: 1, customerPo: "",
    lines: [L("Brake bracket weldment", 120, 38.4, { partNumber: "BB-044", drawingNumber: "D-7180", drawingRevision: "C" }), L("Paint, RAL 7016", 120, 4.1)] },
  { id: "q35", ref: "QUO-0435", customer: "Kestrel Components", description: "Sensor housings, anodised aluminium", rawStatus: "sent", date: "2026-11-12", validUntil: "2026-12-12", sentAt: "2026-11-12", vatEnabled: true, version: 1, customerPo: "",
    lines: [L("Sensor housing, turned and milled", 250, 14.2, { partNumber: "SH-310" }), L("Anodise, black", 250, 2.35)] },
  { id: "q34", ref: "QUO-0434", customer: "Northgate Fabrication", description: "Guard frames for packing line", rawStatus: "accepted", date: "2026-11-14", validUntil: "2026-12-14", sentAt: "2026-11-14", vatEnabled: true, version: 1, customerPo: "NF-88213",
    lines: [L("Guard frame, 40 x 40 box section", 8, 412), L("Fixings and finishing", 1, 140)] },
  { id: "q33", ref: "QUO-0433", customer: "Pemberton Packaging", description: "Sealing jaw bars, tool steel", rawStatus: "sent", date: "2026-11-05", validUntil: "2026-12-05", sentAt: "2026-11-05", vatEnabled: true, version: 1, customerPo: "",
    lines: [L("Sealing jaw bar, hardened", 16, 94.5, { drawingNumber: "D-3002", drawingRevision: "A" })] },
  { id: "q32", ref: "QUO-0432", customer: "Tern Marine Engineering", description: "Rudder stock bushes, bronze", rawStatus: "accepted", date: "2026-11-08", validUntil: "2026-12-08", sentAt: "2026-11-08", vatEnabled: true, version: 1, customerPo: "TM/5521",
    lines: [L("Bush, aluminium bronze, bored", 12, 58), L("Material certificates", 1, 35)] },
  { id: "q31", ref: "QUO-0431", customer: "Coldharbour Automation", description: "Gearbox housing machining, 5 axis", rawStatus: "draft", date: "2026-11-02", validUntil: "2026-11-16", vatEnabled: true, version: 1, customerPo: "",
    lines: [L("Gearbox housing, 5 axis machined", 6, 312)] },
  { id: "q30", ref: "QUO-0430", customer: "Coldharbour Automation", description: "Linear actuator end caps", rawStatus: "rejected", date: "2026-11-01", validUntil: "2026-11-30", sentAt: "2026-11-01", vatEnabled: true, version: 1, customerPo: "",
    lines: [L("End cap, turned", 200, 6.8)] },
  { id: "q29", ref: "QUO-0429", customer: "Halden Precision", description: "Calibration fixtures, ground and lapped", rawStatus: "sent", date: "2026-10-28", validUntil: "2026-12-10", sentAt: "2026-10-28", vatEnabled: true, version: 1, customerPo: "",
    lines: [L("Calibration fixture, ground", 4, 640), L("Inspection and certification", 4, 85)] },
  { id: "q28", ref: "QUO-0428", customer: "Ashby Rail Services", description: "Door pivot pins and carriers", rawStatus: "accepted", date: "2026-10-30", validUntil: "2026-11-29", sentAt: "2026-10-30", vatEnabled: true, version: 1, customerPo: "ARS-20771",
    lines: [L("Pivot pin, hardened", 60, 9.6, { partNumber: "PP-12" }), L("Pin carrier, machined", 60, 18.2, { partNumber: "PC-12" }), L("Spare pivot pins", 20, 9.6, { declined: true })] },
  { id: "q27", ref: "QUO-0412 v2", customer: "Wren & Calder", description: "Conveyor idler rollers, revised for galvanised finish", rawStatus: "sent", date: "2026-11-10", validUntil: "2026-12-10", sentAt: "2026-11-10", vatEnabled: true, version: 2, previousVersionId: "q26", customerPo: "",
    lines: [L("Idler roller 89 mm, galvanised", 90, 41), L("Bearing set", 90, 7.4)] },
  { id: "q26", ref: "QUO-0412", customer: "Wren & Calder", description: "Conveyor idler rollers", rawStatus: "superseded", date: "2026-10-30", validUntil: "2026-11-29", sentAt: "2026-10-30", vatEnabled: true, version: 1, customerPo: "",
    lines: [L("Idler roller 89 mm, painted", 90, 36.5), L("Bearing set", 90, 7.4)] },
  { id: "q25", ref: "QUO-0426", customer: "Brightwell Valves", description: "Ball valve bodies, 316 stainless", rawStatus: "sent", date: "2026-10-20", validUntil: "2026-11-10", sentAt: "2026-10-20", vatEnabled: true, version: 1, customerPo: "",
    lines: [L("Valve body, 316 investment cast, finish machined", 80, 52.3)] },
  { id: "q24", ref: "QUO-0424", customer: "Halden Precision", description: "Reference gauge blocks", rawStatus: "rejected", date: "2026-10-18", validUntil: "2026-11-17", sentAt: "2026-10-18", vatEnabled: true, version: 1, customerPo: "",
    lines: [L("Gauge block set, ground", 3, 880)] },
  { id: "q23", ref: "QUO-0421", customer: "Marlow Hydraulics", description: "Cylinder glands and rod ends", rawStatus: "accepted", date: "2026-10-12", validUntil: "2026-11-11", sentAt: "2026-10-12", vatEnabled: true, version: 1, customerPo: "MH-40918",
    lines: [L("Cylinder gland, turned", 100, 22.5), L("Rod end, turned and threaded", 100, 15.9)] },
  { id: "q22", ref: "QUO-0417", customer: "Northgate Fabrication", description: "Mezzanine handrail posts", rawStatus: "sent", date: "2026-10-02", validUntil: "2026-11-01", sentAt: "2026-10-02", vatEnabled: true, version: 1, customerPo: "",
    lines: [L("Handrail post, 48.3 mm tube, base plate welded", 36, 27.4)] },
  { id: "q21", ref: "QUO-0405 v2", customer: "Kestrel Components", description: "Gimbal brackets, 7075, revised quantity", rawStatus: "accepted", date: "2026-10-09", validUntil: "2026-11-08", sentAt: "2026-10-09", vatEnabled: true, version: 2, previousVersionId: "q20", customerPo: "KC-2290",
    lines: [L("Gimbal bracket, 7075-T651", 150, 31.8, { partNumber: "GB-77", drawingNumber: "D-9004", drawingRevision: "D" })] },
  { id: "q20", ref: "QUO-0405", customer: "Kestrel Components", description: "Gimbal brackets, 7075", rawStatus: "superseded", date: "2026-10-05", validUntil: "2026-11-04", sentAt: "2026-10-05", vatEnabled: true, version: 1, customerPo: "",
    lines: [L("Gimbal bracket, 7075-T651", 100, 33.2, { partNumber: "GB-77", drawingNumber: "D-9004", drawingRevision: "D" })] },
  { id: "q19", ref: "QUO-0399", customer: "Marlow Hydraulics", description: "Test block prototypes", rawStatus: "rejected", date: "2026-10-01", validUntil: "2026-10-31", sentAt: "2026-10-01", vatEnabled: true, version: 1, customerPo: "", manual: "archived",
    lines: [L("Prototype test block", 2, 260)] },
  { id: "q18", ref: "QUO-0310", customer: "Pemberton Packaging", description: "Cutter holders, annual call-off", rawStatus: "accepted", date: "2025-09-10", validUntil: "2025-10-10", sentAt: "2025-09-10", vatEnabled: true, version: 1, customerPo: "PP-1182",
    lines: [L("Cutter holder, hardened", 300, 12.4)] },
  { id: "q17", ref: "QUO-0305", customer: "Kestrel Components", description: "Test rig plates", rawStatus: "rejected", date: "2025-08-14", validUntil: "2025-09-13", sentAt: "2025-08-14", vatEnabled: true, version: 1, customerPo: "",
    lines: [L("Rig plate, ground", 12, 74)] },
];

/* ================================================================== */
/* 3. Pure logic (mirrors lib/quote-status, lib/list-filter, lib/money) */
/* ================================================================== */

const pence = (value: number) => Math.round((Number(value) || 0) * 100);
const dayMs = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

export function daysBetween(from: string, to: string): number { return Math.round((dayMs(to) - dayMs(from)) / 86_400_000); }
export function fmtDate(iso: string): string { return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : ""; }
export function gbp(value: number): string { return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value); }
export function addDays(iso: string, days: number): string { const d = new Date(dayMs(iso) + days * 86_400_000); return d.toISOString().slice(0, 10); }

/** Expired is shown once valid-until is before today, for a quote still undecided (lib/quote-status effectiveQuoteStatus). */
export function effectiveStatus(stored: QuoteStatus, validUntil: string, today: string = TODAY): QuoteStatus {
  return (stored === "sent" || stored === "draft") && validUntil && validUntil.slice(0, 10) < today.slice(0, 10) ? "expired" : stored;
}
export const canOfferSend = (stored: QuoteStatus) => stored !== "superseded" && stored !== "rejected";
export const canRecordDecision = (stored: QuoteStatus) => stored === "draft" || stored === "sent";

export type Totals = { subtotal: number; vat: number; total: number };
/** Per-line VAT rounded, then summed (lib/money documentTotals). */
export function totalsOf(lines: Array<{ quantity: number; unitPrice: number }>, vatEnabled: boolean, rate = 20): Totals {
  let net = 0; let vat = 0;
  for (const line of lines) {
    const n = Math.round(line.quantity * line.unitPrice * 100);
    net += n;
    if (vatEnabled) vat += Math.round((n * rate) / 100);
  }
  return { subtotal: net / 100, vat: vat / 100, total: (net + vat) / 100 };
}

export function quoteRows(seeds: readonly SeedQuote[] = SEED_QUOTES, today: string = TODAY): QuoteRow[] {
  return seeds.map((seed) => {
    const value = totalsOf(seed.lines, seed.vatEnabled).total;
    const declinedValue = totalsOf(seed.lines.filter((l) => l.declined), seed.vatEnabled).total;
    return { ...seed, value, declinedValue, status: effectiveStatus(seed.rawStatus, seed.validUntil, today) };
  });
}

/** Newest first by date, then by reference (lib/quote-status newestFirst). */
export function newestFirst<T extends { date?: string; ref: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.ref.localeCompare(a.ref));
}

export type Bucket = { count: number; value: number };
export type Figures = { open: Bucket; drafts: Bucket; accepted: Bucket; winRate: number | null };
/** The tile figures (lib/quote-status quoteFigures): an accepted quote counts only the lines that were ordered. */
export function figuresOf(rows: readonly QuoteRow[], today: string = TODAY): Figures {
  const by: Record<QuoteStatus, { count: number; pence: number }> = Object.fromEntries(STATUS_ORDER.map((k) => [k, { count: 0, pence: 0 }])) as Record<QuoteStatus, { count: number; pence: number }>;
  let expiredSent = 0;
  for (const r of rows) {
    const status = effectiveStatus(r.rawStatus, r.validUntil, today);
    by[status].count += 1;
    by[status].pence += r.rawStatus === "accepted" ? Math.max(0, pence(r.value) - pence(r.declinedValue)) : pence(r.value);
    if (status === "expired" && r.rawStatus === "sent") expiredSent += 1;
  }
  const decided = by.accepted.count + by.rejected.count + expiredSent;
  const b = (k: QuoteStatus): Bucket => ({ count: by[k].count, value: by[k].pence / 100 });
  return { open: b("sent"), drafts: b("draft"), accepted: b("accepted"), winRate: decided ? Math.round((by.accepted.count / decided) * 100) : null };
}

export type Phase = "open" | "done" | "archived";
/** Open / Done / Archived (lib/archive phaseOf): a manual choice beats the age rule. */
export function phaseOf(row: Pick<QuoteRow, "status" | "validUntil" | "date" | "manual">, today: string = TODAY, months = ARCHIVE_MONTHS): Phase {
  if (row.manual === "archived") return "archived";
  const final = row.status === "accepted" || row.status === "rejected" || row.status === "expired" || row.status === "superseded";
  if (!final) return "open";
  const finalDate = row.validUntil || row.date;
  if (row.manual === "active" || !finalDate) return "done";
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const at = new Date(`${finalDate.slice(0, 10)}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at < cutoff ? "archived" : "done";
}

/** The dashboard's ?filter= rules (lib/list-filter quoteMatchesFilter). */
export function matchesListFilter(filter: ListFilterKey, q: Pick<QuoteRow, "rawStatus" | "validUntil" | "sentAt">, today: string = TODAY): boolean {
  const expired = (q.rawStatus === "draft" || q.rawStatus === "sent") && Boolean(q.validUntil) && q.validUntil < today;
  if (filter === "expired") return expired;
  return q.rawStatus === "sent" && !expired && Boolean(q.sentAt) && daysBetween(q.sentAt as string, today) > NO_DECISION_DAYS;
}

export type Filters = { phase: PhaseValue; statuses: ReadonlySet<string>; listFilter: ListFilterKey | null };
export const DEFAULT_FILTERS: Filters = { phase: "open", statuses: new Set(["all"]), listFilter: null };

export function visibleQuotes(rows: readonly QuoteRow[], f: Filters, today: string = TODAY): QuoteRow[] {
  return newestFirst(rows.filter((q) => (f.listFilter ? matchesListFilter(f.listFilter, q, today) : (f.phase === "all" || phaseOf(q, today) === f.phase) && (f.statuses.has("all") || f.statuses.has(q.status)))));
}
export function phaseCounts(rows: readonly QuoteRow[], today: string = TODAY): Record<Phase, number> {
  return { open: rows.filter((q) => phaseOf(q, today) === "open").length, done: rows.filter((q) => phaseOf(q, today) === "done").length, archived: rows.filter((q) => phaseOf(q, today) === "archived").length };
}
/** The status legend (lib/list-filter quoteLegend): counts what the list is scoped to. */
export function legendOf(rows: readonly QuoteRow[], f: Filters, today: string = TODAY): { counts: Record<QuoteStatus, number>; scope: string } {
  const counts: Record<QuoteStatus, number> = { draft: 0, sent: 0, accepted: 0, rejected: 0, expired: 0, superseded: 0 };
  const inScope = f.listFilter ? rows.filter((q) => matchesListFilter(f.listFilter as ListFilterKey, q, today)) : rows.filter((q) => f.phase === "all" || phaseOf(q, today) === f.phase);
  for (const q of inScope) counts[q.status] += 1;
  const label = f.phase === "all" ? "all quotes" : `${f.phase[0].toUpperCase()}${f.phase.slice(1)}`;
  return { counts, scope: f.listFilter ? QUOTE_FILTER_LABELS[f.listFilter] : `In ${label}` };
}
export function groupsOf(rows: readonly QuoteRow[]): Array<{ status: QuoteStatus; items: QuoteRow[] }> {
  return STATUS_ORDER.map((status) => ({ status, items: rows.filter((q) => q.status === status) })).filter((g) => g.items.length);
}

/** The export button's scope text (lib/spreadsheet exportScopeTitle). */
export function scopeTitle(selected: number, inFilter: number): string {
  const plural = (n: number) => `${n} quote${n === 1 ? "" : "s"}`;
  return selected > 0 ? `Exports the ${plural(selected)} selected` : `Exports all ${plural(inFilter)} in the current filter (nothing is selected)`;
}
/** Why a quote cannot be marked accepted, or null (lib/quote-status quoteAcceptBlock). */
export function acceptBlock(total: number, lineCount?: number, tickedSubtotal?: number): string | null {
  if (pence(total) <= 0) return "A quote for £0.00 can't be accepted. Add a price or decline it.";
  if (lineCount !== undefined && lineCount <= 0) return "A quote with no lines can't be accepted. Add a line or decline it.";
  if (tickedSubtotal !== undefined && pence(tickedSubtotal) <= 0) return "The ticked lines come to £0.00, so they can't be accepted. Tick a priced line or decline the quote.";
  return null;
}
/** The question before Send or Mark accepted on a quote past its date (lib/quote-expiry expiredQuoteCheck), or null. */
export function expiredMessage(q: Pick<QuoteRow, "rawStatus" | "validUntil">, action: "send" | "accept", today: string = TODAY): string | null {
  if (effectiveStatus(q.rawStatus, q.validUntil, today) !== "expired") return null;
  const days = daysBetween(q.validUntil.slice(0, 10), today);
  return `This quote expired on ${fmtDate(q.validUntil.slice(0, 10))} (${days} ${days === 1 ? "day" : "days"} ago). Prices may be out of date. ${action === "send" ? "Send anyway?" : "Mark accepted anyway?"}`;
}
export function lineReference(l: Pick<SeedLine, "partNumber" | "drawingNumber" | "drawingRevision">): string {
  const parts: string[] = [];
  if (l.partNumber) parts.push(`Part ${l.partNumber}`);
  if (l.drawingNumber) parts.push(`Dwg ${l.drawingNumber}${l.drawingRevision ? ` rev ${l.drawingRevision}` : ""}`);
  else if (l.drawingRevision) parts.push(`Rev ${l.drawingRevision}`);
  return parts.join("; ");
}
export const customerPoBeside = (po: string) => (po.trim() ? `Customer PO ${po.trim()}` : "");

/** What each role sees (lib/auth/hasAccess + RoleGate): the Quote Generator is for admin and office only. */
export function canUseQuotes(role: Role): boolean { return role === "admin" || role === "office"; }

/* ================================================================== */
/* 4. Small local pieces (gaps in the shared set, see the report)       */
/* ================================================================== */

const VIEW_KEY = "quotes-preview:view";
const ROLES: Array<{ v: Role; label: string }> = [{ v: "admin", label: "Admin" }, { v: "office", label: "Office" }, { v: "workshop", label: "Workshop" }, { v: "viewer", label: "Viewer" }];
const SCREENS: Array<{ v: Screen | ListFilterKey; label: string }> = [
  { v: "ready", label: "Normal" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "empty", label: "No quotes yet" },
  { v: "expired", label: "Dashboard link: Expired" }, { v: "no-decision", label: "Dashboard link: No decision" },
];

function useMedia(query: string, fallback: boolean): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia(query).matches,
    () => fallback,
  );
}

/** Segmented control (gap in the shared set): a pressed-state button group, 32 px segments in a 40 px track, 48 px hit areas. */
function Segmented<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: Array<{ v: T; label: string; off?: string; testId?: string }>; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div role="group" aria-label={label} className={s.seg}>
      {options.map((o) => (
        <button key={o.v} type="button" aria-pressed={value === o.v} aria-disabled={o.off || disabled ? true : undefined} title={o.off} data-testid={o.testId}
          className={s.segBtn} onClick={() => { if (!o.off && !disabled) onChange(o.v); }}>{o.label}</button>
      ))}
    </div>
  );
}

/** Wide modal on the native dialog element (gap in the shared set: custom footer, scrolling body). Focus is trapped; Escape asks to close. */
function Sheet({ open, title, description, size = "md", children, footer, onClose, testId, closeButton = true }: { closeButton?: boolean; open: boolean; title: ReactNode; description?: string; size?: "sm" | "md" | "lg"; children: ReactNode; footer: ReactNode; onClose: () => void; testId?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const uid = useId();
  // Focus returns to whatever opened the sheet (the native dialog only does it when the element stays mounted). Declared before the
  // showModal effect so the opener is read before focus moves into the dialog.
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    // Kept across the development double-run of effects (the first cleanup cannot focus through the modal, so the opener must survive it).
    if (!openerRef.current || !openerRef.current.isConnected) openerRef.current = document.activeElement as HTMLElement | null;
    return () => {
      const o = openerRef.current;
      if (o && o.isConnected) { o.focus(); if (document.activeElement === o) openerRef.current = null; }
    };
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={cx(premiumTokens, s.sheet, s[`sheet_${size}`])} aria-labelledby={`${uid}-t`} aria-describedby={description ? `${uid}-d` : undefined} data-testid={testId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const f = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select, textarea, [href], [tabindex]:not([tabindex="-1"])') ?? []);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }}>
      {open ? (
        <div className={s.sheetInner}>
          <header className={s.sheetHead}>
            <div className={s.sheetHeadText}>
              <h2 id={`${uid}-t`} className={s.sheetTitle}>{title}</h2>
              {description ? <p id={`${uid}-d`} className={s.sheetDesc}>{description}</p> : null}
            </div>
            {closeButton ? <Button size="sm" variant="quiet" onClick={onClose}>Close</Button> : null}
          </header>
          <div className={s.sheetBody}>{children}</div>
          <footer className={s.sheetFoot}>{footer}</footer>
        </div>
      ) : null}
    </dialog>
  );
}

function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return <label className={cx(s.field, wide && s.fieldWide)}><span className={s.fieldLabel}>{label}</span>{children}{hint ? <span className={s.fieldHint}>{hint}</span> : null}</label>;
}

function StatusPill({ status }: { status: QuoteStatus }) {
  return <StatusBadge tone={STATUS_TONE[status]} plain={status === "superseded"} className={status === "superseded" ? s.superseded : undefined}>{STATUS_LABEL[status]}</StatusBadge>;
}

/* ================================================================== */
/* 5. Dialog state                                                     */
/* ================================================================== */

type Dlg =
  | { k: "builder"; mode: "new" | "edit" | "copy"; id?: string }
  | { k: "send"; id: string }
  | { k: "sendConfirm"; id: string }
  | { k: "expired"; id: string; action: "send" | "accept" }
  | { k: "decision"; id: string; outcome: "accepted" | "rejected" }
  | { k: "revise"; id: string }
  | { k: "po"; id: string };

const EMPTY_HINT = "Press New quote to make your first one.";

/* ================================================================== */
/* 6. The page                                                         */
/* ================================================================== */

export default function QuotesPreview() {
  return <ToastProvider><Inner /></ToastProvider>;
}

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [view, setViewState] = useState<ViewMode>("cards");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<string[]>([]);
  const [hidden, setHidden] = useState<ColumnKey[]>([]);
  const [dlg, setDlgState] = useState<Dlg | null>(null);
  /** The quote's own sheet stays open underneath the confirmations, as the real page's does. */
  const [viewId, setViewId] = useState<string | null>(null);
  const setDlg = useCallback((d: Dlg | null) => { setDlgState(d); if (d) toast.clear(); if (d?.k === "builder") setViewId(null); }, [toast]);
  const [reloadTimer, setReloadTimer] = useState<number | null>(null);
  const wide = useMedia("(min-width: 1024px)", true);
  const notPhone = useMedia("(min-width: 768px)", true);

  useEffect(() => {
    try { const v = window.localStorage.getItem(VIEW_KEY); if (v === "cards" || v === "list" || v === "table") setViewState(v); } catch { /* storage unavailable: Cards stays */ }
  }, []);
  useEffect(() => () => { if (reloadTimer) window.clearTimeout(reloadTimer); }, [reloadTimer]);
  const setView = (v: ViewMode) => { setViewState(v); try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };
  const shownView: ViewMode = wide ? view : "cards";

  const rows = useMemo(() => quoteRows(), []);
  const byId = useMemo(() => new Map(rows.map((q) => [q.id, q])), [rows]);
  const loaded = screen === "ready";
  const data = useMemo(() => (screen === "ready" ? rows : []), [screen, rows]);
  const visible = useMemo(() => visibleQuotes(data, filters), [data, filters]);
  const groups = useMemo(() => groupsOf(visible), [visible]);
  const figures = useMemo(() => figuresOf(data), [data]);
  const counts = useMemo(() => phaseCounts(data), [data]);
  const legend = useMemo(() => legendOf(data, filters), [data, filters]);
  const scopeTotal = STATUS_ORDER.reduce((n, k) => n + legend.counts[k], 0);
  const inView = (c: ColumnKey) => !hidden.includes(c);
  const nSel = selected.length;
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);

  const resetAll = () => { setScreen("ready"); setFilters(DEFAULT_FILTERS); setSelected([]); setHidden([]); setDlg(null); setViewId(null); toast.clear(); };
  const pickScreen = (v: Screen | ListFilterKey) => {
    toast.clear(); setSelected([]);
    if (v === "expired" || v === "no-decision") { setScreen("ready"); setFilters({ ...DEFAULT_FILTERS, listFilter: v }); return; }
    setFilters((f) => ({ ...f, listFilter: null })); setScreen(v);
  };
  const retry = () => {
    setScreen("loading");
    const t = window.setTimeout(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample quotes shown again. No server was contacted." }); }, 700);
    setReloadTimer(t);
  };
  const toggleStatus = (value: string) => setFilters((f) => {
    const next = new Set(f.statuses);
    if (value === "all") { next.clear(); next.add("all"); } else { next.delete("all"); if (next.has(value)) next.delete(value); else next.add(value); if (next.size === 0) next.add("all"); }
    return { ...f, statuses: next };
  });
  const toggleSel = (ref: string) => setSelected((c) => (c.includes(ref) ? c.filter((r) => r !== ref) : [...c, ref]));

  /* ---------- row actions: every one is a preview ---------- */
  const askToSend = (q: QuoteRow, expiryConfirmed = false) => {
    if (!expiryConfirmed && expiredMessage(q, "send")) { setDlg({ k: "expired", id: q.id, action: "send" }); return; }
    setDlg({ k: "send", id: q.id });
  };
  const askToAccept = (q: QuoteRow, expiryConfirmed = false) => {
    if (!expiryConfirmed && expiredMessage(q, "accept")) { setDlg({ k: "expired", id: q.id, action: "accept" }); return; }
    setDlg({ k: "decision", id: q.id, outcome: "accepted" });
  };
  const exportAs = (fmt: string) => {
    preview(`The ${fmt} export would cover ${nSel ? `the ${nSel} selected quote${nSel === 1 ? "" : "s"}` : `all ${visible.length} quote${visible.length === 1 ? "" : "s"} in the current filter`}. No file was downloaded.`);
  };

  const denied = !canUseQuotes(role);
  const sel = nSel > 0;

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="quotes-preview" data-role={role} data-pview={shownView}>
      <header className={s.head}>
        <div className={s.titleBlock}>
          <div className={s.titleLine}>
            <h1 className={s.title}>Quote Generator</h1>
            <span className={s.previewTag} title="Everything on this screen is fictional sample data. Nothing is read from or saved to your account.">Preview, sample data, nothing is saved</span>
            <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
              <div className={s.dock}>
                <p className={s.dockNote}>Not part of Tolra. Sample data; states are simulated and no request is made.</p>
                <p className={s.dockLabel}>Role</p>
                <Segmented label="Role" value={role} options={ROLES} onChange={(v) => { setRole(v); toast.clear(); }} />
                <p className={s.dockLabel}>Screen state</p>
                <div className={s.dockStates} role="group" aria-label="Screen state">
                  {SCREENS.map((x) => {
                    const cur = filters.listFilter ?? screen;
                    return <button key={x.v} type="button" aria-pressed={cur === x.v} className={s.dockBtn} onClick={() => pickScreen(x.v)}>{x.label}</button>;
                  })}
                </div>
                <Button size="sm" variant="secondary" onClick={resetAll}>Reset preview</Button>
              </div>
            </Popover>
          </div>
          <p className={s.subtitle}>A quote is the price we offer a customer. Make, send and follow up quotes here.</p>
        </div>
        {denied ? null : (
          <div className={s.headControls}>
            <Popover label="Columns" title="Quotes columns" size="md" data-testid="columns-trigger">
              <p className={s.colScope}>Changes apply to everyone in this company. In this preview they change this screen only.</p>
              {COLUMNS.map((c) => (c.locked ? (
                <p key={c.key} className={s.colLocked} data-testid={`col-${c.key}`}><span>{c.label}</span><span>Always shown</span></p>
              ) : (
                <Switch key={c.key} label={c.label} checked={inView(c.key)}
                  onChange={(on) => setHidden((h) => (on ? h.filter((k) => k !== c.key) : [...h, c.key]))} data-testid={`col-${c.key}`} />
              )))}
              <div className={s.colReset}><Button size="sm" variant="secondary" disabled={!hidden.length} onClick={() => setHidden([])}>Reset to default (show all columns)</Button></div>
            </Popover>
            {notPhone ? (
              <Segmented label="View" value={shownView} onChange={setView} options={[
                { v: "cards", label: "Cards", testId: "view-cards-btn" },
                { v: "list", label: "List", off: wide ? undefined : "Needs a screen wider than 1024px", testId: "view-list-btn" },
                { v: "table", label: "Table", off: wide ? undefined : "Needs a screen wider than 1024px", testId: "view-table-btn" },
              ]} />
            ) : null}
            <Button variant="primary" data-testid="new-quote" onClick={() => setDlg({ k: "builder", mode: "new" })}>New quote</Button>
          </div>
        )}
      </header>

      {denied ? (
        <section className={s.denied} data-testid="access-denied">
          <h2 className={s.deniedTitle}>Access Denied</h2>
          <p className={s.deniedText}>Redirecting you back to the dashboard.</p>
          <p className={s.deniedNote}>Preview only: no redirect happens here. The real Quote Generator is for Admin and Office; Workshop and Viewer cannot open it.</p>
        </section>
      ) : (
        <>
          <div className={s.tiles} role="group" aria-label="Quote figures">
            {([
              ["Open Quotes", String(figures.open.count), `${gbp(figures.open.value)} awaiting reply`, "sent", "info"],
              ["Drafts", String(figures.drafts.count), `${gbp(figures.drafts.value)} not yet sent`, "draft", "neutral"],
              ["Accepted Quotes", String(figures.accepted.count), `${gbp(figures.accepted.value)} won`, "accepted", "ok"],
              ["Win Rate", figures.winRate === null ? "-" : `${figures.winRate}%`, "Accepted of sent quotes decided or expired", "accepted", "ok"],
            ] as const).map(([label, value, sub, status, tone]) => {
              const active = filters.statuses.size === 1 && filters.statuses.has(status) && !filters.listFilter;
              const waiting = screen === "loading" || screen === "error";
              return (
                <button key={label} type="button" aria-pressed={active} disabled={waiting} className={s.tile} data-testid={`tile-${label.split(" ")[0].toLowerCase()}`}
                  onClick={() => setFilters((f) => ({ ...f, statuses: new Set([status]) }))}>
                  <span className={s.tileLabel}><i className={cx(s.tileDot, s[`dot_${tone}`])} aria-hidden="true" />{label}</span>
                  <span className={cx(s.tileValue, tabularNumbers)}>{waiting ? "—" : value}</span>
                  <span className={s.tileSub}>{waiting ? " " : sub}</span>
                </button>
              );
            })}
          </div>

          {scopeTotal && loaded ? (
            <div className={s.legendWrap} data-testid="legend">
              <div className={s.statusBar} role="img" aria-label="Quotes by status">
                {STATUS_ORDER.filter((k) => legend.counts[k]).map((k) => <span key={k} title={`${STATUS_LABEL[k]}: ${legend.counts[k]}`} className={cx(s.barSeg, s[`seg_${k}`])} style={{ flexGrow: legend.counts[k] }} />)}
              </div>
              <p className={s.legend}>
                <b>{legend.scope}{!filters.listFilter && filters.phase === "open" ? " (expired quotes are under Done)" : ""}:</b>
                {STATUS_ORDER.map((k) => <span key={k} className={s.legendItem}><i className={cx(s.legendDot, s[`seg_${k}`])} aria-hidden="true" />{STATUS_LABEL[k]} <span className={tabularNumbers}>({legend.counts[k]})</span></span>)}
              </p>
            </div>
          ) : null}

          <section className={s.panel} aria-label="Filters" aria-busy={screen === "loading" || undefined}>
            {filters.listFilter ? (
              <div className={s.notice} role="status" data-testid="list-filter-notice">
                <p>Showing only: <strong>{QUOTE_FILTER_LABELS[filters.listFilter]}</strong></p>
                <Button size="sm" variant="secondary" onClick={() => { setFilters((f) => ({ ...f, listFilter: null })); }}>Show everything</Button>
              </div>
            ) : null}
            <div className={s.panelRow}>
              <span className={s.panelLabel}>Show</span>
              <Segmented label="Show" value={filters.phase} disabled={!loaded && screen !== "empty"} onChange={(v) => setFilters((f) => ({ ...f, phase: v }))} options={[
                { v: "open", label: `Open (${counts.open})`, testId: "show-open" }, { v: "done", label: `Done (${counts.done})`, testId: "show-done" },
                { v: "archived", label: `Archived (${counts.archived})`, testId: "show-archived" }, { v: "all", label: "All", testId: "show-all" },
              ]} />
            </div>
            <div className={s.panelRow}>
              <span className={s.panelLabel}>Filters</span>
              <ChipGroup label="Filters">
                {[["all", "All"], ["draft", "Draft"], ["sent", "Sent"], ["accepted", "Accepted"], ["rejected", "Rejected"], ["expired", "Expired"], ["superseded", "Superseded"]].map(([v, label]) => (
                  <FilterChip key={v} selected={filters.statuses.has(v)} disabled={screen === "loading"} onToggle={() => toggleStatus(v)} data-testid={`chip-${v}`}>{label}</FilterChip>
                ))}
              </ChipGroup>
            </div>
          </section>

          <SelectionBar count={nSel} filteredTotal={visible.length} noun="quote" onSelectAll={() => setSelected(visible.map((q) => q.ref))} onClear={() => setSelected([])}
            idleNote={`0 selected of ${visible.length} filtered ${visible.length === 1 ? "record" : "records"}. Export covers all ${visible.length}.`}>
            {sel ? null : <Button size="sm" variant="secondary" disabled={!visible.length} data-testid="select-all" onClick={() => setSelected(visible.map((q) => q.ref))}>Select all {visible.length} filtered</Button>}
            {sel ? null : <Button size="sm" variant="secondary" disabled data-testid="clear-selection">Clear selection</Button>}
            <Menu label="Export" size="sm" variant="secondary" data-testid="export-trigger" items={["CSV", "Excel", "Word", "PDF"].map((f) => ({ id: f, label: f, onSelect: () => exportAs(f) }))} />
          </SelectionBar>

          {/* The shared state panels use an h3: this keeps the heading order h1, h2, h3 on every screen state. */}
          <h2 className={s.srOnly}>Quotes</h2>
          {screen === "loading" ? <LoadingState label="Loading quotes" rows={6} />
            : screen === "error" ? <FailedState title="Couldn’t load quotes." detail="The list could not be fetched. This is a simulated failure: no request was made and nothing was lost." onRetry={retry} retryLabel="Retry" />
            : visible.length === 0 ? (
              <EmptyState title={data.length ? "No quotes match this filter" : "No quotes yet"} detail={data.length ? "Try a different filter." : EMPTY_HINT}
                action={data.length ? <Button variant="secondary" onClick={() => setFilters((f) => ({ ...f, statuses: new Set(["all"]), phase: f.phase }))}>Show all</Button> : <Button variant="primary" onClick={() => setDlg({ k: "builder", mode: "new" })}>New quote</Button>} />
            ) : shownView === "cards" ? (
              <div className={s.groups} data-testid="view-cards">
                {groups.map((g) => (
                  <section key={g.status} aria-label={`${STATUS_LABEL[g.status]} quotes`}>
                    <h2 className={s.groupHead}><i className={cx(s.legendDot, s[`seg_${g.status}`])} aria-hidden="true" />{GROUP_HEAD[g.status]} <span className={tabularNumbers}>({g.items.length})</span></h2>
                    <div className={s.cards}>
                      {g.items.map((q) => (
                        <QuoteCard key={q.id} q={q} selected={selected.includes(q.ref)} inView={inView} onSelect={() => toggleSel(q.ref)}
                          onView={() => setViewId(q.id)} onSend={() => askToSend(q)}
                          onPdf={() => preview(`The PDF for ${q.ref} is not generated.`)} onArchive={() => preview(`${q.ref} would be ${phaseOf(q) === "archived" ? "moved out of the archive" : "archived"}.`)} />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <ScrollTable label="Quotes">
                <thead>
                  <tr>
                    <th className={s.thFirst}>
                      <span className={s.firstCell}>
                        <Checkbox aria-label={`Select all ${visible.length} filtered quotes`} checked={visible.length > 0 && visible.every((q) => selected.includes(q.ref))} onChange={(e) => setSelected(e.target.checked ? visible.map((q) => q.ref) : [])} />
                        Quote
                      </span>
                    </th>
                    {inView("date") ? <th>Date</th> : null}
                    {inView("customer") ? <th>Customer</th> : null}
                    {inView("description") ? <th>Description</th> : null}
                    {inView("status") ? <th>Status</th> : null}
                    {inView("value") ? <th className={s.right}>Value</th> : null}
                    {inView("valid") ? <th>Valid until</th> : null}
                    <th className={s.right}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((q) => (
                    <tr key={q.id} data-quote={q.ref} data-selected={selected.includes(q.ref) || undefined}>
                      <td className={s.tdFirst}>
                        <span className={s.firstCell}>
                          <Checkbox aria-label={`Select ${q.ref}`} data-testid="select-row" checked={selected.includes(q.ref)} onChange={() => toggleSel(q.ref)} />
                          <span className={s.refCell}><span className={cx(s.ref, tabularNumbers)}>{q.ref}</span>{q.customerPo ? <span className={s.po} data-testid="quote-customer-po">{customerPoBeside(q.customerPo)}</span> : null}</span>
                        </span>
                      </td>
                      {inView("date") ? <td className={cx(s.nowrap, tabularNumbers)}>{fmtDate(q.date)}</td> : null}
                      {inView("customer") ? <td><span className={s.clamp} title={q.customer}>{q.customer}</span></td> : null}
                      {inView("description") ? <td><span className={cx(s.clamp, s.desc)}>{q.description}</span></td> : null}
                      {inView("status") ? <td><StatusPill status={q.status} /></td> : null}
                      {inView("value") ? <td className={cx(s.right, s.money, tabularNumbers)}>{gbp(q.value)}</td> : null}
                      {inView("valid") ? <td className={cx(s.nowrap, tabularNumbers)}>{q.validUntil ? fmtDate(q.validUntil) : "—"}</td> : null}
                      <td className={s.right}>
                        <div className={s.rowActions}>
                          <Button size="sm" variant="secondary" aria-label={`View ${q.ref}`} data-action="View" onClick={() => setViewId(q.id)}>View</Button>
                          {canOfferSend(q.rawStatus) ? <Button size="sm" variant={q.rawStatus === "draft" ? "primary" : "quiet"} data-action="Send" aria-label={`${q.rawStatus === "draft" ? "Send" : "Resend"} ${q.ref} to the customer`} onClick={() => askToSend(q)}>{q.rawStatus === "draft" ? "Send" : "Resend"}</Button> : null}
                          <Button size="sm" variant="quiet" aria-label={`Download ${q.ref} as PDF`} data-action="PDF" onClick={() => preview(`The PDF for ${q.ref} is not generated.`)}>PDF</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>
            )}
        </>
      )}

      <Dialogs dlg={dlg} viewId={viewId} setViewId={setViewId} close={() => setDlg(null)} setDlg={setDlg} byId={byId} preview={preview} askToSend={askToSend} askToAccept={askToAccept} />
    </div>
  );
}

/* ---------------- card ---------------- */

function QuoteCard({ q, selected, inView, onSelect, onView, onSend, onPdf, onArchive }: {
  q: QuoteRow; selected: boolean; inView: (c: ColumnKey) => boolean; onSelect: () => void; onView: () => void; onSend: () => void; onPdf: () => void; onArchive: () => void;
}) {
  const passed = q.rawStatus === "draft" && q.validUntil && q.validUntil < TODAY;
  return (
    <article className={s.card} data-quote={q.ref} data-selected={selected || undefined} aria-label={q.ref}>
      <div className={s.cardTop}>
        <Checkbox aria-label={`Select ${q.ref} for export`} title="Select for export" data-testid="select-row" checked={selected} onChange={onSelect} />
        <div className={s.cardRef}><span className={cx(s.ref, tabularNumbers)}>{q.ref}</span>{q.customerPo ? <span className={s.po} data-testid="quote-customer-po">{customerPoBeside(q.customerPo)}</span> : null}</div>
        {inView("status") ? <StatusPill status={q.status} /> : null}
      </div>
      <dl className={s.dl}>
        {inView("customer") ? <div className={s.dlWide}><dt>Customer</dt><dd className={s.dlStrong}>{q.customer}</dd></div> : null}
        {inView("description") ? <div className={s.dlWide}><dt>Description</dt><dd className={cx(s.desc, s.clamp3)} data-testid="quote-card-description">{q.description || "—"}</dd></div> : null}
        {inView("date") ? <div><dt>Date</dt><dd className={tabularNumbers}>{q.date ? fmtDate(q.date) : "—"}</dd></div> : null}
        {inView("valid") ? <div><dt>Valid until</dt><dd className={tabularNumbers}>{q.validUntil ? fmtDate(q.validUntil) : "No expiry date"}</dd></div> : null}
        {inView("value") ? <div className={s.dlValue}><dt>Value</dt><dd className={cx(s.cardValue, tabularNumbers)}>{gbp(q.value)}</dd></div> : null}
      </dl>
      {passed ? <p className={s.passed}>Date has passed: edit before sending</p> : null}
      <div className={s.cardActions}>
        <Button size="sm" variant="secondary" data-action="View" aria-label={`View ${q.ref}`} onClick={onView}>View</Button>
        {canOfferSend(q.rawStatus) ? <Button size="sm" variant={q.rawStatus === "draft" ? "primary" : "quiet"} data-action="Send" aria-label={`${q.rawStatus === "draft" ? "Send" : "Resend"} ${q.ref} to the customer`} onClick={onSend}>{q.rawStatus === "draft" ? "Send" : "Resend"}</Button> : null}
        <span className={s.cardQuiet}>
        <Button size="sm" variant="quiet" data-action="PDF" aria-label={`Download ${q.ref} as PDF`} onClick={onPdf}>PDF</Button>
        <Button size="sm" variant="quiet" data-action="Archive" aria-label={`${phaseOf(q) === "archived" ? "Unarchive" : "Archive"} ${q.ref}`} onClick={onArchive}>{phaseOf(q) === "archived" ? "Unarchive" : "Archive"}</Button>
        </span>
      </div>
    </article>
  );
}

/* ================================================================== */
/* 7. Dialogs (the real confirmations, none of them saves anything)    */
/* ================================================================== */

type DialogsProps = {
  dlg: Dlg | null; viewId: string | null; setViewId: (id: string | null) => void; close: () => void; setDlg: (d: Dlg | null) => void; byId: Map<string, QuoteRow>; preview: (detail: string) => void;
  askToSend: (q: QuoteRow, expiryConfirmed?: boolean) => void; askToAccept: (q: QuoteRow, expiryConfirmed?: boolean) => void;
};

function Dialogs({ dlg, viewId, setViewId, close, setDlg, byId, preview, askToSend, askToAccept }: DialogsProps) {
  const q = dlg && "id" in dlg && dlg.id ? byId.get(dlg.id) ?? null : null;
  const vq = viewId ? byId.get(viewId) ?? null : null;
  const [po, setPo] = useState("");
  const [due, setDue] = useState("");
  const [unticked, setUnticked] = useState<Set<number>>(new Set());
  useEffect(() => { setPo(dlg?.k === "po" ? q?.customerPo ?? "" : ""); setDue(""); setUnticked(new Set()); }, [dlg?.k, q?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const versions = vq ? Array.from(byId.values()).filter((x) => x.ref.split(" v")[0] === vq.ref.split(" v")[0]).sort((a, b) => a.version - b.version) : [];
  const replacedBy = vq ? Array.from(byId.values()).find((x) => x.previousVersionId === vq.id) ?? null : null;

  // A toast sits under an open modal (the dialog element is above everything), so a finished action closes the quote's sheet too, as the real page does.
  const finish = (detail: string) => { close(); setViewId(null); preview(detail); };

  // The ticked lines on Confirm Accepted (068): only ticked lines go on the order.
  const lines = q?.lines ?? [];
  const tickedLines = lines.filter((_, i) => !unticked.has(i));
  const tickedSubtotal = totalsOf(tickedLines, false).subtotal;
  const acceptedBlock = dlg?.k === "decision" && dlg.outcome === "accepted" && q ? acceptBlock(q.value, lines.length, tickedSubtotal) : null;

  return (
    <>
      {vq ? <ViewSheet q={vq} versions={versions} replacedBy={replacedBy} onClose={() => setViewId(null)} setDlg={setDlg} setViewId={setViewId} preview={preview} askToSend={askToSend} askToAccept={askToAccept} /> : null}
      {dlg?.k === "builder" ? <BuilderSheet mode={dlg.mode} q={q} onClose={close} preview={preview} /> : null}

      <Sheet open={dlg?.k === "send" && !!q} size="sm" closeButton={false} onClose={close} testId="dlg-send"
        title={q && dlg?.k === "send" ? `Send ${q.ref} to ${CUSTOMER_EMAIL[q.customer] ?? q.customer}?` : ""}
        description={q && dlg?.k === "send" ? `${CUSTOMER_EMAIL[q.customer] ? "Yes, send: your e-mail app opens addressed to them and the PDF downloads to attach." : `No e-mail address on file for ${q.customer}: your e-mail app opens for you to add one, and the PDF downloads to attach.`} Email it now: sent from here with the PDF attached.${q.validUntil ? "" : ` It has no valid-until date, so it will be valid until ${fmtDate(addDays(TODAY, 30))}.`}` : undefined}
        footer={q ? (<>
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button variant="secondary" onClick={() => finish(`${q.ref} would be e-mailed with the PDF attached. No e-mail was sent.`)}>Email it now</Button>
          <Button variant="primary" onClick={() => setDlg({ k: "sendConfirm", id: q.id })}>Yes, send</Button>
        </>) : null}>
        <p className={s.sheetNote}>Preview only. Your e-mail app and the PDF download are not opened, nothing is e-mailed and the quote keeps its status.</p>
      </Sheet>

      <Dialog open={dlg?.k === "sendConfirm" && !!q} onClose={close} onConfirm={() => finish(`${q?.ref} would be recorded as sent.`)} cancelLabel="Not yet" confirmLabel={"I’ve sent it"}
        title={q ? `Has ${q.ref} gone to the customer?` : ""}
        description={q?.rawStatus === "draft" ? "Attach the PDF and send the email first. Recording it as sent fixes the quote: it can't be edited afterwards." : "Attach the PDF and send the email first, then record it here."} />

      <Dialog open={dlg?.k === "expired" && !!q} onClose={close} confirmLabel={dlg?.k === "expired" && dlg.action === "accept" ? "Mark accepted" : "Send"}
        title={q ? `${q.ref} has expired` : ""} description={q && dlg?.k === "expired" ? expiredMessage(q, dlg.action) ?? "" : ""}
        onConfirm={() => { if (q && dlg?.k === "expired") { if (dlg.action === "send") askToSend(q, true); else askToAccept(q, true); } }} />

      <Dialog open={dlg?.k === "revise" && !!q} onClose={close} confirmLabel="Revise" onConfirm={() => finish(`${q?.ref} would be revised as v${(q?.version ?? 1) + 1}.`)}
        title={q ? `Revise ${q.ref} as v${q.version + 1}?` : ""}
        description={q ? `A new draft is made from it with the same quote number and the next version. ${q.ref} is kept as it was sent, read only, and can no longer be accepted: only the latest version can. Change the draft, then send it.` : ""} />

      <Dialog open={dlg?.k === "po" && !!q} onClose={close} confirmLabel="Save customer PO" confirmDisabled={!po.trim() && q?.rawStatus !== "draft"}
        title={q ? `${q.customerPo ? "Change" : "Add"} the customer PO on ${q.ref}` : ""}
        description="The customer's order number, shown beside the quote number. If the quote is accepted, its job (until it is finished) and its draft invoice get it too; an invoice already issued keeps the PO it was issued with."
        onConfirm={() => finish(`The customer PO on ${q?.ref} would be ${po.trim() ? `set to ${po.trim()}` : "cleared"}.`)}>
        <Field label="Customer PO"><input className={s.input} aria-label="Customer PO" placeholder="Customer order number (their PO)" maxLength={100} value={po} onChange={(e) => setPo(e.target.value)} /></Field>
      </Dialog>

      <Dialog open={dlg?.k === "decision" && !!q} onClose={close} confirmLabel={dlg?.k === "decision" && dlg.outcome === "accepted" ? "Confirm Accepted" : "Confirm Rejected"} confirmDisabled={!!acceptedBlock}
        title={q && dlg?.k === "decision" ? `Mark ${q.ref} as ${dlg.outcome}?` : ""}
        description={dlg?.k === "decision" ? (dlg.outcome === "accepted" ? "Record that the customer accepted this quote. Its job is made now if your company makes jobs automatically. This can't be undone." : "Record that the customer turned this quote down. This can't be undone.") : ""}
        onConfirm={() => { if (q && dlg?.k === "decision") finish(`${q.ref} would be marked ${dlg.outcome}.`); }}>
        {dlg?.k === "decision" && dlg.outcome === "accepted" && q ? (
          <div className={s.form}>
            <Field label="Customer PO (optional)" hint="Not received yet? Leave it empty and add it on the quote when it arrives: it reaches the job and its draft invoice too.">
              <input className={s.input} value={po} maxLength={100} placeholder="Customer order number (their PO)" onChange={(e) => setPo(e.target.value)} />
            </Field>
            <Field label="Due date (optional)" hint="When the customer wants it by. It becomes the job's due date.">
              <input className={s.input} type="date" aria-label="Due date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
            {lines.length > 1 ? (
              <fieldset className={s.ticks} data-testid="accept-lines">
                <legend>Lines the customer ordered. Untick any their PO doesn&apos;t cover: only ticked lines go on the sales order, job and invoice.</legend>
                {lines.map((l, i) => (
                  <label key={i} className={s.tick}>
                    <Checkbox aria-label={`Ordered: ${l.description}`} checked={!unticked.has(i)} onChange={(e) => setUnticked((c) => { const n = new Set(c); if (e.target.checked) n.delete(i); else n.add(i); return n; })} />
                    <span className={s.tickText}><span>{l.description}</span>{lineReference(l) ? <small>{lineReference(l)}</small> : null}</span>
                    <span className={tabularNumbers}>{gbp(totalsOf([l], false).subtotal)}</span>
                  </label>
                ))}
                <p className={cx(s.tickTotal, tabularNumbers)} data-testid="accept-lines-total">Ordered: {gbp(tickedSubtotal)} ex VAT{unticked.size ? ` (${lines.length - unticked.size} of ${lines.length} lines)` : ""}</p>
              </fieldset>
            ) : null}
            {acceptedBlock ? <p role="alert" className={s.blockMsg}>{acceptedBlock}</p> : null}
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

/* ---------------- the quote's own sheet ---------------- */

function ViewSheet({ q, versions, replacedBy, onClose, setDlg, setViewId, preview, askToSend, askToAccept }: {
  q: QuoteRow; versions: QuoteRow[]; replacedBy: QuoteRow | null; onClose: () => void; setDlg: (d: Dlg | null) => void; setViewId: (id: string | null) => void; preview: (d: string) => void;
  askToSend: (q: QuoteRow) => void; askToAccept: (q: QuoteRow) => void;
}) {
  const totals = totalsOf(q.lines, q.vatEnabled);
  const block = acceptBlock(q.value);
  const [note, setNote] = useState("");
  useEffect(() => setNote(""), [q.id]);
  return (
    <Sheet open size="lg" onClose={onClose} testId="dlg-view" title={<><span className={tabularNumbers}>{q.ref}</span> quote details</>} description="Quote details, with the price of each item."
      footer={(
        <div className={s.viewFoot} data-testid="quote-actions">
          <div className={s.footGroup}>
            {q.rawStatus === "draft" ? <Button variant="secondary" onClick={() => setDlg({ k: "builder", mode: "edit", id: q.id })}>Edit Draft</Button> : null}
            <Button variant="secondary" onClick={() => setDlg({ k: "builder", mode: "copy", id: q.id })}>Copy</Button>
            {q.rawStatus === "sent" && !replacedBy ? <Button variant="secondary" onClick={() => setDlg({ k: "revise", id: q.id })}>Revise (v{q.version + 1})</Button> : null}
          </div>
          <div className={s.footGroup}>
            {canRecordDecision(q.rawStatus) && !replacedBy ? (<>
              <Button variant="secondary" onClick={() => setDlg({ k: "decision", id: q.id, outcome: "rejected" })}>Mark Rejected</Button>
              <Button variant="secondary" disabled={Boolean(block)} title={block ?? undefined} aria-describedby={block ? "accept-block-reason" : undefined} onClick={() => askToAccept(q)}>Mark Accepted</Button>
              {block ? <span id="accept-block-reason" className={s.srOnly}>{block}</span> : null}
            </>) : null}
            <Button variant="secondary" onClick={() => setNote(`Preview only. The PDF for ${q.ref} is not generated. Nothing was saved.`)}>Download PDF</Button>
            {canOfferSend(q.rawStatus) ? <Button variant="primary" onClick={() => askToSend(q)}>Send to Customer</Button> : null}
          </div>
        </div>
      )}>
      <div className={s.facts}>
        <div><span className={s.factLabel}>Customer</span><p className={s.factStrong}>{q.customer}</p></div>
        <div><span className={s.factLabel}>Status</span><p><StatusPill status={q.status} /></p></div>
        <div><span className={s.factLabel}>Quote Ref</span><p className={cx(s.factStrong, tabularNumbers)}>{q.ref}</p></div>
        <div data-testid="quote-detail-customer-po"><span className={s.factLabel}>Customer PO</span>
          <p className={s.factPo}><span className={cx(s.factStrong, tabularNumbers)}>{q.customerPo || "Not received yet"}</span>
            {(q.rawStatus !== "rejected" && q.rawStatus !== "superseded") ? <Button size="sm" variant="secondary" onClick={() => setDlg({ k: "po", id: q.id })}>{q.customerPo ? "Change customer PO" : "Add customer PO"}</Button> : null}</p></div>
        <div><span className={s.factLabel}>Valid Until</span><p className={cx(s.factStrong, tabularNumbers)}>{q.validUntil ? fmtDate(q.validUntil) : "-"}</p></div>
        {q.description.trim() ? <div className={s.factWide} data-testid="quote-description"><span className={s.factLabel}>Description</span><p>{q.description}</p></div> : null}
      </div>
      {q.rawStatus === "superseded" ? (
        <div role="status" className={s.callout} data-testid="quote-superseded">
          <span>Replaced by {replacedBy?.ref ?? "a newer version"}. This version is kept as it was sent, read only.</span>
          {replacedBy ? <Button size="sm" variant="secondary" onClick={() => setViewId(replacedBy.id)}>View {replacedBy.ref}</Button> : null}
        </div>
      ) : null}
      {versions.length > 1 ? (
        <div className={s.versions} data-testid="quote-versions"><span className={s.factLabel}>Versions</span>
          {versions.map((v) => <Button key={v.id} size="sm" variant={v.id === q.id ? "primary" : "secondary"} disabled={v.id === q.id} onClick={() => setViewId(v.id)}>v{v.version} ({v.status})</Button>)}
        </div>
      ) : null}
      <div className={s.lines} data-testid="quote-lines">
        <div className={cx(s.lineRow, s.lineHead)}><span>Description</span><span className={s.right}>Qty</span><span className={s.right}>Unit Price</span><span className={s.right}>Total</span></div>
        {q.lines.map((l, i) => (
          <div key={i} className={cx(s.lineRow, l.declined && s.lineOff)} data-testid="quote-line">
            <span><span className={l.declined ? s.struck : undefined}>{l.description}</span>{lineReference(l) ? <small className={s.lineRef}>{lineReference(l)}</small> : null}{l.declined ? <em className={s.notOrdered}>Not ordered</em> : null}</span>
            <span className={cx(s.right, tabularNumbers)}>{l.quantity}</span><span className={cx(s.right, tabularNumbers)}>{gbp(l.unitPrice)}</span><span className={cx(s.right, tabularNumbers)}>{gbp(totalsOf([l], false).subtotal)}</span>
          </div>
        ))}
      </div>
      <dl className={cx(s.totals, tabularNumbers)}>
        <div><dt>Subtotal</dt><dd>{gbp(totals.subtotal)}</dd></div>
        {q.vatEnabled ? <div><dt>VAT 20%</dt><dd>{gbp(totals.vat)}</dd></div> : null}
        <div className={s.totalRow}><dt>Total</dt><dd>{gbp(totals.total)}</dd></div>
      </dl>
      <p className={s.sheetNote}>Attachments, linked e-mails, the bought-in profit panel and the activity history are not part of this preview.</p>
      <p role="status" aria-live="polite" className={cx(s.sheetNote, s.sheetStatus)} data-testid="sheet-status">{note}</p>
    </Sheet>
  );
}

/* ---------------- builder ---------------- */

type BuilderLine = { description: string; qty: number; unit: number; vat: "20" | "5" | "0" | "exempt" };

function BuilderSheet({ mode, q, onClose, preview }: { mode: "new" | "edit" | "copy"; q: QuoteRow | null; onClose: () => void; preview: (d: string) => void }) {
  const [customer, setCustomer] = useState(q?.customer ?? "");
  const [lines, setLines] = useState<BuilderLine[]>(() => (q ? q.lines.map((l) => ({ description: l.description, qty: l.quantity, unit: l.unitPrice, vat: "20" as const })) : [{ description: "", qty: 1, unit: 0, vat: "20" as const }]));
  const [vatOn, setVatOn] = useState(q?.vatEnabled ?? true);
  const sub = lines.reduce((n, l) => n + Math.round(l.qty * l.unit * 100), 0) / 100;
  const vatAmt = vatOn ? lines.reduce((n, l) => n + (l.vat === "exempt" ? 0 : Math.round((Math.round(l.qty * l.unit * 100) * Number(l.vat)) / 100)), 0) / 100 : 0;
  const title = mode === "edit" && q ? `Correct draft ${q.ref}` : mode === "copy" && q ? `Copy of ${q.ref}` : "Quote Builder";
  const setLine = (i: number, patch: Partial<BuilderLine>) => setLines((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Sheet open size="lg" onClose={onClose} testId="dlg-builder" title={title}
      description={mode === "edit" ? "Change the draft and save. It keeps its number." : mode === "copy" ? "A new quote with a new number, starting from this one." : "Add the items, prices and VAT for this quote."}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => { onClose(); preview(`${mode === "edit" ? "The correction" : "The quote"} would be saved.`); }}>{mode === "edit" ? "Save Correction" : "Save Quote"}</Button></>}>
      <div className={s.form}>
        <div className={s.formGrid}>
          <Field label="Customer"><select className={s.input} value={customer} onChange={(e) => setCustomer(e.target.value)} aria-label="Customer"><option value="">Choose a customer</option>{Object.keys(CUSTOMER_EMAIL).map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Valid until"><input className={s.input} type="date" defaultValue={mode === "edit" ? q?.validUntil : ""} aria-label="Valid until" /></Field>
          <Field label="Terms"><input className={s.input} maxLength={200} placeholder="Valid for 30 days" defaultValue="" aria-label="Terms" /></Field>
          <Field label="Customer PO (optional)"><input className={s.input} maxLength={100} placeholder="Customer order number (their PO)" defaultValue={mode === "edit" ? q?.customerPo : ""} aria-label="Customer PO" /></Field>
        </div>
        <Field label="Quote description" wide><textarea className={cx(s.input, s.area)} maxLength={2000} placeholder="Quote description" defaultValue={q?.description ?? ""} /></Field>
        <div className={s.bLines}>
          <div className={cx(s.bRow, s.bHead)}><span>Description</span><span>Qty</span><span>Unit price</span><span>VAT</span><span className={s.right}>Line total</span><span /></div>
          {lines.map((l, i) => (
            <div key={i} className={s.bRow}>
              <input className={s.input} aria-label="Description" maxLength={500} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
              <input className={s.input} aria-label="Quantity" type="number" min="0" step="0.001" inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} />
              <input className={s.input} aria-label="Unit price" type="number" min="0" step="0.01" inputMode="decimal" value={l.unit} onChange={(e) => setLine(i, { unit: Number(e.target.value) })} />
              <select className={s.input} aria-label="VAT rate" disabled={!vatOn} value={l.vat} onChange={(e) => setLine(i, { vat: e.target.value as BuilderLine["vat"] })}><option value="20">20%</option><option value="5">5%</option><option value="0">0%</option><option value="exempt">Exempt</option></select>
              <span className={cx(s.bTotal, tabularNumbers)}>{gbp(Math.round(l.qty * l.unit * 100) / 100)}</span>
              <Button size="sm" variant="quiet" aria-label="Remove line" onClick={() => setLines((rows) => rows.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <div><Button size="sm" variant="secondary" onClick={() => setLines((rows) => [...rows, { description: "New line item", qty: 1, unit: 0, vat: "20" }])}>Add Row</Button></div>
        </div>
        <div className={s.bFoot}>
          <Switch label="Add VAT" checked={vatOn} onChange={setVatOn} />
          <dl className={cx(s.totals, tabularNumbers)}>
            <div><dt>Subtotal</dt><dd>{gbp(sub)}</dd></div>
            {vatOn ? <div><dt>VAT</dt><dd>{gbp(vatAmt)}</dd></div> : null}
            <div className={s.totalRow}><dt>Total</dt><dd>{gbp(sub + vatAmt)}</dd></div>
          </dl>
        </div>
        <Field label="Notes for customer" wide><textarea className={cx(s.input, s.area)} maxLength={2000} placeholder="Shown on the quote sent to the customer" defaultValue={q?.customerNotes ?? ""} /></Field>
        <Field label="Internal notes (not shown to customer)" wide><textarea className={cx(s.input, s.area, s.internal)} maxLength={2000} placeholder="Margins, supplier quotes, risks - for the team only" defaultValue={q?.internalNotes ?? ""} /></Field>
      </div>
    </Sheet>
  );
}
