"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  GUIDE_HIDDEN_KEY, GUIDE_INTRO_KEY, INTRO_DONE, INTRO_START, INTRO_WAIT, STRIP_RELEASE_PX, deferStrip, gutterWidth, guideMode, introSchedule, sceneSchedule,
  type GuideMode, type IntroEvent, type IntroState,
} from "@/lib/marketing/tooly-guide";

// Inputs: children (the whole marketing page). Output: one shared state for Tooly's header menu and for Tooly himself: whether he is hidden (kept
// in sessionStorage only), whether the person allows motion, the measured gutter and the mode it gives (a floating figure in the empty gutter, or
// only a small figure in the caption strip), whether the strip is up yet, and the scene's step (the drop and the spanner/stamp scene).
// The WINDOW scrolls as it always did (iOS address bar, rubber-banding, anchors, find-in-page and scroll restoration are all native). While Tooly
// is shown only two things change: the marketing root gets bottom padding as tall as the caption strip (so the footer and call to action at the
// page end are never under the strip) and the page gets matching scroll-padding (so a jumped-to heading is never under it); both come from one CSS
// variable, --tg-strip-h, which tooly-guide.tsx sets from the strip's measured height once fonts are in.
// Must not change: nothing runs until after the page has mounted and its fonts are in (nothing in the first paint, LCP untouched); where the strip
// would cover the hero's call to action (a phone, at the top) it waits until the person has scrolled a little; the one-time intro plays once per
// browser session and never with reduced motion; the scene is driven by animation frames so it pauses with the tab; Escape ends it. Nothing is sent.

export type GuideCtx = {
  ready: boolean;
  motion: boolean;
  hidden: boolean;
  setHidden: (value: boolean) => void;
  intro: IntroState;
  /** "gutter": a floating Tooly in the empty right-hand gutter (with the ledge scene). "strip": a small Tooly inside the caption strip only. */
  mode: GuideMode;
  /** True when the strip is up (always, except at the top of a phone where it would cover the hero's call to action). */
  stripOn: boolean;
  /** True when the scene uses the gutter's ledge. */
  stage: boolean;
  menuOpen: boolean;
  setMenuOpen: (value: boolean) => void;
  skip: () => void;
  /** Plays the spanner scene again (when the person opens the Job stages menu). Does nothing without motion or while the strip is not up. */
  replay: () => void;
};
export const GuideContext = createContext<GuideCtx | null>(null);
export const useToolyGuide = () => useContext(GuideContext);

const read = (key: string) => { try { return window.sessionStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string | null) => { try { if (value === null) window.sessionStorage.removeItem(key); else window.sessionStorage.setItem(key, value); } catch { /* storage blocked: memory only */ } };

/** The marketing root. */
export const sheetRoot = () => document.querySelector<HTMLElement>(".mk-sheet");

/** The gutter: window width minus the right edge of the widest content column, measured from the page itself. */
export function measureGutter(): number {
  const root = sheetRoot();
  if (!root) return 0;
  let right = 0;
  root.querySelectorAll<HTMLElement>('[class*="max-w-[1240px]"]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1) return;
    right = Math.max(right, r.right - (parseFloat(getComputedStyle(el).paddingRight) || 0));
  });
  return right > 0 ? gutterWidth(document.documentElement.clientWidth, right) : 0;
}

/** The lowest edge, in the page, of the hero's call to action and the link under it (what the strip must not cover at rest). */
function heroBottom(): number {
  let low = 0;
  document.querySelectorAll<HTMLElement>(".mk-hero .mk-cta, .mk-hero a.mk-link").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) low = Math.max(low, r.bottom + window.scrollY);
  });
  return low;
}

export function ToolyGuideProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [motion, setMotion] = useState(false);
  const [hidden, setHiddenState] = useState(false);
  const [intro, setIntro] = useState<IntroState>(INTRO_START);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<GuideMode>("strip");
  const [deferred, setDeferred] = useState(false);
  const [released, setReleased] = useState(false);
  const finished = useRef(false);
  const runner = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setMotion(!query.matches);
    sync();
    setHiddenState(read(GUIDE_HIDDEN_KEY) === "1");
    // Appear only once the page's fonts are in (at most 1.5 s), so the strip is measured at its final height and nothing moves after it shows.
    let alive = true;
    let frame = 0;
    const go = () => {
      if (!alive) return;
      frame = requestAnimationFrame(() => {
        if (!alive) return;
        const next = guideMode(measureGutter());
        setMode(next);
        setDeferred(deferStrip(next, heroBottom(), window.innerHeight) && window.scrollY < STRIP_RELEASE_PX);
        setReady(true);
      });
    };
    const timer = window.setTimeout(go, 1500);
    const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
    if (fonts?.ready) fonts.ready.then(() => { window.clearTimeout(timer); go(); }).catch(go); else go();
    query.addEventListener("change", sync);
    return () => { alive = false; window.clearTimeout(timer); cancelAnimationFrame(frame); query.removeEventListener("change", sync); };
  }, []);

  // Where the strip would cover the hero's call to action it waits for the first scroll; once up it stays up.
  useEffect(() => {
    if (!ready || !deferred || released) return;
    const onScroll = () => { if (window.scrollY >= STRIP_RELEASE_PX) setReleased(true); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, [ready, deferred, released]);
  const stripOn = ready && !hidden && (!deferred || released);

  // The mode follows the measured gutter, again whenever the window changes size.
  useEffect(() => {
    if (!ready) return;
    const update = () => setMode(guideMode(measureGutter()));
    window.addEventListener("resize", update, { passive: true });
    return () => window.removeEventListener("resize", update);
  }, [ready]);

  // While the strip is up the page keeps room for it (see the header comment); the class turns on the two padding rules in marketing.css.
  useEffect(() => {
    if (!stripOn) return;
    const root = sheetRoot();
    if (!root) return;
    root.classList.add("tg-on");
    document.documentElement.classList.add("tg-on");
    return () => { root.classList.remove("tg-on"); document.documentElement.classList.remove("tg-on"); document.documentElement.style.removeProperty("--tg-strip-h"); };
  }, [stripOn]);

  const stopRun = useCallback(() => { runner.current?.stop(); runner.current = null; }, []);
  const setHidden = useCallback((value: boolean) => { finished.current = true; stopRun(); setHiddenState(value); write(GUIDE_HIDDEN_KEY, value ? "1" : null); if (value) setIntro(INTRO_DONE); }, [stopRun]);
  const skip = useCallback(() => { finished.current = true; stopRun(); write(GUIDE_INTRO_KEY, "1"); setIntro(INTRO_DONE); }, [stopRun]);

  /** Runs a schedule on animation frames (so it pauses with the tab); a long gap never jumps it ahead. */
  const run = useCallback((events: IntroEvent[], delay: number) => {
    stopRun();
    let next = 0;
    let t = 0;
    let last = 0;
    let frame = 0;
    const tick = (now: number) => {
      t += Math.min(now - last, 50);
      last = now;
      while (next < events.length && events[next].at <= t) { const ev = events[next]; setIntro((s) => ev.patch(s)); next += 1; }
      if (next < events.length) frame = requestAnimationFrame(tick); else { runner.current = null; finished.current = true; write(GUIDE_INTRO_KEY, "1"); }
    };
    const timer = window.setTimeout(() => { last = performance.now(); frame = requestAnimationFrame(tick); }, delay);
    runner.current = { stop: () => { window.clearTimeout(timer); cancelAnimationFrame(frame); } };
  }, [stopRun]);

  const canPlay = stripOn && motion;
  const stage = mode === "gutter";

  // Reduced motion or hidden: no show at all, he is simply placed (the guide shows no figure while the phase is "off" or "wait").
  useEffect(() => { if (ready && (!motion || hidden)) setIntro(INTRO_DONE); }, [ready, motion, hidden]);

  // The one-time intro, once the strip is up (and the page has loaded).
  useEffect(() => {
    if (!canPlay || finished.current) return;
    if (!deferred && window.scrollY > 8) { finished.current = true; setIntro(INTRO_DONE); return; } // already scrolled (restored): no show
    if (read(GUIDE_INTRO_KEY) === "1") { finished.current = true; setIntro(INTRO_DONE); return; }
    setIntro(INTRO_WAIT);
    let alive = true;
    const begin = () => { if (alive) run(introSchedule(), 400); };
    if (document.readyState === "complete") begin(); else window.addEventListener("load", begin, { once: true });
    return () => { alive = false; window.removeEventListener("load", begin); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPlay]);

  // Escape ends the scene (nothing else does: scrolling and touching the page are free, the scene is not over the page).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && runner.current) skip(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [skip]);
  useEffect(() => () => stopRun(), [stopRun]);

  const replay = useCallback(() => {
    if (!motion || !stripOn || hidden) return;
    setIntro({ ...INTRO_START, phase: "pull", look: "reach" });
    run(sceneSchedule(), 60);
  }, [motion, stripOn, hidden, run]);

  const value = useMemo<GuideCtx>(
    () => ({ ready, motion, hidden, setHidden, intro, mode, stripOn, stage, menuOpen, setMenuOpen, skip, replay }),
    [ready, motion, hidden, setHidden, intro, mode, stripOn, stage, menuOpen, skip, replay],
  );
  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
}
