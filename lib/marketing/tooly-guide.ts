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
  pose: ToolyPose;
  label: string | null;
  caption: string | null;
};

/** In page order. Captions are existing strings only (checked by tests/unit/marketing-tooly-guide.test.ts). */
export const GUIDE_STOPS: readonly GuideStop[] = [
  { id: "hero", selector: "#hero-title", up: "section", pose: "wave", label: TOOLY_TITLE, caption: TOOLY_INTRO },
  { id: "one-place", selector: "#one-place-title", up: "section", pose: "point", label: ONE_PLACE_TITLE, caption: POSITIONING_LINE },
  { id: "pain", selector: "#pain-title", up: "section", pose: "oops", label: PAIN_CARDS[0].title, caption: PAIN_CARDS[0].detail },
  { id: "handles", selector: "#handles-title", up: "div", pose: "think", label: FLOW_STEPS[0].label, caption: TOOLY_FLOW_NOTES.enquiry },
  { id: "board", selector: '[aria-labelledby="features-title"] .mk-reveal', pose: "point", label: SCREENSHOTS[1].title, caption: ONE_PLACE_ITEMS[1].detail },
  { id: "invoices", selector: '[aria-labelledby="features-title"] article', pose: "celebrate", label: FLOW_STEPS[6].label, caption: TOOLY_FLOW_NOTES.invoice },
  { id: "worksheet", selector: '[aria-labelledby="features-title"] article', nth: 1, pose: "point", label: FLOW_STEPS[3].label, caption: FLOW_STEPS[3].caption },
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

export type IntroPhase = "off" | "wait" | "land" | "drop" | "pull" | "carry" | "cheer" | "lift" | "done";
export type IntroState = { phase: IntroPhase; notch: 0 | 1 | 2 | 3; row: number; stamped: number; swing: number };
export const INTRO_START: IntroState = { phase: "off", notch: 0, row: -1, stamped: 0, swing: 0 };
export const INTRO_WAIT: IntroState = { phase: "wait", notch: 0, row: -1, stamped: 0, swing: 0 };
export const INTRO_DONE: IntroState = { phase: "done", notch: 0, row: -1, stamped: 0, swing: 0 };

export const DROP_MS = 700; // the weighted drop and its settle (inside the 120 to 700 ms range for a one-off hero moment)
export const ROW_MS = 480;
const PULL_AT = [1000, 1450, 1900] as const;
const CARRY_AT = 2700;

export type IntroEvent = { at: number; patch: (s: IntroState) => IntroState };
export function introSchedule(): IntroEvent[] {
  const ev: IntroEvent[] = [
    { at: 0, patch: (s) => ({ ...s, phase: "drop" }) },
    { at: 800, patch: (s) => ({ ...s, phase: "pull" }) },
  ];
  PULL_AT.forEach((at, i) => ev.push({ at, patch: (s) => ({ ...s, notch: (i + 1) as 1 | 2 | 3, swing: s.swing + 1 }) }));
  FLOW_STEPS.forEach((_, i) => {
    ev.push({ at: CARRY_AT + i * ROW_MS, patch: (s) => ({ ...s, phase: "carry", row: i, swing: s.swing + 1 }) });
    ev.push({ at: CARRY_AT + i * ROW_MS + 300, patch: (s) => ({ ...s, stamped: i + 1 }) });
  });
  const end = CARRY_AT + FLOW_STEPS.length * ROW_MS;
  ev.push({ at: end, patch: (s) => ({ ...s, phase: "cheer" }) });
  ev.push({ at: end + 800, patch: (s) => ({ ...s, phase: "lift", notch: 0 }) });
  ev.push({ at: end + 1400, patch: () => INTRO_DONE });
  return ev.sort((a, b) => a.at - b.at);
}
/** Narrow screens (no menu scene): he just drops into his place at the edge, then settles. */
export function landSchedule(): IntroEvent[] {
  return [{ at: 0, patch: (s) => ({ ...s, phase: "land" }) }, { at: DROP_MS + 100, patch: () => INTRO_DONE }];
}
export const INTRO_TOTAL_MS = introSchedule().at(-1)!.at;

/** The pose Tooly shows in each intro phase (real stills only). */
export const INTRO_POSE: Record<IntroPhase, ToolyPose> = { off: "idle", wait: "idle", land: "oops", drop: "oops", pull: "point", carry: "point", cheer: "celebrate", lift: "wave", done: "wave" };

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
};

export function choosePlacement(i: PlacementInput): Placement {
  const maxY = i.vh - i.figH - i.controlsH - 8;
  const clamp = (y: number) => Math.min(Math.max(y, i.topMin), Math.max(i.topMin, maxY));
  const free = (r: Rect[]) => r.every((box) => i.avoid.every((a) => !rectsOverlap(box, a, 4)));
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
        if (inside && free([...group(y), b])) return { y, bubble: where };
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
