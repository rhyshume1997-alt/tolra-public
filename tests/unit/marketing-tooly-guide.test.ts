/**
 * Tooly as a living guide on the public home page. Pinned here: the menu's stages are the job traveller's stages (FLOW_STEPS); every caption is
 * an existing string from lib/marketing.ts; the caption lives ONLY in a fixed strip that owns its space (the page's scroll area ends above it),
 * never in a bubble beside him; he floats only in a measured, empty gutter; the intro never reaches over the content; the reduced-motion path
 * shows the same captions with nothing moving; Hide Tooly leaves a Show Tooly button in the header; the frame files are light and registered.
 * (Clicking, sessionStorage and the measured zero-overlap check run in a real browser: scratchpad/pw/overlap-proof.js; this file is
 * server-rendered markup, source checks and pure functions.)
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
  type FrameKey, FIGURE_MARGIN, FIGURE_SIZE, FRAME_FILE, FRAME_SET, FRAME_SRC, GUTTER_NEEDED, WALK_FRAMES, frameLayout, gutterWidth, gutterX, guideMode, lookForPose,
  walkFrameIndex, GUIDE_COPY_SOURCES, GUIDE_LABELS, GUIDE_STOPS, INTRO_DONE, INTRO_PHASES, INTRO_START, MENU_STAGES, activeStopId, idealY, introSchedule, landSchedule,
} from "@/lib/marketing/tooly-guide";

const allCopy = (value: unknown, out: Set<string> = new Set()): Set<string> => {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) value.forEach((v) => allCopy(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => allCopy(v, out));
  return out;
};
const ALLOWED = allCopy(marketing);

const ctx = (over: Partial<GuideCtx> = {}): GuideCtx => ({
  ready: true, motion: false, hidden: false, setHidden: () => {}, intro: INTRO_DONE, mode: "strip", stage: false, menuOpen: false, setMenuOpen: () => {}, skip: () => {}, ...over,
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

  it("the intro never has a menu deck over the page: no deck phases, a short show, and it ends with Tooly placed", () => {
    expect(INTRO_PHASES).toEqual(["drop", "land", "pull", "cheer"]);
    const events = introSchedule();
    let st = INTRO_START;
    const phases = new Set<string>();
    for (const ev of events) { st = ev.patch(st); phases.add(st.phase); }
    expect([...phases].filter((p) => !["drop", "land", "pull", "cheer", "done"].includes(p))).toEqual([]);
    expect(st).toEqual(INTRO_DONE);
    expect(events[0].at).toBe(0);
    expect(events.at(-1)!.at).toBeLessThan(5000);
    expect(landSchedule().at(-1)!.patch(INTRO_START)).toEqual(INTRO_DONE);
    // Nothing of the intro draws the stage list over the page: the stages appear only in the panel the person opens.
    expect(readFileSync(path.join(process.cwd(), "components/marketing/tooly-guide.tsx"), "utf8")).not.toMatch(/tm-deck|tm-floor|data-scene/);
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

describe("the caption strip", () => {
  const view = (stop = GUIDE_STOPS[0], over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(ToolyGuideView, { stop, pose: "idle", mode: "strip", motion: false, onHide: () => {}, ...over }));
  const apos = (t: string) => t.replace(/'/g, "&#x27;");

  it("shows every caption as real text in a polite live region, in a labelled region, with no bubble", () => {
    for (const stop of GUIDE_STOPS.filter((x) => x.caption)) {
      const html = view(stop);
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain(`aria-label="${apos(GUIDE_LABELS.region)}"`);
      const live = html.slice(html.indexOf('class="tg-live"'));
      expect(live).toContain(apos(stop.caption!));
      expect(html).not.toContain("tg-bubble");
    }
  });

  it("is as tall as the tallest caption and never changes height: every caption sits invisibly in one grid cell, hidden from assistive tech", () => {
    const html = view();
    const sizers = html.slice(html.indexOf('class="tg-sizers"'), html.indexOf('class="tg-live"'));
    expect(sizers).toContain('aria-hidden="true"');
    expect((sizers.match(/class="tg-line"/g) ?? []).length).toBe(GUIDE_STOPS.filter((x) => x.caption).length);
  });

  it("holds the Hide Tooly button, and a small figure only where there is no gutter (decorative, labelled nothing)", () => {
    expect(view()).toMatch(/<button[^>]*class="tg-btn"[^>]*>Hide Tooly<\/button>/);
    const strip = view(GUIDE_STOPS[0], { mode: "strip" });
    expect(strip).toContain("tg-strip-fig");
    expect(strip).toContain('aria-hidden="true"');
    const imgs = strip.match(/<img\b[^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThan(1);
    for (const img of imgs) expect(img).toMatch(/alt=""/);
    expect(view(GUIDE_STOPS[0], { mode: "gutter" })).not.toContain("tg-strip-fig"); // the one Tooly is the walker in the gutter
  });

  it("reduced motion: nothing moves (no drop phase, no video, motion flag off), the captions are the same", () => {
    const html = view(GUIDE_STOPS[2], { motion: false });
    expect(html).toContain('data-motion="false"');
    expect(html).toContain('data-phase="done"');
    expect(html).not.toMatch(/<video\b/);
    expect(html).toContain(apos(GUIDE_STOPS[2].caption!));
  });

  it("never mounts anything before the page has mounted, nor while he is hidden", () => {
    expect(withCtx(ctx({ ready: false }), createElement(ToolyGuide))).toBe("");
    expect(renderToStaticMarkup(createElement(ToolyGuide))).toBe("");
    expect(withCtx(ctx({ hidden: true }), createElement(ToolyGuide))).toBe("");
  });

  it("the live guide renders the strip (with Hide Tooly) and, with no clear gutter, no floating figure", () => {
    const html = withCtx(ctx({ mode: "strip" }), createElement(ToolyGuide));
    expect(html).toContain('class="tg-strip"');
    expect(html).toContain(`>${GUIDE_LABELS.hide}<`);
    expect(html).not.toContain('class="tg"');
    expect(html).not.toContain("tg-trail");
    expect(html).not.toContain("tg-ledge");
  });
});

describe("Hide Tooly", () => {
  it("leaves a Show Tooly button in the header (nothing floats to bring him back), and Hide is gone", () => {
    const shown = withCtx(ctx(), createElement(ToolyMenu));
    expect(shown).not.toContain(`>${GUIDE_LABELS.show}<`);
    const hidden = withCtx(ctx({ hidden: true }), createElement(ToolyMenu));
    expect(hidden).toContain(`>${GUIDE_LABELS.show}<`);
    expect(hidden).toContain(`>${GUIDE_LABELS.menu}<`);
    expect(withCtx(ctx({ hidden: true }), createElement(ToolyGuide))).not.toContain(GUIDE_LABELS.hide);
  });
});

describe("where he may be (the no-overlap rule)", () => {
  it("floats only in a measured gutter wide enough for him, otherwise lives in the strip", () => {
    expect(gutterWidth(1440, 1300)).toBe(140);
    expect(gutterWidth(1000, 1100)).toBe(0);
    expect(guideMode(140)).toBe("gutter");
    expect(guideMode(GUTTER_NEEDED)).toBe("gutter");
    expect(guideMode(GUTTER_NEEDED - 1)).toBe("strip");
    expect(guideMode(0)).toBe("strip");
    // The page's column is 1240 px wide with 40 px of padding at lg: the gutter is clear from 1440 px, not at 1280 px.
    const gutterAt = (vw: number) => gutterWidth(vw, vw - Math.max(0, (vw - 1240) / 2) - 40);
    expect(guideMode(gutterAt(1440))).toBe("gutter");
    for (const vw of [390, 768, 1024, 1280, 1360]) expect(guideMode(gutterAt(vw)), String(vw)).toBe("strip");
  });

  it("when he does float, his whole figure (and so his trail and ledge) is right of the content column", () => {
    for (const vw of [1440, 1600, 1920]) {
      const contentRight = vw - (vw - 1240) / 2 - 40;
      const x = gutterX(vw);
      expect(x).toBeGreaterThanOrEqual(contentRight + 4);
      expect(x + FIGURE_SIZE + FIGURE_MARGIN).toBe(vw);
    }
  });

  it("the caption has no bubble anywhere: not in the source, not in the styles; the strip is fixed and the page scroll area ends above it", () => {
    const root = process.cwd();
    const css = readFileSync(path.join(root, "components/marketing/marketing.css"), "utf8");
    const guide = readFileSync(path.join(root, "components/marketing/tooly-guide.tsx"), "utf8");
    const lib = readFileSync(path.join(root, "lib/marketing/tooly-guide.ts"), "utf8");
    for (const text of [css, guide, lib]) expect(text).not.toMatch(/tg-bubble|choosePlacement|leastCovered|tg-controls|Tooly says/);
    expect(css).toMatch(/\.tg-strip \{[^}]*position: fixed;[^}]*bottom: 0;/);
    expect(css).toMatch(/\.mk-sheet\.tg-docked \{[^}]*height: calc\(100dvh - var\(--tg-strip-h/);
    expect(css).toMatch(/html\.tg-docked \{ overflow: hidden; \}/);
    expect(guide).toContain("--tg-strip-h");
  });

  it("follows the scroll down the gutter from the top of the page to the foot, staying in range", () => {
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

  it("use the up-left point for point stops and the clipboard where a document is held; nothing is mirrored", () => {
    expect(lookForPose("point")).toBe("pointUpLeft");
    expect(lookForPose("think")).toBe("think");
    expect(GUIDE_STOPS.find((s) => s.id === "handles")!.pose).toBe("clipboard");
    expect(lookForPose("clipboard")).toBe("clipboard");
    const html = renderToStaticMarkup(createElement(ToolyGuideView, { stop: GUIDE_STOPS[1], pose: "pointUpLeft", mode: "strip", motion: false, onHide: () => {} }));
    expect(html).not.toContain("scaleX(-1)");
    expect(html).not.toContain("data-flip");
    expect(html).toContain("/tooly/point-upleft.webp");
  });

  it("the intro uses the frames in order: air, land, spanner reach and heave (three times), rest, stamp up and down once, then the wave", () => {
    let st = INTRO_START;
    const seen: string[] = [];
    let notch = 0;
    for (const ev of introSchedule()) { st = ev.patch(st); notch = Math.max(notch, st.notch); if (seen.at(-1) !== st.look) seen.push(st.look); }
    expect(seen.slice(0, 3)).toEqual(["air", "land", "reach"]);
    expect(seen.filter((l) => l === "heave")).toHaveLength(3);
    expect(notch).toBe(3);
    expect(seen.indexOf("rest")).toBeGreaterThan(seen.lastIndexOf("heave"));
    expect(seen.filter((l) => l === "stampDown")).toHaveLength(1);
    expect(seen.indexOf("stampUp")).toBeGreaterThan(seen.indexOf("rest"));
    expect(seen.at(-1)).toBe("wave");
  });
});
