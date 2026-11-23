// @vitest-environment jsdom
/**
 * BOUNDARY (Dashboard, Module 7, PREVIEW ONLY). Inputs: the exports of components/dashboard/preview/DashboardPreview.tsx, the REAL lib functions it runs
 * (lib/dashboard-analytics, overview, overview-metrics, dashboard-tile-figures, attention-items, destinations, dashboard-tiles, job-flow, job-status, my-jobs,
 * whole-floor, dates, money) and, for the few rules that live inline in the real page, the SOURCE of app/(dashboard)/dashboard/page.tsx and the components it uses.
 * Output: pass/fail. Pins every figure on the preview to hand arithmetic over the sample rows, the inline filters to the page, the links to the real hrefs, the
 * role rules to canOpenDestination, the tile set to DASHBOARD_TILES, and checks by rendering that nothing reports success.
 * Must not change: never loosen these to make a change pass; if a real rule changes this test is the alarm. No network, no Supabase. Written with createElement (no JSX).
 */
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import DashboardPreview, {
  EMPTY, MONTHS, NINETY_AGO, SAMPLE, SINCE, TODAY, WEEK_END, adminData, attentionFor, dueOpenRow, greeting, hasDateRow, isLateRow, isOpenRow, isRunningRow, kGbp, lastSixMonths,
  makeCanOpen, raisesProblems, receivedByMonth, roleKind, sampleFloor, workshopData, NOW,
} from "@/components/dashboard/preview/DashboardPreview";
import { DASHBOARD_TILES, dashboardTileKeysFor } from "@/lib/dashboard-tiles";
import { attentionSummary, fleetLoad, leaksFrom, otherAttention } from "@/lib/overview";
import { OPEN_JOBS_FILTER, RUNNING_JOBS_FILTER, openJobsDueFilter } from "@/lib/job-flow";
import { HAS_REQUIRED_DATE_FILTER } from "@/lib/job-status";
import { ATTENTION_RULES } from "@/lib/attention-items";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const PAGE = read("app/(dashboard)/dashboard/page.tsx");
const COMPONENT = read("components/dashboard/preview/DashboardPreview.tsx");
const COLUMN_TOGGLE = read("components/column-toggle.tsx");
const PROBLEMS = read("components/workshop/my-job-extras.tsx") + read("lib/job-problems.ts");
const ATTENDANCE = read("lib/floor-attendance.ts");
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

describe("dashboard preview: the real source still says what the preview mirrors", () => {
  it("the inline filters the preview re-implements are the ones the page uses", () => {
    expect(OPEN_JOBS_FILTER).toBe("stage.eq.rework,inspected_at.is.null");
    expect(RUNNING_JOBS_FILTER).toBe("stage.eq.rework,and(finished_at.is.null,inspected_at.is.null,started_at.not.is.null)");
    expect(HAS_REQUIRED_DATE_FILTER).toBe("date_required.not.is.null,due_date.not.is.null");
    expect(openJobsDueFilter("A", "B")).toBe("and(stage.eq.rework,date_required.gte.A,date_required.lte.B),and(stage.eq.rework,due_date.gte.A,due_date.lte.B),and(inspected_at.is.null,date_required.gte.A,date_required.lte.B),and(inspected_at.is.null,due_date.gte.A,due_date.lte.B)");
    expect(PAGE).toContain("const lateFilter = `date_required.lt.${today},and(date_required.is.null,due_date.lt.${today})`;");
    expect(PAGE).toContain("const activeJobs = () => head(\"jobs\").is(\"finished_at\", null);");
    expect(PAGE).toContain("buckets.set(key, toPence(Number(buckets.get(key) ?? 0)) / 100 + toPence(Number(row.amount || 0)) / 100);");
    expect(PAGE).toContain("revenue = months.map((m) => ({ month: m.month, revenue: Math.round(buckets.get(m.key) ?? 0) }));");
    expect(PAGE).toContain("const base = hour < 12 ? \"Good morning\" : hour < 18 ? \"Good afternoon\" : \"Good evening\";");
    expect(PAGE).toContain("new Date(now.getFullYear(), now.getMonth() - i, 15)");
  });
  it("the column picker wording and the Problem rule are the real ones", () => {
    expect(COLUMN_TOGGLE).toContain("Changes apply to everyone in this company.");
    expect(COLUMN_TOGGLE).toContain("Your own view on this device only. Everyone else, and the company setting, are not changed.");
    expect(COLUMN_TOGGLE).toContain("Reset to the company view");
    expect(COLUMN_TOGGLE).toContain("Reset to default (show all columns)");
    expect(COLUMN_TOGGLE).toContain('export const COMPANY_DISPLAY_ROLES = ["admin", "office"] as const;');
    expect(PROBLEMS).toContain('const raises = staff || input.role === "workshop";');
    expect(ATTENDANCE).toContain('export const attendanceReadable = (role: string | null | undefined) => role === "admin" || role === "office";');
    expect(PAGE).toContain("Nothing needs your attention right now.");
    expect(PAGE).toContain("Needs attention couldn&apos;t be loaded. Don&apos;t treat it as all clear.");
  });
  it("every hard-coded link on the real page is a link on the preview, character for character", () => {
    const real = new Set([...PAGE.matchAll(/href="(\/[a-z\-/]*)"/g)].map((m) => m[1]).concat([...PAGE.matchAll(/href=\{?"(\/[a-z\-/#]*)"\}?/g)].map((m) => m[1])));
    for (const href of real) expect(COMPONENT, href).toContain(`"${href}"`);
    for (const href of ["/invoices", "/jobs", "/quotes", "/rfq", "/schedule", "/delivery-notes", "/approval", "/time/week", "/ai-helper", "/settings#workshop-network"]) expect(COMPONENT).toContain(`"${href}"`);
  });
  it("every tile and section key of lib/dashboard-tiles is rendered by the preview", () => {
    for (const tile of DASHBOARD_TILES) expect(COMPONENT, tile.key).toMatch(new RegExp(`["']${tile.key}["']`));
  });
});

describe("dashboard preview: the months, dates and greeting", () => {
  it("six months to November, UK dates, Friday 20 November 2026", () => {
    expect(MONTHS.map((m) => m.key)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(lastSixMonths(NOW)[5].key).toBe("2026-11");
    expect(SINCE).toBe("2026-06-01"); expect(NINETY_AGO).toBe("2026-08-22"); expect(WEEK_END).toBe("2026-11-27"); expect(TODAY).toBe("2026-11-20");
    expect(greeting("Sam Okoro")).toBe("Good afternoon, Sam");
    expect(greeting(null, new Date("2026-11-20T07:00:00Z"))).toBe("Good morning");
    expect(greeting("Sam", new Date("2026-11-20T19:00:00Z"))).toBe("Good evening, Sam");
    expect(kGbp(26300)).toBe("£26.3k"); expect(kGbp(950)).toBe("£950");
  });
});

describe("dashboard preview: every figure is the real function over the sample rows", () => {
  const d = adminData(SAMPLE, false);
  const net = (i: (typeof SAMPLE.invoices)[number]) => Math.round((Number(i.total) - Number(i.vat)) * 100);
  it("money: owed, by age, overdue, unconfirmed imported invoice left out", () => {
    const unpaid = SAMPLE.invoices.filter((i) => i.status !== "paid" && i.status !== "draft" && !i.payment_unverified);
    const owedPence = unpaid.reduce((a, i) => a + Math.round(i.total * 100) - Math.round(i.amount_paid * 100), 0);
    expect(d.moneyOwed).toBe(owedPence / 100);
    expect(d.moneyOwed).toBe(37896);
    expect(d.unpaidInvoices).toBe(10);
    expect(d.owedByAge?.map((b) => b.value)).toEqual([22656, 7560, 4140, 3540]);
    expect(sum(d.owedByAge!.map((b) => b.value))).toBe(d.moneyOwed);
    expect(d.attention.map((a) => a.title)).toEqual(["1 imported invoice: payment to confirm"]);
  });
  it("revenue: invoiced ex VAT less issued credit notes, received including the reversal", () => {
    expect(d.invoiced?.map((p) => p.revenue)).toEqual([18400, 22150, 15900, 26300, 23550, 13930]);
    expect(d.thisMonthInvoiced).toBe(13930);
    const june = SAMPLE.invoices.filter((i) => i.invoice_date?.startsWith("2026-06") && i.status !== "draft").reduce((a, i) => a + net(i), 0) / 100;
    expect(june).toBe(18400);
    expect(d.revenue?.map((p) => p.revenue)).toEqual([12900, 23400, 17820, 11400, 31560, 16320]);
    const nov = SAMPLE.payments.filter((p) => p.paid_on.startsWith("2026-11")).reduce((a, p) => a + Math.round(p.amount * 100), 0) / 100;
    expect(nov).toBe(16320);
    expect(receivedByMonth(SAMPLE.payments, MONTHS, SINCE).latest).toBe(16320);
    expect(d.customers).toMatchObject({ share: 34, topCustomer: "Marlow Hydraulics" });
    expect(d.customers?.rows[0]).toEqual({ customer: "Marlow Hydraulics", value: 40800 });
    expect(d.daysToPay).toEqual({ average: 27.3, count: 10 });
  });
  it("quotes, RFQs and the pipeline", () => {
    expect(d.openQuotes).toBe(6); expect(d.pipelineValue).toBe(8600 + 3400 + 5250 + 2980 + 6400 + 4150);
    expect(d.quotes90).toEqual({ outcomes: [{ key: "accepted", label: "Accepted", count: 7 }, { key: "sent", label: "Awaiting reply", count: 6 }, { key: "expired", label: "Expired", count: 3 }, { key: "rejected", label: "Rejected", count: 2 }], winRate: 58 });
    expect(Math.round((7 / (7 + 2 + 3)) * 100)).toBe(58);
    expect(d.quotesSentThisMonth).toBe(5); expect(d.quotesWon).toEqual({ count: 2, undated: 1 });
    expect(d.rfqsToQuote).toBe(4); expect(d.pipeline).toEqual({ rfqs: 4, quoted: 6, accepted: 7, paid: 18 });
  });
  it("jobs: open, due, late, on time, status, finished on time, right first time, work coming due", () => {
    expect(SAMPLE.jobs.filter(isOpenRow)).toHaveLength(20); expect(d.openJobs).toBe(20);
    expect(d.dueThisWeek).toBe(8);
    expect(SAMPLE.jobs.filter((j) => dueOpenRow(j, TODAY, WEEK_END)).map((j) => j.job_no).sort()).toEqual(["J-1052", "J-1055", "J-1056", "J-1057", "J-1058", "J-1059", "J-1062", "J-1063"]);
    expect(d.lateJobs).toBe(SAMPLE.jobs.filter((j) => isLateRow(j, TODAY)).length); expect(d.lateJobs).toBe(3);
    expect(SAMPLE.jobs.filter(hasDateRow)).toHaveLength(15); expect(d.onTimeJobs).toBe(12);
    expect(d.jobsStatus).toEqual({ notStarted: 8, running: 9, waiting: 3, overdue: 3, dueSoon: 6 });
    expect(d.onTime?.map((m) => m.percent)).toEqual([80, 89, 89, 90, 90, 91]);
    expect(d.rft).toEqual({ percent: 89, jobs: 55, failedFirst: 6 });
    expect(d.workDue).toHaveLength(14); expect(d.workDue?.[0]).toEqual({ date: TODAY, count: 1 });
    const inWindow = SAMPLE.jobs.filter((j) => isOpenRow(j) && (j.date_required || j.due_date || "") >= TODAY && (j.date_required || j.due_date || "") <= "2026-12-03");
    expect(sum(d.workDue!.map((x) => x.count))).toBe(inWindow.length);
  });
  it("machines: load against working hours, cutting time, £ per machine hour, jobs vs estimate", () => {
    expect(d.machines?.map((m) => [m.name, m.percent])).toEqual([["CNC Mill 2", 104], ["CNC Mill 1", 85], ["CNC Lathe 1", 60], ["Wire erosion", 60], ["CNC Lathe 2", 45], ["Band saw", 15]]);
    expect(fleetLoad(d.machines, false)).toMatchObject({ percent: 61, free: 98, detail: "61% of available hours booked · 98h free" });
    expect(d.cutting?.total).toBe(140.3); expect(d.cutting?.machines[0]).toEqual({ id: "m1", name: "CNC Mill 1", hours: 38.33 });
    expect(d.perMachineHour?.value).toEqual({ perHour: 205, jobs: 6, revenue: 37050, hours: 181 });
    expect(Math.round(37050 / 181)).toBe(205);
    expect(d.vsEstimate?.value).toEqual({ percent: 102, jobs: 6, over: 3 });
    expect(Math.round((181 / 178) * 100)).toBe(102);
  });
  it("the nightly owed trend ends on today's real figure; migration 116 off hides it", () => {
    const t = d.owedTrend;
    expect(t && t.state === "ok" && t.points).toHaveLength(91);
    expect(t && t.state === "ok" && t.points[90]).toEqual({ date: TODAY, owed: 37896, late: 15240 });
    expect(adminData(SAMPLE, false, new Set(), false).owedTrend).toEqual({ state: "missing" });
  });
  it("a failed read is null (a dash), never 0", () => {
    const f = adminData(SAMPLE, false, new Set(["payments", "runs", "inspections", "bookings", "quotes"]));
    expect(f.revenue).toBeNull(); expect(f.thisMonthRevenue).toBeNull(); expect(f.cutting).toBeNull(); expect(f.perMachineHour).toBeNull(); expect(f.vsEstimate).toBeNull();
    expect(f.rft).toBeNull(); expect(f.machines).toBeNull(); expect(f.openQuotes).toBeNull(); expect(f.quotes90).toBeNull(); expect(f.rfqsToQuote).toBeNull();
  });
  it("a new company has zeros and empty messages, not invented figures", () => {
    const e = adminData(EMPTY, false);
    expect(e.moneyOwed).toBe(0); expect(e.openJobs).toBe(0); expect(e.owedByAge?.every((b) => b.value === 0)).toBe(true);
    expect(e.customers?.rows).toEqual([]); expect(e.daysToPay).toEqual({ average: null, count: 0 }); expect(e.rft?.percent).toBeNull();
    expect(e.perMachineHour?.value).toBeNull(); expect(e.vsEstimate?.value).toBeNull();
    expect(attentionSummary(attentionFor(EMPTY, "admin"), { count: 0, failed: false }).detail).toBe("Nothing needs you right now.");
  });
});

describe("dashboard preview: Today counts what the list counts", () => {
  const sections = attentionFor(SAMPLE, "admin");
  const d = adminData(SAMPLE, false);
  it("29 things, 7 late; the leak tiles plus the others add up to the figure", () => {
    const summary = attentionSummary(sections, { count: d.attention.length, failed: false });
    expect(summary).toMatchObject({ total: 29, urgent: 7, detail: "29 things need you, 7 late" });
    const leaks = leaksFrom(sections, { rfqsToQuote: d.rfqsToQuote, overdueOwed: 15240, money: (v) => `£${v}` });
    expect(leaks.map((l) => [l.id, l.count])).toEqual([["quotes-no-decision", 3], ["rfqs-to-quote", 4], ["jobs-late", 3], ["jobs-inspection", 3], ["invoices-overdue", 4]]);
    expect(leaks[4].extra).toBe("£15240");
    const others = otherAttention(sections, { items: d.attention, failed: false })!;
    const leakRuleTotal = leaks.filter((l) => l.id !== "rfqs-to-quote").reduce((a, l) => a + (l.count ?? 0), 0);
    expect(leakRuleTotal + others.reduce((a, o) => a + o.count, 0)).toBe(29);
  });
  it("office and workshop see only their rules; admin-only money rules never reach them", () => {
    const ids = (r: "office" | "workshop" | "viewer") => attentionFor(SAMPLE, r).map((x) => x.id);
    expect(ids("office")).not.toContain("invoices-overdue"); expect(ids("office")).toContain("quotes-expired");
    expect(ids("workshop")).toEqual(["jobs-late", "delivery-awaiting", "jobs-inspection"]);
    expect(ids("viewer")).toEqual(ids("workshop"));
  });
  it("every item link is a real route (with the real ?filter= or ?job= / ?quote= parameter)", () => {
    const hrefs = sections.flatMap((x) => [x.href, ...x.items.map((i) => i.href)]);
    for (const rule of ATTENTION_RULES.filter((r) => sections.some((x) => x.id === r.id))) expect(sections.find((x) => x.id === rule.id)?.href).toBe(rule.href);
    for (const h of hrefs) expect(h).toMatch(/^\/(quotes|rfq|purchase-orders|jobs|invoices|delivery-notes)(\?(filter=[a-z-]+|job=[^&]+|quote=[^&]+))?$/);
    expect(hrefs).toContain("/jobs?filter=overdue"); expect(hrefs).toContain("/quotes?filter=no-decision"); expect(hrefs).toContain("/invoices?filter=overdue");
  });
});

describe("dashboard preview: roles decide what is a link and what shows", () => {
  it("the real destination rule decides", () => {
    const admin = makeCanOpen("admin"), viewer = makeCanOpen("viewer"), workshop = makeCanOpen("workshop"), office = makeCanOpen("office");
    expect(admin("/invoices?filter=overdue")).toBe(true); expect(admin("/time/week")).toBe(true); expect(admin("/settings#workshop-network")).toBe(true);
    expect(office("/invoices")).toBe(true); expect(office("/numbers")).toBe(false);
    expect(workshop("/invoices")).toBe(false); expect(workshop("/jobs")).toBe(true); expect(workshop("/delivery-notes")).toBe(true);
    expect(viewer("/delivery-notes")).toBe(false); expect(viewer("/jobs")).toBe(true); expect(viewer("/approval")).toBe(false);
    expect(makeCanOpen("admin", ["invoices"])("/invoices")).toBe(false);
  });
  it("tiles per view come from lib/dashboard-tiles; Problem is raised by admin, office and workshop only", () => {
    expect(roleKind("viewer")).toBe("workshop"); expect(roleKind("office")).toBe("office");
    expect(dashboardTileKeysFor("workshop")).toEqual(expect.arrayContaining(["jobs-running", "due-this-week", "delivery-notes", "my-jobs", "whole-floor"]));
    expect(dashboardTileKeysFor("office")).not.toContain("money-owed"); expect(dashboardTileKeysFor("admin")).toContain("team-week");
    expect(["admin", "office", "workshop", "viewer"].map(raisesProblems)).toEqual([true, true, true, false]);
  });
  it("workshop figures: running, due within 7 days, delivery notes, priority jobs, schedule, my jobs", () => {
    const w = workshopData(SAMPLE, "u-sam");
    expect(w).toMatchObject({ running: 9, dueThisWeek: 6, deliveryNotes: 4 });
    expect(w.priorityJobs?.map((j) => j.jobNo)).toEqual(["J-1043", "J-1051", "J-1056", "J-1057", "J-1062"]);
    expect(w.bookings).toHaveLength(8); expect(w.bookings?.[0]).toMatchObject({ machine: "Wire erosion", jobNo: "J-1066" });
    expect(w.myJobs?.map((j) => j.jobNo)).toEqual(["J-1049", "J-1056", "J-1057", "J-1062"]);
    expect(workshopData(SAMPLE, null).myJobs).toEqual([]);
    const f = sampleFloor();
    expect(f.counts).toEqual({ running: 4, paused: 1, idle: 2, late: 1 });
    expect(f.rows.find((r) => r.place === "Wire erosion")?.stale).toBe(true);
  });
});

describe("dashboard preview: rendered", () => {
  let host: HTMLElement; let root: ReturnType<typeof createRoot>;
  beforeAll(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    class RO { observe() {} unobserve() {} disconnect() {} }
    (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
    (globalThis as unknown as { IntersectionObserver: typeof RO }).IntersectionObserver = RO;
    if (!window.matchMedia) window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  });
  afterEach(() => { act(() => root?.unmount()); host?.remove(); });
  const mount = () => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root.render(createElement(DashboardPreview))); return host; };

  it("shows the real figures and the real link targets, labelled as sample data", () => {
    const el = mount();
    expect(el.textContent).toContain("Preview, sample data, nothing is saved");
    expect(el.textContent).toContain("Good afternoon, Sam. Friday, 20 November 2026");
    expect(el.textContent).toContain("29 things need you, 7 late");
    expect(el.querySelector('[data-testid="tile-money-owed"]')?.textContent).toContain("£37,896");
    expect(el.querySelector('[data-testid="tile-money-owed"]')?.getAttribute("data-href")).toBe("/invoices");
    expect(el.querySelector('[data-testid="leak-jobs-late"]')?.getAttribute("data-href")).toBe("/jobs?filter=overdue");
    expect(el.querySelector('[data-testid="approval-link"]')?.textContent).toBe("3 emails need approval");
    expect(el.querySelector('[data-testid="revenue-total"]')?.textContent).toBe("£120,230 invoiced");
    expect(el.textContent).not.toMatch(/\.example|@/);
  });
  it("a plain click on a link says Preview only and changes nothing; no success wording anywhere", () => {
    const el = mount();
    const a = el.querySelector<HTMLAnchorElement>('[data-testid="tile-open-quotes"]')!;
    act(() => { a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
    const toast = document.body.textContent ?? "";
    expect(toast).toContain("Preview only"); expect(toast).toContain("This would open /quotes. Nothing was changed.");
    expect(document.body.textContent).not.toMatch(/\b(saved successfully|has been saved|was saved|success)\b/i);
  });
  it("v2: one PreviewBar, no yellow pill, one h1; the greeting line is the page description", () => {
    const el = mount();
    expect(el.querySelectorAll('[role="group"][aria-label="Preview information"]')).toHaveLength(1);
    expect(el.querySelectorAll("h1")).toHaveLength(1);
    expect(el.querySelector("header p")?.textContent).toContain("Good afternoon, Sam");
  });
  it("v2: the jump links are the shared underline Tabs (tablist, one selected tab, every section reachable), and a tab press scrolls to its section", () => {
    const el = mount();
    const list = el.querySelector('[role="tablist"][aria-label="Jump to"]')!;
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    expect(tabs.map((x) => x.textContent)).toEqual(["Today", "Money", "Work", "Machines", "People"]);
    expect(tabs.filter((x) => x.getAttribute("aria-selected") === "true")).toHaveLength(1);
    for (const tab of tabs) expect(el.querySelector(`#${tab.getAttribute("aria-controls")}`), tab.textContent ?? "").not.toBeNull();
    const scroll = (Element.prototype as unknown as { scrollIntoView: () => void });
    const calls: string[] = []; const old = scroll.scrollIntoView; scroll.scrollIntoView = function (this: Element) { calls.push((this as HTMLElement).id); };
    act(() => { (tabs[2] as HTMLElement).click(); });
    scroll.scrollIntoView = old;
    expect(calls).toEqual(["work"]);
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
  });
  it("v2: one heading level per section (every heading inside a section is the same level, h3 under the h2 title)", () => {
    const el = mount();
    for (const id of ["today", "money", "work", "machines", "people"]) {
      const sec = el.querySelector(`#${id}`)!;
      expect(sec.querySelector("h2")?.textContent, id).toBeTruthy();
      const inner = [...sec.querySelectorAll("h1, h2, h3, h4, h5, h6")].slice(1).map((h) => h.tagName);
      expect(new Set(inner).size, `${id}: ${inner.join(",")}`).toBeLessThanOrEqual(1);
      expect(inner.every((n) => n === "H3"), id).toBe(true);
    }
  });
  it("v2: 'Also counted in Today' is a two-column list: label left, count right, every item still there with its link and count", () => {
    const el = mount();
    const box = el.querySelector('[data-testid="overview-others"]')!;
    expect(box.querySelector("h3")?.textContent).toBe("Also counted in Today");
    const rows = [...box.querySelectorAll("ul > li")];
    expect(rows.length).toBe(otherAttention(attentionFor(SAMPLE, "admin"), { items: adminData(SAMPLE, false).attention, failed: false }, false)?.length);
    for (const li of rows) {
      expect(li.querySelector('[class*="otherLabel"]')).not.toBeNull();
      expect(li.querySelector('[class*="otherCount"]')).not.toBeNull();
    }
    expect(box.querySelectorAll("a[href]").length).toBe(rows.length);
    expect(box.querySelector('[data-testid="other-count-overdue-invoices"], [data-testid^="other-count-"]')).not.toBeNull();
  });
});

