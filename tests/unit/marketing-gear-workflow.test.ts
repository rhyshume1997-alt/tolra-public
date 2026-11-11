/**
 * "The Tolra Machine" gear workflow on the public home page: the copy is the checked flow copy, the selection helpers stay within
 * the seven stages, the gear train is mechanically consistent (mesh distance, tooth-into-gap at any angle, opposite directions,
 * inverse ratios, no collisions), phones get touch-sized gears, and the markup keeps the page's rules (one tablist on the page,
 * one Illustration label here, no figures, radio groups with one checked stage, no empty paragraphs).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GearWorkflow } from "@/components/marketing/gear-workflow";
import { FLOW_STEPS, PAIN_CARDS } from "@/lib/marketing";
import {
  COMPACT_LAYOUT, GEAR_COPY, GEAR_STAGES, STAGE_COUNT, WIDE_LAYOUT, clampStage, driveFor, gearAngle, gearPath, stepTo, type GearLayout,
} from "@/lib/marketing/gear-workflow";

const mod = (a: number, n: number) => ((a % n) + n) % n;
const near = (a: number, b: number, eps = 0.05) => Math.abs(a - b) <= eps;
const layouts: GearLayout[] = [WIDE_LAYOUT, COMPACT_LAYOUT];

describe("gear workflow copy", () => {
  it("has the seven flow stages in order, with the flow's own captions and example records", () => {
    expect(STAGE_COUNT).toBe(7);
    expect(GEAR_STAGES.map((s) => s.id)).toEqual(FLOW_STEPS.map((s) => s.id));
    GEAR_STAGES.forEach((stage, i) => {
      expect(stage.caption).toBe(FLOW_STEPS[i].caption);
      expect(stage.record).toEqual(FLOW_STEPS[i].record);
      expect(stage.op).toBe(FLOW_STEPS[i].op);
    });
    expect(GEAR_STAGES.map((s) => s.label)).toEqual(["Enquiry", "Quote", "Customer PO", "Job worksheet", "Machine schedule", "Sign-off and inspection", "Invoice"]);
  });

  it("answers each of the four problems exactly once", () => {
    const solved = GEAR_STAGES.map((s) => s.solves).filter(Boolean);
    expect([...solved].sort()).toEqual(PAIN_CARDS.map((p) => p.title).sort());
  });

  it("keeps the page's content rules in every line it adds", () => {
    const lines = [GEAR_COPY.hint, GEAR_COPY.label, ...GEAR_STAGES.flatMap((s) => [s.label, ...s.details])];
    for (const line of lines) {
      expect(line).not.toMatch(/£|\$|€|\d\s*%/);
      expect(line).not.toMatch(/\d[\d.,]*\s*(?:hours?|hrs?|h)\b/i);
      expect(line).not.toMatch(/\b(?:we|we'll|we're|our|ours|us|price|pricing|testimonial|import|imports|backups?|GitHub|Xero|Sage|QuickBooks|automatic\w*)\b/i);
    }
    for (const stage of GEAR_STAGES) expect(stage.details.length).toBeGreaterThan(0);
  });
});

describe("stage selection", () => {
  it("moves forwards and backwards and stops at the first and last stage", () => {
    expect(stepTo(0, 1)).toBe(1);
    expect(stepTo(3, -1)).toBe(2);
    expect(stepTo(0, -1)).toBe(0);
    expect(stepTo(6, 1)).toBe(6);
    expect(clampStage(99)).toBe(6);
    expect(clampStage(Number.NaN)).toBe(0);
    expect(clampStage(2.4)).toBe(2);
  });

  it("turns the train forwards for a later stage and backwards for an earlier one, three teeth of the first gear per stage", () => {
    expect(driveFor(2)).toBeGreaterThan(0);
    expect(driveFor(-1)).toBeLessThan(0);
    expect(driveFor(1)).toBeCloseTo(3 * (360 / GEAR_STAGES[0].teeth));
  });
});

describe.each(layouts)("the $variant gear train", (layout) => {
  const gears = layout.gears;

  it("meshes each pair at the sum of their pitch radii", () => {
    for (let i = 0; i < gears.length - 1; i += 1) {
      const a = gears[i];
      const b = gears[i + 1];
      expect(near(Math.hypot(b.cx - a.cx, b.cy - a.cy), a.r + b.r, 0.05)).toBe(true);
    }
  });

  it("keeps gears that are not neighbours clear of each other, and every gear inside the drawing", () => {
    for (let i = 0; i < gears.length; i += 1) {
      const g = gears[i];
      expect(g.cx - g.ra).toBeGreaterThanOrEqual(0);
      expect(g.cy - g.ra).toBeGreaterThanOrEqual(0);
      expect(g.cx + g.ra).toBeLessThanOrEqual(layout.width);
      expect(g.cy + g.ra).toBeLessThanOrEqual(layout.height);
      for (let j = i + 2; j < gears.length; j += 1) {
        const h = gears[j];
        expect(Math.hypot(h.cx - g.cx, h.cy - g.cy)).toBeGreaterThan(g.ra + h.ra + layout.module);
      }
    }
  });

  it("turns neighbours in opposite directions at the inverse ratio of their teeth", () => {
    for (let i = 0; i < gears.length - 1; i += 1) {
      expect(gears[i].spin).toBe(-gears[i + 1].spin);
      const turnA = gearAngle(gears[i], 30) - gearAngle(gears[i], 0);
      const turnB = gearAngle(gears[i + 1], 30) - gearAngle(gears[i + 1], 0);
      expect(turnB).toBeCloseTo(-turnA * (gears[i].teeth / gears[i + 1].teeth), 6);
    }
  });

  it("sits a tooth of each gear in a gap of the next at rest and at any angle of the train", () => {
    for (const drive of [0, 7, 40, 133.3, -95, driveFor(4)]) {
      for (let i = 0; i < gears.length - 1; i += 1) {
        const a = gears[i];
        const b = gears[i + 1];
        const alpha = a.toNext!;
        const pa = 360 / a.teeth;
        const pb = 360 / b.teeth;
        const t = mod(alpha - gearAngle(a, drive), pa);
        // Where the line between centres meets gear b, b's nearest gap centre must sit the matching arc length past the line.
        // (Phases are rounded to 0.01 degrees for the SVG, hence the 0.02 degree tolerance.)
        const expected = mod(0.5 * pb - (t * a.teeth) / b.teeth, pb);
        const actual = mod(alpha + 180 - gearAngle(b, drive), pb);
        expect(Math.min(Math.abs(actual - expected), pb - Math.abs(actual - expected))).toBeLessThan(0.02);
      }
    }
  });

  it("draws every tooth: one tip land and one root arc per tooth, closed", () => {
    for (const g of gears) {
      expect(g.path).toBe(gearPath(g.teeth, layout.module));
      expect((g.path.match(/A/g) ?? []).length).toBe(g.teeth * 2);
      expect(g.path.endsWith("Z")).toBe(true);
    }
  });
});

describe("touch size", () => {
  it("on a 390px phone (about 334px of drawing inside the gutters and the housing), the smallest compact gear is at least 44px across", () => {
    const scale = 334 / COMPACT_LAYOUT.width;
    const smallest = Math.min(...COMPACT_LAYOUT.gears.map((g) => g.ra * 2));
    expect(smallest * scale).toBeGreaterThanOrEqual(44);
  });
});

describe("markup", () => {
  const html = renderToStaticMarkup(createElement(GearWorkflow));
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("is radio groups, not tabs, with exactly one checked stage per group, and no figures or empty paragraphs", () => {
    expect(html).not.toMatch(/role="tab(?:list|panel)?"/);
    expect(html).not.toMatch(/<figure\b/);
    expect(html.match(/role="radiogroup"/g)).toHaveLength(2);
    expect(html.match(/role="radio"/g)).toHaveLength(14);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(2);
    expect(html).not.toMatch(/<p[^>]*>\s*<\/p>/);
  });

  it("names every gear for screen readers and keeps the drawing itself out of the accessibility tree", () => {
    for (let i = 0; i < STAGE_COUNT; i += 1) expect(html).toContain(`aria-label="Stage ${i + 1} of 7: ${GEAR_STAGES[i].label}"`);
    expect(html.match(/<svg class="gw-svg"[^>]*aria-hidden="true"/g)).toHaveLength(2);
  });

  it("labels the drawing as an illustration once, and shows the first stage's copy before any interaction", () => {
    expect(text.match(/Illustration/g)).toHaveLength(1);
    expect(text).toContain(GEAR_STAGES[0].caption);
    expect(text).toContain("Stage 1 of 7: Enquiry");
  });

  it("lays every stage out in one place so the panel never changes height, with only the selected stage exposed", () => {
    const slides = html.match(/<div class="gw-slide[^"]*"[^>]*>/g) ?? [];
    expect(slides).toHaveLength(STAGE_COUNT * 2);
    expect(slides.filter((s) => s.includes("gw-slide-on"))).toHaveLength(2);
    for (const s of slides.filter((x) => !x.includes("gw-slide-on"))) {
      expect(s).toContain('aria-hidden="true"');
      expect(s).toContain("inert");
    }
  });
});
