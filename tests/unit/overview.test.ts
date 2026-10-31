import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ATTENTION_RULES, type AttentionSection } from "@/lib/attention-items";
import { attentionSummary, fleetLoad, floorNow, leaksFrom, otherAttention, OVERVIEW_SECTIONS, revenueVsLastMonth } from "@/lib/overview";

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

  it("Today counts the whole Needs attention list plus the Dashboard's own items, and the late among them", () => {
    const summary = attentionSummary(sections, { count: 1, failed: false });
    expect(summary).toEqual({ total: 15, urgent: 4, detail: "15 things need you, 4 late", failed: false });
    expect(attentionSummary([sec("jobs-inspection", 1)], { count: 0, failed: false }).detail).toBe("1 thing needs you, none late");
    expect(attentionSummary([sec("jobs-late", 0)], { count: 0, failed: false })).toMatchObject({ total: 0, urgent: 0, detail: "Nothing needs you right now." });
  });

  it("the words say Late, never overdue or late or overdue", () => {
    const words = [
      attentionSummary(sections, { count: 0, failed: false }).detail,
      ...leaksFrom(sections, { rfqsToQuote: 0, overdueOwed: 6900, money }).flatMap((l) => [l.label, l.alarm ?? ""]),
      ...leaksFrom(sections.map((s) => sec(s.id, 0)), { rfqsToQuote: 0, overdueOwed: 0, money }).map((l) => l.detail),
    ].join(" | ");
    expect(words).not.toMatch(/overdue/i);
    const money_ = leaksFrom(sections, { rfqsToQuote: 0, overdueOwed: 6900, money }).find((l) => l.id === "invoices-overdue")!;
    expect(money_).toMatchObject({ label: "Money late", alarm: "Late" });
  });

  it("the headline matches what is on screen: the four leak tiles plus every other rule and Dashboard item add up to it", () => {
    // Rhys saw 6 in the headline and 0 on every tile: the 6 were in rules the tiles don't show. They are listed now, not dropped.
    const hidden = [sec("quotes-no-decision", 0), sec("jobs-late", 0), sec("jobs-inspection", 0), sec("invoices-overdue", 0), sec("invoices-draft", 4), sec("delivery-uninvoiced", 1), sec("pos-late", 0)];
    const extra = [{ key: "inv-payment-to-confirm", title: "3 imported invoices: payment to confirm", href: "/invoices" }];
    const summary = attentionSummary(hidden, { count: extra.length, failed: false });
    expect(summary.detail).toBe("6 things need you, none late");
    const others = otherAttention(hidden, { items: extra, failed: false })!;
    expect(others).toEqual([
      { id: "invoices-draft", kind: "rule", label: "invoices-draft", count: 4, href: "/x?filter=invoices-draft" },
      { id: "delivery-uninvoiced", kind: "rule", label: "delivery-uninvoiced", count: 1, href: "/x?filter=delivery-uninvoiced" },
      { id: "inv-payment-to-confirm", kind: "item", label: "3 imported invoices: payment to confirm", count: 1, href: "/invoices" },
    ]);
    const tiles = leaksFrom(hidden, { rfqsToQuote: 0, overdueOwed: 0, money }).filter((l) => l.id !== "rfqs-to-quote").reduce((sum, l) => sum + (l.count ?? 0), 0);
    expect(tiles + others.reduce((sum, o) => sum + o.count, 0)).toBe(summary.total);
    // And with the full example list.
    const all = otherAttention(sections, { items: [], failed: false })!;
    expect(all.map((o) => o.id)).toEqual(["quotes-expired"]);
  });

  it("open Problems (jobs-problems, migration 117) are counted in Today with the other rules and listed under the tiles, since no tile shows them", () => {
    const rule = ATTENTION_RULES.find((r) => r.id === "jobs-problems")!;
    expect(rule.roles).toEqual(["admin", "office"]);
    const withProblems = [...sections, sec("jobs-problems", 2, "Severn Valve Co (reported today)")];
    // The other rules make 14 (1 + 6 + 2 + 3 + 2), plus the 2 Problems and 1 Dashboard item.
    expect(attentionSummary(withProblems, { count: 1, failed: false })).toEqual({ total: 17, urgent: 4, detail: "17 things need you, 4 late", failed: false });
    // Problems are not Late: they add to the total but not to the late count.
    expect(attentionSummary([sec("jobs-problems", 3)], { count: 0, failed: false })).toEqual({ total: 3, urgent: 0, detail: "3 things need you, none late", failed: false });
    // None of the four tiles is Problems, so the "Also counted in Today" line lists it, with its own title, count and link.
    expect(leaksFrom(withProblems, { rfqsToQuote: 0, overdueOwed: 0, money }).map((l) => l.id)).not.toContain("jobs-problems");
    const others = otherAttention(withProblems, { items: [], failed: false })!;
    expect(others).toContainEqual({ id: "jobs-problems", kind: "rule", label: "jobs-problems", count: 2, href: "/x?filter=jobs-problems" });
    // The tiles plus the listed rules add up to the headline exactly.
    const tiles = leaksFrom(withProblems, { rfqsToQuote: 0, overdueOwed: 0, money }).filter((l) => l.id !== "rfqs-to-quote").reduce((sum, l) => sum + (l.count ?? 0), 0);
    expect(tiles + others.reduce((sum, o) => sum + o.count, 0)).toBe(attentionSummary(withProblems, { count: 0, failed: false }).total);
    // With no open Problem the rule is not listed; if its read failed, the headline and the line are both a dash.
    expect(otherAttention([...sections, sec("jobs-problems", 0)], { items: [], failed: false })!.map((o) => o.id)).not.toContain("jobs-problems");
    expect(attentionSummary([...sections, sec("jobs-problems", 0, "", true)], { count: 0, failed: false })).toMatchObject({ total: null, failed: true });
    expect(otherAttention([...sections, sec("jobs-problems", 0, "", true)], { items: [], failed: false })).toBeNull();
  });

  it("the other items are null (a dash) while loading or when any part failed, like the headline", () => {
    expect(otherAttention(null, { items: [], failed: false })).toBeNull();
    expect(otherAttention(sections, { items: null, failed: false })).toBeNull();
    expect(otherAttention(sections, { items: [], failed: true })).toBeNull();
    expect(otherAttention([...sections, sec("pos-late", 0, "", true)], { items: [], failed: false })).toBeNull();
    expect(otherAttention(sections, { items: [], failed: false }, true)).toBeNull();
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
    // The invoiced series says invoiced.
    expect(revenueVsLastMonth(months([0, 0, 0, 0, 0, 500]), false, money, "invoiced").detail).toBe("Nothing invoiced in Sep");
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

  it("People: how many are on the floor now is the clocked-in count, and a real 0 is a 0", () => {
    expect(floorNow({ clockedIn: 4 }, false)).toEqual({ count: 4, detail: "4 on the floor now", figure: "4 on the floor now", failed: false });
    expect(floorNow({ clockedIn: 0 }, false)).toMatchObject({ count: 0, figure: "0 on the floor now", failed: false });
  });

  it("People: a clock read that failed, or is still loading, is a dash with the reason and never 0", () => {
    expect(floorNow(null, false)).toEqual({ count: null, detail: "Couldn't load this.", figure: "— Couldn't load this.", failed: true });
    expect(floorNow(null, true)).toEqual({ count: null, detail: "Loading…", figure: "— Loading…", failed: false });
    // Still loading wins over a stale count from an earlier read.
    expect(floorNow({ clockedIn: 3 }, true).count).toBeNull();
  });
});
