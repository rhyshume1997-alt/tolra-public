/**
 * Tooly as a living guide on the public home page: plain data and pure functions, no React, no DOM, so tests can read them.
 * Inputs: the copy in lib/marketing.ts. Output: the stops Tooly visits (pose + caption), the menu's stage list, the intro timeline,
 * and the placement search that keeps him and his caption off headings, links and form fields.
 * Must not change: every caption below is an existing string from lib/marketing.ts (no new claim, number, feature or integration);
 * the stages are FLOW_STEPS, never a second list; nothing here calls the network or touches the app, auth or the database.
 */
import {
  CLOSE_CALL_LINE, CLOSE_TITLE, FAQ_TITLE, FEATURES, FLOW_STEPS, ONE_PLACE_ITEMS, ONE_PLACE_TITLE, PAIN_CARDS, POSITIONING_LINE, SCREENSHOTS,
  START_STEPS, TOOLY_FLOW_NOTES, TOOLY_INTRO, TOOLY_TITLE, WHO_TEXT, WHO_TITLE,
} from "@/lib/marketing";
import type { ToolyPose } from "@/components/tooly/poses";

/** Control labels (not claims). */
export const GUIDE_LABELS = { menu: "Job stages", hide: "Hide Tooly", show: "Show Tooly", says: "Tooly says", region: "Tooly's guide", close: "Close" } as const;

export const GUIDE_HIDDEN_KEY = "tolra.tooly.hidden";
export const GUIDE_INTRO_KEY = "tolra.tooly.intro";

/** The menu lists the real stages, straight from the job traveller. */
export const MENU_STAGES = FLOW_STEPS.map((s) => ({ id: s.id, op: s.op, label: s.label, stamp: s.stamp }));

export type GuideStop = {
  id: string;
  /** Where the stop's element is: a selector, then optionally the ancestor to use (so no markup in app/page.tsx has to change). */
  selector: string;
  up?: string;
  /** Which of several matches (default the first). */
  nth?: number;
  /** An original still, or one of the newer frames (the clipboard) by name. */
  pose: ToolyPose | "clipboard";
  label: string | null;
  caption: string | null;
};

/** In page order. Captions are existing strings only (checked by tests/unit/marketing-tooly-guide.test.ts). */
export const GUIDE_STOPS: readonly GuideStop[] = [
  { id: "hero", selector: "#hero-title", up: "section", pose: "wave", label: TOOLY_TITLE, caption: TOOLY_INTRO },
  { id: "one-place", selector: "#one-place-title", up: "section", pose: "point", label: ONE_PLACE_TITLE, caption: POSITIONING_LINE },
  { id: "pain", selector: "#pain-title", up: "section", pose: "oops", label: PAIN_CARDS[0].title, caption: PAIN_CARDS[0].detail },
  { id: "handles", selector: "#handles-title", up: "div", pose: "clipboard", label: FLOW_STEPS[0].label, caption: TOOLY_FLOW_NOTES.enquiry },
  { id: "board", selector: '[aria-labelledby="features-title"] .mk-reveal', pose: "point", label: SCREENSHOTS[1].title, caption: ONE_PLACE_ITEMS[1].detail },
  { id: "invoices", selector: '[aria-labelledby="features-title"] article', pose: "celebrate", label: FLOW_STEPS[6].label, caption: TOOLY_FLOW_NOTES.invoice },
  { id: "worksheet", selector: '[aria-labelledby="features-title"] article', nth: 1, pose: "clipboard", label: FLOW_STEPS[3].label, caption: FLOW_STEPS[3].caption },
  { id: "schedule", selector: '[aria-labelledby="features-title"] article', nth: 2, pose: "think", label: FLOW_STEPS[4].label, caption: FLOW_STEPS[4].caption },
  { id: "tooly", selector: "#tooly-title", up: "section", pose: "point", label: FEATURES[3].title, caption: FEATURES[3].detail },
  { id: "builder", selector: "#builder-title", up: "section", pose: "idle", label: null, caption: null },
  { id: "who", selector: "#who-title", up: "section", pose: "point", label: WHO_TITLE, caption: WHO_TEXT },
  { id: "start", selector: "#start-title", up: "section", pose: "point", label: START_STEPS[2].title, caption: START_STEPS[2].detail },
  { id: "faq", selector: "#faq-title", up: "section", pose: "think", label: FAQ_TITLE, caption: null },
  { id: "close", selector: "#close-title", up: "section", pose: "love", label: CLOSE_TITLE, caption: CLOSE_CALL_LINE },
];

/** Every string a caption or label may be: the checked copy above and nothing else. */
export const GUIDE_COPY_SOURCES: readonly string[] = GUIDE_STOPS.flatMap((s) => [s.label, s.caption].filter((x): x is string => Boolean(x)));

// ---------------------------------------------------------------------------------------------------------------------------------
// The intro: Tooly drops in, pulls the menu down with his spanner in three notches, then the document goes down the real stages.
// ---------------------------------------------------------------------------------------------------------------------------------

export type IntroPhase = "off" | "wait" | "drop" | "land" | "pull" | "carry" | "cheer" | "lift" | "done";
/** What he looks like: one of the new on-model frames (air, land, reach, heave, rest) or one of the original stills. */
export type IntroLook = "air" | "land" | "reach" | "heave" | "rest" | "stampUp" | "stampDown" | ToolyPose;
export type IntroState = { phase: IntroPhase; notch: 0 | 1 | 2 | 3; row: number; stamped: number; swing: number; look: IntroLook };
export const INTRO_START: IntroState = { phase: "off", notch: 0, row: -1, stamped: 0, swing: 0, look: "idle" };
export const INTRO_WAIT: IntroState = { ...INTRO_START, phase: "wait" };
export const INTRO_DONE: IntroState = { ...INTRO_START, phase: "done", look: "wave" };

export const FALL_MS = 420; // the weighted fall, then the landing frame (inside the 120 to 700 ms range for a one-off hero moment)
export const LAND_MS = 380;
export const DROP_MS = FALL_MS + LAND_MS;
export const ROW_MS = 460;
const PULL_AT = [1100, 1550, 2000] as const; // three heaves, each a hold of "heave" then back to "reach"
const HEAVE_MS = 380;
const CARRY_AT = 3000; // after the pull he rests the spanner on his shoulder, then stamps each stage

export type IntroEvent = { at: number; patch: (s: IntroState) => IntroState };
/** Wide screens: drop (air), land, take hold of the bolt (reach), heave three times while the panel lowers, spanner on the shoulder, then stamp each stage (stamp up, stamp down), then cheer. */
export function introSchedule(): IntroEvent[] {
  const ev: IntroEvent[] = [
    { at: 0, patch: (s) => ({ ...s, phase: "drop", look: "air" }) },
    { at: FALL_MS, patch: (s) => ({ ...s, phase: "land", look: "land" }) },
    { at: DROP_MS, patch: (s) => ({ ...s, phase: "pull", look: "reach" }) },
  ];
  PULL_AT.forEach((at, i) => {
    ev.push({ at, patch: (s) => ({ ...s, notch: (i + 1) as 1 | 2 | 3, swing: s.swing + 1, look: "heave" }) });
    ev.push({ at: at + HEAVE_MS, patch: (s) => ({ ...s, look: "reach" }) });
  });
  ev.push({ at: PULL_AT[2] + HEAVE_MS, patch: (s) => ({ ...s, look: "rest" }) });
  FLOW_STEPS.forEach((_, i) => {
    ev.push({ at: CARRY_AT + i * ROW_MS, patch: (s) => ({ ...s, phase: "carry", row: i, swing: s.swing + 1, look: "stampUp" }) });
    ev.push({ at: CARRY_AT + i * ROW_MS + 240, patch: (s) => ({ ...s, look: "stampDown", stamped: i + 1 }) });
  });
  const end = CARRY_AT + FLOW_STEPS.length * ROW_MS;
  ev.push({ at: end, patch: (s) => ({ ...s, phase: "cheer", look: "celebrate" }) });
  ev.push({ at: end + 800, patch: (s) => ({ ...s, phase: "lift", notch: 0, look: "wave" }) });
  ev.push({ at: end + 1400, patch: () => INTRO_DONE });
  return ev.sort((a, b) => a.at - b.at);
}
/** Narrow screens (no menu scene): he drops into his place at the edge (air, then the landing frame) and settles. */
export function landSchedule(): IntroEvent[] {
  return [
    { at: 0, patch: (s) => ({ ...s, phase: "drop", look: "air" }) },
    { at: FALL_MS, patch: (s) => ({ ...s, phase: "land", look: "land" }) },
    { at: DROP_MS + 60, patch: () => INTRO_DONE },
  ];
}
export const INTRO_TOTAL_MS = introSchedule().at(-1)!.at;

// ---------------------------------------------------------------------------------------------------------------------------------
// Placement: keep Tooly, his buttons and his caption off headings, links, buttons and form fields.
// ---------------------------------------------------------------------------------------------------------------------------------

/** `soft`: running text (avoided where there is room); anything else is a heading, link, button or form field (avoided always). */
export type Rect = { left: number; top: number; right: number; bottom: number; soft?: boolean };
export const rectsOverlap = (a: Rect, b: Rect, pad = 0) => a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;

export type Placement = { y: number; bubble: "left" | "above" | "collapsed" | "none" };
export type PlacementInput = {
  idealY: number; vh: number; topMin: number; x: number; figW: number; figH: number; controlsW: number; controlsH: number;
  bubbleW: number; bubbleH: number; hasCaption: boolean; avoid: readonly Rect[];
  /** What the caption bubble itself must clear, when that is less than what he and his buttons must clear (the bubble may cover running text where he may not). */
  bubbleAvoid?: readonly Rect[];
};

export function choosePlacement(i: PlacementInput): Placement {
  const maxY = i.vh - i.figH - i.controlsH - 8;
  const clamp = (y: number) => Math.min(Math.max(y, i.topMin), Math.max(i.topMin, maxY));
  const clear = (r: Rect[], against: readonly Rect[]) => r.every((box) => against.every((a) => !rectsOverlap(box, a, 4)));
  const free = (r: Rect[]) => clear(r, i.avoid);
  const group = (y: number): Rect[] => [
    { left: i.x, top: y, right: i.x + i.figW, bottom: y + i.figH },
    { left: i.x + i.figW - i.controlsW, top: y + i.figH, right: i.x + i.figW, bottom: y + i.figH + i.controlsH },
  ];
  const bubble = (y: number, where: "left" | "above"): Rect =>
    where === "left"
      ? { left: i.x - 10 - i.bubbleW, top: y, right: i.x - 10, bottom: y + i.bubbleH }
      : { left: i.x + i.figW - i.bubbleW, top: y - 10 - i.bubbleH, right: i.x + i.figW, bottom: y - 10 };
  const offsets = [0];
  for (let d = 24; d <= i.vh; d += 24) offsets.push(-d, d);
  if (i.hasCaption) {
    for (const d of offsets) {
      const y = clamp(i.idealY + d);
      for (const where of ["left", "above"] as const) {
        const b = bubble(y, where);
        const inside = b.left >= 4 && b.top >= 4 && b.bottom <= i.vh - 4; // the caption is never cut off by the window
        if (inside && free(group(y)) && clear([b], i.bubbleAvoid ?? i.avoid)) return { y, bubble: where };
      }
    }
  }
  for (const d of offsets) {
    const y = clamp(i.idealY + d);
    if (free(group(y))) return { y, bubble: i.hasCaption ? "collapsed" : "none" };
  }
  // Nowhere is wholly clear: stand where the least is covered, a heading, link, button or field counting ten times running text.
  const bubbleKind = i.hasCaption ? "collapsed" : "none";
  let best = clamp(i.idealY);
  let bestScore = Infinity;
  for (const d of offsets) {
    const y = clamp(i.idealY + d);
    const score = group(y).reduce((sum, box) => sum + i.avoid.reduce((n, a) => n + (rectsOverlap(box, a, 4) ? (a.soft ? 1 : 10) : 0), 0), 0);
    if (score < bestScore) { bestScore = score; best = y; }
  }
  return { y: best, bubble: bubbleKind };
}

/** Where Tooly would stand on his own: down the right-hand edge in step with how far the page is scrolled. */
export function idealY(progress: number, topY: number, bottomY: number): number {
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  return topY + p * Math.max(0, bottomY - topY);
}

/** The last stop whose element crosses the reading line wins; with none crossing, the previous one stays. */
export function activeStopId(crossing: ReadonlySet<string>, previous: string): string {
  let found = previous;
  for (const stop of GUIDE_STOPS) if (crossing.has(stop.id)) found = stop.id;
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The on-model frame set (public/tooly/*.webp, normalised from the ten supplied PNGs): one crop box and one scale for all ten, so the
// feet sit on one baseline and nothing jumps when frames swap. Registered on the original 1024 canvas: centre x 512, feet at y 957.
// ---------------------------------------------------------------------------------------------------------------------------------

export type FrameKey = "air" | "land" | "reach" | "heave" | "rest" | "pointUpLeft" | "walk1" | "walk2" | "walk3" | "walk4" | "clipboard" | "stampUp" | "stampDown";
export const FRAME_SRC: Record<FrameKey, string> = {
  air: "/tooly/air.webp",
  land: "/tooly/land.webp",
  reach: "/tooly/spanner-reach.webp",
  heave: "/tooly/spanner-heave.webp",
  rest: "/tooly/spanner-rest.webp",
  pointUpLeft: "/tooly/point-upleft.webp",
  walk1: "/tooly/walk-1.webp",
  walk2: "/tooly/walk-2.webp",
  walk3: "/tooly/walk-3.webp",
  walk4: "/tooly/walk-4.webp",
  clipboard: "/tooly/clipboard.webp",
  stampUp: "/tooly/stamp-up.webp",
  stampDown: "/tooly/stamp-down.webp",
};
export const WALK_FRAMES: readonly FrameKey[] = ["walk1", "walk2", "walk3", "walk4"];
/** Two sets, each with its own crop but the same character scale: the pose set (206 x 287 files: a 644 x 898 crop at 0.32) and the stamp set (243 x 306: a 950 x 1195 crop at 0.256, aligned to the clipboard's feet and head axis). */
export type FrameSet = "pose" | "stamp";
export const FRAME_SET: Record<FrameKey, FrameSet> = { air: "pose", land: "pose", reach: "pose", heave: "pose", rest: "pose", pointUpLeft: "pose", walk1: "pose", walk2: "pose", walk3: "pose", walk4: "pose", clipboard: "stamp", stampUp: "stamp", stampDown: "stamp" };
export const FRAME_FILE: Record<FrameSet, { w: number; h: number }> = { pose: { w: 206, h: 287 }, stamp: { w: 243, h: 306 } };
const FRAME_CROP: Record<FrameSet, { w: number; h: number; cx: number; footY: number; standH: number }> = {
  pose: { w: 644, h: 898, cx: 322, footY: 892, standH: 870 },
  stamp: { w: 950, h: 1195, cx: 573, footY: 1092, standH: 1084 },
};

/** Where a frame sits in the figure box so his standing height, feet and centre match the stills (stand 496/430 of the width, feet 513/430, centre 0.447). */
export function frameLayout(size: number, set: FrameSet = "pose") {
  const c = FRAME_CROP[set];
  const k = (1.153 * size) / c.standH;
  return { width: c.w * k, height: c.h * k, left: 0.447 * size - c.cx * k, top: 1.193 * size - c.footY * k, k };
}
/** The bolt's centre, as an x offset from the figure box's left edge, so the menu's cable can run down to it (source x 715 of 1024, crop starts at 190). */
export const boltX = (size: number) => frameLayout(size).left + (715 - 190) * frameLayout(size).k;

/** The walk: one frame per this much of his own travel (a fraction of his height), so the feet step as the page scrolls. */
export const WALK_STEP_PER_HEIGHT = 0.17;
export const walkFrameIndex = (travel: number, figH: number) => ((Math.floor(Math.max(0, travel) / (WALK_STEP_PER_HEIGHT * figH)) % 4) + 4) % 4;

/** The look for a stop's pose: the new up-left point replaces the mirrored still; everything else is an original still. */
export const lookForPose = (pose: ToolyPose | "clipboard"): ToolyPose | FrameKey => (pose === "point" ? "pointUpLeft" : pose === "clipboard" ? "clipboard" : pose);

/** Last resort when nowhere is wholly clear: stand where the least is covered (a heading, link, button or field counts ten times running text). */
export function leastCovered(i: Omit<PlacementInput, "hasCaption" | "bubbleW" | "bubbleH">): number {
  const maxY = i.vh - i.figH - i.controlsH - 8;
  const clamp = (y: number) => Math.min(Math.max(y, i.topMin), Math.max(i.topMin, maxY));
  let best = clamp(i.idealY);
  let bestScore = Infinity;
  const offsets = [0];
  for (let d = 24; d <= i.vh; d += 24) offsets.push(-d, d);
  for (const d of offsets) {
    const y = clamp(i.idealY + d);
    const boxes: Rect[] = [
      { left: i.x, top: y, right: i.x + i.figW, bottom: y + i.figH },
      { left: i.x + i.figW - i.controlsW, top: y + i.figH, right: i.x + i.figW, bottom: y + i.figH + i.controlsH },
    ];
    const score = boxes.reduce((sum, box) => sum + i.avoid.reduce((n, a) => n + (rectsOverlap(box, a, 4) ? (a.soft ? 1 : 10) : 0), 0), 0) + Math.abs(d) / 2000;
    if (score < bestScore) { bestScore = score; best = y; }
  }
  return best;
}
