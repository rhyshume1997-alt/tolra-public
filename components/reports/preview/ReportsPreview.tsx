"use client";

/**
 * BOUNDARY (Reports, Module 7, PREVIEW ONLY). Route /dashboard/reports-preview. Inputs: none from the server. Everything shown is fictional sample data (finished and open
 * jobs, delivery notes, machine hour totals, NCR counts by month, invoices with lines, credit notes, payments, quotes and quote lines, as of Fri 20/11/2026) held in this
 * file, plus the person's clicks. Outputs: the look-and-feel prototype of app/(dashboard)/reports/page.tsx (On-time completion, Work in progress ageing, Machine hours:
 * planned vs actual, NCR trend, the Period choice, the Revenue report link) and of app/(dashboard)/reports/revenue/page.tsx (From, To, Customer, invoiced by month, cash by
 * month and by customer, invoiced by customer and by part number, the separate pipeline), with every Download CSV / Excel, note, hidden-section notice, failure and
 * "may be incomplete" line. Only LOCAL UI state. It never reads or writes Supabase, calls no server action, export, e-mail or accounting integration; a Download answers with
 * the neutral "Preview only ... Nothing was changed." toast and no file is made. The real pages have no charts, so this preview adds none: tables only.
 * FIGURES ARE THE REAL ONES: lib/reports (onTimeCompletion, wipAgeing, machineHoursVariance, ncrTrend, lastDespatchByJob, reports-switch) and lib/reports/revenue (invoicedRevenue,
 * cashRevenue, cashByCustomer, invoicedByCustomer, invoicedByPart, pipelineQuotes, revenue-switch) run over the sample rows. The few rules that live inline in the real views (the
 * range check, the customer list, the Period choices, the wording) are mirrored and pinned to the real source by tests/unit/reportsPreview.test.ts.
 * MUST NOT CHANGE: card order, column order and wording, the 3 / 6 / 12 periods (12 default), admin and office only, the switches (off by default), "never 0 for a figure that could not be
 * read", no costs anywhere, invoiced / cash / pipeline never added together. Do not wire this to real data or exports, add no metric or control the real pages lack, keep control hit
 * areas at 48 px. Delete the four preview files (this component and its .module.css, app/(dashboard)/dashboard/reports-preview/page.tsx, tests/unit/reportsPreview.test.ts) to remove it completely.
 */

import { useCallback, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Button, Field, Input, PageHeader, Popover, PreviewBar, ScrollTable, SegmentedControl, Select, StatusBadge, Switch, ToastProvider, cx, premiumTokens, tabularNumbers, typeScale, useToast } from "@/components/ui/premium";
import type { StatusTone } from "@/components/ui/premium";
import { calendarDate, fmtDateTime, toDateInput } from "@/lib/dates";
import { NCR_CONFIRMED_TYPES } from "@/lib/jobs/ncr-register";
import type { NcrMonth } from "@/lib/jobs/ncr-register";
import type { MachineTotal } from "@/lib/jobs/planned-vs-actual";
import { gbp } from "@/lib/money";
import { londonMonthsEnding } from "@/lib/numbers";
import { lastDespatchByJob } from "@/lib/reports/last-despatch";
import { machineHoursVariance, type MachineVarianceReport, type MachineVarianceStatus } from "@/lib/reports/machine-hours-variance";
import { ncrTrend, type NcrTrendReport } from "@/lib/reports/ncr-trend";
import { onTimeCompletion, type OnTimeJob, type OnTimeReport } from "@/lib/reports/on-time-completion";
import { invoicedByCustomer, type CustomerResult } from "@/lib/reports/revenue/by-customer";
import { invoicedByPart, type InvoiceLineRow, type OrderLinePart, type PartInvoice, type PartResult } from "@/lib/reports/revenue/by-part";
import { cashByCustomer, cashRevenue, paymentCustomer, type CashCustomerResult, type CashPayment, type CashResult, type PaymentInvoice } from "@/lib/reports/revenue/cash";
import { creditsInScope, customerName, invoicedRevenue, invoicesInScope, type InvoicedResult, type RevenueRange } from "@/lib/reports/revenue/invoiced";
import { pipelineQuotes, type PipelineQuote, type PipelineQuoteLine, type PipelineResult } from "@/lib/reports/revenue/pipeline";
import { INVOICES_HIDDEN_NOTICE, QUOTES_HIDDEN_NOTICE, REVENUE_OFF_NOTICE, canSeeRevenue, revenueEnabled, revenueSections } from "@/lib/reports/revenue/revenue-switch";
import { REPORTS_OFF_NOTICE, canSeeReports, reportsEnabled } from "@/lib/reports/reports-switch";
import { isInvoiced } from "@/lib/numbers";
import type { NumberCredit, NumberInvoice } from "@/lib/numbers";
import { MEMBER_SECTIONS } from "@/lib/sections";
import { wipAgeing, type WipJob, type WipReport } from "@/lib/reports/wip-ageing";

import s from "./ReportsPreview.module.css";

export type Role = "admin" | "office" | "workshop" | "viewer";
export type Page = "operations" | "revenue";
export type Screen = "ready" | "loading" | "failed" | "partial" | "empty";
export const NOW = new Date("2026-11-20T14:20:00.000Z");
export const TODAY = "2026-11-20";
export const PERIODS = [3, 6, 12] as const;
export const MAYBE_INCOMPLETE = "This may be incomplete: more records exist than were read. Choose a shorter period.";
export const MAX_MONTHS = 60;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, "0");
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const sectionLabel = (key: string) => MEMBER_SECTIONS.find((x) => x.key === key)?.label ?? key;
const CUSTOMERS = ["Marlow Hydraulics", "Tern Marine Engineering", "Coldharbour Automation", "Ashby Rail Services", "Kestrel Components", "Halden Precision", "Brightwell Valves", "Wren & Calder", "Pemberton Packaging"];

/** The Revenue view's range check (components/reports/revenue/revenue-view.tsx rangeProblem), mirrored and pinned to that source. */
export function rangeProblem({ from, to }: RevenueRange): string | null {
  if (!DATE.test(from) || !DATE.test(to)) return "Choose a start and an end date.";
  if (from > to) return "The start date is after the end date.";
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1 > MAX_MONTHS ? `Choose ${MAX_MONTHS} months or fewer.` : null;
}
export const defaultRange = (): RevenueRange => ({ from: londonMonthsEnding(NOW, 12)[0].start, to: toDateInput(NOW) });

/* ---------------- sample world: operations ---------------- */
const MONTHS12 = londonMonthsEnding(NOW, 12);
export type Sample = {
  finished: Array<OnTimeJob & WipJob>; open: WipJob[]; despatches: Array<{ job_id: string; despatched_at: string }>; machines: MachineTotal[]; jobsByMachine: Map<string, number>;
  ncr: Map<string, NcrMonth>; invoices: Array<PartInvoice>; credits: NumberCredit[]; payments: CashPayment[]; paymentInvoices: PaymentInvoice[]; lines: InvoiceLineRow[];
  orderLines: OrderLinePart[]; quotes: PipelineQuote[]; quoteLines: PipelineQuoteLine[];
};
function buildFinished(): Array<OnTimeJob & WipJob> {
  const out: Array<OnTimeJob & WipJob> = [];
  MONTHS12.forEach((p, m) => {
    const n = 6 + (m % 4);
    for (let k = 0; k < n; k++) {
      const day = Math.min(27, 2 + k * 3 + (m % 2));
      const finished = `${p.start.slice(0, 8)}${pad2(day)}`;
      const late = (m * 5 + k * 3) % 11 === 0 ? 2 + (k % 3) : 0;
      const early = (m + k) % 7 === 0 ? 1 : 0;
      const noDate = k % 6 === 5;
      out.push({
        id: `f-${m}-${k}`, job_no: `J-${900 + m * 10 + k}`, customer: CUSTOMERS[(m + k) % CUSTOMERS.length], is_internal: k % 9 === 8, started_at: `${addDays(finished, -9)}T08:00:00Z`, finished_at: `${finished}T15:00:00Z`,
        date_required: noDate ? null : addDays(finished, early - late), due_date: null,
      });
    }
  });
  return out.filter((j) => (j.finished_at as string) < NOW.toISOString());
}
const AGES = [0, 2, 3, 5, 6, 7, 8, 9, 12, 14, 15, 19, 22, 28, 30, 31, 40, 47, 55, 60, 61, 75, 90];
const OPEN: WipJob[] = [
  ...AGES.map((age, i): WipJob => ({ id: `o-${i}`, job_no: `J-${1100 + i}`, customer: CUSTOMERS[i % CUSTOMERS.length], is_internal: false, started_at: `${addDays(TODAY, -age)}T08:00:00Z`, finished_at: null })),
  ...[0, 1, 2].map((i): WipJob => ({ id: `ns-${i}`, job_no: `J-${1200 + i}`, customer: CUSTOMERS[(i + 3) % CUSTOMERS.length], is_internal: false, started_at: null, finished_at: null })),
  { id: "oi-0", job_no: "J-INT-01", customer: null, is_internal: true, started_at: `${addDays(TODAY, -20)}T08:00:00Z`, finished_at: null },
];
const MACHINE_TOTALS: MachineTotal[] = [
  { machineId: "m1", label: "CNC Mill 1", planned: 312, actual: 341.5 }, { machineId: "m2", label: "CNC Mill 2", planned: 280, actual: 331.25 },
  { machineId: "m3", label: "CNC Lathe 1", planned: 190, actual: 164 }, { machineId: "m4", label: "CNC Lathe 2", planned: 150, actual: 148.5 },
  { machineId: "m5", label: "Wire erosion", planned: 96, actual: 101.75 }, { machineId: "m6", label: "Band saw", planned: 0, actual: 38 },
];
const NCR_ROWS: Array<[number, number, number, number, number, number]> = [
  // [rework, inspection fail, concession, problem, scrapped, not linked] per month, Dec 2025 to Nov 2026
  [3, 1, 1, 0, 4, 1], [2, 0, 2, 1, 2, 0], [4, 2, 1, 1, 9, 0], [1, 1, 0, 0, 1, 2], [2, 0, 1, 0, 0, 0], [5, 2, 2, 1, 12, 1],
  [3, 1, 0, 2, 3, 0], [2, 2, 1, 0, 5, 0], [1, 0, 0, 1, 0, 1], [4, 1, 2, 0, 6, 0], [2, 1, 1, 1, 2, 0], [3, 0, 1, 0, 1, 1],
];
function buildNcr(): Map<string, NcrMonth> {
  return new Map(MONTHS12.map((p, i) => {
    const [rework, fail, concession, problem, scrapped, notLinked] = NCR_ROWS[i];
    const byType = { Rework: rework, "Inspection fail": fail, Concession: concession, Problem: problem, "Inspection fail (no rework)": notLinked };
    return [p.key, { confirmed: rework + fail + concession + problem, open: 1, closed: rework + fail + concession + problem - 1, byType, scrapped, notLinked }];
  }));
}

/* ---------------- sample world: revenue ---------------- */
const BASE = [7200, 5600, 4300, 3900, 3300, 3700, 2900, 2600, 2100];
const PARTS = ["VB-4410 valve block", "GH-2208 gland housing", "LP-0931 locating pin", "SR-1175 seat ring", "BR-3304 bracket", "MF-7075 manifold"];
function buildRevenue(): Pick<Sample, "invoices" | "credits" | "payments" | "paymentInvoices" | "lines" | "orderLines" | "quotes" | "quoteLines"> {
  const invoices: PartInvoice[] = [], lines: InvoiceLineRow[] = [], orderLines: OrderLinePart[] = PARTS.map((part_number, i) => ({ id: `ol-${i}`, part_number }));
  let n = 0;
  MONTHS12.forEach((p, m) => CUSTOMERS.forEach((customer, c) => {
    if ((m + c) % 3 === 0) return;
    const net = Math.round((BASE[c] * (0.6 + ((m * 7 + c * 3) % 9) / 10)) / 50) * 50;
    const date = `${p.start.slice(0, 8)}${pad2(3 + ((c * 2) % 24))}`;
    if (date > TODAY) return;
    const carriage = n % 6 === 0 ? 30 : 0;
    const body = net - carriage;
    const id = `inv-${n}`;
    const total = Math.round((net * 1.2) * 100) / 100;
    const mismatch = n === 7;
    invoices.push({ id, customer, status: "sent", subtotal: body, vat: Math.round((total - net) * 100) / 100, carriage, total, invoice_date: date, created_at: `${date}T09:00:00Z` });
    const half = Math.round(body / 2 / 50) * 50;
    const parts = [half, body - half];
    parts.forEach((value, i) => lines.push({ invoice_id: id, quantity: value / 50, unit_price: 50, sales_order_line_id: `ol-${(n + i) % PARTS.length}`, line_kind: "order" }));
    if (mismatch) lines.push({ invoice_id: id, quantity: 1, unit_price: 40, sales_order_line_id: null, line_kind: "manual" });
    n += 1;
  }));
  const credits: NumberCredit[] = [
    { customer: "Tern Marine Engineering", status: "issued", vat: 240, total: 1440, credit_date: "2026-10-15" },
    { customer: "Kestrel Components", status: "issued", vat: 70, total: 420, credit_date: "2026-11-12" },
    { customer: "Marlow Hydraulics", status: "draft", vat: 100, total: 600, credit_date: "2026-11-18" },
  ];
  const payments: CashPayment[] = [
    ...invoices.map((i, k) => ({ invoice_id: i.id as string, amount: i.total as number, paid_on: addDays(i.invoice_date as string, 22 + (k % 17)) })).filter((x) => x.paid_on <= TODAY),
    { invoice_id: "inv-gone", amount: 1200, paid_on: "2026-10-09" }, { invoice_id: "inv-5", amount: -300, paid_on: "2026-11-17" },
  ];
  const paymentInvoices: PaymentInvoice[] = invoices.map((i) => ({ id: i.id, customer: i.customer }));
  const q = (id: string, customer: string, sent: string | null, valid: string, status = "sent"): PipelineQuote => ({ id, customer, status, valid_until: valid, sent_at: sent });
  const quotes = [q("q1", "Tern Marine Engineering", "2026-10-30", "2026-11-29"), q("q2", "Coldharbour Automation", "2026-11-02", "2026-12-02"), q("q3", "Halden Precision", "2026-11-09", "2026-12-09"),
    q("q4", "Wren & Calder", "2026-11-12", "2026-12-12"), q("q5", "Marlow Hydraulics", "2026-11-17", "2026-12-17"), q("q6", "Brightwell Valves", "2026-10-08", "2026-11-30"), q("q7", "Ashby Rail Services", "2026-09-26", "2026-10-26"),
    q("q8", "Kestrel Components", "2026-09-12", "2026-12-12"), q("q9", "Pemberton Packaging", "2026-11-05", "2026-12-05"), q("q10", "Halden Precision", null, "2026-12-20"), q("q11", "Marlow Hydraulics", "2026-08-14", "2026-12-14", "accepted")];
  const ql = (id: string, qty: number, price: number, declined = false): PipelineQuoteLine => ({ quote_id: id, quantity: qty, unit_price: price, declined });
  const quoteLines = [ql("q1", 8, 1075), ql("q2", 17, 200), ql("q3", 21, 250), ql("q3", 1, 0, true), ql("q4", 20, 149), ql("q5", 16, 400), ql("q6", 83, 50), ql("q7", 22, 200), ql("q8", 13, 150), ql("q10", 1, 1850), ql("q11", 10, 980)];
  return { invoices, credits, payments, paymentInvoices, lines, orderLines, quotes, quoteLines };
}
export const SAMPLE: Sample = { finished: buildFinished(), open: OPEN, despatches: [], machines: MACHINE_TOTALS, jobsByMachine: new Map([["m1", 41], ["m2", 38], ["m3", 27], ["m4", 22], ["m5", 9], ["m6", 6]]), ncr: buildNcr(), ...buildRevenue() };
SAMPLE.despatches = SAMPLE.finished.filter((_, i) => i % 4 !== 3).map((j) => ({ job_id: j.id, despatched_at: `${addDays(calendarDate(j.finished_at), 1 + (j.id.length % 2))}T11:00:00Z` }));
export const EMPTY: Sample = { ...SAMPLE, finished: [], open: [], despatches: [], machines: [], jobsByMachine: new Map(), ncr: new Map(), invoices: [], credits: [], payments: [], paymentInvoices: [], lines: [], orderLines: [], quotes: [], quoteLines: [] };

/* ---------------- the cards, as lib/reports/load-reports builds them ---------------- */
export type ReportCard<T> = { state: "ok"; data: T; truncated: boolean; note?: string } | { state: "error" } | { state: "hidden"; sections: string[] };
export type OpsData = { calculatedAt: string; onTime: ReportCard<OnTimeReport>; wip: ReportCard<WipReport>; machines: ReportCard<MachineVarianceReport>; ncr: ReportCard<NcrTrendReport> };
/** lib/reports/load-reports REPORT_SECTION_NEEDS, mirrored (pinned by the test). */
export const NEEDS = { onTime: ["jobs"], wip: ["jobs"], machines: ["jobs", "schedule"], ncr: ["jobs"], despatch: ["delivery-notes"] } as const;
export type Opts = { months: number; hidden: readonly string[]; failed: ReadonlySet<keyof Omit<OpsData, "calculatedAt">>; truncated: boolean };
export function opsData(sample: Sample, o: Opts): OpsData {
  const periods = londonMonthsEnding(NOW, o.months);
  const blocked = (needs: readonly string[]) => needs.filter((x) => o.hidden.includes(x));
  const gate = (needs: readonly string[]): ReportCard<never> | null => (blocked(needs).length ? { state: "hidden", sections: blocked(needs) } : null);
  const windowStart = periods[0].start, windowEnd = periods[periods.length - 1].end;
  const finished = sample.finished.filter((j) => calendarDate(j.finished_at) >= windowStart && calendarDate(j.finished_at) < windowEnd);
  const trunc = (k: string) => o.truncated && (k === "onTime" || k === "machines");
  const onTime = (): ReportCard<OnTimeReport> => {
    const g = gate(NEEDS.onTime); if (g) return g; if (o.failed.has("onTime")) return { state: "error" };
    const despatchHidden = blocked(NEEDS.despatch).length > 0;
    const despatches = despatchHidden ? new Map<string, string>() : lastDespatchByJob(sample.despatches);
    return { state: "ok", data: onTimeCompletion(finished, periods, despatches), truncated: trunc("onTime"), note: despatchHidden ? "Last despatch is not shown: Delivery Notes are hidden for you." : undefined };
  };
  const wip = (): ReportCard<WipReport> => { const g = gate(NEEDS.wip); if (g) return g; if (o.failed.has("wip")) return { state: "error" }; return { state: "ok", data: wipAgeing(sample.open, NOW), truncated: false }; };
  const machines = (): ReportCard<MachineVarianceReport> => { const g = gate(NEEDS.machines); if (g) return g; if (o.failed.has("machines")) return { state: "error" }; return { state: "ok", data: machineHoursVariance(sample.machines, sample.jobsByMachine), truncated: trunc("machines") }; };
  const ncr = (): ReportCard<NcrTrendReport> => { const g = gate(NEEDS.ncr); if (g) return g; if (o.failed.has("ncr")) return { state: "error" }; return { state: "ok", data: ncrTrend(sample.ncr, periods), truncated: false }; };
  return { calculatedAt: NOW.toISOString(), onTime: onTime(), wip: wip(), machines: machines(), ncr: ncr() };
}

export type Read<T> = { rows: T[]; truncated?: boolean } | { failed: true };
export type RevView = {
  names: string[]; invoiced: InvoicedResult | null; cash: CashResult | null; cashCustomers: CashCustomerResult | null; customers: CustomerResult | null; parts: PartResult | null; pipeline: PipelineResult | null;
};
/** The Revenue view's computation (components/reports/revenue/revenue-view.tsx), over the sample rows; `failed` families come back null (a dash), hidden families are not read. */
export function revenueView(sample: Sample, range: RevenueRange, customer: string, failedFamilies: ReadonlySet<"invoices" | "payments" | "quotes">, hiddenSections: readonly string[]): RevView {
  const sec = revenueSections(hiddenSections);
  const who = customer || null;
  const inv = sec.invoices && !failedFamilies.has("invoices") ? sample.invoices : null;
  const cr = sec.invoices && !failedFamilies.has("invoices") ? sample.credits : null;
  const pay = sec.invoices && !failedFamilies.has("payments") ? sample.payments : null;
  const quotes = sec.quotes && !failedFamilies.has("quotes") ? sample.quotes : null;
  // Hiding Sales Orders hides the order lines the invoice lines point at: the part numbers can't be read.
  const orderLines = hiddenSections.includes("sales-orders") ? [] : sample.orderLines;
  const names = new Set<string>();
  if (inv) for (const row of invoicesInScope(inv, range, null)) if (isInvoiced(row)) names.add(customerName(row.customer));
  if (cr) for (const row of creditsInScope(cr, range, null)) names.add(customerName(row.customer));
  if (pay) for (const row of pay) if (calendarDate(row.paid_on) >= range.from && calendarDate(row.paid_on) <= range.to) names.add(paymentCustomer(row, sample.paymentInvoices));
  if (quotes) for (const row of quotes) if (calendarDate(row.sent_at) >= range.from && calendarDate(row.sent_at) <= range.to) names.add(customerName(row.customer));
  return {
    names: [...names].sort((a, b) => a.localeCompare(b)),
    invoiced: inv && cr ? invoicedRevenue(inv, cr, range, who) : null,
    cash: pay ? cashRevenue(pay, sample.paymentInvoices, range, who) : null,
    cashCustomers: pay ? cashByCustomer(pay, sample.paymentInvoices, range, who) : null,
    customers: inv && cr ? invoicedByCustomer(inv, cr, range, who) : null,
    parts: inv && cr ? invoicedByPart(inv, sample.lines, orderLines, cr, range, who) : null,
    pipeline: quotes ? pipelineQuotes(quotes, sample.quoteLines, TODAY, range, who) : null,
  };
}
/** The text the toast gives for a Download (no file is made). */
export const downloadDetail = (what: string, format: "csv" | "xlsx", rows: number) => `${format === "csv" ? "A CSV" : "An Excel file"} of ${rows} ${rows === 1 ? "row" : "rows"} (${what}) would download. No file was made.`;
export const STATUS_TEXT: Record<MachineVarianceStatus, string> = { over: "Over plan", under: "Under plan", on_plan: "On plan", no_plan: "No plan" };
const STATUS_TONE: Record<MachineVarianceStatus, StatusTone> = { over: "danger", under: "info", on_plan: "ok", no_plan: "neutral" };
export const signed = (n: number | null) => (n === null ? "–" : `${n > 0 ? "+" : ""}${n.toFixed(2)}`);
const dashTxt = (v: number | null, f: (n: number) => string) => (v === null ? "—" : f(v));

/* ---------------- local pieces ---------------- */
type Preview = (detail: string) => void;
function Frame({ title, testId, children, wide }: { title: string; testId: string; children: ReactNode; wide?: boolean }) {
  const id = useId();
  return (
    <section data-testid={testId} className={cx(s.frame, wide && s.frameWide)} aria-labelledby={id}>
      <header className={s.frameHead}><h2 className={s.frameTitle} id={id}>{title}</h2></header>
      <div className={s.frameBody}>{children}</div>
    </section>
  );
}
function Tbl({ label, children }: { label: string; children: ReactNode }) {
  return <ScrollTable label={`${label}, table`} dense>{children}</ScrollTable>;
}
function Downloads({ what, rows, disabled, preview }: { what: string; rows: number; disabled?: boolean; preview: Preview }) {
  return (
    <div className={s.downloads}>
      {(["csv", "xlsx"] as const).map((f) => <Button key={f} size="sm" variant="secondary" disabled={disabled} aria-label={`${f === "csv" ? "Download CSV" : "Download Excel"}: ${what}`} onClick={() => preview(downloadDetail(what, f, rows))}>{f === "csv" ? "Download CSV" : "Download Excel"}</Button>)}
    </div>
  );
}
function Skeleton() { return <div className={s.skeleton} role="status" aria-label="Loading"><i /><i /><i /></div>; }

function CardFrame<T>({ title, testId, card, onRetry, children, loading, wide }: { title: string; testId: string; card: ReportCard<T> | undefined; onRetry: () => void; loading: boolean; children: (d: T) => ReactNode; wide?: boolean }) {
  return (
    <Frame title={title} testId={testId} wide={wide}>
      {loading || !card ? <Skeleton />
        : card.state === "hidden" ? <p data-testid="report-hidden" className={s.muted}>Not shown: {card.sections.map(sectionLabel).join(" and ")} {card.sections.length > 1 ? "are" : "is"} hidden for you.</p>
        : card.state === "error" ? <p data-testid="report-error" className={s.errorLine}>This report can&rsquo;t be read right now.<Button size="sm" variant="secondary" data-testid="report-retry" onClick={onRetry}>Retry</Button></p>
        : (<>
            {children(card.data)}
            {card.note ? <p className={s.note}>{card.note}</p> : null}
            {card.truncated ? <p data-testid="report-incomplete" className={cx(s.note, s.incomplete)}>{MAYBE_INCOMPLETE}</p> : null}
          </>)}
    </Frame>
  );
}

function OnTime({ d, preview }: { d: OnTimeReport; preview: Preview }) {
  const { total } = d;
  return (
    <div className={s.stack}>
      <p data-testid="on-time-total" className={s.lead}><strong className={tabularNumbers}>{total.percent === null ? "–" : `${total.percent}%`}</strong> on time ({total.onTime} of {total.dated} jobs with a due date). {total.noDueDate} finished with no due date, not in the percentage.</p>
      <Tbl label="On-time completion by month">
        <thead><tr>{["Month", "Finished", "On time", "Late", "No due date", "On time %"].map((h, i) => <th key={h} scope="col" className={i ? s.right : undefined}>{h}</th>)}</tr></thead>
        <tbody>{d.months.map((m) => (
          <tr key={m.key} data-testid="on-time-month" data-month={m.key}><th scope="row">{m.label}</th><td className={s.right}>{m.finished}</td><td className={s.right}>{m.onTime}</td><td className={s.right}>{m.late}</td><td className={s.right}>{m.noDueDate}</td><td className={s.right}>{m.percent === null ? "–" : `${m.percent}%`}</td></tr>
        ))}</tbody>
      </Tbl>
      <p className={s.note}>A job counts in the month it was finished. On time means finished on or before its required date. Internal jobs are left out.</p>
      <Downloads what="On-time completion" rows={d.rows.length} disabled={!d.rows.length} preview={preview} />
    </div>
  );
}
function Wip({ d, preview }: { d: WipReport; preview: Preview }) {
  return (
    <div className={s.stack}>
      <p data-testid="wip-open" className={s.lead}><strong className={tabularNumbers}>{d.open}</strong> open {d.open === 1 ? "job" : "jobs"}.</p>
      <Tbl label="Work in progress by age">
        <thead><tr><th scope="col">Age since started</th><th scope="col" className={s.right}>Open jobs</th></tr></thead>
        <tbody>
          {d.bands.map((b) => <tr key={b.key} data-testid="wip-band" data-band={b.key}><th scope="row">{b.label}</th><td className={s.right}>{b.count}</td></tr>)}
          <tr data-testid="wip-band" data-band="not-started"><th scope="row">Not started</th><td className={s.right}>{d.notStarted}</td></tr>
        </tbody>
      </Tbl>
      <p className={s.note}>Age is whole days (UK time) from the day the job started. Internal jobs are left out.</p>
      <Downloads what="WIP ageing" rows={d.rows.length} disabled={!d.rows.length} preview={preview} />
    </div>
  );
}
function Machines({ d, preview }: { d: MachineVarianceReport; preview: Preview }) {
  return (
    <div className={s.stack}>
      {!d.rows.length ? <p className={s.muted}>No machine hours for jobs finished in this period.</p> : (
        <Tbl label="Planned and actual machine hours">
          <thead><tr>{["Machine", "Jobs", "Planned (h)", "Actual (h)", "Variance (h)", "Variance %", "Status"].map((h, i) => <th key={h} scope="col" className={i > 0 && i < 6 ? s.right : undefined}>{h}</th>)}</tr></thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.machineId} data-testid="machine-row"><th scope="row">{r.label}</th><td className={s.right}>{r.jobs}</td><td className={s.right}>{r.plannedHours.toFixed(2)}</td><td className={s.right}>{r.actualHours.toFixed(2)}</td><td className={s.right}>{signed(r.varianceHours)}</td><td className={s.right}>{r.variancePercent === null ? "–" : `${signed(r.variancePercent)}%`}</td><td><StatusBadge tone={STATUS_TONE[r.status]}>{STATUS_TEXT[r.status]}</StatusBadge></td></tr>
            ))}
            <tr data-testid="machine-total" className={s.totalRow}><th scope="row">Total</th><td /><td className={s.right}>{d.plannedHours.toFixed(2)}</td><td className={s.right}>{d.actualHours.toFixed(2)}</td><td className={s.right}>{signed(d.varianceHours)}</td><td className={s.right}>{d.plannedMachinesPercent === null ? "–" : `${signed(d.plannedMachinesPercent)}%`}</td><td /></tr>
          </tbody>
        </Tbl>
      )}
      <p className={s.note}>Jobs finished in the period (newest 500 at most). Internal jobs are left out. The total percentage leaves out machines with no planned hours. Bench time is not included.</p>
      <Downloads what="Machine hours" rows={d.rows.length} disabled={!d.rows.length} preview={preview} />
    </div>
  );
}
function Ncr({ d, preview }: { d: NcrTrendReport; preview: Preview }) {
  return (
    <div className={s.stack}>
      <Tbl label="NCRs by month">
        <thead><tr>{["Month", "Confirmed", ...NCR_CONFIRMED_TYPES, "Scrapped", "Not linked"].map((h, i) => <th key={h} scope="col" className={i ? s.right : undefined}>{h}</th>)}</tr></thead>
        <tbody>
          {d.months.map((m) => <tr key={m.key} data-testid="ncr-month" data-month={m.key}><th scope="row">{m.label}</th><td className={s.right}>{m.confirmed}</td>{NCR_CONFIRMED_TYPES.map((t) => <td key={t} className={s.right}>{m.byType[t] ?? 0}</td>)}<td className={s.right}>{m.scrapped}</td><td className={s.right}>{m.notLinked}</td></tr>)}
          <tr data-testid="ncr-total" className={s.totalRow}><th scope="row">Total</th><td className={s.right}>{d.total.confirmed}</td>{NCR_CONFIRMED_TYPES.map((t) => <td key={t} className={s.right}>{d.total.byType[t] ?? 0}</td>)}<td className={s.right}>{d.total.scrapped}</td><td className={s.right}>{d.total.notLinked}</td></tr>
        </tbody>
      </Tbl>
      <p className={s.note}>By the month the record was raised. &ldquo;Not linked&rdquo; is a failed inspection with no rework record; it is not in the confirmed count. No costs are shown.</p>
      <Downloads what="NCR trend" rows={d.months.length} preview={preview} />
    </div>
  );
}

/* revenue frames */
function RevFrame({ title, meta, testId, children }: { title: string; meta: string; testId: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={s.frame} aria-labelledby={id}>
      <header className={s.frameHead}><h2 className={s.frameTitle} id={id}>{title}</h2><span className={s.frameMeta}>{meta}</span></header>
      <div className={s.frameBody} data-testid={testId}>{children}</div>
    </section>
  );
}
const Cant = ({ children, testId }: { children: string; testId?: string }) => <p className={s.muted} data-testid={testId}>{children}</p>;
const Incomplete = () => <p className={s.note}>Some rows were not read (20,000 row limit), so these figures may be incomplete.</p>;
function ShareTable({ label, head, rows, testId }: { label: string; head: [string, string, string]; rows: Array<{ key: string; name: string; value: string; share: string }>; testId: string }) {
  return (
    <Tbl label={label}>
      <thead><tr><th scope="col">{head[0]}</th><th scope="col" className={s.right}>{head[1]}</th><th scope="col" className={s.right}>{head[2]}</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.key} data-testid={testId}><th scope="row">{r.name}</th><td className={s.right} data-col="value">{r.value}</td><td className={s.right} data-col="share">{r.share}</td></tr>)}</tbody>
    </Tbl>
  );
}
function RevenueBody({ view, incomplete, sections, preview, loading }: { view: RevView | null; incomplete: boolean; sections: { invoices: boolean; quotes: boolean }; preview: Preview; loading: boolean }) {
  if (loading || !view) return <p className={s.muted} role="status">Loading revenue{"…"}</p>;
  const inc = incomplete;
  return (
    <>
      {sections.invoices ? (
        <>
          <RevFrame title="Invoiced revenue (ex VAT, less credit notes)" meta="Issued invoices on invoice date; credit notes on their own date" testId="revenue-invoiced">
            {!view.invoiced ? <Cant testId="revenue-invoiced-failed">Invoiced revenue can&rsquo;t be read right now.</Cant> : (<>
              {inc ? <Incomplete /> : null}
              <Tbl label="Invoiced revenue by month">
                <thead><tr><th scope="col">Month</th><th scope="col" className={s.right}>Invoiced</th></tr></thead>
                <tbody>
                  {view.invoiced.months.map((m) => <tr key={m.key} data-testid={`revenue-invoiced-${m.key}`}><th scope="row">{m.label}</th><td className={s.right} data-col="invoiced">{m.invoiced === null ? "—" : gbp(m.invoiced)}</td></tr>)}
                  <tr className={s.totalRow}><th scope="row">Total invoiced</th><td className={s.right} data-testid="revenue-invoiced-total">{view.invoiced.invoicedTotal === null ? "—" : gbp(view.invoiced.invoicedTotal)}</td></tr>
                </tbody>
              </Tbl>
              <Downloads what="Revenue invoiced by month" rows={view.invoiced.months.length} preview={preview} />
            </>)}
          </RevFrame>
          <RevFrame title="Cash received" meta="Payments by the date received, reversals included" testId="revenue-cash">
            {!view.cash ? <Cant testId="revenue-cash-failed">Cash received can&rsquo;t be read right now.</Cant> : (<>
              {inc ? <Incomplete /> : null}
              <Tbl label="Cash received by month">
                <thead><tr><th scope="col">Month</th><th scope="col" className={s.right}>Received</th></tr></thead>
                <tbody>
                  {view.cash.months.map((m) => <tr key={m.key} data-testid={`revenue-cash-${m.key}`}><th scope="row">{m.label}</th><td className={s.right} data-col="received">{gbp(m.received)}</td></tr>)}
                  <tr className={s.totalRow}><th scope="row">Total received</th><td className={s.right} data-testid="revenue-cash-total">{gbp(view.cash.receivedTotal)}</td></tr>
                </tbody>
              </Tbl>
              <Downloads what="Revenue cash received by month" rows={view.cash.months.length} preview={preview} />
            </>)}
          </RevFrame>
          <RevFrame title="Cash received by customer" meta="By the customer name on the invoice each payment was paid against" testId="revenue-cash-customers">
            {!view.cashCustomers ? <Cant>Cash received by customer can&rsquo;t be read right now.</Cant> : (<>
              {inc ? <Incomplete /> : null}
              {view.cashCustomers.cashRows.length === 0 ? <Cant>No cash received in this period.</Cant> : <ShareTable label="Cash received by customer" head={["Customer", "Received", "Share"]} testId="revenue-cash-customer-row" rows={view.cashCustomers.cashRows.map((r) => ({ key: r.cashCustomer, name: r.cashCustomer, value: gbp(r.cashReceived), share: r.cashShare === null ? "—" : `${r.cashShare}%` }))} />}
              <Downloads what="Revenue cash received by customer" rows={view.cashCustomers.cashRows.length} disabled={false} preview={preview} />
            </>)}
          </RevFrame>
          <RevFrame title="Invoiced revenue by customer" meta="Customers are matched by the name on the invoice" testId="revenue-customers">
            {!view.customers ? <Cant testId="revenue-customers-failed">Revenue by customer can&rsquo;t be read right now.</Cant> : (<>
              {inc ? <Incomplete /> : null}
              {view.customers.rows.length === 0 ? <Cant>No invoiced work in this period.</Cant> : <ShareTable label="Invoiced revenue by customer" head={["Customer", "Invoiced", "Share"]} testId="revenue-customer-row" rows={view.customers.rows.map((r) => ({ key: r.customer, name: r.customer, value: r.invoicedNet === null ? "—" : gbp(r.invoicedNet), share: r.invoicedShare === null ? "—" : `${r.invoicedShare}%` }))} />}
              <Downloads what="Revenue invoiced by customer" rows={view.customers.rows.length} preview={preview} />
            </>)}
          </RevFrame>
          <RevFrame title="Invoiced revenue by part number" meta="From invoice lines linked to order lines" testId="revenue-parts">
            {!view.parts ? <Cant testId="revenue-parts-failed">Revenue by part number can&rsquo;t be read right now.</Cant> : (<>
              {inc ? <Incomplete /> : null}
              {view.parts.mismatchedInvoices > 0 ? <p className={s.notice} data-testid="revenue-parts-mismatch">{view.parts.mismatchedInvoices} {view.parts.mismatchedInvoices === 1 ? "invoice doesn't" : "invoices don't"} add up by line. Their whole value is under Uncategorised.</p> : null}
              {view.parts.unreadableLines > 0 ? <p className={s.notice} data-testid="revenue-parts-unreadable">{view.parts.unreadableLines} {view.parts.unreadableLines === 1 ? "line links" : "lines link"} to sales order lines you can&rsquo;t read (Sales Orders hidden for you): their part numbers aren&rsquo;t shown.</p> : null}
              {view.parts.unknownInvoices > 0 ? <p className={s.notice}>{view.parts.unknownInvoices} {view.parts.unknownInvoices === 1 ? "invoice has" : "invoices have"} no figures, so the shares can&rsquo;t be worked out.</p> : null}
              {view.parts.rows.length === 0 ? <Cant>No invoiced work in this period.</Cant> : <ShareTable label="Invoiced revenue by part number" head={["Part number", "Invoiced", "Share"]} testId="revenue-part-row" rows={view.parts.rows.map((r) => ({ key: `${r.partKind}:${r.part}`, name: r.part, value: gbp(r.partNet), share: r.partShare === null ? "—" : `${r.partShare}%` }))} />}
              <Downloads what="Revenue invoiced by part number" rows={view.parts.rows.length} preview={preview} />
            </>)}
          </RevFrame>
        </>
      ) : <p className={s.muted} data-testid="revenue-invoices-hidden">{INVOICES_HIDDEN_NOTICE}</p>}
      {sections.quotes ? (
        <RevFrame title="Pipeline (not revenue)" meta="Quotes sent and still open, by month sent" testId="revenue-pipeline">
          {!view.pipeline ? <Cant testId="revenue-pipeline-failed">The pipeline can&rsquo;t be read right now.</Cant> : (<>
            <p className={s.note}>Open quotes are not invoiced and not paid. This is never added to the revenue above.</p>
            {inc ? <Incomplete /> : null}
            {view.pipeline.quotesWithoutLines > 0 ? <p className={s.note}>{view.pipeline.quotesWithoutLines} open {view.pipeline.quotesWithoutLines === 1 ? "quote has" : "quotes have"} no lines, so no value.</p> : null}
            <Tbl label="Open quotes by month sent">
              <thead><tr><th scope="col">Month sent</th><th scope="col" className={s.right}>Quotes</th><th scope="col" className={s.right}>Quoted</th></tr></thead>
              <tbody>
                {view.pipeline.pipelineMonths.map((m) => <tr key={m.sentMonth} data-testid={`revenue-pipeline-${m.sentMonth}`}><th scope="row">{m.sentLabel}</th><td className={s.right} data-col="quotes">{m.quoteCount}</td><td className={s.right} data-col="quoted">{gbp(m.quotedValue)}</td></tr>)}
                <tr className={s.totalRow}><th scope="row">Open quotes</th><td className={s.right} data-testid="revenue-pipeline-count">{view.pipeline.openQuotes}</td><td className={s.right} data-testid="revenue-pipeline-total">{gbp(view.pipeline.quotedTotal)}</td></tr>
              </tbody>
            </Tbl>
            <Downloads what="Pipeline open quotes by month sent" rows={view.pipeline.pipelineMonths.length} preview={preview} />
          </>)}
        </RevFrame>
      ) : <p className={s.muted} data-testid="revenue-quotes-hidden">{QUOTES_HIDDEN_NOTICE}</p>}
    </>
  );
}

/* ---------------- the page ---------------- */
const SCREENS: Array<[Screen, string]> = [["ready", "Normal"], ["loading", "Loading"], ["failed", "Reads failed"], ["partial", "One report failed, one capped"], ["empty", "New company, no data"]];
const HIDEABLE = ["jobs", "schedule", "delivery-notes", "invoices", "quotes", "sales-orders"] as const;

export default function ReportsPreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [page, setPage] = useState<Page>("operations");
  const [screen, setScreen] = useState<Screen>("ready");
  const [months, setMonths] = useState<number>(12);
  const [range, setRange] = useState<RevenueRange>(defaultRange);
  const [customer, setCustomer] = useState("");
  const [hidden, setHidden] = useState<string[]>([]);
  const [reportsOn, setReportsOn] = useState(true);
  const [revenueOn, setRevenueOn] = useState(true);
  const [timer, setTimer] = useState<number | null>(null);
  const preview = useCallback<Preview>((detail) => toast.show({ title: "Preview only", detail: `${detail} Nothing was changed.` }), [toast]);
  const loading = screen === "loading";
  const sample = screen === "empty" ? EMPTY : SAMPLE;
  const hiddenNav = useMemo(() => [...(reportsOn ? ["reports:on"] : []), ...(revenueOn ? ["reports-revenue:on"] : [])], [reportsOn, revenueOn]);
  const retry = () => { toast.clear(); setScreen("loading"); if (timer) window.clearTimeout(timer); setTimer(window.setTimeout(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample figures shown again. No server was contacted." }); }, 700)); };
  const failedOps = useMemo(() => new Set<keyof Omit<OpsData, "calculatedAt">>(screen === "failed" ? ["onTime", "wip", "machines", "ncr"] : screen === "partial" ? ["machines"] : []), [screen]);
  const ops = useMemo(() => (loading ? null : opsData(sample, { months, hidden, failed: failedOps, truncated: screen === "partial" })), [loading, sample, months, hidden, failedOps, screen]);
  const sections = revenueSections(hidden);
  const failedFam = useMemo(() => new Set<"invoices" | "payments" | "quotes">(screen === "failed" ? ["invoices", "payments", "quotes"] : screen === "partial" ? ["quotes"] : []), [screen]);
  const problem = rangeProblem(range);
  const rev = useMemo(() => (loading || problem ? null : revenueView(sample, range, customer, failedFam, hidden)), [loading, problem, sample, range, customer, failedFam, hidden]);
  const names = rev?.names ?? [];
  const anyFailed = !loading && !problem && ((sections.quotes && failedFam.has("quotes")) || (sections.invoices && (failedFam.has("invoices") || failedFam.has("payments"))));
  const allowed = canSeeReports(role);
  const showRevenueLink = canSeeRevenue(role) && revenueEnabled(hiddenNav);
  const pageNow: Page = page === "revenue" ? "revenue" : "operations";
  const periodOptions = PERIODS.map((m) => ({ value: String(m), label: `${m} months`, testId: `period-${m}` }));
  const toggleHidden = (k: string, on: boolean) => setHidden((h) => (on ? [...h, k] : h.filter((x) => x !== k)));

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="reports-preview" data-role={role} data-page={pageNow} data-screen={screen}>
      <PreviewBar controls={
        <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
          <div className={s.dock}>
                <p className={typeScale.caption}>Not part of Tolra. Sample data as of Friday 20 November 2026; states are simulated and no request is made.</p>
                <p className={typeScale.label}>Page</p>
                <SegmentedControl label="Page" value={page} size="sm" onChange={setPage} options={[{ value: "operations", label: "Reports", testId: "page-operations" }, { value: "revenue", label: "Revenue", testId: "page-revenue" }]} />
                <p className={typeScale.label}>Role (the view the person works in)</p>
                <SegmentedControl label="Role" value={role} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} options={[{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" }]} />
                <p className={typeScale.label}>Screen state</p>
                <div className={s.dockStates} role="group" aria-label="Screen state">
                  {SCREENS.map(([v, l]) => <Button key={v} size="sm" variant="secondary" fullWidth aria-pressed={screen === v} onClick={() => { toast.clear(); setScreen(v); }}>{l}</Button>)}
                </div>
                <Switch label="Reports switched on" hint="Company setting, off by default." checked={reportsOn} onChange={setReportsOn} data-testid="dock-reports-on" />
                <Switch label="Revenue report switched on" hint="Company setting, off by default." checked={revenueOn} onChange={setRevenueOn} data-testid="dock-revenue-on" />
                <p className={typeScale.label}>Hidden for this person (Page access)</p>
                {HIDEABLE.map((k) => <Switch key={k} label={`${sectionLabel(k)} hidden`} checked={hidden.includes(k)} onChange={(on) => toggleHidden(k, on)} data-testid={`dock-hide-${k}`} />)}
                <Button size="sm" variant="secondary" onClick={() => { setRole("admin"); setPage("operations"); setScreen("ready"); setMonths(12); setRange(defaultRange()); setCustomer(""); setHidden([]); setReportsOn(true); setRevenueOn(true); toast.clear(); }}>Reset preview</Button>
              </div>
        </Popover>
      } />
      <PageHeader title={pageNow === "revenue" ? "Revenue" : "Reports"} />

      {!allowed ? (
        <section className={s.denied} data-testid="access-denied"><h2 className={s.deniedTitle}>Access Denied</h2><p className={s.muted}>Redirecting you back to the dashboard.</p><p className={s.muted}>Preview only: no redirect happens here. Reports are for Admin and Office; Workshop and Viewer cannot open them.</p></section>
      ) : !reportsOn && pageNow === "operations" ? (
        <p className={s.muted} data-testid="reports-off">{REPORTS_OFF_NOTICE}</p>
      ) : pageNow === "operations" ? (
        <div className={s.body} data-testid="reports-view">
          <p className={s.intro}>Read-only operations reports. Dates are UK time. No costs are shown here: these reports count jobs, hours and records only.</p>
          {showRevenueLink ? <p className={s.linkRow}><a data-testid="reports-revenue-link" href="/reports/revenue" className={s.link} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); preview("This would open /reports/revenue."); } }}>Revenue report</a></p> : null}
          <div className={s.periodRow}>
            <div className={s.periodGroup}><span className={s.periodLabel} id="period-label">Period</span><SegmentedControl label="Period" value={String(months)} onChange={(v) => setMonths(Number(v))} options={periodOptions} disabled={loading} /></div>
            {ops ? <span data-testid="reports-calculated-at" className={s.calc}>Calculated {fmtDateTime(ops.calculatedAt)} (UK time)</span> : null}
          </div>
          <CardFrame title="On-time completion" testId="report-on-time" card={ops?.onTime} loading={loading} onRetry={retry}>{(d) => <OnTime d={d} preview={preview} />}</CardFrame>
          <CardFrame title="Work in progress ageing" testId="report-wip" card={ops?.wip} loading={loading} onRetry={retry}>{(d) => <Wip d={d} preview={preview} />}</CardFrame>
          <CardFrame title="Machine hours: planned vs actual" testId="report-machines" card={ops?.machines} loading={loading} onRetry={retry}>{(d) => <Machines d={d} preview={preview} />}</CardFrame>
          <CardFrame title="NCR trend" testId="report-ncr" card={ops?.ncr} loading={loading} onRetry={retry}>{(d) => <Ncr d={d} preview={preview} />}</CardFrame>
        </div>
      ) : !revenueOn ? (
        <div className={s.stack} data-testid="revenue-off"><p className={s.muted}>{REVENUE_OFF_NOTICE}</p></div>
      ) : (
        <div className={s.body} data-testid="revenue-page">
          <p className={s.intro}>Read-only. Invoiced revenue and cash received are two separate measures and are never added together. Months follow the UK calendar. Customers are matched by the name on the invoice.</p>
          <div className={s.filters}>
            <Field label="From"><Input type="date" aria-label="From date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
            <Field label="To"><Input type="date" aria-label="To date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
            <Field label="Customer">
              <Select aria-label="Customer" value={customer} onChange={(e) => setCustomer(e.target.value)}>
                <option value="">All customers</option>
                {customer && !names.includes(customer) ? <option value={customer}>{customer}</option> : null}
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </Field>
          </div>
          {problem ? <p className={s.alert} role="alert">{problem}</p> : null}
          {anyFailed ? <p className={s.alert} role="alert">Some of this report couldn&rsquo;t be read.<Button size="sm" variant="secondary" data-testid="revenue-retry" onClick={retry}>Retry</Button></p> : null}
          {!rev ? (problem ? null : <p className={s.muted} role="status">Loading revenue{"…"}</p>) : <RevenueBody view={rev} incomplete={screen === "partial"} sections={sections} preview={preview} loading={loading} />}
        </div>
      )}
    </div>
  );
}
