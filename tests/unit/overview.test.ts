import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AttentionSection } from "@/lib/attention-items";
import { leaksFrom, OVERVIEW_SECTIONS } from "@/lib/overview";

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
