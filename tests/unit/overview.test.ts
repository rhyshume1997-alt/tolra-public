import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AttentionSection } from "@/lib/attention-items";
import { attentionSummary, fleetLoad, leaksFrom, OVERVIEW_SECTIONS, revenueVsLastMonth } from "@/lib/overview";

const sec = (id: AttentionSection["id"], count: number, detail = "", failed = false): AttentionSection => ({
  id,
  title: id,
  href: `/x?filter=${id}`,
  count,
  items: count ? [{ key: `${id}-1`, title: "t", detail, href: "#", ageDays: 3 }] : [],
  failed,
});
const money = (v: number) => `£${v.toLocaleString("en-GB")}`;

describe("owner overview leaks", () => {
  const sections = [
    sec("quotes-no-decision", 6, "Severn Valve Co (sent 12 days ago)"),
    sec("jobs-late", 2, "Severn Valve Co (2 days late)"),
    sec("jobs-inspection", 3, "Kestrel Motorsport (finished 2 days ago)"),
    sec("invoices-overdue", 2, "Precision Engineering Group (34 days overdue)"),
  ];

  it("reads its counts from the Needs attention sections, so the row and the list agree", () => {
    const leaks = leaksFrom(sections, { rfqsToQuote: 3, overdueOwed: 6900, money });
    expect(leaks.map((l) => [l.id, l.count])).toEqual([
      ["quotes-no-decision", 6],
      ["rfqs-to-quote", 3],
      ["jobs-late", 2],
      ["jobs-inspection", 3],
      ["invoices-overdue", 2],
    ]);
    expect(leaks.find((l) => l.id === "invoices-overdue")?.extra).toBe("£6,900");
    expect(leaks.find((l) => l.id === "jobs-late")?.detail).toBe("Severn Valve Co (2 days late)");
    expect(leaks.find((l) => l.id === "jobs-late")?.href).toBe("/x?filter=jobs-late");
  });

  it("shows the alarm word only when there is something late or overdue", () => {
    const quiet = leaksFrom([sec("quotes-no-decision", 0), sec("jobs-late", 0), sec("jobs-inspection", 0), sec("invoices-overdue", 0)], { rfqsToQuote: 0, overdueOwed: 0, money });
    expect(quiet.every((l) => !l.alarm)).toBe(true);
    expect(quiet.find((l) => l.id === "jobs-late")?.detail).toBe("Nothing is late.");
    expect(leaksFrom(sections, { rfqsToQuote: 0, overdueOwed: 0, money }).find((l) => l.id === "jobs-late")?.alarm).toBe("Late");
  });

  it("a failed read is a dash and says so, never a reassuring 0", () => {
    const leaks = leaksFrom([...sections.filter((s) => s.id !== "jobs-late"), sec("jobs-late", 0, "", true)], { rfqsToQuote: null, overdueOwed: null, money });
    const late = leaks.find((l) => l.id === "jobs-late")!;
    expect(late.count).toBeNull();
    expect(late.failed).toBe(true);
    expect(late.detail).toBe("Couldn't load this.");
    expect(leaks.find((l) => l.id === "rfqs-to-quote")?.count).toBeNull();
  });

  it("when the whole list can't be read, every leak from it says so and none is dropped", () => {
    const leaks = leaksFrom(null, { rfqsToQuote: 2, overdueOwed: 0, money }, true);
    expect(leaks.map((l) => l.id)).toEqual(["quotes-no-decision", "rfqs-to-quote", "jobs-late", "jobs-inspection", "invoices-overdue"]);
    for (const l of leaks.filter((x) => x.id !== "rfqs-to-quote")) {
      expect(l.count, l.id).toBeNull();
      expect(l.failed, l.id).toBe(true);
      expect(l.detail, l.id).toBe("Couldn't load this.");
    }
    expect(leaks.find((l) => l.id === "rfqs-to-quote")?.count).toBe(2);
  });

  it("while the list loads every count is a dash; a rule this role doesn't have is left out", () => {
    expect(leaksFrom(null, { rfqsToQuote: null, overdueOwed: null, money }).every((l) => l.count === null)).toBe(true);
    const noMoney = leaksFrom(sections.filter((s) => s.id !== "invoices-overdue"), { rfqsToQuote: 1, overdueOwed: 0, money });
    expect(noMoney.map((l) => l.id)).not.toContain("invoices-overdue");
  });

  it("the sections run Today, Money, Work, Machines, People", () => {
    expect(OVERVIEW_SECTIONS.map((s) => s.id)).toEqual(["today", "money", "work", "machines", "people"]);
  });

  it("the jump bar sticks at the app top bar's height, so it sits below the bar and not under it", () => {
    const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
    expect(read("components/topbar.tsx")).toMatch(/<header className="sticky top-0 z-30 [^"]*\bh-16\b/);
    expect(read("components/overview.tsx")).toMatch(/aria-label="Jump to" className="sticky top-16 /);
  });
});

describe("owner overview figures", () => {
  const sections = [
    sec("quotes-expired", 1),
    sec("quotes-no-decision", 6),
    sec("jobs-late", 2),
    sec("jobs-inspection", 3),
    sec("invoices-overdue", 2),
  ];

  it("Today counts the whole Needs attention list plus the Dashboard's own items, and the late or overdue among them", () => {
    const summary = attentionSummary(sections, { count: 1, failed: false });
    expect(summary).toEqual({ total: 15, urgent: 4, detail: "15 things need you, 4 of them late or overdue", failed: false });
    expect(attentionSummary([sec("jobs-inspection", 1)], { count: 0, failed: false }).detail).toBe("1 thing needs you, none late or overdue");
    expect(attentionSummary([sec("jobs-late", 0)], { count: 0, failed: false })).toMatchObject({ total: 0, urgent: 0, detail: "Nothing needs you right now." });
  });

  it("Today is a dash while loading, and says so when any part of the list failed", () => {
    expect(attentionSummary(null, { count: 0, failed: false })).toEqual({ total: null, urgent: null, detail: "Loading…", failed: false });
    expect(attentionSummary(sections, { count: null, failed: false })).toMatchObject({ total: null, detail: "Loading…" });
    for (const failed of [
      attentionSummary(null, { count: 0, failed: false }, true),
      attentionSummary([...sections, sec("pos-late", 0, "", true)], { count: 0, failed: false }),
      attentionSummary(sections, { count: 0, failed: true }),
      attentionSummary(sections, { count: null, failed: true }),
    ]) expect(failed).toEqual({ total: null, urgent: null, detail: "Couldn't load this.", failed: true });
  });

  const months = (values: number[]) => ["May", "Jun", "Jul", "Aug", "Sep", "Oct"].map((month, i) => ({ month, revenue: values[i] }));

  it("this month's revenue so far is compared with all of last month, from the Revenue panel's last two points", () => {
    expect(revenueVsLastMonth(months([1, 2, 3, 4, 16290, 18244]), false, money)).toEqual({ previous: 16290, change: 12, detail: "So far 12% above Sep (£16,290)", failed: false });
    expect(revenueVsLastMonth(months([0, 0, 0, 0, 2000, 500]), false, money)).toMatchObject({ change: -75, detail: "So far 75% below Sep (£2,000)" });
    expect(revenueVsLastMonth(months([0, 0, 0, 0, 1000, 1000]), false, money).detail).toBe("So far level with Sep (£1,000)");
    expect(revenueVsLastMonth(months([0, 0, 0, 0, 0, 500]), false, money)).toEqual({ previous: 0, change: null, detail: "Nothing received in Sep", failed: false });
  });

  it("a last month that netted below zero (reversals) is not compared with, and a tiny amount is never '100% below'", () => {
    expect(revenueVsLastMonth(months([0, 0, 0, 0, -100, 500]), false, money)).toEqual({ previous: -100, change: null, detail: "Sep netted below zero", failed: false });
    expect(revenueVsLastMonth(months([0, 0, 0, 0, -100, 0]), false, money).detail).toBe("Sep netted below zero");
    expect(revenueVsLastMonth(months([0, 0, 0, 0, 100000, 1]), false, money)).toMatchObject({ change: -99, detail: "So far 99% below Sep (£100,000)" });
    expect(revenueVsLastMonth(months([0, 0, 0, 0, 100000, 0]), false, money)).toMatchObject({ change: -100, detail: "So far 100% below Sep (£100,000)" });
  });

  it("the revenue comparison is a dash while loading and says so when the payments read failed", () => {
    expect(revenueVsLastMonth(null, true, money)).toEqual({ previous: null, change: null, detail: "Loading…", failed: false });
    expect(revenueVsLastMonth(null, false, money)).toEqual({ previous: null, change: null, detail: "Couldn't load this.", failed: true });
  });

  it("all machines together: hours booked of hours available, and the free hours an overbooked machine can't lend", () => {
    const fleet = fleetLoad([{ booked: 46, available: 40 }, { booked: 10, available: 40 }, { booked: 0, available: 20 }], false);
    expect(fleet).toEqual({ percent: 56, free: 50, detail: "56% of available hours booked · 50h free", failed: false });
    expect(fleetLoad([{ booked: 0, available: 40 }], false)).toMatchObject({ percent: 0, free: 40 });
    expect(fleetLoad([], false)).toEqual({ percent: null, free: null, detail: "No machine hours set up.", failed: false });
  });

  it("a machine with no working days adds no booked hours, so the fleet agrees with the bars", () => {
    expect(fleetLoad([{ booked: 10, available: 40 }, { booked: 30, available: 0 }], false)).toEqual({ percent: 25, free: 30, detail: "25% of available hours booked · 30h free", failed: false });
    expect(fleetLoad([{ booked: 30, available: 0 }], false)).toEqual({ percent: null, free: null, detail: "No machine hours set up.", failed: false });
  });

  it("the machine figure is a dash while loading and says so when the machines or bookings read failed", () => {
    expect(fleetLoad(null, true)).toEqual({ percent: null, free: null, detail: "Loading…", failed: false });
    expect(fleetLoad(null, false)).toEqual({ percent: null, free: null, detail: "Couldn't load this.", failed: true });
  });
});
