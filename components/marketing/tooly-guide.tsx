"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type Ref } from "react";

import { useToolyGuide } from "@/components/marketing/tooly-guide-state";
import { TOOLY_POSES, type ToolyPose } from "@/components/tooly/poses";
import {
  GUIDE_LABELS, GUIDE_STOPS, INTRO_POSE, activeStopId, choosePlacement, idealY,
  type GuideStop, type Placement, type Rect,
} from "@/lib/marketing/tooly-guide";

// Inputs: the guide state (tooly-guide-state.tsx), the stops in lib/marketing/tooly-guide.ts and the page's own sections (found by id).
// Output: a fixed Tooly down the right-hand edge who walks with the scroll, changes pose for each section, and has a short caption (an
// existing string from lib/marketing.ts) beside him; a dotted trail drawn behind him on wide screens; and the "Hide Tooly" button.
// Also the intro: he drops in on the menu's deck, works the spanner and then walks to his place (the menu draws the rest).
// Must not change: he is decorative (every image aria-hidden, no pointer events on him) and nothing is only in the animation: the caption is
// real text in a labelled region, kept whether or not he moves; the caption and his buttons are moved off headings, links, buttons and form
// fields (placement search in lib, run once scrolling settles; if no spot is free the caption folds into a "Tooly says" button the person
// presses); transform and opacity only; no per-frame React renders; frames pause with the tab; for reduced motion there is no drop, walk,
// bob or trail animation: he stands in the corner with the same captions and a full static trail; hiding him is remembered in memory and
// sessionStorage only; nothing traps focus; no network call .
// Only the nine real stills are ever drawn as Tooly (no redrawn body or hands, no video): the drop, squash, waddle and pose swaps are
// transform changes on them, and the spanner and bolt around him are separate drawn props in the menu.

const FIG_SRC = 768; // the stills are 768 px square; Tooly fills x 195..625, y 212..742 of it (measured from the nine files)
const CROP_W = 430;
const CROP_H = 530;
const TRAIL_MIN_VW = 1360;
const POSES: readonly ToolyPose[] = ["idle", "blink", "wave", "think", "celebrate", "oops", "point", "love"];

/** One cropped Tooly: every pose stacked in the same box, so a pose change is only an opacity swap. */
function Figure({ pose, flip, size, eager }: { pose: ToolyPose; flip: boolean; size: number; eager?: boolean }) {
  return (
    <div className="tg-fig" style={{ "--fw": `${size}px` } as CSSProperties} aria-hidden="true">
      <div className="tg-flip" data-flip={flip}>
        <div className="tg-body">
          {POSES.map((name) => (
            <Image
              key={name}
              src={TOOLY_POSES[name]}
              alt=""
              width={FIG_SRC}
              height={FIG_SRC}
              sizes={`${Math.round((size * FIG_SRC * 2) / CROP_W)}px`}
              loading={eager ? "eager" : "lazy"}
              decoding="async"
              draggable={false}
              className="tg-img"
              style={{ opacity: name === pose ? 1 : 0 }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export type ToolyGuideViewProps = {
  stop: GuideStop;
  pose: ToolyPose;
  bubble: Placement["bubble"];
  saysOpen: boolean;
  /** Reduced motion: no walking, no trail animation, no entrance. */
  motion: boolean;
  size: number;
  moving?: boolean;
  phase?: string;
  swing?: "a" | "b";
  settled?: boolean;
  arrive?: "a" | "b";
  onHide: () => void;
  onSays: () => void;
  rootRef?: Ref<HTMLDivElement>;
  bubbleRef?: Ref<HTMLDivElement>;
};

/** What the guide looks like for a given state: used by the live component and by the tests (which render it with motion off). */
export function ToolyGuideView(p: ToolyGuideViewProps) {
  const open = p.bubble === "left" || p.bubble === "above" || (p.bubble === "collapsed" && p.saysOpen);
  const flip = p.pose === "point";
  return (
    <aside
      ref={p.rootRef}
      className="tg"
      data-tg
      data-motion={p.motion}
      data-moving={Boolean(p.moving)}
      data-phase={p.phase ?? "done"}
      data-swing={p.swing ?? "a"}
      data-place={p.bubble}
      data-quiet={p.settled === false}
      data-arrive={p.arrive ?? "a"}
      aria-label={GUIDE_LABELS.region}
      style={{ "--fw": `${p.size}px` } as CSSProperties}
    >
      <div ref={p.bubbleRef} id="tg-note" className="tg-bubble" data-open={open} data-place={p.bubble === "above" ? "above" : "left"}>
        {p.stop.label ? <p className="tg-label mk-label">{p.stop.label}</p> : null}
        {p.stop.caption ? <p className="tg-text">{p.stop.caption}</p> : null}
      </div>
      <Figure pose={p.pose} flip={flip} size={p.size} />
      <div className="tg-controls">
        {p.stop.caption ? (
          <button type="button" className="tg-btn" data-says hidden={p.bubble !== "collapsed"} aria-expanded={p.saysOpen} aria-controls="tg-note" onClick={p.onSays}>{GUIDE_LABELS.says}</button>
        ) : null}
        <button type="button" className="tg-btn" onClick={p.onHide}>{GUIDE_LABELS.hide}</button>
      </div>
    </aside>
  );
}

const AVOID = 'h1,h2,h3,h4,a[href],button,input,select,textarea,summary,label,[role="tab"]';

// Running text is avoided where there is room (always, on a phone); the hard rule is only headings, links, buttons and form fields.
const AVOID_TEXT = "p,li,dd,dt,figcaption,td,th,blockquote";

function collectAvoid(withText: boolean): Rect[] {
  const out: Rect[] = [];
  const vh = window.innerHeight;
  document.querySelectorAll<HTMLElement>(withText ? `${AVOID},${AVOID_TEXT}` : AVOID).forEach((el) => {
    if (el.closest("[data-tg]")) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < -40 || r.top > vh + 40) return;
    out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, soft: !el.matches(AVOID) });
  });
  return out;
}

function resolve(stop: GuideStop): Element | null {
  const el = document.querySelectorAll(stop.selector)[stop.nth ?? 0] ?? null;
  return el && stop.up ? el.closest(stop.up) : el;
}

export function ToolyGuide() {
  const g = useToolyGuide();
  const [stopId, setStopId] = useState(GUIDE_STOPS[0].id);
  const [placement, setPlacement] = useState<Placement>({ y: 80, bubble: "none" });
  const [settled, setSettled] = useState(true);
  const [moving, setMoving] = useState(false);
  const [saysOpen, setSaysOpen] = useState(false);
  const [arrive, setArrive] = useState(0);
  const [blink, setBlink] = useState(false);
  const [vw, setVw] = useState(1280);
  const root = useRef<HTMLDivElement | null>(null);
  const bubbleEl = useRef<HTMLDivElement | null>(null);
  const trailRect = useRef<SVGRectElement | null>(null);
  const showBtn = useRef<HTMLButtonElement | null>(null);
  const live = useRef({ placement, settled, phase: "off", motion: true, size: 104, vw: 1280, pos: { x: 0, y: -400, set: false }, maxDoc: 0, lastScroll: 0, raf: 0, last: 0 });
  const stop = GUIDE_STOPS.find((s) => s.id === stopId) ?? GUIDE_STOPS[0];

  const hidden = g?.hidden ?? false;
  const motion = g?.motion ?? false;
  const phase = g?.intro.phase ?? "off";
  const scene = ["drop", "pull", "carry", "cheer", "lift"].includes(phase);
  const size = vw < 640 ? 56 : vw < 1100 ? 84 : 104;

  const base: ToolyPose = scene || phase === "land" ? INTRO_POSE[phase] : motion && !settled ? "idle" : stop.pose;
  const pose: ToolyPose = blink && base === "idle" ? "blink" : base; // the real blink still, now and then, while he stands idle

  live.current.placement = placement;
  live.current.settled = settled;
  live.current.phase = phase;
  live.current.motion = motion;
  live.current.size = size;
  live.current.vw = vw;

  // ----- where he is: written straight to the element's transform; React is not involved per frame ---------------------------------
  const targetNow = useCallback(() => {
    const s = live.current;
    const h = (s.size * CROP_H) / CROP_W;
    const margin = s.vw >= TRAIL_MIN_VW ? 18 : 12;
    const x = s.vw - s.size - margin;
    const vh = window.innerHeight;
    const bottom = vh - h - 56;
    if (!s.motion) return { x, y: Math.max(8, bottom) }; // reduced motion: one fixed place in the corner
    const doc = document.documentElement;
    const progress = window.scrollY / Math.max(1, doc.scrollHeight - vh);
    return { x, y: s.settled ? s.placement.y : idealY(progress, 80, bottom) };
  }, []);

  const apply = useCallback(() => {
    const s = live.current;
    if (root.current && s.pos.set) root.current.style.transform = `translate3d(${s.pos.x.toFixed(1)}px,${s.pos.y.toFixed(1)}px,0)`;
    const h = (s.size * CROP_H) / CROP_W;
    if (s.vw >= TRAIL_MIN_VW && trailRect.current) {
      const total = document.documentElement.scrollHeight;
      if (s.motion) s.maxDoc = Math.max(s.maxDoc, window.scrollY + s.pos.y + h);
      const k = s.motion ? Math.min(1, s.maxDoc / Math.max(1, total)) : 1;
      trailRect.current.setAttribute("transform", `scale(1 ${k.toFixed(4)})`);
    }
  }, []);

  const frame = useCallback((now: number) => {
    const s = live.current;
    const dt = Math.min(now - s.last, 50);
    s.last = now;
    let busy = false;
    if (["drop", "pull", "carry", "cheer", "lift"].includes(s.phase)) {
      const floor = document.querySelector<HTMLElement>("[data-tm-floor]");
      if (floor) {
        const r = floor.getBoundingClientRect();
        s.pos = { x: r.left, y: r.top - (s.size * CROP_H) / CROP_W + 3, set: true };
      }
      busy = true;
    } else {
      const t = targetNow();
      if (!s.pos.set) s.pos = { ...t, set: true };
      const k = 1 - Math.exp(-dt / 150);
      const dx = t.x - s.pos.x;
      const dy = t.y - s.pos.y;
      s.pos = { x: s.pos.x + dx * k, y: s.pos.y + dy * k, set: true };
      const speed = Math.hypot(dx, dy);
      busy = speed > 0.6 || now - s.lastScroll < 220;
      const walking = speed > 3 || now - s.lastScroll < 240; // on his feet while the page scrolls and while he glides to his place
      setMoving((m) => (m !== walking ? walking : m));
    }
    apply();
    if (busy) s.raf = requestAnimationFrame(frame); else { s.raf = 0; setMoving(false); }
  }, [apply, targetNow]);

  const kick = useCallback(() => {
    const s = live.current;
    if (!s.motion) { const t = targetNow(); s.pos = { ...t, set: true }; apply(); return; }
    if (!s.raf) { s.last = performance.now(); s.raf = requestAnimationFrame(frame); }
  }, [apply, frame, targetNow]);

  // ----- size and placement ------------------------------------------------------------------------------------------------------
  useEffect(() => {
    const onResize = () => setVw(document.documentElement.clientWidth);
    onResize();
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const settle = useCallback(() => {
    const s = live.current;
    const vh = window.innerHeight;
    const h = (s.size * CROP_H) / CROP_W;
    const stopNow = GUIDE_STOPS.find((x) => x.id === (document.documentElement.dataset.toolyStop ?? "")) ?? GUIDE_STOPS[0];
    const btn = s.vw < 1024 ? 44 : 36;
    const progress = window.scrollY / Math.max(1, document.documentElement.scrollHeight - vh);
    const t = targetNow();
    const base = {
      idealY: s.motion ? idealY(progress, 80, vh - h - 56) : t.y,
      vh, topMin: 8, x: t.x, figW: s.size, figH: h, controlsW: Math.max(s.size, 92), controlsH: btn,
      bubbleW: Math.min(264, s.vw - 32), bubbleH: bubbleEl.current?.offsetHeight ?? 110,
      hasCaption: Boolean(stopNow.caption),
    };
    const run = (avoid: Rect[]): Placement => {
      const first = choosePlacement({ ...base, avoid });
      // Folded into the "Tooly says" button: his controls stack two high, so find a place that is clear for that.
      return first.bubble === "collapsed" ? { ...choosePlacement({ ...base, hasCaption: false, controlsH: btn * 2, avoid }), bubble: "collapsed" } : first;
    };
    let next = run(collectAvoid(true));
    if (next.bubble === "collapsed" || next.bubble === "none") {
      const hard = collectAvoid(false); // headings, links, buttons and fields only
      next = s.vw >= 640 && next.bubble === "collapsed"
        ? run(hard)
        : { ...choosePlacement({ ...base, hasCaption: false, controlsH: btn * (next.bubble === "collapsed" ? 2 : 1), avoid: hard }), bubble: next.bubble };
    }
    s.settled = true;
    setPlacement(next);
    setSettled(true);
    setArrive((n) => n + 1);
    setSaysOpen(false);
    kick();
  }, [kick, targetNow]);

  // The reading line: the last stop whose section crosses it is the one Tooly speaks for.
  useEffect(() => {
    if (!g?.ready || hidden) return;
    const crossing = new Set<string>();
    let current: string = GUIDE_STOPS[0].id;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.toolyStopId!;
        if (entry.isIntersecting) crossing.add(id); else crossing.delete(id);
      }
      const next = activeStopId(crossing, current);
      if (next !== current) { current = next; document.documentElement.dataset.toolyStop = next; setStopId(next); }
    }, { rootMargin: "-45% 0px -54% 0px" });
    GUIDE_STOPS.forEach((s) => { const el = resolve(s) as HTMLElement | null; if (el) { el.dataset.toolyStopId = s.id; observer.observe(el); } });
    document.documentElement.dataset.toolyStop = current;
    return () => { observer.disconnect(); delete document.documentElement.dataset.toolyStop; };
  }, [g?.ready, hidden]);

  // Scrolling: he walks; the caption waits until the page is still, then finds a clear place.
  useEffect(() => {
    if (!g?.ready || hidden) return;
    let timer = 0;
    const onScroll = () => {
      if (["drop", "pull", "carry", "cheer", "lift"].includes(live.current.phase)) return;
      live.current.lastScroll = performance.now();
      if (live.current.settled) { live.current.settled = false; setSettled(false); setSaysOpen(false); }
      kick();
      window.clearTimeout(timer);
      timer = window.setTimeout(settle, 180);
    };
    const onHidden = () => { root.current?.setAttribute("data-paused", String(document.hidden)); };
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onHidden);
    return () => { window.clearTimeout(timer); window.removeEventListener("scroll", onScroll); document.removeEventListener("visibilitychange", onHidden); };
  }, [g?.ready, hidden, kick, settle]);

  // Settle on arrival, on resize, when the stop changes while still, and when the intro hands him over.
  useEffect(() => {
    if (!g?.ready || hidden || scene || phase === "off" || phase === "wait") return;
    const id = window.setTimeout(settle, phase === "done" ? 250 : 0);
    return () => window.clearTimeout(id);
  }, [g?.ready, hidden, scene, phase, vw, stopId, motion, settle]);

  useEffect(() => { if (g?.ready && !hidden) kick(); }, [g?.ready, hidden, scene, phase, placement, settled, size, kick]);
  useEffect(() => () => { cancelAnimationFrame(live.current.raf); live.current.raf = 0; }, []);

  // An occasional blink (his own blink still), only with motion allowed and the tab visible.
  useEffect(() => {
    if (!g?.ready || hidden || !motion) return;
    let id = 0;
    const loop = () => {
      id = window.setTimeout(() => {
        if (!document.hidden) { setBlink(true); id = window.setTimeout(() => { setBlink(false); loop(); }, 150); } else loop();
      }, 3200 + Math.random() * 2800);
    };
    loop();
    return () => { window.clearTimeout(id); setBlink(false); };
  }, [g?.ready, hidden, motion]);

  // Moving focus after Hide / Show so the keyboard never loses its place.
  const wasHidden = useRef(false);
  useEffect(() => { if (hidden && !wasHidden.current) showBtn.current?.focus(); wasHidden.current = hidden; }, [hidden]);

  if (!g || !g.ready || phase === "off" || phase === "wait") return null;
  if (hidden) {
    return (
      <aside className="tg-show" data-tg aria-label={GUIDE_LABELS.region}>
        <button ref={showBtn} type="button" className="tg-btn" onClick={() => { g.setHidden(false); }}>{GUIDE_LABELS.show}</button>
      </aside>
    );
  }
  const bubble: Placement["bubble"] = scene || phase === "land" || (motion && !settled) ? "none" : placement.bubble;
  return (
    <>
      {vw >= TRAIL_MIN_VW ? <Trail rectRef={trailRect} motion={motion} x={vw - size / 2 - 18} /> : null}
      <ToolyGuideView
        stop={stop}
        pose={pose}
        bubble={bubble}
        saysOpen={saysOpen}
        motion={motion}
        size={size}
        moving={moving}
        phase={phase}
        swing={g.intro.swing % 2 ? "b" : "a"}
        settled={settled}
        arrive={arrive % 2 ? "b" : "a"}
        onHide={() => g.setHidden(true)}
        onSays={() => setSaysOpen((v) => !v)}
        rootRef={root}
        bubbleRef={bubbleEl}
      />
    </>
  );
}

/** The dotted trail down the right-hand edge: drawn from the top of the page to wherever he has walked (clip scaled with transform). */
function Trail({ rectRef, x, motion }: { rectRef: Ref<SVGRectElement>; x: number; motion: boolean }) {
  const h = typeof document === "undefined" ? 0 : document.documentElement.scrollHeight;
  return (
    <svg className="tg-trail" data-tg aria-hidden="true" focusable="false" width="12" height={h} style={{ left: Math.round(x - 6) }}>
      <defs>
        <clipPath id="tg-trail-clip"><rect ref={rectRef} x="0" y="0" width="12" height={h} transform={motion ? "scale(1 0)" : undefined} /></clipPath>
      </defs>
      <g clipPath="url(#tg-trail-clip)">
        <line x1="6" y1="0" x2="6" y2={h} className="tg-trail-dots" />
        <line x1="6" y1="0" x2="6" y2={h} className="tg-trail-bolts" />
      </g>
    </svg>
  );
}
