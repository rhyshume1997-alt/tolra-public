/**
 * Tooly as a living guide on the public home page: the menu's stages are the job traveller's stages (FLOW_STEPS), every caption is an
 * existing string from lib/marketing.ts (no new claim), the reduced-motion path still shows the same captions with nothing moving, the
 * Hide Tooly control exists and swaps to Show Tooly, the placement search keeps him off headings, links and form fields, and the intro
 * timeline walks every real stage once. (Clicking and sessionStorage are checked in a real browser; this file is server-rendered markup and pure functions.)
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ToolyGuide, ToolyGuideView } from "@/components/marketing/tooly-guide";
import { GuideContext, type GuideCtx } from "@/components/marketing/tooly-guide-state";
import { ToolyMenu } from "@/components/marketing/tooly-menu";
import * as marketing from "@/lib/marketing";
import { FLOW_STEPS } from "@/lib/marketing";
import {
  GUIDE_COPY_SOURCES, GUIDE_LABELS, GUIDE_STOPS, INTRO_DONE, INTRO_START, MENU_STAGES, activeStopId, choosePlacement, idealY, introSchedule,
  landSchedule, rectsOverlap, type Rect,
} from "@/lib/marketing/tooly-guide";

const allCopy = (value: unknown, out: Set<string> = new Set()): Set<string> => {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) value.forEach((v) => allCopy(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => allCopy(v, out));
  return out;
};
const ALLOWED = allCopy(marketing);

const ctx = (over: Partial<GuideCtx> = {}): GuideCtx => ({
  ready: true, motion: false, hidden: false, setHidden: () => {}, intro: INTRO_DONE, menuOpen: false, setMenuOpen: () => {}, skip: () => {}, ...over,
});
const withCtx = (value: GuideCtx, child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(GuideContext.Provider, { value }, child));

describe("menu stages", () => {
  it("are exactly the traveller's stages, in order, with its labels, numbers and stamps", () => {
    expect(MENU_STAGES.map((s) => s.id)).toEqual(FLOW_STEPS.map((s) => s.id));
    expect(MENU_STAGES.map((s) => s.label)).toEqual(FLOW_STEPS.map((s) => s.label));
    expect(MENU_STAGES.map((s) => s.op)).toEqual(FLOW_STEPS.map((s) => s.op));
    expect(MENU_STAGES.map((s) => s.stamp)).toEqual(FLOW_STEPS.map((s) => s.stamp));
  });

  it("the open panel lists every stage with its stamp as plain text, labels the example, and the button is a closed disclosure until used", () => {
    const closed = withCtx(ctx(), createElement(ToolyMenu));
    expect(closed).toContain(GUIDE_LABELS.menu);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('class="tm-panel"');
    const open = withCtx(ctx({ menuOpen: true }), createElement(ToolyMenu));
    expect(open).toContain('aria-expanded="true"');
    for (const step of FLOW_STEPS) {
      expect(open).toContain(`>${step.label}<`);
      expect(open).toContain(`>${step.stamp}<`);
    }
    expect(open.match(/<li\b/g)).toHaveLength(FLOW_STEPS.length);
    expect(open).toContain(marketing.ILLUSTRATION_LABEL);
    expect(open).not.toContain('data-on="false"'); // still panel: every stamp shown
  });

  it("the intro timeline stamps every real stage once, in order, and ends with Tooly placed", () => {
    const events = introSchedule();
    let s = INTRO_START;
    const rows: number[] = [];
    for (const ev of events) { s = ev.patch(s); if (s.phase === "carry" && !rows.includes(s.row)) rows.push(s.row); }
    expect(rows).toEqual(FLOW_STEPS.map((_, i) => i));
    expect(s).toEqual(INTRO_DONE);
    expect(events[0].at).toBe(0);
    const drop = events.find((e) => e.patch(INTRO_START).phase === "drop")!;
    expect(drop.at).toBe(0);
    expect(landSchedule().at(-1)!.patch(INTRO_START)).toEqual(INTRO_DONE);
  });
});

describe("captions", () => {
  it("every label and caption is an existing string from lib/marketing.ts, nothing new", () => {
    expect(GUIDE_COPY_SOURCES.length).toBeGreaterThan(10);
    for (const text of GUIDE_COPY_SOURCES) expect(ALLOWED.has(text), text).toBe(true);
    for (const stop of GUIDE_STOPS) {
      if (stop.caption) expect(ALLOWED.has(stop.caption), stop.id).toBe(true);
      if (stop.label) expect(ALLOWED.has(stop.label), stop.id).toBe(true);
    }
  });

  it("keeps the page's content rules (no prices or numbers, no we/our/us, no integrations, promises or em dashes) and the labels too", () => {
    const lines = [...GUIDE_COPY_SOURCES, ...Object.values(GUIDE_LABELS)];
    for (const line of lines) {
      expect(line).not.toMatch(/£|\$|€|\d\s*%/);
      expect(line).not.toMatch(/\b(?:we|we'll|we're|our|ours|us|price|pricing|testimonial|import|imports|backups?|GitHub|Xero|Sage|QuickBooks|automatic\w*|soon|coming)\b/i);
      expect(line).not.toContain("—");
    }
  });

  it("says the AI helper is optional and off until an admin switches it on, in the stops that mention it", () => {
    const text = GUIDE_COPY_SOURCES.join(" ");
    expect(text).toMatch(/Optional/);
    expect(text).toMatch(/stays off until your admin switches it on/);
    expect(text).toMatch(/in pilot/);
  });

  it("uses the poses the stops promise: point, think at the enquiry, celebrate at the invoice, wave to start", () => {
    const pose = (id: string) => GUIDE_STOPS.find((s) => s.id === id)!.pose;
    expect(pose("hero")).toBe("wave");
    expect(pose("handles")).toBe("think");
    expect(pose("invoices")).toBe("celebrate");
    expect(pose("one-place")).toBe("point");
  });
});

describe("reduced motion", () => {
  it("renders the same captions with nothing moving: no walking, no drop, no clips, decorative images, a labelled region", () => {
    for (const stop of GUIDE_STOPS.filter((s) => s.caption)) {
      const html = renderToStaticMarkup(createElement(ToolyGuideView, { stop, pose: stop.pose, bubble: "left", saysOpen: false, motion: false, size: 104, onHide: () => {}, onSays: () => {} }));
      expect(html).toContain(stop.caption!.replace(/'/g, "&#x27;"));
      expect(html).toContain('data-motion="false"');
      expect(html).toContain('data-moving="false"');
      expect(html).toContain('data-phase="done"');
      expect(html).toContain(`aria-label="${GUIDE_LABELS.region.replace(/'/g, "&#x27;")}"`);
      expect(html).not.toMatch(/<video\b/);
      const imgs = html.match(/<img\b[^>]*>/g) ?? [];
      expect(imgs.length).toBeGreaterThan(1);
      for (const img of imgs) expect(img).toMatch(/alt=""/);
      expect(html).toContain('aria-hidden="true"'); // the figure
      expect(imgs.filter((i) => i.includes("opacity:1"))).toHaveLength(1);
    }
  });

  it("never mounts the guide before the page has mounted (nothing in the first paint)", () => {
    expect(withCtx(ctx({ ready: false }), createElement(ToolyGuide))).toBe("");
    expect(renderToStaticMarkup(createElement(ToolyGuide))).toBe("");
  });
});

describe("Hide Tooly", () => {
  it("is a real button beside him, and hiding leaves only a Show Tooly button", () => {
    const stop = GUIDE_STOPS[0];
    const shown = withCtx(ctx({ intro: INTRO_DONE }), createElement(ToolyGuide));
    expect(shown).toContain(`>${GUIDE_LABELS.hide}<`);
    expect(shown).not.toContain(`>${GUIDE_LABELS.show}<`);
    expect(renderToStaticMarkup(createElement(ToolyGuideView, { stop, pose: "wave", bubble: "none", saysOpen: false, motion: true, size: 104, onHide: () => {}, onSays: () => {} }))).toMatch(/<button[^>]*>Hide Tooly<\/button>/);
    const hidden = withCtx(ctx({ hidden: true }), createElement(ToolyGuide));
    expect(hidden).toContain(`>${GUIDE_LABELS.show}<`);
    expect(hidden).not.toContain(`>${GUIDE_LABELS.hide}<`);
    expect(hidden).not.toContain("<img");
  });

  it("folds a caption that has no clear place into a Tooly says button (aria-expanded) and keeps the text in the page", () => {
    const stop = GUIDE_STOPS.find((s) => s.id === "pain")!;
    const html = renderToStaticMarkup(createElement(ToolyGuideView, { stop, pose: stop.pose, bubble: "collapsed", saysOpen: false, motion: true, size: 56, onHide: () => {}, onSays: () => {} }));
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="tg-note"[^>]*>Tooly says<\/button>/);
    expect(html).toContain("An enquiry comes in");
    expect(html).toContain('data-open="false"');
  });
});

describe("placement", () => {
  const input = { idealY: 300, vh: 900, topMin: 8, x: 1330, figW: 104, figH: 128, controlsW: 104, controlsH: 36, bubbleW: 264, bubbleH: 120, hasCaption: true };
  const heading: Rect = { left: 1100, top: 280, right: 1300, bottom: 330 };

  it("never lets his body, buttons or caption touch a heading, link or form field", () => {
    const avoid = [heading, { left: 1000, top: 440, right: 1340, bottom: 480 }];
    const result = choosePlacement({ ...input, avoid });
    const bubbleRect: Rect = result.bubble === "left"
      ? { left: input.x - 10 - input.bubbleW, top: result.y, right: input.x - 10, bottom: result.y + input.bubbleH }
      : { left: input.x + input.figW - input.bubbleW, top: result.y - 10 - input.bubbleH, right: input.x + input.figW, bottom: result.y - 10 };
    const parts: Rect[] = [
      { left: input.x, top: result.y, right: input.x + input.figW, bottom: result.y + input.figH },
      { left: input.x, top: result.y + input.figH, right: input.x + input.figW, bottom: result.y + input.figH + input.controlsH },
      ...(result.bubble === "left" || result.bubble === "above" ? [bubbleRect] : []),
    ];
    for (const part of parts) for (const box of avoid) expect(rectsOverlap(part, box, 4)).toBe(false);
  });

  it("folds the caption away rather than cover something when nowhere is clear, and needs no caption when there is none", () => {
    const wall: Rect = { left: 0, top: -50, right: 1440, bottom: 1000 };
    expect(choosePlacement({ ...input, avoid: [wall] }).bubble).toBe("collapsed");
    expect(choosePlacement({ ...input, hasCaption: false, avoid: [wall] }).bubble).toBe("none");
    expect(choosePlacement({ ...input, avoid: [] })).toEqual({ y: 300, bubble: "left" });
  });

  it("follows the scroll from the top of the page to the bottom and stays in range", () => {
    expect(idealY(0, 80, 700)).toBe(80);
    expect(idealY(1, 80, 700)).toBe(700);
    expect(idealY(0.5, 80, 700)).toBe(390);
    expect(idealY(NaN, 80, 700)).toBe(80);
    expect(idealY(3, 80, 700)).toBe(700);
  });

  it("speaks for the last stop crossing the reading line and keeps the previous one in a gap", () => {
    expect(activeStopId(new Set(["pain", "handles"]), "hero")).toBe("handles");
    expect(activeStopId(new Set(), "pain")).toBe("pain");
  });
});
