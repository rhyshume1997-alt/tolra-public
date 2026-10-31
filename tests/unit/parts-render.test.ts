/**
 * Parts done, rendered (react-dom/server): the My jobs card's "N of M" and its 48 px "+1 part" button, fail closed until the database has
 * 118, who gets the button, and the Whole floor's Clocked in figure (a number for admin and office, words for everyone else).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClockedInFigure } from "@/components/workshop/clocked-in-figure";
import { MyJobs } from "@/components/workshop/my-jobs";
import type { PartsTotals } from "@/lib/job-parts";
import type { MyJob } from "@/lib/my-jobs";

const running: MyJob = { id: "r1", jobNo: "J-2409", customer: "Severn Valve Co", description: "Valve body", quantity: 50, stage: "machining", status: "running", due: "2026-10-26", dueLight: "overdue", notes: "" };
const noQuantity: MyJob = { id: "n1", jobNo: "J-2427", customer: "Aldridge Hydraulics Ltd", description: "Gland nut", quantity: null, stage: "setup", status: "not_started", due: null, dueLight: "no_due_date", notes: "" };
const parts = (done: Record<string, number>, available: boolean | null = true): PartsTotals => ({ available, done: new Map(Object.entries(done)) });
const render = (role: string, initialParts?: PartsTotals, canOpenJobs = true) => renderToStaticMarkup(createElement(MyJobs, { jobs: [running, noQuantity], role, canOpenJobs, initialParts }));

describe("My jobs: parts logged", () => {
  it("with 118, a card with a quantity shows 'N of M parts' in words and a +1 part button at least 48 px tall; a card without a quantity shows nothing", () => {
    const html = render("workshop", parts({ r1: 12, n1: 0 }));
    expect(html.match(/data-testid="my-job-parts"/g)).toHaveLength(1);
    expect(html).toContain("Parts logged: <span class=\"tabular-nums\">12 of 50 parts</span>");
    expect(html.match(/data-testid="my-job-add-part"/g)).toHaveLength(1);
    expect(html).toContain("+1 part");
    expect(html).toMatch(/class="[^"]*min-h-12[^"]*"[^>]*data-testid="my-job-add-part"|data-testid="my-job-add-part"[^>]*class="[^"]*min-h-12/);
    expect(html).toMatch(/class="[^"]*min-h-12[^"]*"[^>]*data-testid="my-job-change-count"|data-testid="my-job-change-count"[^>]*class="[^"]*min-h-12/);
    // Start / Finish / Pause are still the Job Board links, unchanged.
    expect(html).toContain("Finish on the Job Board");
    expect(html).toContain("Pause or resume");
  });

  it("zero is shown as '0 of 50 parts' when the database says nothing is logged yet", () => {
    expect(render("workshop", parts({ r1: 0 }))).toContain("0 of 50 parts");
  });

  it("at M the +1 part button is disabled and says all the parts are logged", () => {
    const html = render("workshop", parts({ r1: 50 }));
    expect(html).toContain("50 of 50 parts");
    expect(html).toMatch(/<button[^>]*data-testid="my-job-add-part"[^>]*disabled|<button[^>]*disabled[^>]*data-testid="my-job-add-part"/);
  });

  it("fail closed: nothing at all until the database says it has 118 (missing, or not known), or for a count that failed", () => {
    for (const available of [false, null]) {
      const html = render("workshop", parts({ r1: 12 }, available));
      expect(html, String(available)).not.toContain("my-job-parts");
      expect(html).not.toContain("+1 part");
    }
    expect(render("workshop", parts({}))).not.toContain("my-job-add-part");
    expect(render("workshop")).not.toContain("my-job-parts");
  });

  it("workshop, office and admin get the buttons; a viewer sees the count in words and no button", () => {
    for (const role of ["workshop", "office", "admin"]) expect(render(role, parts({ r1: 3 })).match(/data-testid="my-job-add-part"/g), role).toHaveLength(1);
    const viewer = render("viewer", parts({ r1: 3 }));
    expect(viewer).toContain("3 of 50 parts");
    expect(viewer).not.toContain("my-job-add-part");
    expect(viewer).not.toContain("my-job-change-count");
  });

  it("without access to the Job Board the card still shows and takes the count", () => {
    const html = render("workshop", parts({ r1: 3 }), false);
    expect(html).toContain("3 of 50 parts");
    expect(html).toContain("my-job-add-part");
  });
});

describe("Whole floor: the Clocked in figure", () => {
  const html = (role: string | null, clocked: { clockedIn: number; onBreak: number } | null) => renderToStaticMarkup(createElement("ul", null, createElement(ClockedInFigure, { role, clocked })));

  it("admin and office see the count and how many are on a break, in words", () => {
    for (const role of ["admin", "office"]) {
      const out = html(role, { clockedIn: 5, onBreak: 1 });
      expect(out).toContain('data-testid="floor-clocked-in">5<');
      expect(out).toContain("Clocked in");
      expect(out).toContain("1 on a break");
      expect(out).not.toContain("floor-clocked-in-note");
    }
  });

  it("a count that couldn't be read (or is loading) is a dash, never 0", () => {
    const out = html("admin", null);
    expect(out).toContain('data-testid="floor-clocked-in">—<');
    expect(out).not.toContain('data-testid="floor-clocked-in">0<');
  });

  it("workshop and viewer are told, in words, that it is shown to office and admin only (the row rules give them only their own clock records)", () => {
    for (const role of ["workshop", "viewer", null]) {
      const out = html(role, { clockedIn: 1, onBreak: 0 });
      expect(out).toContain("Who is clocked in is shown to office and admin only.");
      expect(out).not.toContain('data-testid="floor-clocked-in"');
    }
  });
});
