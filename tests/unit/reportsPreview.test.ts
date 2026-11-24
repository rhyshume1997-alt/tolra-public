// @vitest-environment jsdom
/**
 * BOUNDARY (Reports, Module 7, PREVIEW ONLY). Inputs: the exports of components/reports/preview/ReportsPreview.tsx, the REAL lib/reports and lib/reports/revenue functions it runs and the
 * SOURCE of app/(dashboard)/reports/page.tsx, reports/revenue/page.tsx, components/reports/*, components/reports/revenue/* and lib/reports/load-reports.ts. Output: pass/fail. Pins the
 * wording, the period choices, the range check, the section needs and the switches to the real source; pins every figure to hand arithmetic over the sample rows; checks by rendering
 * that nothing reports success and that Download only answers with the Preview only toast. No network, no Supabase. Written with createElement (no JSX).
 * Must not change: never loosen these to make a change pass; if a real rule changes this test is the alarm.
 */
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import ReportsPreview, {
  EMPTY, MAYBE_INCOMPLETE, MAX_MONTHS, NEEDS, NOW, PERIODS, SAMPLE, STATUS_TEXT, TODAY, defaultRange, downloadDetail, opsData, rangeProblem, revenueView, signed,
} from "@/components/reports/preview/ReportsPreview";
import { calendarDate } from "@/lib/dates";
import { londonMonthsEnding } from "@/lib/numbers";
import { REPORT_SECTION_NEEDS } from "@/lib/reports/load-reports";
import { OVER_PLAN_TOLERANCE } from "@/lib/jobs/planned-vs-actual";
import { REPORTS_OFF_NOTICE, canSeeReports } from "@/lib/reports/reports-switch";
import { REVENUE_OFF_NOTICE, canSeeRevenue } from "@/lib/reports/revenue/revenue-switch";

import { REPORT_PERIODS } from "@/lib/reports/use-reports-data";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const VIEW = read("components/reports/reports-view.tsx");
const REV = read("components/reports/revenue/revenue-view.tsx");
const CARDS = ["on-time-card", "wip-ageing-card", "machine-hours-card", "ncr-trend-card"].map((f) => read(`components/reports/${f}.tsx`)).join("\n");
const REVCARDS = ["invoiced-card", "cash-card", "customer-table", "part-table", "pipeline-card"].map((f) => read(`components/reports/revenue/${f}.tsx`)).join("\n");
const COMPONENT = read("components/reports/preview/ReportsPreview.tsx");
const none = new Set<never>();
const ops = (o: Partial<Parameters<typeof opsData>[1]> = {}) => opsData(SAMPLE, { months: 12, hidden: [], failed: none, truncated: false, ...o });
const pence = (n: number) => Math.round(n * 100);

describe("reports preview: the real source still says what the preview mirrors", () => {
  it("operations page: periods, default, copy, order of the cards", () => {
    expect(REPORT_PERIODS).toEqual(PERIODS);
    expect(read("lib/reports/use-reports-data.ts")).toContain("useState<number>(12)");
    expect(VIEW).toContain(`const MAYBE_INCOMPLETE = "${MAYBE_INCOMPLETE}";`);
    for (const t of ["Read-only operations reports. Dates are UK time. No costs are shown here: these reports count jobs, hours and records only.", "Revenue report", "Last {m} months", "Calculated {fmtDateTime(data.calculatedAt)} (UK time)", "This report can&apos;t be read right now.", "Not shown: "]) expect(VIEW, t).toContain(t);
    expect(VIEW.indexOf("On-time completion")).toBeLessThan(VIEW.indexOf("Work in progress ageing"));
    expect(VIEW.indexOf("Work in progress ageing")).toBeLessThan(VIEW.indexOf("Machine hours: planned vs actual"));
    expect(VIEW.indexOf("Machine hours: planned vs actual")).toBeLessThan(VIEW.indexOf("NCR trend"));
    for (const t of ["On-time completion", "Work in progress ageing", "Machine hours: planned vs actual", "NCR trend", "Revenue report", "Read-only operations reports. Dates are UK time. No costs are shown here: these reports count jobs, hours and records only."]) expect(COMPONENT, t).toContain(t);
  });
  it("the cards' wording, columns and notes are the real ones", () => {
    for (const t of ["A job counts in the month it was finished. On time means finished on or before its required date. Internal jobs are left out.", "Age is whole days (UK time) from the day the job started. Internal jobs are left out.",
      "Jobs finished in the period (newest 500 at most). Internal jobs are left out. The total percentage leaves out machines with no planned hours. Bench time is not included.", "No costs are shown.",
      "No machine hours for jobs finished in this period.", "Download CSV", "Download Excel", '["Month", "Finished", "On time", "Late", "No due date", "On time %"]', '["Machine", "Jobs", "Planned (h)", "Actual (h)", "Variance (h)", "Variance %", "Status"]']) {
      expect(CARDS, t).toContain(t); expect(COMPONENT, t.replace(/&quot;/g, "“")).toContain(t === "No costs are shown." ? t : t);
    }
    for (const k of Object.keys(STATUS_TEXT) as Array<keyof typeof STATUS_TEXT>) expect(CARDS).toContain(`${k}: "${STATUS_TEXT[k]}"`);
    expect(CARDS).toContain("disabled={!data.rows.length}");
  });
  it("section needs and the switches", () => {
    expect(NEEDS).toEqual(REPORT_SECTION_NEEDS);
    expect(canSeeReports("admin") && canSeeReports("office") && !canSeeReports("workshop") && !canSeeReports("viewer")).toBe(true);
    expect(canSeeRevenue("office")).toBe(true); expect(canSeeRevenue("viewer")).toBe(false);
    expect(REPORTS_OFF_NOTICE).toBe("Reports are switched off for your company."); expect(REVENUE_OFF_NOTICE).toBe("Revenue reports are switched off for your company.");
    expect(read("app/(dashboard)/reports/page.tsx")).toContain('<RoleGate allowed={["admin", "office"]}>');
    expect(read("app/(dashboard)/reports/revenue/page.tsx")).toContain('<RoleGate allowed={["admin", "office"]}>');
  });
  it("revenue page: range rule, wording, filters", () => {
    expect(REV).toContain("const MAX_MONTHS = 60;"); expect(MAX_MONTHS).toBe(60);
    for (const t of ['"Choose a start and an end date."', '"The start date is after the end date."', "Choose ${MAX_MONTHS} months or fewer.", "Some of this report couldn&apos;t be read.", "Read-only. Invoiced revenue and cash received are two separate measures and are never added together. Months follow the UK calendar."]) expect(REV, t).toContain(t);
    for (const t of ["Choose a start and an end date.", "The start date is after the end date.", "Choose ${MAX_MONTHS} months or fewer."]) expect(COMPONENT, t).toContain(t);
    for (const t of ["Invoiced revenue (ex VAT, less credit notes)", "Cash received", "Cash received by customer", "Invoiced revenue by customer", "Invoiced revenue by part number", "Pipeline (not revenue)", "Open quotes are not invoiced and not paid. This is never added to the revenue above."]) { expect(REVCARDS, t).toContain(t); expect(COMPONENT, t).toContain(t); }
    expect(REVCARDS).toContain("Some rows were not read (20,000 row limit), so these figures may be incomplete.");
    expect(read("lib/reports/revenue/revenue-switch.ts")).toContain('"Invoices are hidden for you, so revenue can\'t be shown."');
  });
  it("no chart on the real pages, none on the preview", () => {
    expect(VIEW + CARDS + REV + REVCARDS).not.toMatch(/recharts|<svg|Chart/);
    expect(COMPONENT).not.toMatch(/<svg|recharts/);
  });
});

describe("reports preview: range check", () => {
  it("is the page's rule", () => {
    expect(rangeProblem({ from: "", to: TODAY })).toBe("Choose a start and an end date.");
    expect(rangeProblem({ from: "2026-11-21", to: "2026-11-20" })).toBe("The start date is after the end date.");
    expect(rangeProblem({ from: "2021-01-01", to: "2026-11-20" })).toBe("Choose 60 months or fewer.");
    expect(rangeProblem({ from: "2021-12-01", to: "2026-11-20" })).toBeNull();
    expect(defaultRange()).toEqual({ from: "2025-12-01", to: TODAY });
  });
});

describe("reports preview: operations figures are the real functions over the sample rows", () => {
  it("on-time: by hand from the finished jobs", () => {
    const card = ops().onTime; if (card.state !== "ok") throw new Error("ok expected");
    const d = card.data;
    const mine = SAMPLE.finished.filter((j) => !j.is_internal);
    const dated = mine.filter((j) => j.date_required);
    const onTime = dated.filter((j) => calendarDate(j.finished_at) <= (j.date_required as string));
    expect(d.total).toMatchObject({ finished: 85, dated: dated.length, onTime: onTime.length, late: dated.length - onTime.length, noDueDate: mine.length - dated.length, percent: 90.4 });
    expect(Math.round((onTime.length / dated.length) * 1000) / 10).toBe(90.4);
    expect(d.months).toHaveLength(12); expect(d.months.reduce((a, m) => a + m.finished, 0)).toBe(85); expect(d.rows).toHaveLength(85);
    expect(d.rows.every((r) => r.jobNo !== "")).toBe(true);
    expect(d.months.every((m) => m.percent === null || (m.percent >= 0 && m.percent <= 100))).toBe(true);
    expect(ops({ months: 3 }).onTime.state === "ok" && (ops({ months: 3 }).onTime as { data: { months: unknown[] } }).data.months).toHaveLength(3);
  });
  it("last despatch is information only and disappears with Delivery Notes hidden", () => {
    const d = (ops().onTime as { data: { rows: Array<{ lastDespatch: string; result: string }> } }).data;
    expect(d.rows.some((r) => r.lastDespatch)).toBe(true);
    const hidden = ops({ hidden: ["delivery-notes"] }).onTime as { data: { rows: Array<{ lastDespatch: string }> }; note?: string };
    expect(hidden.data.rows.every((r) => r.lastDespatch === "")).toBe(true); expect(hidden.note).toBe("Last despatch is not shown: Delivery Notes are hidden for you.");
  });
  it("WIP: bands by whole days, not started apart, internal left out", () => {
    const card = ops().wip; if (card.state !== "ok") throw new Error();
    expect(card.data.bands.map((b) => b.count)).toEqual([6, 4, 5, 5, 3]); expect(card.data.notStarted).toBe(3); expect(card.data.open).toBe(26);
    expect(card.data.bands.reduce((a, b) => a + b.count, 0) + card.data.notStarted).toBe(card.data.open);
    expect(SAMPLE.open.filter((j) => !j.is_internal)).toHaveLength(26);
  });
  it("machine hours: variance, status by the Jobs tolerance, total percent leaves out unplanned machines", () => {
    const card = ops().machines; if (card.state !== "ok") throw new Error();
    const d = card.data;
    expect(d.rows.map((r) => r.status)).toEqual(["on_plan", "over", "under", "on_plan", "on_plan", "no_plan"]);
    for (const r of d.rows.filter((x) => x.plannedHours > 0)) expect(r.status).toBe(r.actualHours > r.plannedHours * (1 + OVER_PLAN_TOLERANCE) ? "over" : r.actualHours < r.plannedHours * (1 - OVER_PLAN_TOLERANCE) ? "under" : "on_plan");
    expect(d).toMatchObject({ plannedHours: 1028, actualHours: 1125, varianceHours: 97, plannedMachinesPercent: 5.7 });
    const planned = d.rows.filter((r) => r.plannedHours > 0);
    expect(Math.round((((planned.reduce((a, r) => a + r.actualHours, 0)) - 1028) / 1028) * 1000) / 10).toBe(5.7);
    expect(d.rows[5]).toMatchObject({ varianceHours: null, variancePercent: null }); expect(signed(null)).toBe("–"); expect(signed(9.5)).toBe("+9.50"); expect(signed(-26)).toBe("-26.00");
    expect(ops({ hidden: ["schedule"] }).machines).toEqual({ state: "hidden", sections: ["schedule"] });
  });
  it("NCR: every month, totals, not linked kept apart", () => {
    const card = ops().ncr; if (card.state !== "ok") throw new Error();
    expect(card.data.total).toEqual({ confirmed: 62, byType: { Rework: 32, "Inspection fail": 11, Concession: 12, Problem: 7 }, scrapped: 45, notLinked: 6 });
    expect(card.data.months.reduce((a, m) => a + m.confirmed, 0)).toBe(62); expect(card.data.months).toHaveLength(12);
    expect(card.data.months.every((m) => m.confirmed === Object.values(m.byType).reduce((a, b) => a + b, 0))).toBe(true);
  });
  it("hidden sections turn a card into a notice, failures are errors, a cap says 'may be incomplete'", () => {
    expect(ops({ hidden: ["jobs"] }).onTime).toEqual({ state: "hidden", sections: ["jobs"] });
    expect(ops({ hidden: ["jobs", "schedule"] }).machines).toEqual({ state: "hidden", sections: ["jobs", "schedule"] });
    expect(ops({ failed: new Set(["wip", "ncr"] as const) }).wip).toEqual({ state: "error" });
    const capped = ops({ truncated: true }); expect(capped.onTime.state === "ok" && capped.onTime.truncated).toBe(true); expect(capped.wip.state === "ok" && capped.wip.truncated).toBe(false);
  });
  it("a new company: zeros and the real empty sentences, never an invented figure", () => {
    const e = opsData(EMPTY, { months: 12, hidden: [], failed: none, truncated: false });
    expect(e.onTime.state === "ok" && e.onTime.data.total.percent).toBeNull(); expect(e.wip.state === "ok" && e.wip.data.open).toBe(0);
    expect(e.machines.state === "ok" && e.machines.data.rows).toEqual([]); expect(e.ncr.state === "ok" && e.ncr.data.total.confirmed).toBe(0);
  });
});

describe("reports preview: revenue figures are the real functions over the sample rows", () => {
  const range = defaultRange();
  const view = revenueView(SAMPLE, range, "", none, []);
  it("invoiced, by customer and by part agree; credit notes come off on their own date; drafts are not credits", () => {
    const net = SAMPLE.invoices.filter((i) => (i.invoice_date as string) >= range.from && (i.invoice_date as string) <= range.to).reduce((a, i) => a + pence(i.total as number) - pence(i.vat as number), 0);
    const credit = pence(1440) - pence(240) + pence(420) - pence(70);
    expect(view.invoiced?.invoicedTotal).toBe((net - credit) / 100); expect(view.invoiced?.invoicedTotal).toBe(284800);
    expect(view.customers?.invoicedNetTotal).toBe(284800); expect(view.parts?.partNetTotal).toBe(284800);
    expect(view.invoiced?.months).toHaveLength(12);
    expect(view.customers?.rows.reduce((a, r) => a + (r.invoicedShare ?? 0), 0)).toBe(100);
    expect(view.parts?.rows.reduce((a, r) => a + (r.partShare ?? 0), 0)).toBe(100);
    expect(view.parts?.mismatchedInvoices).toBe(1);
    expect(view.parts?.rows.map((r) => r.part).slice(-3)).toEqual(["Uncategorised", "Carriage", "Credit notes (not split by product)"]);
    expect(view.parts?.rows.at(-1)?.partNet).toBe(-1550);
  });
  it("cash: by month and by customer, the reversal and 'Customer not known'", () => {
    const sum = SAMPLE.payments.filter((p) => (p.paid_on as string) >= range.from && (p.paid_on as string) <= range.to).reduce((a, p) => a + pence(p.amount as number), 0);
    expect(view.cash?.receivedTotal).toBe(sum / 100); expect(view.cash?.receivedTotal).toBe(314160);
    expect(view.cashCustomers?.cashCustomerTotal).toBe(314160);
    expect(view.cashCustomers?.cashRows.some((r) => r.cashCustomer === "Customer not known" && r.cashReceived === 1200)).toBe(true);
    expect(view.cashCustomers?.cashRows.reduce((a, r) => a + (r.cashShare ?? 0), 0)).toBe(100);
  });
  it("pipeline is separate: open quotes only, none added to revenue", () => {
    expect(view.pipeline).toMatchObject({ openQuotes: 7, quotedTotal: 32730, quotesWithoutLines: 1, undatedQuotes: 1 });
    expect(view.pipeline?.quotedTotal).not.toBe((view.invoiced?.invoicedTotal ?? 0) + 32730);
  });
  it("customer filter narrows every table; the list holds every customer seen", () => {
    const one = revenueView(SAMPLE, range, "Marlow Hydraulics", none, []);
    expect(one.customers?.rows.map((r) => r.customer)).toEqual(["Marlow Hydraulics"]); expect(one.customers?.rows[0].invoicedShare).toBe(100);
    expect((one.invoiced?.invoicedTotal ?? 0) < 284800).toBe(true);
    expect(view.names).toEqual([...view.names].sort((a, b) => a.localeCompare(b))); expect(view.names).toContain("Customer not known");
  });
  it("range changes the months; a short range is fewer months", () => {
    const six = revenueView(SAMPLE, { from: londonMonthsEnding(NOW, 6)[0].start, to: TODAY }, "", none, []);
    expect(six.invoiced?.months).toHaveLength(6); expect((six.invoiced?.invoicedTotal ?? 0) < 284800).toBe(true);
  });
  it("hidden sections and failures: a dash or a notice, never 0", () => {
    const noInv = revenueView(SAMPLE, range, "", none, ["invoices"]); expect(noInv.invoiced).toBeNull(); expect(noInv.cash).toBeNull(); expect(noInv.pipeline).not.toBeNull();
    expect(revenueView(SAMPLE, range, "", none, ["quotes"]).pipeline).toBeNull();
    const so = revenueView(SAMPLE, range, "", none, ["sales-orders"]); expect(so.parts?.unreadableLines).toBeGreaterThan(0);
    const failed = revenueView(SAMPLE, range, "", new Set(["payments"] as const), []); expect(failed.cash).toBeNull(); expect(failed.invoiced).not.toBeNull();
  });
});

describe("reports preview: rendered", () => {
  let host: HTMLElement; let root: ReturnType<typeof createRoot>;
  beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
  afterEach(() => { act(() => root?.unmount()); host?.remove(); });
  const mount = () => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root.render(createElement(ReportsPreview))); return host; };
  it("v2: one PreviewBar, one h1 and no yellow pill beside the title", () => {
    const el = mount();
    expect(el.querySelectorAll('[role="group"][aria-label="Preview information"]')).toHaveLength(1);
    expect(el.querySelectorAll("h1")).toHaveLength(1);
    expect(el.querySelector("h1")?.textContent).toBe("Reports");
  });
  it("labelled sample data; the four cards in order; the figures; Download answers Preview only", () => {
    const el = mount(); const t = el.textContent ?? "";
    expect(t).toContain("Preview, sample data, nothing is saved");
    expect([...el.querySelectorAll("section h2")].map((h) => h.textContent)).toEqual(["On-time completion", "Work in progress ageing", "Machine hours: planned vs actual", "NCR trend"]);
    expect(el.querySelector('[data-testid="on-time-total"]')?.textContent).toBe("90.4% on time (66 of 73 jobs with a due date). 12 finished with no due date, not in the percentage.");
    expect(el.querySelector('[data-testid="wip-open"]')?.textContent).toBe("26 open jobs.");
    expect(el.querySelectorAll('[data-testid="machine-row"]')).toHaveLength(6);
    expect(el.querySelector('[data-testid="reports-revenue-link"]')?.getAttribute("href")).toBe("/reports/revenue");
    const btn = [...el.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Download CSV: On-time completion")!;
    act(() => { btn.click(); });
    expect(document.body.textContent).toContain(`Preview only${downloadDetail("On-time completion", "csv", 85)} Nothing was changed.`.replace("only", "only"));
    expect(document.body.textContent).not.toMatch(/\b(saved successfully|has been saved|downloaded|success)\b/i);
    expect(t).not.toMatch(/\.example|@/);
  });
});
