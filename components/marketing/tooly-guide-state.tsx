"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { GUIDE_HIDDEN_KEY, GUIDE_INTRO_KEY, INTRO_DONE, INTRO_START, INTRO_WAIT, introSchedule, landSchedule, type IntroState } from "@/lib/marketing/tooly-guide";

// Inputs: children. Output: one shared state for Tooly's menu (header) and Tooly himself (fixed, end of page): whether he is hidden (kept in
// sessionStorage only), whether the person allows motion, the intro timeline's current step and whether the menu is open.
// Must not change: nothing runs until after the page has mounted and gone idle (no work before first paint, so LCP is untouched); the intro
// plays once per browser session, never with reduced motion, never on a phone or tablet width, never when the page is already scrolled, and
// and is driven by animation frames so it pauses with the tab; scrolling, a key press or a click skips it. Nothing is sent anywhere.

type Ctx = {
  ready: boolean;
  motion: boolean;
  hidden: boolean;
  setHidden: (value: boolean) => void;
  intro: IntroState;
  /** True when the intro is the full menu show (wide screens); false for the plain drop on phones and tablets. */
  stage: boolean;
  menuOpen: boolean;
  setMenuOpen: (value: boolean) => void;
  skip: () => void;
};
export type GuideCtx = Ctx;
export const GuideContext = createContext<Ctx | null>(null);
export const useToolyGuide = () => useContext(GuideContext);

const STAGE_MIN_WIDTH = 1100;
const read = (key: string) => { try { return window.sessionStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string | null) => { try { if (value === null) window.sessionStorage.removeItem(key); else window.sessionStorage.setItem(key, value); } catch { /* storage blocked: memory only */ } };

export function ToolyGuideProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [motion, setMotion] = useState(false);
  const [hidden, setHiddenState] = useState(false);
  const [intro, setIntro] = useState<IntroState>(INTRO_START);
  const [menuOpen, setMenuOpen] = useState(false);
  const [stage, setStage] = useState(false);
  const finished = useRef(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setMotion(!query.matches);
    sync();
    setHiddenState(read(GUIDE_HIDDEN_KEY) === "1");
    setReady(true);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const setHidden = useCallback((value: boolean) => { finished.current = true; setHiddenState(value); write(GUIDE_HIDDEN_KEY, value ? "1" : null); if (value) setIntro(INTRO_DONE); }, []);
  const skip = useCallback(() => { finished.current = true; write(GUIDE_INTRO_KEY, "1"); setIntro(INTRO_DONE); }, []);

  const canPlay = ready && motion && !hidden;

  // Reduced motion or hidden: no show at all, he is simply placed (the guide shows nothing while the phase is "off" or "wait").
  useEffect(() => { if (ready && !canPlay) setIntro(INTRO_DONE); }, [ready, canPlay]);
  useEffect(() => {
    if (!canPlay || finished.current) return;
    const wide = document.documentElement.clientWidth >= STAGE_MIN_WIDTH;
    if (window.scrollY > 8 || read(GUIDE_INTRO_KEY) === "1") { finished.current = true; setIntro(INTRO_DONE); return; }
    setIntro(INTRO_WAIT);
    setStage(wide);
    const events = wide ? introSchedule() : landSchedule();
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
      if (event.type === "scroll" && window.scrollY < 6) return;
      cancelAnimationFrame(frame);
      window.clearTimeout(startTimer);
      skip();
    };
    const names = ["scroll", "keydown", "pointerdown"] as const;
    names.forEach((n) => window.addEventListener(n, stop, { passive: true }));
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(startTimer);
      window.removeEventListener("load", begin);
      names.forEach((n) => window.removeEventListener(n, stop));
    };
  }, [canPlay, skip]);

  const value = useMemo<Ctx>(() => ({ ready, motion, hidden, setHidden, intro, stage, menuOpen, setMenuOpen, skip }), [ready, motion, hidden, setHidden, intro, stage, menuOpen, skip]);
  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
}
