"use client";

/**
 * BOUNDARY (Dashboard, Module 7, PREVIEW ONLY, v2 = shared UI v4 plus owner-approved structural items 6, 10 and 11: one PreviewBar, one PageHeader, ONE heading level per section (the section title is h2, every panel and group inside it the same level below), the jump links as the shared underline Tabs, "Also counted in Today" as a two-column list with right-aligned counts, the type scale). Route /dashboard/preview inside the existing dashboard shell (verified session, sidebar, top bar).
 * Inputs: none from the server. Everything shown is fictional sample data (rows for invoices, credit notes, payments, quotes, RFQs, jobs, machines,
 * bookings, machine runs, inspections, delivery notes and so on, as of Fri 20/11/2026) held in this file, plus the person's clicks. Outputs: the
 * Dashboard look-and-feel prototype for all four views (Admin Overview, Office, Workshop, Viewer) with every tile, chart, link, filter and role rule of
 * app/(dashboard)/dashboard/page.tsx. Its only state is LOCAL UI state. It never reads or writes Supabase, calls no server action, API route, e-mail,
 * accounting or AI integration, and no action reports success: a click on a tile or link answers with the neutral "Preview only ... Nothing was
 * changed." toast naming the real target (the href is the real one; Ctrl or middle click opens the real page).
 * FIGURES ARE THE REAL ONES: every number comes from the app's own pure functions (lib/dashboard-analytics, lib/overview, lib/overview-metrics,
 * lib/dashboard-tile-figures, lib/attention-items, lib/quote-status, lib/rfq-stage, lib/job-flow, lib/job-status, lib/my-jobs, lib/whole-floor,
 * lib/dashboard-tiles, lib/destinations, lib/dates, lib/money) run over the sample rows. The few lines of arithmetic that live inline in
 * loadAdminData (revenue received per month, the open-jobs and due-this-week filters, late and on-time counts) are mirrored here and pinned to the page by
 * tests/unit/dashboardPreview.test.ts. Run-time imports from lib/ are pure modules only (no Supabase client, no hooks).
 * MUST NOT CHANGE: tile set, wording, order, links (every href is the real one), the role rules (lib/destinations canOpenDestination decides whether a tile
 * is a link), the traffic lights and the money rules. Do not wire this to real data or actions, add no metric or control the real page lacks, keep
 * control hit areas at 48 px. Delete the four preview files (this component and its .module.css, app/(dashboard)/dashboard/preview/page.tsx,
 * tests/unit/dashboardPreview.test.ts) to remove it completely.
 */

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode, RefObject } from "react";
import {
  Button, PageHeader, Popover, PreviewBar, ScrollTable, SegmentedControl, StatusBadge, Switch, Tabs, ToastProvider, cx, premiumTokens, srOnly, tabularNumbers, typeScale, useToast,
} from "@/components/ui/premium";
import { buildAttention, type AttentionInput, type AttentionRole, type AttentionSection } from "@/lib/attention-items";
import { attentionState } from "@/lib/attention";
import { DASHBOARD_TILES, dashboardTileKeysFor, type DashboardRole } from "@/lib/dashboard-tiles";
import { overdueOwed as overdueFromBuckets, moneyTilesFromRows, quoteTilesFromRows } from "@/lib/dashboard-tile-figures";
import { jobsByStatus, lights, machineLoad, onTimeByMonth, rightFirstTime, workloadDue, type AgeBucket, type JobsByStatus, type Light, type MachineLoad } from "@/lib/dashboard-analytics";
import { canOpenDestination } from "@/lib/destinations";
import { dueWindow, fmtDateText, fmtDateTime, fmtDueBy, toDateInput } from "@/lib/dates";
import { hasReworkTag, stageLabel, stageOf, JOB_STATUS_BADGE, JOB_STATUS_LABELS, reworkTag } from "@/lib/job-flow";
import { DUE_CHIPS, onTimeJobCount } from "@/lib/job-status";
import { myJobAction, myJobOffersPause, myJobs, type MyJob } from "@/lib/my-jobs";
import { gbp, toPence } from "@/lib/money";
import { OVERVIEW_SECTIONS, attentionSummary, fleetLoad, floorNow, leaksFrom, otherAttention, revenueVsLastMonth, type Leak, type OtherAttention } from "@/lib/overview";
import {
  cuttingHoursByMachine, daysToGetPaid, estimateByJob, invoicedByJob, invoicedByMonth, jobsVsEstimate, owedTrend, revenuePerMachineHour, runHoursByJob, topCustomersInvoiced,
  type CreditMetricRow, type InvoiceMetricRow, type OwedPoint,
} from "@/lib/overview-metrics";
import { COLOUR_TOKENS, STATUS_MAP } from "@/lib/status-colours";
import type { TeamRow } from "@/lib/team-week";
import { hm, localTimeOf } from "@/lib/time-sheet";
import { unrecognisedBannerText } from "@/lib/site-network";
import { FLOOR_WORDS, countText, dueText, elapsedText, sinceText, wholeFloor, type FloorRow, type FloorState, type WholeFloor as Floor } from "@/lib/whole-floor";

import s from "./DashboardPreview.module.css";

export type Role = "admin" | "office" | "workshop" | "viewer";
export type Screen = "ready" | "loading" | "error" | "empty" | "partial" | "attention-failed";
export type Basis = "invoiced" | "received";

/* ------------------------------------------------------------------ the sample world ------------------------------------------------------------------ */
const DAY_MS = 86_400_000;
/** The sample's "today" (a Friday, UK date), the clock "now" (GMT) and the Monday of this week. */
export const TODAY = "2026-11-20";
export const NOW_ISO = "2026-11-20T14:20:00.000Z";
export const NOW = new Date(NOW_ISO);
export const MONDAY = new Date("2026-11-16T00:00:00.000Z");
const SUNDAY = new Date(MONDAY.getTime() + 7 * DAY_MS);
export const DASH = "—";
export const FIRST_NAME = "Sam";

export type Month = { key: string; month: string };
/** loadAdminData's lastSixMonths(), worked on UTC parts so the sample never depends on the machine's time zone. */
export function lastSixMonths(now: Date): Month[] {
  const out: Month[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 15));
    out.push({ key: toDateInput(d.toISOString()).slice(0, 7), month: new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "Europe/London" }).format(d) });
  }
  return out;
}
export const MONTHS = lastSixMonths(NOW);
export const SINCE = `${MONTHS[0].key}-01`;
export const MONTH_START = `${MONTHS[5].key}-01`;
export const NINETY_AGO = toDateInput(new Date(NOW.getTime() - 90 * DAY_MS));
export const { end: WEEK_END } = dueWindow(NOW);

/** loadAdminData's greeting (hour of the day, first name). The sample clock is 14:20, so it reads "Good afternoon". */
export function greeting(name: string | null | undefined, now: Date = NOW): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Europe/London" }).format(now)) % 24;
  const first = name?.trim().split(/\s+/)[0];
  const base = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return first ? `${base}, ${first}` : base;
}

type Inv = InvoiceMetricRow & {
  id: string; ref: string; customer: string; status: string; subtotal: number; vat: number; carriage: number; total: number; invoice_date: string | null; created_at: string;
  due_date: string | null; paid_at: string | null; amount_paid: number; credited_amount: number; refunded_amount: number; payment_unverified: boolean; job_id: string | null;
};
type Credit = CreditMetricRow & { customer: string; status: string; vat: number; total: number; credit_date: string };
type Pay = { amount: number; paid_on: string };
type QuoteRow = { id: string; quote_ref: string; customer: string; status: string; valid_until: string | null; total_value: number; sent_at: string | null; accepted_at: string | null; version: number; rfq_id?: string; created_at: string; vat_enabled: boolean };
type RfqRow = { id: string; status: string; customer: string; description: string; created_at: string };
export type JobRow = {
  id: string; job_no: string; customer: string; description: string; stage: string; started_at: string | null; finished_at: string | null; inspected_at: string | null; flow_status: string | null;
  date_required: string | null; due_date: string | null; quantity_required: number | null; assigned_to: string | null; specification: string | null; status: string | null;
};
type MachineRow = { id: string; name: string; hours_per_day: number; working_days: number[]; active: boolean };
type Booking = { id: string; machine_id: string; job_no: string; start_at: string; estimated_hours: number; status: string };
type Run = { job_id: string; machine_id: string; started_at: string; ended_at: string | null };
type Insp = { job_id: string; result: string; inspected_at: string };

export type Sample = {
  invoices: Inv[]; credits: Credit[]; payments: Pay[]; quotes: QuoteRow[]; rfqs: RfqRow[]; jobs: JobRow[]; inspections: Insp[]; machines: MachineRow[]; bookings: Booking[];
  runs: Run[]; plans: Array<{ job_id: string; estimated_hours: number }>; snapshots: Array<{ snapshot_date: string; owed_amount: number; late_amount: number }>;
  deliveryNotes: Array<Record<string, unknown>>; purchaseOrders: Array<Record<string, unknown>>; problems: Array<Record<string, unknown>>; unbilled: Array<Record<string, unknown>>;
  emailsAwaiting: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const inv = (ref: string, customer: string, net: number, date: string, status: string, due: string | null, paidAt: string | null = null, extra: Partial<Inv> = {}): Inv => {
  const total = r2(net * 1.2);
  return { id: `i-${ref}`, ref, customer, status, subtotal: net, vat: r2(total - net), carriage: 0, total, invoice_date: date, created_at: `${date}T09:00:00Z`, due_date: due, paid_at: paidAt, amount_paid: status === "paid" ? total : 0, credited_amount: 0, refunded_amount: 0, payment_unverified: false, job_id: null, ...extra };
};
const INVOICES: Inv[] = [
  inv("INV-2101", "Marlow Hydraulics", 6200, "2026-06-04", "paid", "2026-07-04", "2026-06-30"),
  inv("INV-2102", "Tern Marine Engineering", 4850, "2026-06-11", "paid", "2026-07-11", "2026-07-08"),
  inv("INV-2103", "Coldharbour Automation", 3900, "2026-06-18", "paid", "2026-07-18", "2026-07-15"),
  inv("INV-2104", "Ashby Rail Services", 3450, "2026-06-26", "paid", "2026-07-26", "2026-07-22"),
  inv("INV-2105", "Marlow Hydraulics", 7300, "2026-07-03", "paid", "2026-08-02", "2026-07-30"),
  inv("INV-2106", "Kestrel Components", 2850, "2026-07-09", "paid", "2026-08-08", "2026-08-05"),
  inv("INV-2107", "Tern Marine Engineering", 5600, "2026-07-16", "paid", "2026-08-15", "2026-08-12"),
  inv("INV-2108", "Halden Precision", 3900, "2026-07-24", "paid", "2026-08-23", "2026-08-20"),
  inv("INV-2109", "Brightwell Valves", 2500, "2026-07-30", "paid", "2026-08-29", "2026-08-27"),
  inv("INV-2110", "Marlow Hydraulics", 5400, "2026-08-06", "paid", "2026-09-05", "2026-09-03"),
  inv("INV-2111", "Coldharbour Automation", 4100, "2026-08-14", "paid", "2026-09-13", "2026-09-10"),
  inv("INV-2112", "Wren & Calder", 2950, "2026-08-21", "sent", "2026-09-20"),
  inv("INV-2113", "Ashby Rail Services", 3450, "2026-08-28", "sent", "2026-09-27"),
  inv("INV-2114", "Marlow Hydraulics", 8200, "2026-09-04", "paid", "2026-10-04", "2026-10-02", { job_id: "jd-0902" }),
  inv("INV-2115", "Tern Marine Engineering", 6150, "2026-09-10", "paid", "2026-10-10", "2026-10-08", { job_id: "jd-0909" }),
  inv("INV-2116", "Coldharbour Automation", 4300, "2026-09-17", "paid", "2026-10-17", "2026-10-12", { job_id: "jd-0916" }),
  inv("INV-2117", "Kestrel Components", 3650, "2026-09-22", "paid", "2026-10-22", "2026-10-20"),
  inv("INV-2118", "Halden Precision", 4000, "2026-09-29", "paid", "2026-10-29", "2026-10-27"),
  inv("INV-2119", "Marlow Hydraulics", 7900, "2026-10-05", "paid", "2026-11-04", "2026-11-04", { job_id: "jd-1001" }),
  inv("INV-2120", "Tern Marine Engineering", 4200, "2026-10-09", "sent", "2026-11-08"),
  inv("INV-2121", "Brightwell Valves", 3350, "2026-10-14", "partial", "2026-11-13", null, { amount_paid: 1500 }),
  inv("INV-2122", "Ashby Rail Services", 4700, "2026-10-20", "paid", "2026-11-19", "2026-11-12", { job_id: "jd-1013" }),
  inv("INV-2123", "Pemberton Packaging", 2300, "2026-10-28", "sent", "2026-11-27"),
  inv("INV-2124", "Kestrel Components", 2300, "2026-10-30", "sent", "2026-11-29"),
  inv("INV-2125", "Marlow Hydraulics", 5800, "2026-11-03", "sent", "2026-12-03", null, { job_id: "jd-1103" }),
  inv("INV-2126", "Coldharbour Automation", 3780, "2026-11-10", "sent", "2026-12-10"),
  inv("INV-2127", "Halden Precision", 2200, "2026-11-13", "sent", "2026-12-13"),
  inv("INV-2128", "Wren & Calder", 2500, "2026-11-18", "sent", "2026-12-18"),
  // Outside the six months: an imported invoice whose payment is still to be confirmed, and an old draft.
  inv("INV-1986", "Pemberton Packaging", 1750, "2026-03-14", "sent", "2026-04-13", null, { payment_unverified: true }),
  inv("INV-2129", "Halden Precision", 1900, "2026-11-12", "draft", null),
];
const CREDITS: Credit[] = [
  { customer: "Tern Marine Engineering", status: "issued", vat: 240, total: 1440, credit_date: "2026-10-15" },
  { customer: "Kestrel Components", status: "issued", vat: 70, total: 420, credit_date: "2026-11-12" },
  { customer: "Wren & Calder", status: "draft", vat: 60, total: 360, credit_date: "2026-11-18" },
];
/** Money received: every paid invoice on the day it cleared, two payments from before June, a part payment and one reversal (a refunded overpayment). */
const PAYMENTS: Pay[] = [
  ...INVOICES.filter((i) => i.status === "paid" && i.paid_at).map((i) => ({ amount: i.total, paid_on: i.paid_at as string })),
  { amount: 3300, paid_on: "2026-06-05" }, { amount: 2160, paid_on: "2026-06-19" },
  { amount: 1500, paid_on: "2026-11-06" }, { amount: -300, paid_on: "2026-11-17" },
];

const Q = (id: string, ref: string, customer: string, status: string, sent: string | null, valid: string | null, value: number, extra: Partial<QuoteRow> = {}): QuoteRow =>
  ({ id: `q-${id}`, quote_ref: ref, customer, status, valid_until: valid, total_value: value, sent_at: sent, accepted_at: null, version: 1, created_at: `${sent ?? valid ?? TODAY}T08:00:00Z`, vat_enabled: true, ...extra });
const QUOTES: QuoteRow[] = [
  Q("01", "QUO-3201", "Marlow Hydraulics", "accepted", "2026-09-02", "2026-10-02", 9800, { accepted_at: "2026-09-10" }),
  Q("02", "QUO-3204", "Tern Marine Engineering", "accepted", "2026-09-09", "2026-10-09", 7450, { accepted_at: "2026-09-18" }),
  Q("03", "QUO-3207", "Coldharbour Automation", "accepted", "2026-09-23", "2026-10-23", 4200, { accepted_at: "2026-10-01" }),
  Q("04", "QUO-3210", "Halden Precision", "accepted", "2026-10-06", "2026-11-05", 3900, { accepted_at: "2026-10-14" }),
  Q("05", "QUO-3214", "Marlow Hydraulics", "accepted", "2026-10-27", "2026-11-26", 6150, { accepted_at: "2026-11-05", rfq_id: "r6" }),
  Q("06", "QUO-3217", "Brightwell Valves", "accepted", "2026-11-04", "2026-12-04", 2850, { accepted_at: "2026-11-12" }),
  Q("07", "QUO-3198", "Ashby Rail Services", "accepted", "2026-08-28", "2026-09-27", 5100),
  Q("08", "QUO-3203", "Kestrel Components", "rejected", "2026-09-05", "2026-10-05", 3300),
  Q("09", "QUO-3212", "Pemberton Packaging", "rejected", "2026-10-15", "2026-11-14", 2100),
  Q("10", "QUO-3199", "Wren & Calder", "sent", "2026-08-30", "2026-09-29", 2750),
  Q("11", "QUO-3205", "Ashby Rail Services", "sent", "2026-09-12", "2026-10-12", 4400),
  Q("12", "QUO-3208", "Kestrel Components", "sent", "2026-09-26", "2026-10-26", 1950),
  Q("13", "QUO-3215", "Tern Marine Engineering", "sent", "2026-10-30", "2026-11-29", 8600, { rfq_id: "r5" }),
  Q("14", "QUO-3216", "Coldharbour Automation", "sent", "2026-11-02", "2026-12-02", 3400),
  Q("15", "QUO-3218", "Halden Precision", "sent", "2026-11-09", "2026-12-09", 5250),
  Q("16", "QUO-3219", "Wren & Calder", "sent", "2026-11-12", "2026-12-12", 2980),
  Q("17", "QUO-3220", "Marlow Hydraulics", "sent", "2026-11-17", "2026-12-17", 6400),
  Q("18", "QUO-3211", "Brightwell Valves", "sent", "2026-10-08", "2026-11-30", 4150),
  Q("19", "QUO-3221", "Pemberton Packaging", "draft", null, "2026-12-20", 1850),
  Q("20", "QUO-3200", "Kestrel Components", "draft", null, "2026-10-30", 2200),
];
const RFQS: RfqRow[] = [
  { id: "r1", status: "new", customer: "Ashby Rail Services", description: "Axle cap, 16 off, 4140", created_at: "2026-11-19T09:00:00Z" },
  { id: "r2", status: "clarification", customer: "Halden Precision", description: "Spindle housing, drawing rev B missing", created_at: "2026-11-12T09:00:00Z" },
  { id: "r3", status: "ready", customer: "Brightwell Valves", description: "Seat rings, 60 off", created_at: "2026-11-16T09:00:00Z" },
  { id: "r4", status: "clarification", customer: "Wren & Calder", description: "Pump covers, material not stated", created_at: "2026-11-05T09:00:00Z" },
  { id: "r5", status: "ready", customer: "Tern Marine Engineering", description: "Impeller shafts, 8 off", created_at: "2026-10-27T09:00:00Z" },
  { id: "r6", status: "ready", customer: "Marlow Hydraulics", description: "Valve blocks, 6 off", created_at: "2026-10-22T09:00:00Z" },
];

type JobArgs = Partial<JobRow>;
const J = (no: string, customer: string, description: string, o: JobArgs): JobRow => ({
  id: `j-${no.slice(2)}`, job_no: no, customer, description, stage: "machining", started_at: null, finished_at: null, inspected_at: null, flow_status: null, date_required: null, due_date: null,
  quantity_required: null, assigned_to: null, specification: null, status: null, ...o,
});
const OPEN_JOBS: JobRow[] = [
  J("J-1062", "Coldharbour Automation", "Clamp plates, batch of 40", { stage: "material", date_required: "2026-11-24", quantity_required: 40, assigned_to: "u-sam", specification: "6082-T6 plate, 12 mm. Deburr all edges. Anodise is not required." }),
  J("J-1063", "Marlow Hydraulics", "Valve block, 6082", { stage: "material", date_required: "2026-11-26", quantity_required: 6 }),
  J("J-1064", "Halden Precision", "Spindle housings x12", { stage: "material", date_required: "2026-11-30", quantity_required: 12 }),
  J("J-1065", "Brightwell Valves", "Seat rings x60", { stage: "material", date_required: "2026-12-04", quantity_required: 60 }),
  J("J-1066", "Tern Marine Engineering", "Impeller shafts x8", { stage: "material", date_required: "2026-12-09", quantity_required: 8 }),
  J("J-1067", "Kestrel Components", "Brackets x200", { stage: "material", date_required: "2026-12-12", quantity_required: 200 }),
  J("J-1068", "Ashby Rail Services", "Axle caps x16", { stage: "material", quantity_required: 16 }),
  J("J-1069", "Pemberton Packaging", "Roller guides", { stage: "material", due_date: "2026-12-18" }),
  J("J-1051", "Marlow Hydraulics", "Manifold, 7075", { started_at: "2026-11-12T08:00:00Z", date_required: "2026-11-18", quantity_required: 4 }),
  J("J-1043", "Tern Marine Engineering", "Gland housings x24", { started_at: "2026-11-05T08:00:00Z", date_required: "2026-11-13", quantity_required: 24 }),
  J("J-1038", "Wren & Calder", "Pump covers x20", { started_at: "2026-10-30T08:00:00Z", due_date: "2026-11-06", quantity_required: 20 }),
  J("J-1056", "Coldharbour Automation", "Gearbox covers x30", { stage: "setup", started_at: "2026-11-17T08:00:00Z", date_required: "2026-11-21", quantity_required: 30, assigned_to: "u-sam", specification: "Face both sides to 25.00 +/- 0.05. Mark job number on the rear face." }),
  J("J-1057", "Halden Precision", "Locating pins x400", { started_at: "2026-11-18T08:00:00Z", date_required: "2026-11-23", quantity_required: 400, assigned_to: "u-sam" }),
  J("J-1058", "Brightwell Valves", "Valve bodies x10", { started_at: "2026-11-19T08:00:00Z", date_required: "2026-11-25", quantity_required: 10 }),
  J("J-1059", "Ashby Rail Services", "Brake caliper pins x80", { started_at: "2026-11-19T08:00:00Z", date_required: "2026-11-27", quantity_required: 80 }),
  J("J-1060", "Marlow Hydraulics", "Hydraulic ports x16", { started_at: "2026-11-19T08:00:00Z", date_required: "2026-12-02", quantity_required: 16 }),
  J("J-1049", "Kestrel Components", "Mounting flanges x50", { stage: "rework", started_at: "2026-11-10T08:00:00Z", finished_at: "2026-11-17T16:00:00Z", date_required: "2026-11-19", quantity_required: 50, assigned_to: "u-sam", specification: "Re-bore to 38.10 H7 after the failed first inspection." }),
  J("J-1052", "Halden Precision", "Flange adaptors x8", { stage: "inspection", started_at: "2026-11-11T08:00:00Z", finished_at: "2026-11-19T15:00:00Z", date_required: "2026-11-20", quantity_required: 8 }),
  J("J-1054", "Tern Marine Engineering", "Coupling hubs x6", { stage: "inspection", started_at: "2026-11-09T08:00:00Z", finished_at: "2026-11-18T15:00:00Z", date_required: "2026-11-18", quantity_required: 6 }),
  J("J-1055", "Coldharbour Automation", "Guide bushes x100", { stage: "inspection", started_at: "2026-11-12T08:00:00Z", finished_at: "2026-11-20T09:30:00Z", date_required: "2026-11-21", quantity_required: 100 }),
];
/** Complete jobs of the last six months: [day finished, days finished after the required date (negative = early)] per month. */
const FINISHED_TUPLES: Record<string, Array<[number, number]>> = {
  "2026-06": [[3, 0], [5, -2], [9, 0], [12, 1], [16, -1], [19, 0], [24, 0], [26, -3], [29, 2], [30, 0]],
  "2026-07": [[2, 0], [7, -1], [10, 0], [14, 0], [17, -2], [21, 0], [23, 1], [28, 0], [30, -4]],
  "2026-08": [[4, 0], [8, 0], [12, -1], [15, 3], [19, 0], [22, 0], [26, 0], [28, -2], [31, 0]],
  "2026-09": [[2, 0], [5, 0], [9, -1], [11, 0], [16, 0], [18, 2], [23, 0], [25, -3], [29, 0], [30, 0]],
  "2026-10": [[1, 0], [6, 0], [8, 0], [13, -2], [15, 0], [20, 0], [22, 1], [27, 0], [29, 0], [30, -1]],
  "2026-11": [[3, 0], [5, -1], [10, 0], [12, 0], [14, 2], [17, 0], [19, 0]],
};
const pad2 = (n: number) => String(n).padStart(2, "0");
const COMPLETE_JOBS: JobRow[] = Object.entries(FINISHED_TUPLES).flatMap(([month, rows]) => rows.map(([day, delta]) => {
  const finished = `${month}-${pad2(day)}`;
  const required = new Date(Date.parse(`${finished}T00:00:00Z`) - delta * DAY_MS).toISOString().slice(0, 10);
  return J(`J-${month.slice(5)}${pad2(day)}`, "Marlow Hydraulics", "Finished job", { id: `jd-${month.slice(5)}${pad2(day)}`, started_at: `${finished}T07:00:00Z`, finished_at: `${finished}T16:00:00Z`, inspected_at: `${finished}T17:00:00Z`, date_required: required, flow_status: "complete" });
}));
const INSPECTION_TUPLES: Array<[string, string]> = [
  // [job, result of the FIRST inspection]; a later pass after a fail is a second row and never counts.
  ...COMPLETE_JOBS.map((j, i): [string, string] => [j.id, i % 13 === 4 ? "fail" : i % 27 === 9 ? "concession" : "pass"]),
];
const INSPECTIONS: Insp[] = [
  ...INSPECTION_TUPLES.map(([job_id, result]) => ({ job_id, result, inspected_at: `${COMPLETE_JOBS.find((j) => j.id === job_id)?.finished_at?.slice(0, 10)}T17:00:00Z` })),
  ...COMPLETE_JOBS.filter((_, i) => i % 13 === 4).map((j) => ({ job_id: j.id, result: "pass", inspected_at: `${j.finished_at?.slice(0, 10)}T17:30:00Z` })),
];

const MACHINES: MachineRow[] = [
  { id: "m1", name: "CNC Mill 1", hours_per_day: 8, working_days: [1, 2, 3, 4, 5], active: true },
  { id: "m2", name: "CNC Mill 2", hours_per_day: 8, working_days: [1, 2, 3, 4, 5], active: true },
  { id: "m3", name: "CNC Lathe 1", hours_per_day: 8, working_days: [1, 2, 3, 4, 5], active: true },
  { id: "m4", name: "CNC Lathe 2", hours_per_day: 8, working_days: [1, 2, 3, 4, 5], active: true },
  { id: "m5", name: "Wire erosion", hours_per_day: 10, working_days: [1, 2, 3, 4, 5], active: true },
  { id: "m6", name: "Band saw", hours_per_day: 8, working_days: [1, 2, 3, 4, 5], active: true },
];
const B = (id: string, machine: string, job: string, start: string, hours: number, status: string): Booking => ({ id, machine_id: machine, job_no: job, start_at: start, estimated_hours: hours, status });
const BOOKINGS: Booking[] = [
  B("b01", "m1", "J-1051", "2026-11-16T08:00:00Z", 12, "complete"), B("b02", "m1", "J-1056", "2026-11-17T08:00:00Z", 10, "complete"), B("b03", "m1", "J-1057", "2026-11-19T08:00:00Z", 8, "booked"), B("b04", "m1", "J-1060", "2026-11-20T14:00:00Z", 4, "booked"),
  B("b05", "m2", "J-1043", "2026-11-16T09:00:00Z", 16, "complete"), B("b06", "m2", "J-1058", "2026-11-18T08:00:00Z", 14.5, "booked"), B("b07", "m2", "J-1059", "2026-11-20T08:00:00Z", 11, "booked"),
  B("b08", "m3", "J-1063", "2026-11-17T08:00:00Z", 10, "booked"), B("b09", "m3", "J-1064", "2026-11-19T08:00:00Z", 14, "booked"),
  B("b10", "m4", "J-1062", "2026-11-18T08:30:00Z", 18, "booked"),
  B("b11", "m5", "J-1066", "2026-11-16T08:00:00Z", 30, "booked"),
  B("b12", "m6", "J-1067", "2026-11-19T09:00:00Z", 6, "booked"),
];
const R = (job: string, machine: string, start: string, hours: number | null): Run => ({ job_id: job, machine_id: machine, started_at: start, ended_at: hours === null ? null : new Date(Date.parse(start) + hours * 3_600_000).toISOString() });
const RUNS: Run[] = [
  // Jobs finished and invoiced in the last 90 days (run time against the planned machine hours).
  R("jd-0902", "m1", "2026-09-01T08:00:00Z", 14), R("jd-0902", "m3", "2026-09-02T08:00:00Z", 12),
  R("jd-0909", "m2", "2026-09-08T08:00:00Z", 30), R("jd-0909", "m4", "2026-09-09T08:00:00Z", 14),
  R("jd-0916", "m1", "2026-09-15T08:00:00Z", 18),
  R("jd-1001", "m2", "2026-09-29T08:00:00Z", 22), R("jd-1001", "m3", "2026-10-01T08:00:00Z", 16),
  R("jd-1013", "m5", "2026-10-12T08:00:00Z", 22),
  R("jd-1103", "m1", "2026-11-02T08:00:00Z", 18), R("jd-1103", "m4", "2026-11-03T08:00:00Z", 15),
  // This week, Monday to now (a run still open ends at "now"; overlapping runs on one machine count once).
  R("j-1051", "m1", "2026-11-16T08:00:00Z", 8.5), R("j-1051", "m1", "2026-11-17T08:00:00Z", 8), R("j-1056", "m1", "2026-11-18T08:00:00Z", 7.5), R("j-1056", "m1", "2026-11-19T08:00:00Z", 8), R("j-1056", "m1", "2026-11-20T08:00:00Z", null),
  R("j-1043", "m2", "2026-11-16T08:00:00Z", 8), R("j-1043", "m2", "2026-11-17T08:00:00Z", 8), R("j-1058", "m2", "2026-11-18T08:00:00Z", 8), R("j-1058", "m2", "2026-11-19T08:00:00Z", 8), R("j-1051", "m2", "2026-11-20T08:00:00Z", 6),
  R("j-1063", "m3", "2026-11-16T08:00:00Z", 4), R("j-1063", "m3", "2026-11-17T08:00:00Z", 8), R("j-1064", "m3", "2026-11-19T08:00:00Z", 6),
  R("j-1062", "m4", "2026-11-17T09:00:00Z", 6), R("j-1062", "m4", "2026-11-18T08:00:00Z", 8),
  R("j-1066", "m5", "2026-11-16T08:00:00Z", 6), R("j-1066", "m5", "2026-11-17T08:00:00Z", 6), R("j-1066", "m5", "2026-11-18T08:00:00Z", 6), R("j-1066", "m5", "2026-11-19T08:00:00Z", 6), R("j-1066", "m5", "2026-11-20T08:00:00Z", 6),
  R("j-1067", "m6", "2026-11-18T10:00:00Z", 2),
];
const PLANS = [
  { job_id: "jd-0902", estimated_hours: 28 }, { job_id: "jd-0909", estimated_hours: 40 }, { job_id: "jd-0916", estimated_hours: 20 },
  { job_id: "jd-1001", estimated_hours: 36 }, { job_id: "jd-1013", estimated_hours: 24 }, { job_id: "jd-1103", estimated_hours: 30 },
];

/** Nightly owed snapshots (migration 116), 91 nights ending today; the last one is today's real figure. */
export function sampleSnapshots(owedNow: number, lateNow: number): Sample["snapshots"] {
  return Array.from({ length: 91 }, (_, i) => {
    const date = new Date(Date.parse(`${NINETY_AGO}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10);
    const wave = Math.round(Math.sin(i / 6.5) * 3400 + Math.cos(i / 2.3) * 700);
    const owed = i === 90 ? owedNow : Math.max(9000, 31500 + i * 70 + wave);
    const late = i === 90 ? lateNow : Math.max(0, Math.round(owed * 0.22 + Math.cos(i / 9) * 1500));
    return { snapshot_date: date, owed_amount: owed, late_amount: late };
  });
}

const DN = (id: string, no: string, customer: string, status: string, updated: string, extra: Record<string, unknown> = {}) => ({ id, dn_number: no, customer, status, updated_at: `${updated}T10:00:00Z`, created_at: `${updated}T09:00:00Z`, delivery_date: updated, invoice_id: null, ...extra });

export const SAMPLE: Sample = {
  invoices: INVOICES, credits: CREDITS, payments: PAYMENTS, quotes: QUOTES, rfqs: RFQS, jobs: [...OPEN_JOBS, ...COMPLETE_JOBS], inspections: INSPECTIONS, machines: MACHINES, bookings: BOOKINGS,
  runs: RUNS, plans: PLANS, snapshots: [],
  deliveryNotes: [
    DN("d1", "DLN-0213", "Coldharbour Automation", "awaiting", "2026-11-20"), DN("d2", "DLN-0208", "Halden Precision", "awaiting", "2026-11-18"),
    DN("d3", "DLN-0209", "Kestrel Components", "awaiting", "2026-11-13"), DN("d4", "DLN-0214", "Brightwell Valves", "awaiting", "2026-11-19"),
    DN("d5", "DLN-0212", "Marlow Hydraulics", "despatched", "2026-11-19"), DN("d6", "DLN-0211", "Tern Marine Engineering", "despatched", "2026-11-16"),
    DN("d7", "DLN-0206", "Ashby Rail Services", "signed", "2026-11-16", { invoice_id: "i-INV-2122" }),
  ],
  purchaseOrders: [
    { id: "po1", po_ref: "PO-0455", supplier: "Ironbridge Metals", status: "ordered", expected_delivery: "2026-11-12", received_at: null },
    { id: "po2", po_ref: "PO-0458", supplier: "Harlow Tooling Supplies", status: "ordered", expected_delivery: "2026-11-18", received_at: null },
  ],
  problems: [{ id: "p1", reported_at: "2026-11-18T10:00:00Z", status: "open", reason: "material", note: "Bar stock short by 3 lengths", job_id: "j-1057", jobs: { job_no: "J-1057", customer: "Halden Precision" } }],
  unbilled: [{ job_id: "jd-1103", job_no: "J-1103", customer: "Marlow Hydraulics", completed_at: "2026-11-12T10:00:00Z", to_despatch: 0, to_invoice: 12 }],
  emailsAwaiting: 3,
};
export const EMPTY: Sample = { ...SAMPLE, invoices: [], credits: [], payments: [], quotes: [], rfqs: [], jobs: [], inspections: [], bookings: [], runs: [], plans: [], snapshots: [], deliveryNotes: [], purchaseOrders: [], problems: [], unbilled: [], emailsAwaiting: 0 };

/* ------------------------------------------------------------------ the figures (mirror of loadAdminData / loadWorkshopData) ------------------------------------------------------------------ */
export type AttentionItem = { key: string; title: string; detail: string; href: string };
export type AdminData = {
  openQuotes: number | null; pipelineValue: number | null; moneyOwed: number | null; unpaidInvoices: number | null; rfqsToQuote: number | null; openJobs: number | null;
  dueThisWeek: number | null; dueBy: string; revenue: Array<{ month: string; revenue: number }> | null; thisMonthRevenue: number | null;
  invoiced: Array<{ month: string; revenue: number }> | null; thisMonthInvoiced: number | null; quotesSentThisMonth: number | null; quotesWon: { count: number; undated: number } | null;
  lateJobs: number | null; onTimeJobs: number | null; daysToPay: { average: number | null; count: number } | null;
  pipeline: { rfqs: number | null; quoted: number | null; accepted: number | null; paid: number | null };
  attention: AttentionItem[]; attentionFailed: boolean; draftEmails: number | null; owedByAge: AgeBucket[] | null; quotes90: ReturnType<typeof quoteTilesFromRows>["quotes90"];
  jobsStatus: JobsByStatus | null; onTime: Array<{ month: string; percent: number | null; finished: number }> | null; rft: ReturnType<typeof rightFirstTime> | null; machines: MachineLoad[] | null;
  workDue: Array<{ date: string; count: number }> | null; customers: { rows: Array<{ customer: string; value: number }>; share: number | null; topCustomer: string | null } | null;
  cutting: { total: number; machines: Array<{ id: string; name: string; hours: number }> } | null; perMachineHour: { value: ReturnType<typeof revenuePerMachineHour> } | null;
  vsEstimate: { value: ReturnType<typeof jobsVsEstimate> } | null; owedTrend: { state: "missing" } | { state: "ok"; points: OwedPoint[] } | null;
};
export type ReadName = "payments" | "runs" | "inspections" | "bookings" | "quotes";
export type WorkshopData = {
  running: number | null; dueThisWeek: number | null; dueBy: string; deliveryNotes: number | null;
  priorityJobs: Array<{ id: string; jobNo: string; description: string; stage: string; status: string }> | null;
  bookings: Array<{ id: string; machine: string; jobNo: string; start: string }> | null; myJobs: MyJob[] | null;
};

/** OPEN_JOBS_FILTER ("stage.eq.rework,inspected_at.is.null") as a predicate. */
export const isOpenRow = (j: JobRow) => j.stage === "rework" || j.inspected_at === null;
/** RUNNING_JOBS_FILTER as a predicate. */
export const isRunningRow = (j: JobRow) => j.stage === "rework" || (j.finished_at === null && j.inspected_at === null && j.started_at !== null);
const inRange = (d: string | null, from: string, to: string) => d !== null && d >= from && d <= to;
/** openJobsDueFilter(from, to): open jobs whose date_required or due_date falls in the range. */
export const dueOpenRow = (j: JobRow, from: string, to: string) => isOpenRow(j) && (inRange(j.date_required, from, to) || inRange(j.due_date, from, to));
/** loadAdminData's lateFilter on unfinished jobs: required date before today, else due date before today. */
export const isLateRow = (j: JobRow, today: string) => j.finished_at === null && ((j.date_required !== null && j.date_required < today) || (j.date_required === null && j.due_date !== null && j.due_date < today));
export const hasDateRow = (j: JobRow) => j.finished_at === null && (j.date_required !== null || j.due_date !== null);

/** The Revenue panel's "received" series: invoice_payments by the date received, reversals included, in whole pence (as loadAdminData). */
export function receivedByMonth(payments: Pay[], months: Month[], since: string): Array<{ month: string; revenue: number }> & { latest: number } {
  const buckets = new Map(months.map((m) => [m.key, 0]));
  for (const row of payments) {
    if (!row.paid_on || row.paid_on < since) continue;
    const key = String(row.paid_on).slice(0, 7);
    if (buckets.has(key)) buckets.set(key, toPence(Number(buckets.get(key) ?? 0)) / 100 + toPence(Number(row.amount || 0)) / 100);
  }
  const series = months.map((m) => ({ month: m.month, revenue: Math.round(buckets.get(m.key) ?? 0) }));
  return Object.assign(series, { latest: buckets.get(months[months.length - 1].key) ?? 0 });
}

export function adminData(sample: Sample, office: boolean, fail: ReadonlySet<ReadName> = new Set(), snapshotsOn = true): AdminData {
  const dates = { today: TODAY, monthStart: MONTH_START, ninetyDaysAgo: NINETY_AGO };
  const quoteTiles = fail.has("quotes")
    ? { openQuotes: null, pipelineValue: null, acceptedQuotes: null, rfqsToQuote: null, quotesSentThisMonth: null, quotesWon: null, quotes90: null }
    : quoteTilesFromRows(sample.quotes, [], sample.rfqs.map((r) => ({ id: r.id, status: r.status })), dates);
  const open = sample.jobs.filter(isOpenRow);
  const lateCount = sample.jobs.filter((j) => isLateRow(j, TODAY)).length;
  const datedCount = sample.jobs.filter(hasDateRow).length;
  const finished = sample.jobs.filter((j) => j.finished_at !== null && j.finished_at >= SINCE);
  const monthKeys = MONTHS.map((m) => m.key);
  let moneyOwed: number | null = null, unpaidInvoices: number | null = null, revenue: AdminData["revenue"] = null, thisMonthRevenue: number | null = null;
  let invoiced: AdminData["invoiced"] = null, thisMonthInvoiced: number | null = null, daysToPay: AdminData["daysToPay"] = null, ageBuckets: AgeBucket[] | null = null;
  let customers: AdminData["customers"] = null, cutting: AdminData["cutting"] = null, perMachineHour: AdminData["perMachineHour"] = null, vsEstimate: AdminData["vsEstimate"] = null;
  let owedTrendData: AdminData["owedTrend"] = null, paidCount: number | null = null;
  const attention: AttentionItem[] = [];
  let attentionFailed = false;
  if (!office) {
    const moneyTiles = moneyTilesFromRows(sample.invoices.filter((i) => i.status !== "paid"), TODAY);
    paidCount = sample.invoices.filter((i) => i.status === "paid").length;
    if (moneyTiles.failed) attentionFailed = true;
    else {
      const toConfirm = moneyTiles.toConfirm ?? 0;
      if (toConfirm) attention.push({ key: "inv-payment-to-confirm", title: `${toConfirm} imported invoice${toConfirm === 1 ? "" : "s"}: payment to confirm`, detail: "Record the payment or confirm it is still owed. Not counted as money owed until checked.", href: "/invoices" });
      unpaidInvoices = moneyTiles.unpaidInvoices; moneyOwed = moneyTiles.moneyOwed; ageBuckets = moneyTiles.owedByAge;
    }
    const issued = sample.invoices.filter((i) => (i.invoice_date !== null && i.invoice_date >= SINCE) || (i.invoice_date === null && i.created_at >= SINCE));
    const credits = sample.credits.filter((c) => c.status === "issued" && c.credit_date >= SINCE);
    if (!fail.has("payments")) {
      const series = receivedByMonth(sample.payments, MONTHS, SINCE);
      revenue = series.map((p) => ({ ...p })); thisMonthRevenue = series.latest;
    }
    daysToPay = daysToGetPaid(sample.invoices.filter((i) => i.status === "paid" && (((i.paid_at ?? "") >= SINCE) || ((i.invoice_date ?? "") >= SINCE) || i.created_at >= SINCE)), NINETY_AGO);
    const byMonth = invoicedByMonth(issued, credits, monthKeys);
    if (byMonth) {
      invoiced = MONTHS.map((m) => ({ month: m.month, revenue: Math.round(byMonth.get(m.key) ?? 0) }));
      thisMonthInvoiced = byMonth.get(MONTHS[5].key) ?? 0;
    }
    const top = topCustomersInvoiced(issued, credits, SINCE);
    customers = top ? { rows: top.rows, share: top.share, topCustomer: top.topCustomer } : null;
    if (!fail.has("runs")) {
      const runs = sample.runs.filter((r) => r.ended_at === null || r.ended_at >= SINCE);
      const perMachine = cuttingHoursByMachine(runs, MONDAY.toISOString(), NOW_ISO);
      const machinesCut = sample.machines.map((m) => ({ id: m.id, name: m.name, hours: perMachine.get(m.id) ?? 0 })).sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));
      cutting = { total: Math.round(machinesCut.reduce((sum, m) => sum + m.hours, 0) * 10) / 10, machines: machinesCut };
      const hoursByJob = runHoursByJob(runs, NOW_ISO);
      perMachineHour = { value: revenuePerMachineHour(invoicedByJob(issued, NINETY_AGO), hoursByJob) };
      const ids = finished.filter((j) => toDateInput(j.finished_at) >= NINETY_AGO).map((j) => j.id);
      vsEstimate = { value: jobsVsEstimate(ids, estimateByJob(sample.plans.filter((p) => ids.includes(p.job_id))), hoursByJob) };
    }
    // A company with no invoices has taken no nightly figure yet: the real page then says the trend starts once two have been taken.
    owedTrendData = snapshotsOn ? { state: "ok", points: owedTrend(!sample.invoices.length ? [] : sample.snapshots.length ? sample.snapshots : sampleSnapshots(moneyOwed ?? 0, overdueFromBuckets(ageBuckets) ?? 0)) } : { state: "missing" };
  }
  const bookings = sample.bookings.filter((b) => b.start_at >= MONDAY.toISOString() && b.start_at < SUNDAY.toISOString());
  const inspections = sample.inspections.filter((r) => r.inspected_at >= SINCE);
  return {
    openQuotes: quoteTiles.openQuotes, pipelineValue: quoteTiles.pipelineValue, moneyOwed, unpaidInvoices, rfqsToQuote: quoteTiles.rfqsToQuote, openJobs: open.length,
    dueThisWeek: sample.jobs.filter((j) => dueOpenRow(j, TODAY, WEEK_END)).length, dueBy: WEEK_END, revenue, thisMonthRevenue, invoiced, thisMonthInvoiced,
    quotesSentThisMonth: quoteTiles.quotesSentThisMonth, quotesWon: quoteTiles.quotesWon, lateJobs: lateCount, onTimeJobs: onTimeJobCount(datedCount, lateCount), daysToPay,
    pipeline: { rfqs: quoteTiles.rfqsToQuote, quoted: quoteTiles.openQuotes, accepted: quoteTiles.acceptedQuotes, paid: paidCount },
    attention, attentionFailed, draftEmails: sample.emailsAwaiting, owedByAge: ageBuckets, quotes90: quoteTiles.quotes90, jobsStatus: jobsByStatus(open, TODAY),
    onTime: onTimeByMonth(finished, MONTHS),
    rft: fail.has("inspections") ? null : rightFirstTime(inspections),
    machines: fail.has("bookings") ? null : machineLoad(sample.machines, bookings, MONDAY),
    workDue: workloadDue(open, TODAY), customers, cutting, perMachineHour, vsEstimate, owedTrend: owedTrendData,
  };
}

export function workshopData(sample: Sample, userId: string | null): WorkshopData {
  const names = new Map(sample.machines.map((m) => [m.id, m.name]));
  const unfinished = sample.jobs.filter((j) => j.finished_at === null);
  const byDate = [...unfinished].sort((a, b) => (a.date_required === null ? 1 : 0) - (b.date_required === null ? 1 : 0) || (a.date_required ?? "").localeCompare(b.date_required ?? ""));
  const week = sample.bookings.filter((b) => b.status !== "complete" && b.start_at >= MONDAY.toISOString() && b.start_at < SUNDAY.toISOString()).sort((a, b) => a.start_at.localeCompare(b.start_at)).slice(0, 8);
  return {
    running: sample.jobs.filter(isRunningRow).length,
    dueThisWeek: unfinished.filter((j) => inRange(j.date_required, TODAY, WEEK_END) || inRange(j.due_date, TODAY, WEEK_END)).length,
    dueBy: WEEK_END,
    deliveryNotes: sample.deliveryNotes.filter((d) => d.status === "awaiting").length,
    priorityJobs: byDate.slice(0, 5).map((j) => ({ id: j.id, jobNo: j.job_no, description: j.description, stage: j.stage, status: j.status ?? "" })),
    bookings: week.map((b) => ({ id: b.id, machine: names.get(b.machine_id) || "Machine", jobNo: b.job_no, start: b.start_at })),
    myJobs: userId ? myJobs(sample.jobs.filter((j) => (j.finished_at === null || j.stage === "rework") && j.assigned_to === userId), userId, 20, TODAY) : [],
  };
}

/** The attention sections for a role, from the sample rows through the real rules (lib/attention-items buildAttention). */
export function attentionFor(sample: Sample, role: AttentionRole): AttentionSection[] {
  const unpaid = sample.invoices.filter((i) => i.status !== "paid");
  const input: AttentionInput = {
    quotes: sample.quotes.filter((q) => q.status === "draft" || q.status === "sent"), rfqs: sample.rfqs.filter((r) => r.status === "clarification"),
    quotedRfqIds: sample.quotes.filter((q) => q.rfq_id).map((q) => q.rfq_id as string), purchaseOrders: sample.purchaseOrders,
    lateJobs: sample.jobs.filter((j) => j.finished_at === null), finishedJobs: sample.jobs.filter((j) => j.finished_at !== null && j.inspected_at === null),
    invoices: unpaid, deliveryNotes: sample.deliveryNotes, unbilledJobs: sample.unbilled, jobProblems: sample.problems,
  };
  return buildAttention(input, role, TODAY);
}

/** Sample floor reads through the real wholeFloor(): two machines running, one paused, two idle, one job on the bench, one run left open overnight. */
export function sampleFloor(): Floor {
  const jobRows = ["j-1056", "j-1051", "j-1066", "j-1063", "j-1060"].map((id) => OPEN_JOBS.find((j) => j.id === id) as JobRow);
  return wholeFloor({
    machines: MACHINES.map(({ id, name, active }) => ({ id, name, active })),
    inUse: [
      { run_id: "ru1", machine_id: "m1", machine_name: "CNC Mill 1", job_id: "j-1056", job_no: "J-1056", operator_name: "Priya Nair", started_at: "2026-11-20T08:05:00Z", stale: false },
      { run_id: "ru2", machine_id: "m2", machine_name: "CNC Mill 2", job_id: "j-1051", job_no: "J-1051", operator_name: "Jordan Mackay", started_at: "2026-11-20T08:20:00Z", stale: false },
      { run_id: "ru3", machine_id: "m5", machine_name: "Wire erosion", job_id: "j-1066", job_no: "J-1066", operator_name: "Priya Nair", started_at: "2026-11-19T16:40:00Z", stale: false },
    ],
    paused: [{ machine_id: "m3", paused_run_id: "pr1", job_id: "j-1063", job_no: "J-1063", operator_name: "Casey Ross", paused_by_name: "Casey Ross", paused_at: "2026-11-20T12:05:00Z" }],
    bench: [{ job_id: "j-1060", run_id: "br1", is_open: true, started_at: "2026-11-20T13:10:00Z", ended_at: null, end_reason: null, operator_id: "u3", operator_name: "Robin Gallagher", on_machine: false, state: "on_bench" }],
    jobs: jobRows, bookings: BOOKINGS.filter((b) => b.status !== "complete").map((b) => ({ id: b.id, job_id: `j-${b.job_no.slice(2)}`, job_no: b.job_no, machine_id: b.machine_id, start_at: b.start_at, status: b.status })),
  }, TODAY, NOW);
}
export const SAMPLE_CLOCKED_IN = 5;
export const SAMPLE_TEAM: TeamRow[] = [
  { userId: "u-priya", name: "Priya Nair", now: { state: "on_job", jobNo: "J-1056", since: "2026-11-20T08:05:00Z" }, jobMinutes: 1950, paidMinutes: 2310, onJobsPercent: 84, jobsFinished: 3, daysWorked: 4 },
  { userId: "u-jordan", name: "Jordan Mackay", now: { state: "on_job", jobNo: "J-1051", since: "2026-11-20T08:20:00Z" }, jobMinutes: 1805, paidMinutes: 2250, onJobsPercent: 80, jobsFinished: 2, daysWorked: 4 },
  { userId: "u-casey", name: "Casey Ross", now: { state: "on_break", since: "2026-11-20T12:05:00Z" }, jobMinutes: 1420, paidMinutes: 2160, onJobsPercent: 66, jobsFinished: 1, daysWorked: 4 },
  { userId: "u-robin", name: "Robin Gallagher", now: { state: "on_job", jobNo: "J-1060", since: "2026-11-20T13:10:00Z" }, jobMinutes: 1210, paidMinutes: 1980, onJobsPercent: 61, jobsFinished: 0, daysWorked: 4 },
  { userId: "u-lee", name: "Lee Menzies", now: { state: "out" }, jobMinutes: 960, paidMinutes: 1620, onJobsPercent: 59, jobsFinished: 1, daysWorked: 3 },
  { userId: "u-morgan", name: "Morgan Sutherland", now: { state: "clocked_in", since: "2026-11-20T13:55:00Z" }, jobMinutes: 410, paidMinutes: 1100, onJobsPercent: 37, jobsFinished: 0, daysWorked: 3 },
];

/* ------------------------------------------------------------------ roles, tiles, links ------------------------------------------------------------------ */
export const roleKind = (r: Role): DashboardRole => (r === "office" ? "office" : r === "admin" ? "admin" : "workshop");
export const ROLE_LABEL: Record<Role, string> = { admin: "Admin", office: "Office", workshop: "Workshop", viewer: "Viewer" };
/** Whether a tile or link is a link for this person (the real canOpen: lib/destinations, no hidden sections or menu items unless the preview sets them). */
export const makeCanOpen = (role: Role, hiddenSections: readonly string[] = [], hiddenNav: readonly string[] = []) => (href: string) => canOpenDestination(href, { activeRole: role, hiddenSections, hiddenNav });
/** Changes apply to everyone in the company (admin and office); everyone else changes their own view on this device only (components/column-toggle.tsx). */
export const COMPANY_DISPLAY_ROLES: readonly Role[] = ["admin", "office"];
export const COLUMN_SCOPE_COMPANY = "Changes apply to everyone in this company.";
export const COLUMN_SCOPE_OWN = "Your own view on this device only. Everyone else, and the company setting, are not changed.";
export const resetLabel = (own: boolean) => (own ? "Reset to the company view" : "Reset to default (show all columns)");
export const NOTHING_NEEDS_YOU = "Nothing needs your attention right now.";
export const FAILED = "Couldn’t load this.";
export const LOADING = "Loading…";

export const LIGHT_COLOUR: Record<Light, string> = { green: COLOUR_TOKENS.green.light, amber: COLOUR_TOKENS.yellow.light, red: COLOUR_TOKENS.red.light, blue: COLOUR_TOKENS.blue.light, none: COLOUR_TOKENS.grey.light };
export const LIGHT_WORD: Record<Light, string> = { green: "Done", amber: "Watch", red: "Act now", blue: "In progress", none: "" };

/* ------------------------------------------------------------------ local building blocks (gaps in the shared set, listed in the report) ------------------------------------------------------------------ */
const NavCtx = createContext<(href: string) => void>(() => {});
/** The heading level of a panel: 3 under the Overview's section headings (h2), 2 where the page has no sections (Office, Workshop, Viewer). */
const LevelCtx = createContext<2 | 3>(3);
const Hn = ({ n, className, id, children }: { n: number; className?: string; id?: string; children: ReactNode }) => { const T = `h${n}` as "h2" | "h3" | "h4"; return <T className={className} id={id}>{children}</T>; };
const num = (value: number | null | undefined, loading: boolean) => (loading || value === null || value === undefined ? DASH : String(value));
const money = (value: number | null | undefined, loading: boolean) => (loading || value === null || value === undefined ? DASH : gbp(value, 0));
/** components/dashboard-charts.tsx kGbp: the axis and direct labels. */
export const kGbp = (value: number) => (Math.abs(value) >= 1000 ? `£${Math.round(value / 100) / 10}k` : `£${Math.round(value)}`);
const toneOfColour = (status: keyof typeof STATUS_MAP) => ({ green: "ok", yellow: "warn", red: "danger", blue: "info", purple: "progress", grey: "neutral" } as const)[STATUS_MAP[status].colour];
export const weekdayDay = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", timeZone: "Europe/London" }).format(new Date(`${date}T12:00:00Z`));

/** A link when its page opens for this person, otherwise the same content without a link. A plain click answers with the Preview only toast; Ctrl, Shift or middle click opens the real page. */
function A({ href, allowed = true, className, children, label, testId, kind, title, describedBy }: { href: string; allowed?: boolean; className?: string; children: ReactNode; label?: string; testId?: string; kind?: string; title?: string; describedBy?: string }) {
  const go = useContext(NavCtx);
  if (!allowed) return <div className={className} data-testid={testId}>{children}</div>;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (href.startsWith("#") || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(href);
  };
  return <a href={href} className={className} aria-label={label} title={title} aria-describedby={describedBy} onClick={onClick} data-testid={testId} data-href={href} data-kind={kind}>{children}</a>;
}

function useWidth(initial = 320): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(Math.max(160, Math.round(el.clientWidth)));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function Dot({ light }: { light: Light }) {
  return <i className={s.dot} style={{ background: LIGHT_COLOUR[light] }} aria-hidden="true" />;
}
const Word = ({ light }: { light: Light }) => (LIGHT_WORD[light] ? <span className={srOnly}> ({LIGHT_WORD[light]})</span> : null);

/** A headline figure: label, one figure in tabular numerals, one line of context. A link when its page opens for this person. The traffic light is a dot with its WORD. */
function Tile({ label, value, sub, hint, href, allowed, light = "none", testId, large }: { label: string; value: string; sub?: string; hint?: string; href?: string; allowed?: boolean; light?: Light; testId?: string; large?: boolean }) {
  const hintId = useId();
  const body = (
    <>
      <span className={s.tileLabel}>{label}{light !== "none" ? <span className={s.lightWord}><Dot light={light} />{LIGHT_WORD[light]}</span> : null}</span>
      <span className={cx(s.tileValue, tabularNumbers, large && s.tileValueLg)} data-kpi-value="">{value}</span>
      {sub ? <span className={s.tileSub}>{sub}</span> : null}
      {hint ? <span id={hintId} className={srOnly}>{hint}</span> : null}
    </>
  );
  return href && allowed
    ? <A href={href} className={s.tile} title={hint} describedBy={hint ? hintId : undefined} testId={testId}>{body}</A>
    : <div className={s.tile} title={hint} aria-describedby={hint ? hintId : undefined} data-testid={testId}>{body}</div>;
}

/** A panel: title (a link to the list it summarises when that page opens), one line of context on the right, the chart or list below. */
function Panel({ title, meta, href, allowed, children, testId, className }: { title: string; meta?: ReactNode; href?: string; allowed?: boolean; children: ReactNode; testId?: string; className?: string }) {
  const lvl = useContext(LevelCtx);
  const id = useId();
  return (
    <section className={cx(s.panel, className)} data-testid={testId} aria-labelledby={id}>
      <header className={s.panelHead}>
        <Hn n={lvl} className={s.panelTitle} id={id}>{href && allowed ? <A href={href} className={s.panelLink}>{title}</A> : title}</Hn>
        {meta ? <span className={cx(s.panelMeta, tabularNumbers)}>{meta}</span> : null}
      </header>
      <div className={s.panelBody}>{children}</div>
    </section>
  );
}
const Waiting = ({ children, tall }: { children: ReactNode; tall?: boolean }) => <p className={cx(s.waiting, tall && s.waitingTall)}>{children}</p>;

/** A closed disclosure for a chart's data table: the keyboard-reachable alternative to the picture. */
function DataTable({ summary, head, rows, testId }: { summary: string; head: string[]; rows: Array<Array<string>>; testId?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={s.dataAlt} data-testid={testId}>
      <Button size="sm" variant="quiet" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>{open ? "Hide data table" : "Show data table"}</Button>
      {open ? (
        <div id={id} className={s.dataWrap}>
          <ScrollTable label={summary} dense flush>
            <caption className={srOnly}>{summary}</caption>
            <thead><tr>{head.map((h, i) => <th key={h} scope="col" className={i ? s.right : undefined}>{h}</th>)}</tr></thead>
            <tbody>{rows.map((r) => <tr key={r[0]}>{r.map((c, i) => (i === 0 ? <th key={i} scope="row">{c}</th> : <td key={i} className={s.right}>{c}</td>))}</tr>)}</tbody>
          </ScrollTable>
        </div>
      ) : null}
    </div>
  );
}

/* ---- charts: hand-built SVG at the measured pixel width, direct labels, tabular figures, one navy series, no gradients ---- */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

function LineChart({ data, format, tickFormat, ticks, target, summary, height = 188 }: { data: Array<{ label: string; value: number | null }>; format: (v: number) => string; tickFormat?: (v: number) => string; ticks: number[]; target?: { value: number; label: string }; summary: string; height?: number }) {
  const [ref, w] = useWidth(360);
  const tid = useId();
  const L = 46, Rr = 18, T = 24, Bt = 28;
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (height - T - Bt);
  const x = (i: number) => L + 14 + (data.length < 2 ? 0 : (i * (w - L - Rr - 28)) / (data.length - 1));
  const pts = data.map((d, i) => (d.value === null ? null : { i, x: x(i), y: y(d.value), v: d.value }));
  const line = pts.filter((p): p is NonNullable<typeof p> => p !== null);
  const fmt = tickFormat ?? format;
  return (
    <div ref={ref} className={s.chart}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-labelledby={tid} className={s.svg}>
        <title id={tid}>{summary}</title>
        {ticks.map((t) => <g key={t}><line x1={L} x2={w - Rr} y1={y(t)} y2={y(t)} className={t === lo ? s.axisLine : s.gridLine} /><text x={L - 8} y={y(t) + 4} textAnchor="end" className={s.axisText}>{fmt(t)}</text></g>)}
        {target ? <g><line x1={L} x2={w - Rr} y1={y(target.value)} y2={y(target.value)} className={s.targetLine} /><text x={w - Rr} y={y(target.value) - 6} textAnchor="end" className={s.targetText}>{target.label}</text></g> : null}
        {line.length > 1 ? <polyline points={line.map((p) => `${p.x},${p.y}`).join(" ")} className={s.seriesLine} fill="none" /> : null}
        {data.map((d, i) => <text key={d.label} x={x(i)} y={height - 8} textAnchor="middle" className={s.axisText}>{d.label}</text>)}
        {line.map((p, k) => {
          const last = k === line.length - 1;
          const above = p.y > T + 14;
          return <g key={p.i}><circle cx={p.x} cy={p.y} r={last ? 5 : 3.5} className={cx(s.point, last && s.pointLast)} /><text x={p.x} y={above ? p.y - 10 : p.y + 20} textAnchor="middle" className={cx(s.valueText, last && s.valueLast)}>{format(p.v)}</text></g>;
        })}
      </svg>
    </div>
  );
}

function Sparkline({ points, summary }: { points: OwedPoint[]; summary: string }) {
  const [ref, w] = useWidth(320);
  const tid = useId();
  const H = 64, pad = 6;
  const vals = points.map((p) => p.owed);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const x = (i: number) => pad + (i * (w - pad * 2 - 6)) / Math.max(1, points.length - 1);
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo || 1)) * (H - pad * 2);
  const last = points[points.length - 1];
  return (
    <div ref={ref} className={s.chart}>
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-labelledby={tid} className={s.svg}>
        <title id={tid}>{summary}</title>
        <polyline points={points.map((p, i) => `${x(i)},${y(p.owed)}`).join(" ")} className={s.seriesLineThin} fill="none" />
        <circle cx={x(points.length - 1)} cy={y(last.owed)} r={3.5} className={cx(s.point, s.pointLast)} />
      </svg>
    </div>
  );
}

function ColumnChart({ data, summary, height = 176 }: { data: Array<{ date: string; count: number }>; summary: string; height?: number }) {
  const [ref, w] = useWidth(340);
  const tid = useId();
  const L = 30, Rr = 6, T = 22, Bt = 28;
  const max = Math.max(1, ...data.map((d) => d.count));
  const ticks = max <= 4 ? Array.from({ length: max + 1 }, (_, i) => i) : niceTicks(max);
  const hi = ticks[ticks.length - 1];
  const y = (v: number) => T + (1 - v / hi) * (height - T - Bt);
  const step = (w - L - Rr) / data.length;
  const bar = Math.min(26, step * 0.62);
  const every = step < 28 ? 3 : 2;
  return (
    <div ref={ref} className={s.chart}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-labelledby={tid} className={s.svg}>
        <title id={tid}>{summary}</title>
        {ticks.map((t) => <g key={t}><line x1={L} x2={w - Rr} y1={y(t)} y2={y(t)} className={t === 0 ? s.axisLine : s.gridLine} /><text x={L - 6} y={y(t) + 4} textAnchor="end" className={s.axisText}>{t}</text></g>)}
        {data.map((d, i) => {
          const cx0 = L + step * i + step / 2;
          return (
            <g key={d.date}>
              {d.count > 0 ? <rect x={cx0 - bar / 2} y={y(d.count)} width={bar} height={y(0) - y(d.count)} className={s.bar} /> : null}
              {d.count > 0 ? <text x={cx0} y={y(d.count) - 5} textAnchor="middle" className={s.valueText}>{d.count}</text> : null}
              {i % every === 0 ? <text x={cx0} y={height - 8} textAnchor="middle" className={s.axisText}>{weekdayDay(d.date)}</text> : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** One horizontal bar per row: label, bar, figure. The bar is decoration: the figure is text, so the list is its own data table. */
function BarRows({ rows, format = String, empty }: { rows: Array<{ key: string; label: string; value: number; light?: Light; colour?: string }>; format?: (v: number) => string; empty: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length || max === 0) return <p className={s.empty}>{empty}</p>;
  return (
    <ul className={s.bars}>
      {rows.map((r) => (
        <li key={r.key} className={s.barRow}>
          <span className={s.barLabel}>{r.light && r.light !== "none" ? <Dot light={r.light} /> : null}<span className={s.truncate}>{r.label}</span><Word light={r.light ?? "none"} /></span>
          <span className={s.barTrack} aria-hidden="true"><span className={s.barFill} style={{ width: `${(r.value / max) * 100}%`, background: r.colour ?? (r.light && r.light !== "none" ? LIGHT_COLOUR[r.light] : undefined) }} /></span>
          <span className={cx(s.barValue, tabularNumbers)}>{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function SplitBar({ parts }: { parts: AgeBucket[] }) {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  return (
    <div className={s.split} role="img" aria-label={total <= 0 ? "Nothing owed" : parts.filter((p) => p.value > 0).map((p) => `${p.label} ${gbp(p.value, 0)}`).join(", ")}>
      {parts.filter((p) => p.value > 0).map((p) => <span key={p.key} className={s.splitPart} style={{ width: `${(p.value / total) * 100}%`, background: LIGHT_COLOUR[p.light] }} />)}
    </div>
  );
}

/** A thin, honest notice (the shared set has no inline Callout yet): role=alert, a plain bar, the words, an optional action. */
function Notice({ children, action, tone = "danger", testId }: { children: ReactNode; action?: ReactNode; tone?: "danger" | "warn"; testId?: string }) {
  return <div role="alert" className={cx(s.notice, s[`notice_${tone}`])} data-testid={testId}><p>{children}</p>{action}</div>;
}

/* ------------------------------------------------------------------ the views ------------------------------------------------------------------ */
type Att = { data: AttentionSection[] | null; loading: boolean; error: boolean };
type ViewProps = {
  role: Role; office?: boolean; d: AdminData | null; loading: boolean; error: boolean; att: Att; isVisible: (key: string) => boolean; canOpen: (href: string) => boolean;
  retry: () => void; basis: Basis; setBasis: (b: Basis) => void; clockedIn: number | null; team: TeamRow[] | null;
};
const readsClocks = (r: Role) => r === "admin" || r === "office";
const nowText = (now: TeamRow["now"]) => (now.state === "on_job" ? `On ${now.jobNo} since ${localTimeOf(now.since)}` : now.state === "on_break" ? `On a break since ${localTimeOf(now.since)}` : now.state === "clocked_in" ? `Clocked in, not on a job, since ${localTimeOf(now.since)}` : "Not clocked in");
const NOW_LIGHT: Record<TeamRow["now"]["state"], Light> = { on_job: "blue", clocked_in: "amber", on_break: "amber", out: "none" };

function LeakRow({ leaks, canOpen }: { leaks: Leak[]; canOpen: (href: string) => boolean }) {
  return (
    <div className={s.leaks} data-testid="overview-leaks">
      {leaks.map((leak) => {
        const linkable = !leak.failed && leak.href !== "#" && canOpen(leak.href);
        const body = (
          <>
            <span className={s.leakLabel}>{leak.label}{leak.alarm ? <span className={s.alarm}><Dot light="red" />{leak.alarm}</span> : null}</span>
            <span className={cx(s.leakCount, tabularNumbers)} data-testid={`leak-count-${leak.id}`}>{leak.count === null ? DASH : leak.count}{leak.extra ? <span className={s.leakExtra}>{leak.extra}</span> : null}</span>
            <span className={s.leakDetail}>{leak.detail}</span>
            {linkable ? <span className={s.leakAction}>{leak.action}</span> : null}
          </>
        );
        return linkable ? <A key={leak.id} href={leak.href} className={s.leak} testId={`leak-${leak.id}`}>{body}</A> : <div key={leak.id} className={s.leak} data-testid={`leak-${leak.id}`}>{body}</div>;
      })}
    </div>
  );
}

function OthersRow({ others, loading, canOpen }: { others: OtherAttention[] | null; loading: boolean; canOpen: (href: string) => boolean }) {
  const lvl = useContext(LevelCtx);
  return (
    <div className={s.others} data-testid="overview-others">
      <Hn n={lvl} className={typeScale.label}>Also counted in Today</Hn>
      {others === null ? <p className={cx(typeScale.secondary, s.muted)}>{loading ? LOADING : `${DASH} ${FAILED}`}</p> : !others.length ? <p className={cx(typeScale.secondary, s.muted)}>Nothing else needs you.</p> : (
        <ul className={s.othersList}>
          {others.map((o) => {
            const body = <><span className={s.otherLabel}>{o.label}</span><span className={cx(typeScale.name, s.otherCount, tabularNumbers)} data-testid={o.kind === "rule" ? `other-count-${o.id}` : undefined}>{o.kind === "rule" ? o.count : null}</span></>;
            return <li key={o.id}>{canOpen(o.href) ? <A href={o.href} className={s.otherRow} testId={`other-${o.id}`}>{body}</A> : <span className={cx(s.otherRow, s.otherPlain)} data-testid={`other-${o.id}`}>{body}</span>}</li>;
          })}
        </ul>
      )}
    </div>
  );
}

/** The "Needs your attention" card (rules: lib/attention-items). */
function AttentionList({ att, extra, extraFailed, extraLoading, canOpen, retry }: { att: Att; extra: AttentionItem[]; extraFailed: boolean; extraLoading: boolean; canOpen: (href: string) => boolean; retry: () => void }) {
  const lvl = useContext(LevelCtx);
  const sections = att.data ?? [];
  const total = sections.reduce((sum, x) => sum + x.count, 0) + extra.length;
  const anyFailed = extraFailed || sections.some((x) => x.failed);
  const state = attentionState(total, anyFailed);
  const loading = att.loading || extraLoading;
  return (
    <Panel title="Needs your attention" testId="needs-attention" className={s.attention}>
      {loading ? <p className={s.muted}>{LOADING}</p> : null}
      {att.error ? <Notice tone="warn" action={<Button size="sm" variant="secondary" onClick={retry}>Retry</Button>}>Needs attention couldn&rsquo;t be loaded. Don&rsquo;t treat it as all clear.</Notice> : null}
      {!loading && !att.error && state === "clear" ? <p className={s.muted}>{NOTHING_NEEDS_YOU}</p> : null}
      {!loading && !att.error && state === "incomplete" && !sections.some((x) => x.failed) ? <Notice tone="warn">Some of this list couldn&rsquo;t be loaded, so it may be incomplete. Don&rsquo;t treat it as all clear.</Notice> : null}
      <div className={s.attentionGrid}>
        {extra.length ? <div className={cx(s.attnSection, s.attnExtra)}>{extra.map((item) => <A key={item.key} href={item.href} allowed={canOpen(item.href)} className={s.attnRow}><span className={s.attnTitle}>{item.title}</span><span className={s.attnDetail}>{item.detail}</span></A>)}</div> : null}
        {sections.map((sec) => (sec.failed || sec.count > 0) ? (
          <div key={sec.id} className={s.attnSection} data-testid={`attention-${sec.id}`}>
            <div className={s.attnHead}>
              <Hn n={lvl} className={s.attnHeading}>{sec.title}{sec.failed ? null : <span className={cx(s.countChip, tabularNumbers)} data-testid={`attention-count-${sec.id}`}>{sec.count}</span>}</Hn>
              {!sec.failed && canOpen(sec.href) ? <A href={sec.href} className={s.viewAll}>View all<span className={srOnly}> {sec.title}</span></A> : null}
            </div>
            {sec.failed ? <p className={s.muted}>Couldn&rsquo;t load this list. <button type="button" className={s.textBtn} onClick={retry}>Retry</button></p> : null}
            {sec.items.map((item) => <A key={item.key} href={item.href} allowed={canOpen(item.href)} className={s.attnRow}><span className={s.attnTitle}>{item.title}</span><span className={s.attnDetail}>{item.detail}</span></A>)}
            {!sec.failed && sec.count > sec.items.length ? <p className={s.more}>and {sec.count - sec.items.length} more, oldest shown first</p> : null}
          </div>
        ) : null)}
      </div>
    </Panel>
  );
}

function JumpNav({ present }: { present: string[] }) {
  const [current, setCurrent] = useState<string>(present[0] ?? "today");
  useEffect(() => {
    const nodes = present.map((id) => document.getElementById(id)).filter((n): n is HTMLElement => Boolean(n));
    if (!nodes.length || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const shown = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (shown[0]) setCurrent(shown[0].target.id);
    }, { rootMargin: "-140px 0px -55% 0px" });
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [present]);
  const links = OVERVIEW_SECTIONS.filter((x) => present.includes(x.id));
  if (links.length < 2) return null;
  const go = (id: string) => {
    setCurrent(id);
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(id)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };
  return (
    <div className={s.jump} data-testid="overview-jump">
      <Tabs label="Jump to" value={current} onChange={go} tabs={links.map((x) => ({ value: x.id, label: x.label, controls: x.id, testId: `jump-${x.id}` }))} />
    </div>
  );
}

function Section({ id, title, figure, sub, href, linkLabel, canOpen, children }: { id: string; title: string; figure?: string; sub: string; href?: string; linkLabel?: string; canOpen: (href: string) => boolean; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={s.section} data-testid={`overview-${id}`}>
      <header className={s.sectionHead}>
        <h2 id={`${id}-title`} className={cx(typeScale.section, s.sectionTitle)}>{title}</h2>
        {figure ? <p className={cx(s.sectionFigure, tabularNumbers)} data-testid={`overview-${id}-figure`}>{figure}</p> : null}
        <p className={cx(typeScale.secondary, s.sectionSub)}>{sub}</p>
        {href && linkLabel && canOpen(href) ? <A href={href} className={s.sectionLink}>{linkLabel}</A> : null}
      </header>
      {children}
    </section>
  );
}

function TeamWeekPanel({ rows, canOpen }: { rows: TeamRow[] | null; canOpen: (href: string) => boolean }) {
  const most = rows ? Math.max(0, ...rows.map((r) => r.jobMinutes)) : 0;
  const totalJob = rows ? rows.reduce((sum, r) => sum + r.jobMinutes, 0) : 0;
  return (
    <Panel title="Team this week" meta={rows ? `${hm(totalJob)} on jobs · only admins see this` : "Only admins see this"} href="/time/week" allowed={canOpen("/time/week")} testId="team-week">
      {!rows ? <Waiting>{LOADING}</Waiting> : !rows.length ? <Waiting>Nobody has clocked in this week yet.</Waiting> : (
        <ScrollTable label="Team this week" dense flush>
          <thead><tr><th scope="col">Person</th><th scope="col">Right now</th><th scope="col">Time on jobs</th><th scope="col" className={s.right}>Paid hours</th><th scope="col" className={s.right} title="Share of clocked time spent on jobs">On jobs</th><th scope="col" className={s.right}>Jobs finished</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.userId}>
              <th scope="row"><span className={s.personName}>{r.name}</span><span className={s.personSub}>{r.daysWorked} day{r.daysWorked === 1 ? "" : "s"} worked</span></th>
              <td><span className={s.nowCell}><Dot light={NOW_LIGHT[r.now.state]} />{nowText(r.now)}</span></td>
              <td><span className={s.timeCell}><span className={s.miniTrack} aria-hidden="true"><span className={s.miniFill} style={{ width: `${most ? (r.jobMinutes / most) * 100 : 0}%` }} /></span><span className={s.timeFig}>{hm(r.jobMinutes)}</span></span></td>
              <td className={s.right}>{hm(r.paidMinutes)}</td>
              <td className={s.right}>{r.onJobsPercent === null ? DASH : `${r.onJobsPercent}%`}</td>
              <td className={s.right}><b>{r.jobsFinished}</b></td>
            </tr>))}</tbody>
        </ScrollTable>
      )}
    </Panel>
  );
}

function AdminView({ role, office = false, d, loading, error, att, isVisible, canOpen, retry, basis, setBasis, clockedIn, team }: ViewProps) {
  const overdueOwed = overdueFromBuckets(d?.owedByAge ?? null);
  const series = basis === "invoiced" ? d?.invoiced ?? null : d?.revenue ?? null;
  const thisMonthSeries = basis === "invoiced" ? d?.thisMonthInvoiced : d?.thisMonthRevenue;
  const revenueTotal = series ? series.reduce((sum, row) => sum + row.revenue, 0) : null;
  const pipe = d?.pipeline;
  const failedSub = loading ? LOADING : FAILED;
  const waiting = loading ? LOADING : FAILED;
  const revenueCompare = revenueVsLastMonth(series, loading, (v) => gbp(v, 0), basis);
  const fleet = fleetLoad(d?.machines ?? null, loading);
  const daysAvg = d?.daysToPay?.average ?? null;
  const won = d?.quotesWon ?? null;
  const estimate = d?.vsEstimate ?? null;
  const lastOnTime = d?.onTime ? [...d.onTime].reverse().find((m) => m.percent !== null)?.percent ?? null : null;
  const vis = isVisible;

  // Tiles, as the real page builds them (label, figure, context, link, light).
  const kpiMoneyOwed = <Tile key="money-owed" label="Money owed" value={money(d?.moneyOwed, loading)} sub={d?.unpaidInvoices != null ? `Across ${d.unpaidInvoices} invoice${d.unpaidInvoices === 1 ? "" : "s"}${overdueOwed ? `, ${gbp(overdueOwed, 0)} overdue` : ""}` : "Unpaid invoices"} hint="Green: nothing overdue. Red: money is past its due date." href="/invoices" allowed={canOpen("/invoices")} light={lights.moneyOwed(d?.moneyOwed ?? null, overdueOwed)} testId="tile-money-owed" />;
  const kpiRfqs = <Tile key="rfqs-to-quote" label="RFQs to quote" value={num(d?.rfqsToQuote, loading)} sub="Outstanding: no quote yet" href="/rfq" allowed={canOpen("/rfq")} light={d?.rfqsToQuote ? "amber" : "none"} testId="tile-rfqs-to-quote" />;
  const kpiOpenJobs = <Tile key="open-jobs" label="Open jobs" value={num(d?.openJobs, loading)} sub={d?.dueThisWeek != null ? `${d.dueThisWeek} due by ${fmtDueBy(d.dueBy)}${d.jobsStatus?.overdue ? `, ${d.jobsStatus.overdue} late` : ""}` : "Not started, running or waiting"} hint="Not started + Running + Waiting for inspection. Complete jobs are not counted. Due by: a required or due date from today (included) to that day. Late: not finished and past its required date, the Job Board's Late. Amber: something due within 7 days. Red: something late." href="/jobs" allowed={canOpen("/jobs")} light={lights.openJobs(d?.jobsStatus ?? null)} testId="tile-open-jobs" />;
  const kpiOpenQuotes = <Tile key="open-quotes" label="Open quotes" value={num(d?.openQuotes, loading)} sub={d?.pipelineValue != null ? `${gbp(d.pipelineValue, 0)} awaiting reply` : "Sent, awaiting reply"} href="/quotes" allowed={canOpen("/quotes")} testId="tile-open-quotes" />;
  const stat = (key: string, label: string, value: string, sub: string, href: string, light: Light) => <Tile key={key} label={label} value={value} sub={sub} href={href} allowed={canOpen(href)} light={light} testId={`tile-${key}`} />;
  const statTiles: Record<string, ReactNode> = {
    "this-month-revenue": stat("this-month-revenue", `This month, ${basis === "invoiced" ? "invoiced ex VAT" : "received"}`, money(thisMonthSeries, loading), revenueCompare.detail, "/invoices", "none"),
    "quotes-sent": stat("quotes-sent", "Quotes sent", num(d?.quotesSentThisMonth, loading), "Sent this month", "/quotes", "none"),
    "jobs-late-on-time": stat("jobs-late-on-time", "Jobs late / on time", d && d.lateJobs !== null && d.onTimeJobs !== null ? `${d.lateJobs} / ${d.onTimeJobs}` : DASH, "Jobs not finished, by required date", "/jobs", d && d.lateJobs !== null ? (d.lateJobs ? "red" : "green") : "none"),
    "avg-days-to-pay": stat("avg-days-to-pay", "Average days to pay", daysAvg !== null && !loading ? `${Math.round(daysAvg)} days` : DASH, !d?.daysToPay || loading ? failedSub : d.daysToPay.count ? `Invoice date to paid, ${d.daysToPay.count} paid in the last 90 days` : "Nothing paid in the last 90 days", "/invoices", lights.daysToPay(loading ? null : daysAvg)),
    "quotes-won": stat("quotes-won", "Quotes won", won && !loading ? String(won.count) : DASH, !won || loading ? failedSub : `Accepted this month${won.undated ? ` · ${won.undated} accepted with no date not counted` : ""}`, "/quotes", "none"),
    "jobs-vs-estimate": stat("jobs-vs-estimate", "Jobs vs estimate", estimate?.value && !loading ? `${estimate.value.percent}%` : DASH,
      !estimate || loading ? failedSub : estimate.value ? `Run time of planned, ${estimate.value.jobs} job${estimate.value.jobs === 1 ? "" : "s"} finished in 90 days, ${estimate.value.over} over` : "No finished job in 90 days has both a plan and run time", "/jobs",
      !estimate?.value || loading ? "none" : estimate.value.percent > 110 ? "red" : estimate.value.percent > 100 ? "amber" : "green"),
  };
  const pmh = d?.perMachineHour ?? null;
  const perHourTile = <Tile key="per-machine-hour" label="£ per machine hour" value={pmh?.value && !loading ? gbp(pmh.value.perHour, 0) : DASH}
    sub={!pmh || loading ? failedSub : pmh.value ? `${gbp(pmh.value.revenue, 0)} invoiced over ${pmh.value.hours}h on ${pmh.value.jobs} job${pmh.value.jobs === 1 ? "" : "s"}, last 90 days` : "No job invoiced in 90 days has recorded run time"} href="/invoices" allowed={canOpen("/invoices")} testId="tile-per-machine-hour" />;

  /* panels */
  const revenuePanel = (
    <Panel key="revenue" title="Revenue, last 6 months" href="/invoices" allowed={canOpen("/invoices")} testId="panel-revenue" className={s.wide2}
      meta={<span className={s.metaGroup}><SegmentedControl label="Revenue shown as" value={basis} size="md" onChange={setBasis} options={[{ value: "invoiced", label: "Invoiced ex VAT", testId: "revenue-basis-invoiced" }, { value: "received", label: "Received", testId: "revenue-basis-received" }]} /><span data-testid="revenue-total">{revenueTotal !== null ? `${gbp(revenueTotal, 0)} ${basis === "invoiced" ? "invoiced" : "received"}` : DASH}</span></span>}>
      {series ? (
        <>
          <LineChart data={series.map((p) => ({ label: p.month, value: p.revenue }))} format={kGbp} ticks={niceTicks(Math.max(...series.map((p) => p.revenue), 0))}
            summary={`${basis === "invoiced" ? "Invoiced ex VAT" : "Received"} by month: ${series.map((p) => `${p.month} ${gbp(p.revenue, 0)}`).join(", ")}.`} />
          <DataTable testId="revenue-table" summary={`${basis === "invoiced" ? "Invoiced ex VAT" : "Received"} by month`} head={["Month", basis === "invoiced" ? "Invoiced ex VAT" : "Received"]} rows={series.map((p) => [p.month, gbp(p.revenue, 0)])} />
        </>
      ) : <Waiting tall>{waiting}</Waiting>}
    </Panel>
  );
  const trend = d?.owedTrend;
  const trendBlock = loading || !d || trend?.state === "missing" ? null : !trend ? <p className={cx(s.trend, s.muted)} data-testid="owed-trend">{DASH} {FAILED}</p>
    : trend.points.length < 2 ? <p className={cx(s.trend, s.muted)} data-testid="owed-trend">The trend starts once two nightly figures have been taken.</p> : (
      <div className={s.trend} data-testid="owed-trend">
        <p className={s.trendLine}>Owed each night, {trend.points.length} nights from {fmtDueBy(trend.points[0].date)}</p>
        <Sparkline points={trend.points} summary={`Owed each night, ${trend.points.length} nights from ${fmtDueBy(trend.points[0].date)}: latest ${gbp(trend.points[trend.points.length - 1].owed, 0)}, lowest ${gbp(Math.min(...trend.points.map((p) => p.owed)), 0)}, highest ${gbp(Math.max(...trend.points.map((p) => p.owed)), 0)}.`} />
        <DataTable summary="Money owed each night" head={["Night", "Owed"]} rows={[...trend.points].reverse().map((p) => [fmtDueBy(p.date), gbp(p.owed, 0)])} />
      </div>);
  const owedPanel = (
    <Panel key="owed" title="Money owed by age" meta={d?.moneyOwed != null ? gbp(d.moneyOwed, 0) : undefined} href="/invoices" allowed={canOpen("/invoices")} testId="panel-owed">
      {d?.owedByAge && !d.owedByAge.some((b) => b.value > 0) ? <p className={s.empty}>Nothing owed.</p> : d?.owedByAge ? (
        <div className={s.stack}>
          <SplitBar parts={d.owedByAge} />
          <ul className={s.ageList}>{d.owedByAge.map((b) => <li key={b.key}><span className={s.ageLabel}><Dot light={b.value > 0 ? b.light : "none"} />{b.label}</span><span className={cx(s.barValue, tabularNumbers)}>{gbp(b.value, 0)}</span></li>)}</ul>
        </div>
      ) : <p className={s.empty}>{waiting}</p>}
      {trendBlock}
    </Panel>
  );
  const quotesPanel = (
    <Panel key="quotes" title="Quotes, last 90 days" meta={d?.quotes90?.winRate != null ? `Win rate ${d.quotes90.winRate}%` : undefined} href="/quotes" allowed={canOpen("/quotes")} testId="panel-quotes">
      {d?.quotes90 ? <BarRows rows={d.quotes90.outcomes.map((o) => ({ key: o.key, label: o.label, value: o.count, light: o.key === "accepted" ? "green" as const : o.key === "expired" ? "amber" as const : o.key === "rejected" ? "none" as const : undefined, colour: o.key === "sent" ? "var(--ui-accent)" : undefined }))} empty="No quotes sent in the last 90 days." /> : <p className={s.empty}>{waiting}</p>}
    </Panel>
  );
  const jobsStatusPanel = (
    <Panel key="jobs-status" title="Open jobs by status" meta={d?.jobsStatus ? `${d.jobsStatus.notStarted + d.jobsStatus.running + d.jobsStatus.waiting} open` : undefined} href="/jobs" allowed={canOpen("/jobs")} testId="panel-jobs-status">
      {d?.jobsStatus ? <BarRows rows={[
        { key: "not-started", label: "Not started", value: d.jobsStatus.notStarted, colour: "var(--ui-neutral)" },
        { key: "running", label: "Running", value: d.jobsStatus.running, colour: "var(--ui-accent)" },
        { key: "waiting", label: "Waiting for inspection", value: d.jobsStatus.waiting, light: "amber" },
        { key: "overdue", label: "Late", value: d.jobsStatus.overdue, light: "red" },
      ]} empty="No open jobs." /> : <p className={s.empty}>{waiting}</p>}
    </Panel>
  );
  const onTimePanel = (
    <Panel key="on-time" title="Finished on time" testId="panel-on-time" meta={lastOnTime !== null ? <span className={s.metaDot}><Dot light={lights.percent(lastOnTime, 95, 85)} />{lastOnTime}% latest month</span> : undefined}>
      {d?.onTime ? (
        <>
          <LineChart data={d.onTime.map((m) => ({ label: m.month, value: m.percent }))} format={(v) => `${v}%`} ticks={[0, 50, 100]} target={{ value: 95, label: "Target 95%" }} height={176}
            summary={`Share of jobs finished on time by month: ${d.onTime.map((m) => `${m.month} ${m.percent === null ? "no dated jobs" : `${m.percent}%`}`).join(", ")}. Target 95%.`} />
          <DataTable summary="Finished on time by month" head={["Month", "On time", "Dated jobs finished"]} rows={d.onTime.map((m) => [m.month, m.percent === null ? "No dated jobs" : `${m.percent}%`, String(m.finished)])} />
        </>
      ) : <Waiting tall>{waiting}</Waiting>}
      <p className={s.note}>Finished jobs only: finished on or before their required date. Jobs with no date are left out.</p>
    </Panel>
  );
  const rftPanel = (
    <Panel key="rft" title="Right first time" meta="Last 6 months" testId="panel-rft">
      {d?.rft ? (d.rft.percent === null ? <p className={s.empty}>No inspections in the last 6 months.</p> : (
        <div className={s.rft}>
          <p className={s.rftFigure}><Dot light={lights.percent(d.rft.percent, 95, 85)} /><span className={tabularNumbers}>{d.rft.percent}%</span><Word light={lights.percent(d.rft.percent, 95, 85)} /></p>
          <p className={s.muted}>{d.rft.jobs} job{d.rft.jobs === 1 ? "" : "s"} inspected, {d.rft.failedFirst} failed first inspection</p>
        </div>
      )) : <p className={s.empty}>{waiting}</p>}
    </Panel>
  );
  const workDuePanel = (
    <Panel key="work-due" title="Work coming due" meta="Next 14 days" href="/jobs" allowed={canOpen("/jobs")} testId="panel-work-due">
      {d?.workDue ? (
        <>
          <ColumnChart data={d.workDue} summary={`Open jobs coming due per day over the next 14 days: ${d.workDue.filter((x) => x.count).map((x) => `${weekdayDay(x.date)} ${x.count}`).join(", ") || "none"}.`} />
          <DataTable summary="Open jobs coming due per day" head={["Day", "Jobs due"]} rows={d.workDue.map((x) => [weekdayDay(x.date), String(x.count)])} />
        </>
      ) : <Waiting tall>{waiting}</Waiting>}
    </Panel>
  );
  const machinePanel = (
    <Panel key="machine-load" title="Machine load this week" href="/schedule" allowed={canOpen("/schedule")} testId="panel-machine-load" meta={<span data-testid="machine-load-overall">{fleet.percent === null ? DASH : fleet.detail}</span>}>
      {d?.machines ? <BarRows rows={d.machines.map((m) => ({ key: m.id, label: m.name, value: m.percent, light: m.percent > 100 ? "red" as const : m.percent >= 85 ? "amber" as const : "green" as const }))} format={(v) => `${v}%`} empty="No machines booked this week." /> : <p className={s.empty}>{waiting}</p>}
    </Panel>
  );
  const customersPanel = (
    <Panel key="customers" title="Top customers" testId="panel-customers" meta={<span data-testid="top-customer-share">{d?.customers?.share != null && !loading ? `Largest ${d.customers.share}% of invoiced` : "Invoiced ex VAT, last 6 months"}</span>}>
      {d?.customers ? <BarRows rows={d.customers.rows.map((c) => ({ key: c.customer, label: c.customer, value: c.value }))} format={(v) => gbp(v, 0)} empty="Nothing invoiced in the last 6 months." /> : <p className={s.empty}>{waiting}</p>}
      <p className={s.note}>Invoiced ex VAT in the last 6 months, credit notes taken off.</p>
    </Panel>
  );
  const cuttingPanel = (
    <Panel key="cutting" title="Cutting time this week" href="/schedule" allowed={canOpen("/schedule")} testId="panel-cutting" meta={<span data-testid="cutting-total">{d?.cutting && !loading ? `${d.cutting.total}h recorded` : DASH}</span>}>
      {d?.cutting ? <BarRows rows={d.cutting.machines.map((m) => ({ key: m.id, label: m.name, value: m.hours, colour: "var(--ui-brand)" }))} format={(v) => `${v}h`} empty="No machine runs recorded this week." /> : <p className={s.empty}>{waiting}</p>}
      <p className={s.note}>Recorded machine runs, paused time left out. Machine load is the booked hours.</p>
    </Panel>
  );
  const pipelinePanel = (
    <Panel key="pipeline" title="Quote pipeline" href="/quotes" allowed={canOpen("/quotes")} testId="panel-pipeline">
      <A href="/quotes" allowed={canOpen("/quotes")} className={s.pipeline}>
        {([["RFQs outstanding", pipe?.rfqs], ["Quotes awaiting reply", pipe?.quoted], ["Accepted", pipe?.accepted], ...(office ? [] : [["Invoices paid", pipe?.paid]])] as Array<[string, number | null | undefined]>).map(([label, value]) => (
          <span key={label} className={s.pipeCell}><span className={s.pipeLabel}>{label}</span><span className={cx(s.pipeValue, tabularNumbers)}>{num(value, loading)}</span></span>
        ))}
      </A>
    </Panel>
  );
  const attentionCard = <AttentionList key="attention" att={att} extra={d?.attention ?? []} extraFailed={d?.attentionFailed ?? false} extraLoading={loading} canOpen={canOpen} retry={retry} />;
  const errorNotice = error ? <Notice testId="dashboard-error" action={<Button size="sm" variant="secondary" onClick={retry}>Retry</Button>}>Couldn&rsquo;t load the dashboard.</Notice> : null;
  const tileRow = (tiles: ReactNode[]) => tiles.length ? <div className={s.tiles} data-count={tiles.length > 4 ? "many" : tiles.length}>{tiles}</div> : null;
  const panelGrid = (panels: ReactNode[]) => panels.length ? <div className={s.panels} data-count={Math.min(panels.length, 3)}>{panels}</div> : null;

  if (!office) {
    const showLeaks = vis("leaks"), showAttention = vis("needs-attention"), showPipeline = vis("quote-pipeline");
    const moneyTiles = [vis("money-owed") && kpiMoneyOwed, vis("this-month-revenue") && statTiles["this-month-revenue"], vis("avg-days-to-pay") && statTiles["avg-days-to-pay"]].filter(Boolean) as ReactNode[];
    const moneyPanels = [vis("revenue-trend") && revenuePanel, vis("money-by-age") && owedPanel, vis("top-customers") && customersPanel].filter(Boolean) as ReactNode[];
    const workTiles = [vis("open-jobs") && kpiOpenJobs, vis("open-quotes") && kpiOpenQuotes, ...["quotes-sent", "jobs-late-on-time", "quotes-won", "jobs-vs-estimate"].map((k) => vis(k) && statTiles[k])].filter(Boolean) as ReactNode[];
    const workPanels = [vis("quote-outcomes") && quotesPanel, vis("jobs-by-status") && jobsStatusPanel, vis("on-time-delivery") && onTimePanel, vis("right-first-time") && rftPanel, vis("work-due") && workDuePanel, showPipeline && pipelinePanel].filter(Boolean) as ReactNode[];
    const machineTiles = [vis("per-machine-hour") && perHourTile].filter(Boolean) as ReactNode[];
    const machinePanels = [vis("machine-load") && machinePanel, vis("cutting-time") && cuttingPanel].filter(Boolean) as ReactNode[];
    const present = [(showLeaks || showAttention) && "today", (moneyTiles.length || moneyPanels.length) && "money", (workTiles.length || workPanels.length) && "work", (machineTiles.length || machinePanels.length) && "machines", vis("team-week") && "people"].filter((x): x is string => typeof x === "string");
    const overdueNow = loading ? null : overdueOwed;
    const leaks = leaksFrom(att.data, { rfqsToQuote: loading ? null : d?.rfqsToQuote ?? null, overdueOwed: overdueNow, money: (v) => gbp(v, 0) }, att.error);
    const summary = attentionSummary(att.data, loading ? { count: null, failed: false } : d ? { count: d.attention.length, failed: d.attentionFailed } : { count: null, failed: true }, att.error);
    const peopleFigure = floorNow(clockedIn === null ? null : { clockedIn }, loading).figure;
    const others = otherAttention(att.data, loading || !d ? { items: null, failed: !loading } : { items: d.attention, failed: d.attentionFailed }, att.error);
    return (
      <>
        {errorNotice}
        <JumpNav present={present} />
        {present.includes("today") ? <Section id="today" title="Today" figure={summary.total === null ? `${DASH} ${summary.detail}` : summary.detail} sub="Where work and money are slipping, and what needs doing" canOpen={canOpen}>
          {showLeaks ? <div className={s.todayStack}><LeakRow leaks={leaks} canOpen={canOpen} /><OthersRow others={others} loading={loading || att.loading} canOpen={canOpen} /></div> : null}
          {showAttention ? attentionCard : null}
        </Section> : null}
        {present.includes("money") ? <Section id="money" title="Money" sub="What's coming in, from whom, and what's still owed" href="/invoices" linkLabel="Open invoicing" canOpen={canOpen}>{tileRow(moneyTiles)}{panelGrid(moneyPanels)}</Section> : null}
        {present.includes("work") ? <Section id="work" title="Work" sub="Winning it, making it, and getting it out on time" href="/jobs" linkLabel="Open the Job Board" canOpen={canOpen}>{tileRow(workTiles)}{panelGrid(workPanels)}</Section> : null}
        {present.includes("machines") ? <Section id="machines" title="Machines" sub="How busy each machine is this week, and what its time earns" href="/schedule" linkLabel="Machine schedule" canOpen={canOpen}>{tileRow(machineTiles)}{panelGrid(machinePanels)}</Section> : null}
        {present.includes("people") ? <Section id="people" title="People" figure={readsClocks(role) ? peopleFigure : undefined} sub="This week, from clock-ins · only admins see this" href="/time/week" linkLabel="Weekly hours" canOpen={canOpen}><TeamWeekPanel rows={loading ? null : team} canOpen={canOpen} /></Section> : null}
      </>
    );
  }

  // Office: one flat page, as the real page arranges it.
  const kpis = [vis("rfqs-to-quote") && kpiRfqs, vis("open-jobs") && kpiOpenJobs, vis("open-quotes") && kpiOpenQuotes].filter(Boolean) as ReactNode[];
  const opsRow = [vis("jobs-by-status") && jobsStatusPanel, vis("on-time-delivery") && onTimePanel, vis("right-first-time") && rftPanel].filter(Boolean) as ReactNode[];
  const loadRow = [vis("machine-load") && machinePanel, vis("work-due") && workDuePanel].filter(Boolean) as ReactNode[];
  const showAttention = vis("needs-attention"), showPipeline = vis("quote-pipeline");
  return (
    <>
      {errorNotice}
      {kpis.length ? <div className={s.tiles} data-count={kpis.length}>{kpis}</div> : null}
      {vis("quote-outcomes") ? <div className={s.panels} data-count={1}>{quotesPanel}</div> : null}
      {panelGrid(opsRow)}
      {panelGrid(loadRow)}
      {showAttention || showPipeline ? <div className={s.attnPipe} data-both={showAttention && showPipeline ? "1" : "0"}>{showAttention ? attentionCard : null}{showPipeline ? pipelinePanel : null}</div> : null}
    </>
  );
}

/** My jobs (shop-floor tablet): one card per job, one big main action. Every action only opens the job on the Job Board (/jobs?job=<id>). */
const jobHrefOf = (job: { id: string }) => `/jobs?job=${encodeURIComponent(job.id)}`;
const DUE_WORD = Object.fromEntries(DUE_CHIPS.map((c) => [c.value, c.label])) as Record<MyJob["dueLight"], string>;
/** components/workshop/my-job-extras.tsx problemControls: a role that can't raise (viewer) gets no Problem button. */
export const raisesProblems = (role: string | null | undefined) => role === "admin" || role === "office" || role === "workshop";

function MyJobsPanel({ jobs, role, canOpen, preview }: { jobs: MyJob[]; role: Role; canOpen: (href: string) => boolean; preview: (d: string) => void }) {
  return (
    <section className={s.panel} data-testid="my-jobs" aria-labelledby="my-jobs-title">
      <header className={s.panelHead}><Hn n={2} className={s.panelTitle} id="my-jobs-title">My jobs</Hn><span className={cx(s.panelMeta, tabularNumbers)}>{jobs.length} job{jobs.length === 1 ? "" : "s"}</span></header>
      <div className={s.myJobs}>
        {jobs.map((job) => {
          const action = myJobAction(job, role);
          const tag = reworkTag(job);
          const what = [job.customer, job.description, job.quantity != null ? `qty ${job.quantity}` : ""].filter(Boolean).join(" · ");
          const href = jobHrefOf(job);
          return (
            <article key={job.id} className={s.myJob} data-testid="my-job" data-job-id={job.id} aria-label={job.jobNo}>
              <div className={s.myJobTop}>
                <p className={cx(s.jobNo, tabularNumbers)}>{job.jobNo}</p>
                <span className={s.badges}>
                  <StatusBadge tone={toneOfColour(JOB_STATUS_BADGE[job.status])}>{JOB_STATUS_LABELS[job.status]}</StatusBadge>
                  {tag ? <StatusBadge tone={toneOfColour(tag.status)}>{tag.label}</StatusBadge> : null}
                  <StatusBadge tone={toneOfColour(job.dueLight)}>{DUE_WORD[job.dueLight]}</StatusBadge>
                </span>
              </div>
              {what ? <p className={s.what}>{what}</p> : null}
              <dl className={s.facts}>
                {stageOf(job.stage) ? <div><dt>Stage</dt><dd>{stageLabel(job.stage)}</dd></div> : null}
                <div><dt>Due</dt><dd className={tabularNumbers}>{job.due ? fmtDueBy(job.due) : DUE_WORD.no_due_date}</dd></div>
              </dl>
              {job.notes ? <div className={s.spec} data-testid="my-job-notes"><p className={s.specLabel}>Specification</p><p>{job.notes}</p></div> : null}
              <div className={s.jobButtons}>
                <Button variant="secondary" onClick={() => preview(`The drawing for ${job.jobNo} would open.`)} aria-label={`Open drawing: ${job.jobNo}`} data-testid="my-job-drawing">Open drawing</Button>
                {raisesProblems(role) ? <Button variant="secondary" onClick={() => preview(`A form to report a problem on ${job.jobNo} would open.`)} aria-label={`Report a problem: ${job.jobNo}`} data-testid="my-job-problem">Problem</Button> : null}
              </div>
              {canOpen("/jobs") ? (
                <div className={s.jobActions}>
                  <A href={href} className={s.bigAction} testId="my-job-action" label={`${action.label}: ${job.jobNo}`} kind={action.kind}>{action.label}</A>
                  {myJobOffersPause(job, role) ? <A href={href} className={s.pauseAction} testId="my-job-pause" label={`Pause or resume ${job.jobNo} on the Job Board`}>Pause or resume</A> : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function WholeFloorPanel({ floor, loading, failed, role, clockedIn, canOpen, retry }: { floor: Floor | null; loading: boolean; failed: boolean; role: Role; clockedIn: number | null; canOpen: (href: string) => boolean; retry: () => void }) {
  const counts = loading || !floor || failed ? { running: null, paused: null, idle: null, late: null } : floor.counts;
  const summary: Array<[FloorState | "late", number | null]> = [["running", counts.running], ["paused", counts.paused], ["idle", counts.idle], ["late", counts.late]];
  return (
    <section className={s.panel} data-testid="whole-floor" aria-labelledby="whole-floor-title">
      <header className={s.panelHead}><Hn n={2} className={s.panelTitle} id="whole-floor-title">Whole floor</Hn><span className={s.panelMeta}>Every machine right now, and anything on the bench. Read-only.</span></header>
      <div className={s.panelBody}>
        <ul className={s.floorSummary} aria-label="On the floor now" data-testid="floor-summary">
          {summary.map(([word, value]) => <li key={word}><span className={cx(s.floorCount, tabularNumbers)} data-testid={`floor-count-${word}`}>{countText(value)}</span><span className={s.floorWord}><i className={s.dot} style={{ background: LIGHT_COLOUR[word === "running" ? "blue" : word === "paused" ? "amber" : word === "late" ? "red" : "none"] }} aria-hidden="true" />{FLOOR_WORDS[word].label}</span></li>)}
          {readsClocks(role) ? <li data-testid="floor-clocked-in-item"><span className={cx(s.floorCount, tabularNumbers)} data-testid="floor-clocked-in">{loading || clockedIn === null ? DASH : clockedIn}</span><span className={s.floorWord}>Clocked in</span></li>
            : <li className={s.muted} data-testid="floor-clocked-in-note">Who is clocked in is shown to office and admin only.</li>}
        </ul>
      </div>
      {loading && !floor ? <p className={s.floorMsg}>{LOADING}</p> : null}
      {failed ? <div className={s.floorFail} data-testid="floor-failed"><Notice action={<Button variant="secondary" onClick={retry}>Retry</Button>}>Couldn&rsquo;t load who is on what. Don&rsquo;t treat the floor as idle.</Notice></div> : null}
      {floor && !failed && !loading ? (floor.rows.length ? (
        <ul className={s.floorRows} data-testid="floor-rows">
          {floor.rows.map((row) => <FloorRowView key={row.key} row={row} floor={floor} canOpen={canOpen} />)}
        </ul>
      ) : <p className={s.floorMsg}>No machines set up yet.</p>) : null}
    </section>
  );
}

function FloorRowView({ row, floor, canOpen }: { row: FloorRow; floor: Floor; canOpen: (href: string) => boolean }) {
  const href = row.job ? `/jobs?job=${encodeURIComponent(row.job.id)}` : "/schedule";
  const linkable = canOpen(row.job ? "/jobs" : "/schedule");
  const since = sinceText(row, NOW), elapsed = elapsedText(row, NOW);
  const tone = (w: FloorState | "late") => LIGHT_COLOUR[w === "running" ? "blue" : w === "paused" ? "amber" : w === "late" ? "red" : "none"];
  const body = (
    <>
      <div className={s.floorPlace}><span className={s.floorName}>{row.place}</span><span className={s.floorWord}><i className={s.dot} style={{ background: tone(row.state) }} aria-hidden="true" />{FLOOR_WORDS[row.state].label}</span></div>
      <div className={s.floorJob}>
        {row.job ? (<>
          <p><span className={cx(s.floorJobNo, tabularNumbers)}>{row.job.jobNo}</span>{row.job.late ? <span className={cx(s.floorWord, s.floorLate)}><i className={s.dot} style={{ background: tone("late") }} aria-hidden="true" />Late</span> : null}</p>
          <p className={s.truncate}>{row.job.customer ?? DASH}</p>
          {row.job.description ? <p className={cx(s.truncate, s.muted)}>{row.job.description}</p> : null}
          <p className={s.muted}>{dueText(row.job, floor.detailsFailed)}</p>
        </>) : <p className={s.muted}>Nothing on it</p>}
      </div>
      <div>{row.state === "idle" ? null : (<>
        <p className={s.truncate}>{row.operator ?? "No name on file"}</p><p className={s.muted}>{since || DASH}</p>
        {elapsed ? <p className={cx(s.elapsed, tabularNumbers)}>{elapsed}</p> : null}
        {row.stale ? <p className={s.stale}>Open 12 h+ with no Finish or Pause</p> : null}
      </>)}</div>
      <div>{row.bench ? null : (<><p className={s.muted}>Next</p><p className={s.nextJob}>{row.next === undefined ? DASH : row.next ?? <span className={s.muted}>Nothing booked</span>}</p></>)}</div>
    </>
  );
  return <li className={s.floorRow} data-testid="floor-row" data-state={row.state}>{linkable ? <A href={href} className={s.floorLink}>{body}</A> : <div className={s.floorLink}>{body}</div>}</li>;
}

function WorkshopView({ role, d, loading, error, att, isVisible, canOpen, retry, floor, floorFailed, clockedIn, preview }: Omit<ViewProps, "office" | "basis" | "setBasis" | "team" | "d"> & { d: WorkshopData | null; floor: Floor | null; floorFailed: boolean; preview: (d: string) => void }) {
  const vis = isVisible;
  const tiles = [
    vis("jobs-running") && <Tile key="jobs-running" label="Jobs running" value={num(d?.running, loading)} sub="Started, not finished" hint="Started, not finished (rework included)" href="/jobs" allowed={canOpen("/jobs")} testId="tile-jobs-running" />,
    vis("due-this-week") && <Tile key="due-this-week" label="Due within 7 days" value={num(d?.dueThisWeek, loading)} sub={d ? `Today to ${fmtDueBy(d.dueBy)}` : "Today and the next 7 days"} hint="Jobs not finished with a required or due date from today (included) to 7 days on" href="/jobs" allowed={canOpen("/jobs")} testId="tile-due-this-week" />,
    vis("delivery-notes") && <Tile key="delivery-notes" label="Delivery notes" value={num(d?.deliveryNotes, loading)} sub="Awaiting signature" href="/delivery-notes" allowed={canOpen("/delivery-notes")} testId="tile-delivery-notes" />,
  ].filter(Boolean) as ReactNode[];
  const showPriority = vis("priority-jobs"), showSchedule = vis("workshop-schedule");
  return (
    <>
      {error ? <Notice testId="dashboard-error" action={<Button size="sm" variant="secondary" onClick={retry}>Retry</Button>}>Couldn&rsquo;t load the dashboard.</Notice> : null}
      {tiles.length ? <div className={s.tiles} data-count={tiles.length}>{tiles}</div> : null}
      {vis("my-jobs") && d?.myJobs && d.myJobs.length ? <MyJobsPanel jobs={d.myJobs} role={role} canOpen={canOpen} preview={preview} /> : null}
      {vis("needs-attention") ? <AttentionList att={att} extra={[]} extraFailed={false} extraLoading={false} canOpen={canOpen} retry={retry} /> : null}
      {showPriority || showSchedule ? (
        <div className={s.twoCol} data-count={showPriority && showSchedule ? 2 : 1}>
          {showPriority ? (
            <Panel title="Priority Jobs" testId="priority-jobs">
              {loading ? <p className={s.muted}>{LOADING}</p> : null}
              {!loading && d?.priorityJobs && !d.priorityJobs.length ? <p className={s.muted}>No unfinished jobs.</p> : null}
              {!loading && !d?.priorityJobs ? <p className={s.muted}>{DASH}</p> : null}
              <div className={s.list}>{(d?.priorityJobs ?? []).map((job) => (
                <A key={job.id} href={jobHrefOf(job)} allowed={canOpen("/jobs")} className={s.listRow}>
                  <span className={s.listMain}><b className={tabularNumbers}>{job.jobNo}</b> {job.description}</span>
                  {hasReworkTag(job) ? <StatusBadge tone="progress">Rework</StatusBadge> : <StatusBadge tone="neutral">{stageOf(job.stage) ? stageLabel(job.stage) : "Workshop"}</StatusBadge>}
                </A>))}</div>
            </Panel>) : null}
          {showSchedule ? (
            <Panel title="Workshop Schedule This Week" testId="workshop-schedule">
              {loading ? <p className={s.muted}>{LOADING}</p> : null}
              {!loading && d?.bookings && !d.bookings.length ? <p className={s.muted}>Nothing booked onto machines this week.</p> : null}
              {!loading && !d?.bookings ? <p className={s.muted}>{DASH}</p> : null}
              <div className={s.list}>{(d?.bookings ?? []).map((row) => (
                <A key={row.id} href="/schedule" allowed={canOpen("/schedule")} className={s.listRow}><span className={cx(s.listMain, tabularNumbers)}>{fmtDateTime(row.start)}: {row.machine} - {row.jobNo}</span></A>))}</div>
            </Panel>) : null}
        </div>
      ) : null}
      {vis("whole-floor") ? <WholeFloorPanel floor={floor} loading={loading} failed={floorFailed} role={role} clockedIn={clockedIn} canOpen={canOpen} retry={retry} /> : null}
    </>
  );
}

/* ------------------------------------------------------------------ the page ------------------------------------------------------------------ */
const ROLES: Array<{ value: Role; label: string }> = [{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" }];
const SCREENS: Array<{ v: Screen; label: string }> = [
  { v: "ready", label: "Normal" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "empty", label: "New company, no data" },
  { v: "partial", label: "Some figures couldn't load" }, { v: "attention-failed", label: "Needs attention couldn't load" },
];

export default function DashboardPreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [basis, setBasis] = useState<Basis>("invoiced");
  const [hiddenTiles, setHiddenTiles] = useState<Record<string, string[]>>({});
  const [snapshots, setSnapshots] = useState(true);
  const [aiOn, setAiOn] = useState(true);
  const [banner, setBanner] = useState(true);
  const [bannerOn, setBannerOn] = useState(true);
  const [hideInvoicing, setHideInvoicing] = useState(false);
  const [timer, setTimer] = useState<number | null>(null);
  useEffect(() => () => { if (timer) window.clearTimeout(timer); }, [timer]);

  const kind = roleKind(role);
  const hidden = useMemo(() => hiddenTiles[kind] ?? [], [hiddenTiles, kind]);
  const isVisible = useCallback((key: string) => !hidden.includes(key), [hidden]);
  const canOpen = useMemo(() => makeCanOpen(role, hideInvoicing ? ["invoices"] : []), [role, hideInvoicing]);
  const go = useCallback((href: string) => toast.show({ title: "Preview only", detail: `This would open ${href}. Nothing was changed.` }), [toast]);
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was changed.` }), [toast]);

  const loading = screen === "loading";
  const failed = screen === "error";
  const sample = screen === "empty" ? EMPTY : SAMPLE;
  const office = role === "office";
  const fail = useMemo<ReadonlySet<ReadName>>(() => (screen === "partial" ? new Set<ReadName>(["payments", "runs", "inspections", "bookings"]) : new Set()), [screen]);
  const data = useMemo(() => (loading || failed ? null : adminData(sample, office, fail, snapshots)), [loading, failed, sample, office, fail, snapshots]);
  const workshop = useMemo(() => (loading || failed ? null : workshopData(sample, "u-sam")), [loading, failed, sample]);
  const attRole: AttentionRole = role === "viewer" ? "viewer" : role;
  const sections = useMemo(() => (loading || failed || screen === "attention-failed" ? null : attentionFor(sample, attRole)), [loading, failed, screen, sample, attRole]);
  const att: Att = { data: sections, loading, error: failed || screen === "attention-failed" };
  const floor = useMemo(() => (loading || failed || screen === "empty" ? null : sampleFloor()), [loading, failed, screen]);
  const empty = screen === "empty";
  const team = empty ? [] : SAMPLE_TEAM;
  const clockedIn = loading || failed ? null : empty ? 0 : SAMPLE_CLOCKED_IN;

  const retry = () => {
    toast.clear(); setScreen("loading");
    setTimer(window.setTimeout(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample figures shown again. No server was contacted." }); }, 700));
  };
  const pickScreen = (v: Screen) => { toast.clear(); setScreen(v); };
  const resetAll = () => { setScreen("ready"); setRole("admin"); setBasis("invoiced"); setHiddenTiles({}); setSnapshots(true); setAiOn(true); setBanner(true); setBannerOn(true); setHideInvoicing(false); toast.clear(); };

  const own = !COMPANY_DISPLAY_ROLES.includes(role);
  const tileKeys = dashboardTileKeysFor(kind);
  const emails = loading ? 0 : sample.emailsAwaiting;
  const showApproval = (role === "admin" || role === "office") && emails > 0 && canOpen("/approval");
  const viewProps = { role, d: data, loading, error: failed, att, isVisible, canOpen, retry, basis, setBasis, clockedIn, team };

  return (
    <NavCtx.Provider value={go}>
      <div className={cx(premiumTokens, s.root)} data-testid="dashboard-preview" data-role={role} data-screen={screen}>
        <PreviewBar controls={
          <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
            <div className={s.dock}>
              <p className={typeScale.caption}>Not part of Tolra. Sample data as of Friday 20 November 2026; states are simulated and no request is made.</p>
              <p className={typeScale.label}>Role (the view the person works in)</p>
              <SegmentedControl label="Role" value={role} options={ROLES} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
              <p className={typeScale.label}>Screen state</p>
              <div className={s.dockStates} role="group" aria-label="Screen state">
                {SCREENS.map((x) => <Button key={x.v} size="sm" variant="secondary" fullWidth aria-pressed={screen === x.v} onClick={() => pickScreen(x.v)}>{x.label}</Button>)}
              </div>
              <Switch label="Owed trend snapshots" hint="On when the database has migration 116; off hides the trend." checked={snapshots} onChange={setSnapshots} data-testid="dock-snapshots" />
              <Switch label="AI helper" hint="The header link shows only when the server has it on and the company has a feature on." checked={aiOn} onChange={setAiOn} data-testid="dock-ai" />
              <Switch label="Unrecognised-network warning" hint="Admin only: clock-ins from a network Tolra doesn't recognise." checked={bannerOn} onChange={(on) => { setBannerOn(on); setBanner(on); }} data-testid="dock-banner" />
              <Switch label="Invoicing hidden from this person" hint="Admin > Users > Page access: tiles that point at Invoicing stop being links." checked={hideInvoicing} onChange={setHideInvoicing} data-testid="dock-hide-invoicing" />
              <Button size="sm" variant="secondary" onClick={resetAll}>Reset preview</Button>
            </div>
          </Popover>
        } />
        <PageHeader title="Dashboard" description={`${greeting(FIRST_NAME)}. ${fmtDateText(NOW, { weekday: "long", year: true, numberAs: "full" })}`}
          actions={
            <div className={s.headControls}>
              {role === "admin" || role === "office" ? (
                <>
                  {aiOn ? <A href="/ai-helper" className={s.headLink} testId="ai-helper-link">AI helper</A> : null}
                  {showApproval ? <A href="/approval" className={s.headLink} testId="approval-link">{emails} email{emails === 1 ? "" : "s"} need{emails === 1 ? "s" : ""} approval</A> : null}
                </>
              ) : null}
              <Popover label="Columns" title="Dashboard: show / hide" variant="secondary" size="md" data-testid="columns-trigger">
                <p className={cx(typeScale.caption, s.colScope)} data-testid="column-scope">{own ? COLUMN_SCOPE_OWN : COLUMN_SCOPE_COMPANY}</p>
                <div className={s.colList}>
                  {DASHBOARD_TILES.filter((t) => tileKeys.includes(t.key)).map((t) => (
                    <Switch key={t.key} label={t.label} checked={!hidden.includes(t.key)} data-testid={`col-${t.key}`}
                      onChange={(on) => setHiddenTiles((h) => ({ ...h, [kind]: on ? (h[kind] ?? []).filter((k) => k !== t.key) : [...(h[kind] ?? []), t.key] }))} />
                  ))}
                </div>
                <div className={s.colReset}><Button size="sm" variant="secondary" disabled={!hidden.length} onClick={() => setHiddenTiles((h) => ({ ...h, [kind]: [] }))}>{resetLabel(own)}</Button></div>
              </Popover>
            </div>
          } />

        {role === "admin" && banner && bannerOn && !loading ? (
          <div className={s.banner} role="alert" data-testid="unrecognised-network-banner">
            <p>{unrecognisedBannerText(3)}<span className={s.bannerLinkRow}><A href="/settings#workshop-network" className={s.bannerLink} testId="unrecognised-network-link">Open Settings &gt; Workshop network</A></span></p>
            <Button size="sm" variant="secondary" aria-label="Dismiss this warning" onClick={() => setBanner(false)} data-testid="unrecognised-network-dismiss">Dismiss</Button>
          </div>
        ) : null}

        <div className={s.body} aria-busy={loading || undefined}>
          {loading ? <p className={srOnly} role="status">Loading the dashboard</p> : null}
          <LevelCtx.Provider value={role === "admin" ? 3 : 2}>
            {role === "workshop" || role === "viewer"
              ? <WorkshopView role={role} d={workshop} loading={loading} error={failed} att={att} isVisible={isVisible} canOpen={canOpen} retry={retry} floor={floor} floorFailed={failed} clockedIn={clockedIn} preview={preview} />
              : <AdminView {...viewProps} office={office} />}
          </LevelCtx.Provider>
        </div>
      </div>
    </NavCtx.Provider>
  );
}
