/**
 * Tooly as a living guide on the public home page: the menu's stages are the job traveller's stages (FLOW_STEPS), every caption is an
 * existing string from lib/marketing.ts (no new claim), the reduced-motion path still shows the same captions with nothing moving, the
 * Hide Tooly control exists and swaps to Show Tooly, the placement search keeps him off headings, links and form fields, and the intro
 * timeline walks every real stage once. (Clicking and sessionStorage are checked in a real browser; this file is server-rendered markup and pure functions.)
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ToolyGuide, ToolyGuideView } from "@/components/marketing/tooly-guide";
import { GuideContext, type GuideCtx } from "@/components/marketing/tooly-guide-state";
import { SiteHeader } from "@/components/marketing/site-header";
import { ToolyMenu } from "@/components/marketing/tooly-menu";
import * as marketing from "@/lib/marketing";
import { FLOW_STEPS } from "@/lib/marketing";
import {
  type FrameKey, FRAME_FILE, FRAME_SET, FRAME_SRC, WALK_FRAMES, frameLayout, leastCovered, lookForPose, walkFrameIndex,
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
  ready: true, motion: false, hidden: false, setHidden: () => {}, intro: INTRO_DONE, stage: false, menuOpen: false, setMenuOpen: () => {}, skip: () => {}, ...over,
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

  it("uses the poses the stops promise: point, the clipboard at the enquiry, think at the schedule, celebrate at the invoice, wave to start", () => {
    const pose = (id: string) => GUIDE_STOPS.find((s) => s.id === id)!.pose;
    expect(pose("hero")).toBe("wave");
    expect(pose("handles")).toBe("clipboard");
    expect(pose("schedule")).toBe("think");
    expect(pose("invoices")).toBe("celebrate");
    expect(pose("one-place")).toBe("point");
  });
});

describe("reduced motion", () => {
  it("renders the same captions with nothing moving: no walking, no drop, no clips, decorative images, a labelled region", () => {
    for (const stop of GUIDE_STOPS.filter((s) => s.caption)) {
      const look = lookForPose(stop.pose);
      const html = renderToStaticMarkup(createElement(ToolyGuideView, { stop, pose: look, frames: new Set([look as FrameKey, "pointUpLeft" as FrameKey]), bubble: "left", saysOpen: false, motion: false, size: 104, onHide: () => {}, onSays: () => {} }));
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

  it("never puts the caption where the window would cut it off", () => {
    const top = choosePlacement({ ...input, idealY: 20, x: 20, avoid: [{ left: 0, top: 0, right: 400, bottom: 200 }] });
    if (top.bubble === "above") expect(top.y - 10 - input.bubbleH).toBeGreaterThanOrEqual(4);
    const none = choosePlacement({ ...input, idealY: 8, x: 1330, avoid: [{ left: 0, top: 0, right: 1100, bottom: 900 }] });
    if (none.bubble === "above") expect(none.y - 10 - input.bubbleH).toBeGreaterThanOrEqual(4);
    expect(["left", "above", "collapsed"]).toContain(none.bubble);
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

describe("shared header", () => {
  it("is unchanged for the other public pages (no menu slot: no extra button, not positioned), and takes the menu only on the home page", () => {
    const plain = renderToStaticMarkup(createElement(SiteHeader));
    expect(plain).not.toContain("tm-");
    expect(plain).not.toContain("relative");
    expect(plain).toContain(marketing.SHEET_LABELS.signIn);
    expect(plain.match(/<a\b/g)).toHaveLength(2); // the logo and Sign in, as before
    const withMenu = withCtx(ctx(), createElement(SiteHeader, { menu: createElement(ToolyMenu) }));
    expect(withMenu).toContain("tm-launch");
    expect(withMenu).toContain("relative z-40");
  });

  it("the home page hero no longer carries the large static Tooly (the animated guide is the one that drops in), and keeps its proof line", async () => {
    const page = await import("@/app/page");
    const html = renderToStaticMarkup(createElement(page.default));
    const hero = html.slice(html.indexOf('aria-labelledby="hero-title"'), html.indexOf('aria-labelledby="one-place-title"'));
    expect(hero).not.toContain("width:200px;height:200px"); // the old 200 px hero mark (the traveller's small 72 px note mark is unchanged)
    expect(hero).toContain(marketing.PROOF_LINE);
  });
});

describe("the on-model frames", () => {
  const files = Object.entries(FRAME_SRC) as Array<[keyof typeof FRAME_SRC, string]>;
  const webp = (src: string) => path.join(process.cwd(), "public", src);

  it("are all there as WebP with alpha, at the size the layout expects, and light (under 60 KB each)", () => {
    expect(files).toHaveLength(13);
    for (const [key, src] of files) {
      const buf = readFileSync(webp(src));
      expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
      expect(buf.toString("ascii", 8, 12)).toBe("WEBP");
      expect(buf.toString("ascii", 12, 16), key).toBe("VP8X"); // extended header: carries the alpha flag
      expect(buf[20] & 0x10, `${key} alpha`).toBe(0x10);
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      expect([w, h], key).toEqual([FRAME_FILE[FRAME_SET[key]].w, FRAME_FILE[FRAME_SET[key]].h]);
      expect(statSync(webp(src)).size, key).toBeLessThan(60 * 1024);
    }
  });

  it("put his feet on one baseline whichever set a frame is from, so swapping never makes him jump", () => {
    const S = 104;
    const feet = (set: "pose" | "stamp") => { const l = frameLayout(S, set); return l.top + (set === "pose" ? 892 : 1092) * l.k; };
    expect(feet("pose")).toBeCloseTo(1.193 * S, 5);
    expect(feet("stamp")).toBeCloseTo(1.193 * S, 5);
    for (const set of ["pose", "stamp"] as const) { const l = frameLayout(S, set); expect(l.left).toBeGreaterThan(-0.25 * S); expect(l.left + l.width).toBeLessThan(1.15 * S); }
  });

  it("the four walk frames step with his own travel: one frame per slice of his height, round and round, never negative", () => {
    expect(WALK_FRAMES).toEqual(["walk1", "walk2", "walk3", "walk4"]);
    const h = 128;
    const step = 0.17 * h;
    expect([0, step * 1.01, step * 2.01, step * 3.01, step * 4.01].map((t) => walkFrameIndex(t, h))).toEqual([0, 1, 2, 3, 0]);
    expect(walkFrameIndex(-50, h)).toBe(0);
  });

  it("use the up-left point for point stops and the clipboard where a document is held; no stop needs a mirrored still", () => {
    expect(lookForPose("point")).toBe("pointUpLeft");
    expect(lookForPose("think")).toBe("think");
    expect(GUIDE_STOPS.find((s) => s.id === "handles")!.pose).toBe("clipboard");
    expect(lookForPose("clipboard")).toBe("clipboard");
    const html = renderToStaticMarkup(createElement(ToolyGuideView, { stop: GUIDE_STOPS[1], pose: "pointUpLeft", bubble: "left", saysOpen: false, motion: false, size: 104, onHide: () => {}, onSays: () => {} }));
    expect(html).not.toContain("scaleX(-1)");
    expect(html).not.toContain("data-flip");
    expect(html).toContain("/tooly/point-upleft.webp");
  });

  it("the intro uses the frames in order: air, land, spanner reach and heave (three times), rest, stamp up and down once per stage, then cheers", () => {
    let st = INTRO_START;
    const seen: string[] = [];
    for (const ev of introSchedule()) { st = ev.patch(st); if (seen.at(-1) !== st.look) seen.push(st.look); }
    expect(seen.slice(0, 3)).toEqual(["air", "land", "reach"]);
    expect(seen.filter((l) => l === "heave")).toHaveLength(3);
    expect(seen.indexOf("rest")).toBeGreaterThan(seen.lastIndexOf("heave"));
    expect(seen.filter((l) => l === "stampDown")).toHaveLength(FLOW_STEPS.length);
    expect(seen.indexOf("stampUp")).toBeGreaterThan(seen.indexOf("rest"));
    expect(seen.at(-1)).toBe("wave");
  });

  it("falls back to standing where least is covered, a heading counting more than running text", () => {
    const common = { idealY: 300, vh: 900, topMin: 8, x: 1330, figW: 104, figH: 128, controlsW: 104, controlsH: 36 };
    const heading: Rect = { left: 1300, top: 100, right: 1440, bottom: 880 };
    const text: Rect = { left: 1300, top: 100, right: 1440, bottom: 880, soft: true };
    expect(leastCovered({ ...common, avoid: [] })).toBe(300);
    const y = leastCovered({ ...common, avoid: [heading, { ...text, top: 500, bottom: 700 }] });
    expect(Number.isFinite(y)).toBe(true);
  });
});
