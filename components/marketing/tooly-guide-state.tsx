"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  GUIDE_HIDDEN_KEY, GUIDE_INTRO_KEY, INTRO_DONE, INTRO_START, INTRO_WAIT, gutterWidth, guideMode, introSchedule, landSchedule, type GuideMode, type IntroState,
} from "@/lib/marketing/tooly-guide";

// Inputs: children (the whole marketing page). Output: one shared state for Tooly's header menu and for Tooly himself: whether he is hidden (kept
// in sessionStorage only), whether the person allows motion, the measured gutter and the mode it gives (a floating figure in the empty gutter, or
// only a small figure in the caption strip), and the intro timeline's step.
// DOCKING: while Tooly is shown, the marketing root (.mk-sheet) becomes the page's scroll area and ends above the caption strip
// (marketing.css: .mk-sheet.tg-docked, with --tg-strip-h set by tooly-guide.tsx). The strip therefore owns its own space and never lies over the
// page's content, footer or call to action; hiding him puts the ordinary window scroll back, at the same place.
// Must not change: nothing runs until after the page has mounted (nothing in the first paint, so LCP is untouched); the intro plays once per
// browser session, never with reduced motion, never when the page is already scrolled, and only drops him into the gutter when the gutter is
// clear (else into the strip); it is driven by animation frames so it pauses with the tab; scrolling, a key press or a click skips it. Nothing is sent anywhere.

export type GuideCtx = {
  ready: boolean;
  motion: boolean;
  hidden: boolean;
  setHidden: (value: boolean) => void;
  intro: IntroState;
  /** "gutter": a floating Tooly in the empty right-hand gutter. "strip": a small Tooly inside the caption strip only. */
  mode: GuideMode;
  /** True when the intro is the gutter show (the ledge on the cable), false for the plain drop into the strip. */
  stage: boolean;
  menuOpen: boolean;
  setMenuOpen: (value: boolean) => void;
  skip: () => void;
};
type Ctx = GuideCtx;
export const GuideContext = createContext<Ctx | null>(null);
export const useToolyGuide = () => useContext(GuideContext);

const read = (key: string) => { try { return window.sessionStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string | null) => { try { if (value === null) window.sessionStorage.removeItem(key); else window.sessionStorage.setItem(key, value); } catch { /* storage blocked: memory only */ } };

/** The marketing root, and whether it is currently the scroll area. */
export const sheetRoot = () => document.querySelector<HTMLElement>(".mk-sheet");
export const scrollTopNow = () => { const root = sheetRoot(); return root?.classList.contains("tg-docked") ? root.scrollTop : window.scrollY; };

/** The gutter: window (or scroll area) width minus the right edge of the widest content column, measured from the page itself. */
export function measureGutter(): number {
  const root = sheetRoot();
  if (!root) return 0;
  const width = root.classList.contains("tg-docked") ? root.clientWidth : document.documentElement.clientWidth;
  let right = 0;
  root.querySelectorAll<HTMLElement>('[class*="max-w-[1240px]"]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1) return;
    right = Math.max(right, r.right - (parseFloat(getComputedStyle(el).paddingRight) || 0));
  });
  return right > 0 ? gutterWidth(width, right) : 0;
}

export function ToolyGuideProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [motion, setMotion] = useState(false);
  const [hidden, setHiddenState] = useState(false);
  const [intro, setIntro] = useState<IntroState>(INTRO_START);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<GuideMode>("strip");
  const finished = useRef(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setMotion(!query.matches);
    sync();
    setHiddenState(read(GUIDE_HIDDEN_KEY) === "1");
    // Appear only once the page's fonts are in (at most 1.5 s), so the strip is measured at its final height and nothing moves after it shows.
    let alive = true;
    let frame = 0;
    // The mode is measured before the first render of the strip, so it never changes height (a figure in it or not) after it shows.
    const go = () => { if (alive) frame = requestAnimationFrame(() => { if (alive) { setMode(guideMode(measureGutter())); setReady(true); } }); };
    const timer = window.setTimeout(go, 1500);
    const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
    if (fonts?.ready) fonts.ready.then(() => { window.clearTimeout(timer); go(); }).catch(go); else go();
    query.addEventListener("change", sync);
    return () => { alive = false; window.clearTimeout(timer); cancelAnimationFrame(frame); query.removeEventListener("change", sync); };
  }, []);

  // Dock the caption strip: the marketing root becomes the scroll area above it, keeping the place the person has reached.
  useEffect(() => {
    if (!ready || hidden) return;
    const root = sheetRoot();
    if (!root) return;
    const at = window.scrollY;
    root.classList.add("tg-docked");
    document.documentElement.classList.add("tg-docked");
    root.scrollTop = at;
    return () => {
      const top = root.scrollTop;
      root.classList.remove("tg-docked");
      document.documentElement.classList.remove("tg-docked");
      root.style.removeProperty("--tg-strip-h");
      window.scrollTo(0, top);
    };
  }, [ready, hidden]);

  // The mode follows the measured gutter, again whenever the window or the layout changes size.
  useEffect(() => {
    if (!ready) return;
    const update = () => setMode(guideMode(measureGutter()));
    update();
    window.addEventListener("resize", update, { passive: true });
    const root = sheetRoot();
    const observer = typeof ResizeObserver === "undefined" || !root ? null : new ResizeObserver(update);
    if (observer && root) observer.observe(root);
    return () => { window.removeEventListener("resize", update); observer?.disconnect(); };
  }, [ready, hidden]);

  const setHidden = useCallback((value: boolean) => { finished.current = true; setHiddenState(value); write(GUIDE_HIDDEN_KEY, value ? "1" : null); if (value) setIntro(INTRO_DONE); }, []);
  const skip = useCallback(() => { finished.current = true; write(GUIDE_INTRO_KEY, "1"); setIntro(INTRO_DONE); }, []);

  const canPlay = ready && motion && !hidden;
  const stage = mode === "gutter";

  // Reduced motion or hidden: no show at all, he is simply placed (the guide shows no figure while the phase is "off" or "wait").
  useEffect(() => { if (ready && !canPlay) setIntro(INTRO_DONE); }, [ready, canPlay]);
  useEffect(() => {
    if (!canPlay || finished.current) return;
    if (scrollTopNow() > 8 || read(GUIDE_INTRO_KEY) === "1") { finished.current = true; setIntro(INTRO_DONE); return; }
    setIntro(INTRO_WAIT);
    const events = guideMode(measureGutter()) === "gutter" ? introSchedule() : landSchedule(); // measured now: the mode state may not have caught up yet
    let next = 0;
    let t = 0;
    let last = 0;
    let frame = 0;
    let startTimer = 0;
    const tick = (now: number) => {
      t += Math.min(now - last, 50); // a hidden tab stops the frames; a long gap never jumps the show ahead
      last = now;
      while (next < events.length && events[next].at <= t) { const ev = events[next]; setIntro((s) => ev.patch(s)); next += 1; }
      if (next < events.length) frame = requestAnimationFrame(tick);
      else { finished.current = true; write(GUIDE_INTRO_KEY, "1"); }
    };
    const begin = () => { startTimer = window.setTimeout(() => { last = performance.now(); frame = requestAnimationFrame(tick); }, 400); };
    if (document.readyState === "complete") begin(); else window.addEventListener("load", begin, { once: true });
    const stop = (event: Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      if (event.type === "scroll" && scrollTopNow() < 6) return;
      cancelAnimationFrame(frame);
      window.clearTimeout(startTimer);
      skip();
    };
    // Scroll events do not bubble from the scroll area to the window, so listen in the capture phase.
    window.addEventListener("scroll", stop, { passive: true, capture: true });
    window.addEventListener("keydown", stop, { passive: true });
    window.addEventListener("pointerdown", stop, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(startTimer);
      window.removeEventListener("load", begin);
      window.removeEventListener("scroll", stop, { capture: true });
      window.removeEventListener("keydown", stop);
      window.removeEventListener("pointerdown", stop);
    };
    // The plan (gutter show or plain drop) is fixed when the intro starts; later resizes do not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPlay, skip]);

  const value = useMemo<Ctx>(() => ({ ready, motion, hidden, setHidden, intro, mode, stage, menuOpen, setMenuOpen, skip }), [ready, motion, hidden, setHidden, intro, mode, stage, menuOpen, skip]);
  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
}
