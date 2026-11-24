// @vitest-environment jsdom
/**
 * BOUNDARY (Numbers, Module 7, PREVIEW ONLY). Inputs: the exports of components/numbers/preview/NumbersPreview.tsx, the REAL lib/numbers functions it runs and the
 * SOURCE of app/(dashboard)/numbers/page.tsx. Output: pass/fail. Pins the months choices, the customer bars, the cash table and the machine hours to hand arithmetic over
 * the sample rows, the failure wording to the page, and checks by rendering that nothing reports success. No network, no Supabase. Written with createElement (no JSX).
 * Must not change: never loosen these to make a change pass; if a real rule changes this test is the alarm.
 */
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import NumbersPreview, { CREDITS, FAILED, INVOICES, MACHINES, MONTH_CHOICES, NOW, PAYMENTS, RUNS, SHOWN_CUSTOMERS, customerRows, loadSample, numbersView } from "@/components/numbers/preview/NumbersPreview";
import { londonMonthsEnding, windowOf } from "@/lib/numbers";

const PAGE = fs.readFileSync(path.join(process.cwd(), "app/(dashboard)/numbers/page.tsx"), "utf8");
const pence = (x: number | string | null | undefined) => Math.round(Number(x ?? 0) * 100);

describe("numbers preview: the real page still says what the preview mirrors", () => {
  it("choices, shown customers, failure wording, admin-only, labels", () => {
    expect(PAGE).toContain("const MONTH_CHOICES = [3, 6, 12] as const;"); expect([...MONTH_CHOICES]).toEqual([3, 6, 12]);
    expect(PAGE).toContain("const SHOWN_CUSTOMERS = 8;"); expect(SHOWN_CUSTOMERS).toBe(8);
    expect(PAGE).toContain("const FAILED = \"Couldn't load this.\";"); expect(FAILED.replace("’", "'")).toBe("Couldn't load this.");
    expect(PAGE).toContain("activeRole !== \"admin\") router.replace(\"/dashboard\")");
    for (const t of ["1. Which customers are we relying on?", "2. Are invoices turning into cash?", "3. Where is machine time going?", "Issued invoices, less credit notes on their own date", "Payments by the date received, reversals included", "Recorded machine runs, not booked hours", "Invoiced ex VAT against money received, by month", "No invoiced work in these months.", "No machine time recorded in these months.", "The gap is invoiced less received in that month, not money owed: a payment can settle an invoice from an earlier month."]) expect(PAGE).toContain(t);
    const src = fs.readFileSync(path.join(process.cwd(), "components/numbers/preview/NumbersPreview.tsx"), "utf8");
    for (const t of ["1. Which customers are we relying on?", "2. Are invoices turning into cash?", "3. Where is machine time going?", "Issued invoices, less credit notes on their own date", "Payments by the date received, reversals included", "Recorded machine runs, not booked hours", "Invoiced ex VAT against money received, by month", "No invoiced work in these months.", "No machine time recorded in these months."]) expect(src).toContain(t);
  });
});

describe("numbers preview: figures are lib/numbers over the sample rows", () => {
  const six = numbersView(loadSample(6, "ready"), 6);
  it("six months to November 2026 (UK calendar)", () => {
    expect(six.periods.map((p) => p.key)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(six.periods[0].label).toBe("Jun 26");
  });
  it("invoiced and received totals equal plain arithmetic over the rows in the window", () => {
    const w = windowOf(londonMonthsEnding(NOW, 6));
    const inv = INVOICES.filter((i) => (i.invoice_date as string) >= w.start && (i.invoice_date as string) < w.end).reduce((a, i) => a + pence(i.total) - pence(i.vat), 0);
    const cred = CREDITS.filter((c) => c.status === "issued" && (c.credit_date as string) >= w.start && (c.credit_date as string) < w.end).reduce((a, c) => a + pence(c.total) - pence(c.vat), 0);
    expect(six.invoicedTotal).toBe((inv - cred) / 100);
    const rec = PAYMENTS.filter((p) => (p.paid_on as string) >= w.start && (p.paid_on as string) < w.end).reduce((a, p) => a + pence(p.amount), 0);
    expect(six.receivedTotal).toBe(rec / 100);
    expect(six.cash.map((m) => m.gap)).toEqual(six.cash.map((m) => ((pence(m.invoiced) - pence(m.received)) / 100)));
    expect(six.cash.reduce((a, m) => a + pence(m.invoiced), 0)).toBe(pence(six.invoicedTotal));
  });
  it("customers: shares add up; the top eight then 'N other customers'", () => {
    const c = six.customers!;
    expect(c).not.toBeNull();
    expect(c.rows.reduce((a, r) => a + pence(r.value), 0)).toBe(pence(c.total));
    expect(c.topCustomer).toBe(c.rows[0].customer); expect(c.topShare).toBe(Math.round((c.rows[0].value / c.total) * 100));
    const twelve = numbersView(loadSample(12, "ready"), 12).customers!;
    const rows = customerRows(twelve);
    expect(rows).toHaveLength(twelve.rows.length > 8 ? 9 : twelve.rows.length);
    expect(rows[0].label).toBe(`${twelve.rows[0].customer} · ${twelve.rows[0].share}%`);
    if (twelve.rows.length > 8) { expect(rows[8].label).toBe(`${twelve.rows.length - 8} other customers`); expect(pence(rows[8].value)).toBe(twelve.rows.slice(8).reduce((a, r) => a + pence(r.value), 0)); }
  });
  it("machine hours: recorded runs inside the window, never past now", () => {
    const m = six.machines!;
    expect(m.map((r) => r.machine).sort()).toEqual(MACHINES.map((x) => x.name).sort());
    const w = windowOf(londonMonthsEnding(NOW, 6));
    for (const row of m) {
      const id = MACHINES.find((x) => x.name === row.machine)!.id;
      const hours = RUNS.filter((r) => r.machine_id === id).reduce((a, r) => a + Math.max(0, Math.min(Date.parse(r.ended_at as string), Date.parse(w.endAt), NOW.getTime()) - Math.max(Date.parse(r.started_at), Date.parse(w.startAt))) / 3_600_000, 0);
      expect(row.hours).toBeCloseTo(hours, 1);
    }
  });
  it("a failed read is a dash, never 0; a missing figure blanks the customers", () => {
    const failed = numbersView(loadSample(6, "failed"), 6);
    expect(failed.invoicedTotal).toBeNull(); expect(failed.receivedTotal).toBeNull(); expect(failed.customers).toBeUndefined(); expect(failed.machines).toBeNull();
    const part = numbersView(loadSample(6, "partial"), 6);
    expect(part.receivedTotal).toBeNull(); expect(part.invoicedTotal).not.toBeNull(); expect(part.receivedRead).toBe(false);
    expect(numbersView(loadSample(6, "no-figures"), 6).customers).toBeNull();
    const empty = numbersView(loadSample(6, "empty"), 6);
    expect(empty.invoicedTotal).toBe(0); expect(empty.customers?.rows).toEqual([]);
  });
  it("3, 6 and 12 months change the window", () => {
    expect(numbersView(loadSample(3, "ready"), 3).periods).toHaveLength(3);
    expect(numbersView(loadSample(12, "ready"), 12).periods[0].key).toBe("2025-12");
  });
});

describe("numbers preview: rendered", () => {
  let host: HTMLElement; let root: ReturnType<typeof createRoot>;
  beforeAll(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    class RO { observe() {} unobserve() {} disconnect() {} }
    (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  });
  afterEach(() => { act(() => root?.unmount()); host?.remove(); });
  it("labelled as sample data, three questions, the totals, no success wording", () => {
    host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root.render(createElement(NumbersPreview)));
    const t = host.textContent ?? "";
    expect(t).toContain("Preview, sample data, nothing is saved"); expect(t).toContain("Last 6 months, Jun 26 to Nov 26. Months follow the UK calendar.");
    expect(host.querySelector('[data-testid="numbers-invoiced"]')?.textContent).toMatch(/^£\d/);
    expect(host.querySelectorAll("table tbody tr")).toHaveLength(6);
    expect(t).not.toMatch(/\b(saved successfully|has been saved|success)\b/i);
  });
  it("v2: one PreviewBar and one h1; the rule line is the page description; the Months choice is reachable in the header actions", () => {
    host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root.render(createElement(NumbersPreview)));
    expect(host.querySelectorAll('[role="group"][aria-label="Preview information"]')).toHaveLength(1);
    expect(host.querySelectorAll("h1")).toHaveLength(1);
    expect(host.querySelector("header")?.textContent).toContain("Months follow the UK calendar.");
    expect([...host.querySelectorAll('[role="radiogroup"][aria-label="Months to show"] [role="radio"]')].map((r) => r.textContent)).toEqual(["3", "6", "12"]);
  });
});
