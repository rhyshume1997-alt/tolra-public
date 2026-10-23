import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DOT, StatTile } from "@/components/stat-tile";
import { StatusBadge } from "@/components/status-badge";
import { COLOUR_CLASSES, STATUS_MAP, type StatusKey } from "@/lib/status-colours";

const html = (status: StatusKey | null, label?: string) => renderToStaticMarkup(createElement(StatusBadge, { status, label }));

describe("StatusBadge", () => {
  it("renders the status word next to the colour for every status", () => {
    for (const [status, entry] of Object.entries(STATUS_MAP)) {
      const out = html(status as StatusKey);
      expect(out, status).toContain(`>${entry.label}</span>`);
      expect(out, status).toContain(`data-colour="${entry.colour}"`);
    }
  });

  it("uses the colour classes of its family, and drops the default brand fill", () => {
    const out = html("overdue");
    expect(out).toContain(COLOUR_CLASSES.red.badge);
    expect(out).not.toMatch(/\sbg-brand\s/);
    expect(out).not.toContain("text-brand-ink");
  });

  it("keeps a page's own wording when one is given", () => {
    const out = html("complete", "Done");
    expect(out).toContain(">Done</span>");
    expect(out).toContain('data-colour="green"');
  });

  it("shows a yellow status with dark text", () => {
    const out = html("at_risk");
    expect(out).toContain("bg-[#CA8A04]");
    expect(out).toContain("text-slate-950");
    expect(out).not.toContain("text-white");
  });

  it("renders an unmapped status as the plain badge with its word", () => {
    const out = renderToStaticMarkup(createElement(StatusBadge, { status: null, label: "Rejected", unmapped: { className: "bg-red-100" } }));
    expect(out).toContain(">Rejected</span>");
    expect(out).toContain("bg-red-100");
    expect(out).not.toContain("data-colour");
  });

  it("shows two badges at once without either hiding the other (Overdue red + Rework purple)", () => {
    const out = renderToStaticMarkup(createElement("div", null, createElement(StatusBadge, { status: "overdue" }), createElement(StatusBadge, { status: "rework" })));
    expect(out).toContain('data-colour="red"');
    expect(out).toContain('data-colour="purple"');
    expect(out).toContain(">Overdue</span>");
    expect(out).toContain(">Rework</span>");
  });
});

describe("Job Board tiles: In rework is purple, Overdue stays red", () => {
  const tile = (label: string, tone: "bad" | "rework") => renderToStaticMarkup(createElement(StatTile, { label, value: 3, tone }));

  it("draws the In rework tile marker in the rework purple and Overdue in red", () => {
    const rework = tile("In rework", "rework");
    const overdue = tile("Overdue", "bad");
    expect(rework).toContain("bg-[#7C3AED]");
    expect(rework).not.toContain("bg-[#DC2626]");
    expect(overdue).toContain("bg-[#DC2626]");
    expect(overdue).not.toContain("bg-[#7C3AED]");
    expect(rework).not.toBe(overdue.replace("Overdue", "In rework"));
  });

  it("keeps the two tones apart in the marker map", () => {
    expect(DOT.rework).toBe(COLOUR_CLASSES.purple.dot);
    expect(DOT.bad).toBe(COLOUR_CLASSES.red.dot);
    expect(DOT.rework).not.toBe(DOT.bad);
  });

  it("is wired on the Job Board: Rework is a purple tag chip (never a status tile) and Overdue stays on the red one", () => {
    const page = readFileSync(path.resolve(__dirname, "../../app/(dashboard)/jobs/page.tsx"), "utf8");
    // Rework is a tag on a Running job (Rhys, Wed 21 Oct): no In rework tile; its chip carries the rework purple.
    expect(page).not.toMatch(/<StatTile label="In rework"/);
    expect(page).toMatch(/COLOUR_CLASSES\.purple\.dot[^\n]*`Rework \(/);
    // Overdue is a due-date chip and badge now, drawn from the one map, which keeps it red.
    expect(page).toContain('<StatusBadge data-testid="due-light" status={due}');
    expect(STATUS_MAP.overdue.colour).toBe("red");
    expect(STATUS_MAP.rework.colour).toBe("purple");
  });
});
