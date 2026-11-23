"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type Ref } from "react";

import { scrollTopNow, sheetRoot, useToolyGuide } from "@/components/marketing/tooly-guide-state";
import { TOOLY_POSES, type ToolyPose } from "@/components/tooly/poses";
import {
  FIGURE_SIZE, FRAME_FILE, FRAME_SET, FRAME_SRC, GUIDE_LABELS, GUIDE_STOPS, INTRO_PHASES, INTRO_TOP, LEDGE_STEP, STRIP_FIGURE, WALK_FRAMES, activeStopId, boltX, frameLayout,
  gutterX, idealY, lookForPose, walkFrameIndex, FIGURE_MARGIN,
  type FrameKey, type GuideMode, type GuideStop, type IntroLook,
} from "@/lib/marketing/tooly-guide";

// Inputs: the guide state (tooly-guide-state.tsx), the stops in lib/marketing/tooly-guide.ts and the page's own sections (found by id).
// Output, two parts that never touch the page's content:
//  1. the CAPTION STRIP: a fixed bar at the foot of the window that owns its space (the page's scroll area ends above it, see marketing.css
//     .mk-sheet.tg-docked): his caption (an existing string from lib/marketing.ts) as real text in a polite live region, the "Hide Tooly" button
//     and, where there is no clear gutter, a small Tooly figure at its left;
//  2. only where the right-hand gutter beside the content column is wide enough (measured at run time): a floating Tooly who walks down the
//     gutter with the scroll, changing pose per section, with a dotted trail behind him and, in the first seconds, a ledge on a cable.
// Must not change: nothing of his is ever placed over a content box, heading, text, card, link or form field (the figure, trail and ledge exist
// only in the measured gutter; the caption only in the strip); he is decorative (every image aria-hidden, no pointer events) and the caption is
// real text, kept whether or not he moves; transform and opacity only; no per-frame React renders; frames pause with the tab; for reduced motion
// there is no drop, walk, blink or trail animation (a still figure in the gutter or the strip, the same captions, a full trail); hiding him is
// remembered in sessionStorage only and the Show button is in the header; nothing traps focus; no network call.
// Tooly is only ever drawn from the on-model art: the nine original stills and the supplied frames (air, land, spanner reach/heave/rest, stamp
// up/down, clipboard, point up-left, a four-frame side-view walk), normalised to one crop, one scale and one foot baseline (lib/marketing/
// tooly-guide.ts), so a swap never moves his feet. Frames load only when needed, lazily, decoded async, in a fixed-size box, so nothing shifts.

const FIG_SRC = 768; // the stills are 768 px square; Tooly fills x 195..625, y 212..742 of it (measured from the nine files)
const CROP_W = 430;
const CROP_H = 530;
const POSES: readonly ToolyPose[] = ["idle", "blink", "wave", "think", "celebrate", "oops", "point", "love"];
const DEFAULT_FRAMES: ReadonlySet<FrameKey> = new Set<FrameKey>(["pointUpLeft"]);

type Look = ToolyPose | FrameKey;
const isFrame = (look: Look): look is FrameKey => look in FRAME_SRC;

/** One cropped Tooly: every still and every mounted frame stacked in the same box, so a look change is only an opacity swap. */
function Figure({ look, size, frames, walkRefs, eager }: { look: Look; size: number; frames: ReadonlySet<FrameKey>; walkRefs?: MutableRefObject<Array<HTMLImageElement | null>>; eager?: boolean }) {
  const lay = frameLayout(size);
  const lays = { pose: lay, stamp: frameLayout(size, "stamp") };
  return (
    <div className="tg-fig" style={{ "--fw": `${size}px` } as CSSProperties} aria-hidden="true">
      <div className="tg-flip">
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
              style={{ opacity: name === look ? 1 : 0 }}
            />
          ))}
          {(Object.keys(FRAME_SRC) as FrameKey[]).filter((k) => frames.has(k) && !WALK_FRAMES.includes(k)).map((k) => (
            <Image
              key={k}
              src={FRAME_SRC[k]}
              alt=""
              width={FRAME_FILE[FRAME_SET[k]].w}
              height={FRAME_FILE[FRAME_SET[k]].h}
              unoptimized
              loading="lazy"
              decoding="async"
              draggable={false}
              className="tg-frame"
              style={{ left: lays[FRAME_SET[k]].left, top: lays[FRAME_SET[k]].top, width: lays[FRAME_SET[k]].width, height: lays[FRAME_SET[k]].height, opacity: look === k ? 1 : 0 }}
            />
          ))}
        </div>
        {walkRefs ? (
          <div className="tg-walk">
            {WALK_FRAMES.filter((k) => frames.has(k)).map((k, i) => (
              <Image
                key={k}
                ref={(el) => { walkRefs.current[i] = el; }}
                src={FRAME_SRC[k]}
                alt=""
                width={FRAME_FILE.pose.w}
                height={FRAME_FILE.pose.h}
                unoptimized
                loading="lazy"
                decoding="async"
                draggable={false}
                className="tg-walk-frame"
                style={{ left: lay.left, top: lay.top, width: lay.width, height: lay.height }}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const CAPTIONED = GUIDE_STOPS.filter((s) => s.caption);

export type ToolyGuideViewProps = {
  /** The stop whose caption is shown. */
  stop: GuideStop;
  /** What the small figure in the strip looks like (used only when `mode` is "strip"). */
  pose: Look;
  frames?: ReadonlySet<FrameKey>;
  mode: GuideMode;
  /** Reduced motion: nothing animates. */
  motion: boolean;
  phase?: string;
  onHide: () => void;
  stripRef?: Ref<HTMLElement>;
};

/**
 * The caption strip. Every caption is laid out invisibly in one grid cell, so the strip is as tall as the tallest caption at this width and never
 * changes height from one stop to the next (the page's scroll area ends exactly above it); the visible caption is a separate live region on top.
 * Used by the live component and by the tests (which render it with motion off).
 */
export function ToolyGuideView(p: ToolyGuideViewProps) {
  return (
    <aside ref={p.stripRef} className="tg-strip" data-tg data-mode={p.mode} data-motion={p.motion} data-phase={p.phase ?? "done"} aria-label={GUIDE_LABELS.region}>
      <div className="tg-strip-in">
        {p.mode === "strip" ? (
          <div className="tg-strip-fig" aria-hidden="true">
            <Figure look={p.pose} size={STRIP_FIGURE} frames={p.frames ?? DEFAULT_FRAMES} />
          </div>
        ) : null}
        <div className="tg-strip-text">
          <div className="tg-sizers" aria-hidden="true">
            {CAPTIONED.map((s) => (
              <p key={s.id} className="tg-line"><span className="tg-label mk-label">{s.label}</span> <span className="tg-text">{s.caption}</span></p>
            ))}
          </div>
          <div id="tg-note" className="tg-live" role="status" aria-live="polite">
            {p.stop.caption ? <p key={p.stop.id} className="tg-line"><span className="tg-label mk-label">{p.stop.label}</span> <span className="tg-text">{p.stop.caption}</span></p> : null}
          </div>
        </div>
        <button type="button" className="tg-btn" onClick={p.onHide}>{GUIDE_LABELS.hide}</button>
      </div>
    </aside>
  );
}

function resolve(stop: GuideStop): Element | null {
  const el = document.querySelectorAll(stop.selector)[stop.nth ?? 0] ?? null;
  return el && stop.up ? el.closest(stop.up) : el;
}

/** The window's scroll area: the marketing root while docked, else the window. */
const area = () => {
  const root = sheetRoot();
  const docked = Boolean(root?.classList.contains("tg-docked"));
  return {
    w: docked && root ? root.clientWidth : document.documentElement.clientWidth,
    h: docked && root ? root.clientHeight : window.innerHeight,
    top: scrollTopNow(),
    total: docked && root ? root.scrollHeight : document.documentElement.scrollHeight,
  };
};

export function ToolyGuide() {
  const g = useToolyGuide();
  const [stopId, setStopId] = useState(GUIDE_STOPS[0].id);
  const [captionId, setCaptionId] = useState(GUIDE_STOPS[0].id);
  const [settled, setSettled] = useState(true);
  const [moving, setMoving] = useState(false);
  const [arrive, setArrive] = useState(0);
  const [blink, setBlink] = useState(false);
  const [vw, setVw] = useState(1280);
  const root = useRef<HTMLDivElement | null>(null);
  const strip = useRef<HTMLElement | null>(null);
  const trailRect = useRef<SVGRectElement | null>(null);
  const walkRefs = useRef<Array<HTMLImageElement | null>>([]);
  const [walkReady, setWalkReady] = useState(false);
  const live = useRef({ settled, phase: "off", gutter: false, motion: true, vw: 1280, pos: { x: 0, y: -400, set: false }, maxDoc: 0, lastScroll: 0, raf: 0, last: 0, travel: 0, walkIdx: -1, notch: 0 });
  const stop = GUIDE_STOPS.find((s) => s.id === captionId) ?? GUIDE_STOPS[0];

  const hidden = g?.hidden ?? false;
  const motion = g?.motion ?? false;
  const mode: GuideMode = g?.mode ?? "strip";
  const gutter = mode === "gutter";
  const phase = g?.intro.phase ?? "off";
  const inIntro = (INTRO_PHASES as readonly string[]).includes(phase);
  const waiting = phase === "off" || phase === "wait";
  const showLedge = inIntro && gutter && Boolean(g?.stage);

  const introLook: IntroLook = g?.intro.look ?? "idle";
  const baseLook: Look = inIntro ? introLook : gutter && motion && !settled ? "idle" : lookForPose(stop.pose);
  const look: Look = blink && baseLook === "idle" ? "blink" : baseLook; // his own blink still, now and then, while he stands idle

  // Which frames are in the page: the point up-left always; the intro's frames once the page has loaded; the walk when he first has to walk.
  const frames = new Set<FrameKey>(["pointUpLeft"]);
  if (motion && (inIntro || waiting)) {
    frames.add("air"); frames.add("land");
    if (gutter && g?.stage) (["reach", "heave", "rest", "stampUp", "stampDown"] as FrameKey[]).forEach((k) => frames.add(k));
  }
  if (stop.pose === "clipboard") frames.add("clipboard");
  if (motion && gutter && walkReady) WALK_FRAMES.forEach((k) => frames.add(k));

  live.current.settled = settled;
  live.current.phase = phase;
  live.current.gutter = gutter && !waiting;
  live.current.motion = motion;
  live.current.vw = vw;
  live.current.notch = g?.intro.notch ?? 0;

  const figH = (FIGURE_SIZE * CROP_H) / CROP_W;

  // ----- where he is (gutter only): written straight to the element's transform; React is not involved per frame -------------------
  const targetNow = useCallback(() => {
    const s = live.current;
    const a = area();
    const x = gutterX(a.w);
    if (!s.motion) return { x, y: Math.max(8, a.h - figH - 12) }; // reduced motion: one fixed place at the foot of the gutter
    if (INTRO_PHASES.includes(s.phase as never)) return { x, y: INTRO_TOP + s.notch * LEDGE_STEP };
    const progress = a.top / Math.max(1, a.total - a.h);
    return { x, y: idealY(progress, 80, a.h - figH - 12) };
  }, [figH]);

  const apply = useCallback(() => {
    const s = live.current;
    if (root.current && s.pos.set) root.current.style.transform = `translate3d(${s.pos.x.toFixed(1)}px,${s.pos.y.toFixed(1)}px,0)`;
    if (trailRect.current) {
      const a = area();
      if (s.motion) s.maxDoc = Math.max(s.maxDoc, a.top + s.pos.y + figH);
      const k = s.motion ? Math.min(1, s.maxDoc / Math.max(1, a.total)) : 1;
      trailRect.current.setAttribute("transform", `scale(1 ${k.toFixed(4)})`);
    }
  }, [figH]);

  // The walk: while he is on his feet, show one of the four side-view frames, chosen by how far he has travelled, so the feet step with the scroll.
  const showWalk = useCallback((on: boolean, idx: number) => {
    const s = live.current;
    const els = walkRefs.current;
    const ready = on && els.length === WALK_FRAMES.length && els.every((el) => el && el.complete && el.naturalWidth > 0);
    const want = ready ? idx : -1;
    if (want === s.walkIdx) return;
    s.walkIdx = want;
    els.forEach((el, i) => { if (el) el.style.opacity = i === want ? "1" : "0"; });
    root.current?.setAttribute("data-walking", String(want >= 0));
  }, []);

  const frame = useCallback((now: number) => {
    const s = live.current;
    const dt = Math.min(now - s.last, 50);
    s.last = now;
    const t = targetNow();
    if (!s.pos.set) s.pos = { ...t, set: true };
    const k = 1 - Math.exp(-dt / (INTRO_PHASES.includes(s.phase as never) ? 90 : 150));
    const dx = t.x - s.pos.x;
    const dy = t.y - s.pos.y;
    const step = Math.hypot(dx * k, dy * k);
    s.pos = { x: s.pos.x + dx * k, y: s.pos.y + dy * k, set: true };
    s.travel += step;
    const speed = Math.hypot(dx, dy);
    const busy = speed > 0.6 || performance.now() - s.lastScroll < 220 || INTRO_PHASES.includes(s.phase as never);
    const walking = (speed > 3 || performance.now() - s.lastScroll < 240) && s.phase === "done";
    showWalk(walking && s.motion, walkFrameIndex(s.travel, figH));
    setMoving((m) => (m !== walking ? walking : m));
    apply();
    if (busy) s.raf = requestAnimationFrame(frame); else { s.raf = 0; showWalk(false, 0); setMoving(false); }
  }, [apply, targetNow, showWalk, figH]);

  const kick = useCallback(() => {
    const s = live.current;
    if (!s.gutter) return;
    if (!s.motion) { const t = targetNow(); s.pos = { ...t, set: true }; apply(); return; }
    if (!s.raf) { s.last = performance.now(); s.raf = requestAnimationFrame(frame); }
  }, [apply, frame, targetNow]);

  // ----- the scroll area's size, the strip's height ------------------------------------------------------------------------------------
  useEffect(() => {
    if (!g?.ready) return;
    const onResize = () => { setVw(area().w); kick(); };
    onResize();
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, [g?.ready, kick]);

  // The strip owns its space: the page's scroll area is as tall as the window minus the strip (marketing.css), so nothing is ever under it.
  useEffect(() => {
    const el = strip.current;
    const sheet = sheetRoot();
    if (!g?.ready || hidden || !el || !sheet) return;
    const set = () => { sheet.style.setProperty("--tg-strip-h", `${Math.ceil(el.getBoundingClientRect().height)}px`); setVw(area().w); kick(); };
    set();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(set);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [g?.ready, hidden, mode, kick]);

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

  // Scrolling: in the gutter he walks; the caption (and so the live region) changes once the page has been still for a moment.
  const settle = useCallback(() => {
    live.current.settled = true;
    setSettled(true);
    setCaptionId(document.documentElement.dataset.toolyStop ?? GUIDE_STOPS[0].id);
    setArrive((n) => n + 1);
    kick();
  }, [kick]);
  useEffect(() => {
    if (!g?.ready || hidden) return;
    let timer = 0;
    const onScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target !== document && target !== sheetRoot()) return; // some other scrolling box on the page
      setWalkReady(true);
      if ((INTRO_PHASES as readonly string[]).includes(live.current.phase)) return;
      live.current.lastScroll = performance.now();
      if (live.current.settled) { live.current.settled = false; setSettled(false); }
      kick();
      window.clearTimeout(timer);
      timer = window.setTimeout(settle, 180);
    };
    const onHidden = () => { root.current?.setAttribute("data-paused", String(document.hidden)); };
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onHidden);
    return () => { window.clearTimeout(timer); window.removeEventListener("scroll", onScroll, { capture: true }); document.removeEventListener("visibilitychange", onHidden); };
  }, [g?.ready, hidden, kick, settle]);

  // Settle on arrival, when the stop changes while still, and when the intro hands him over.
  useEffect(() => {
    if (!g?.ready || hidden || inIntro || waiting) return;
    const id = window.setTimeout(settle, phase === "done" ? 250 : 0);
    return () => window.clearTimeout(id);
  }, [g?.ready, hidden, inIntro, waiting, phase, stopId, motion, settle]);

  useEffect(() => { if (g?.ready && !hidden) kick(); }, [g?.ready, hidden, phase, g?.intro.notch, settled, vw, gutter, kick]);
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

  // The intro's frames are fetched while the page waits to start (wait phase), the walk's at the first scroll or a moment after the intro.
  useEffect(() => {
    if (phase !== "wait" || !motion) return;
    const keys: FrameKey[] = gutter ? ["air", "land", "reach", "heave", "rest", "stampUp", "stampDown"] : ["air", "land"];
    const held = keys.map((k) => { const img = new window.Image(); img.decoding = "async"; img.src = FRAME_SRC[k]; return img; });
    return () => { held.length = 0; };
  }, [phase, motion, gutter]);
  useEffect(() => {
    if (phase !== "done" || !motion || !gutter) return;
    const id = window.setTimeout(() => setWalkReady(true), 1500);
    return () => window.clearTimeout(id);
  }, [phase, motion, gutter]);

  if (!g || !g.ready || hidden) return null;
  const centre = vw - FIGURE_SIZE / 2 - FIGURE_MARGIN;
  return (
    <>
      {gutter && !waiting ? <Trail rectRef={trailRect} motion={motion} x={centre} /> : null}
      {gutter && !waiting ? (
        <div
          ref={root}
          className="tg"
          data-tg
          data-motion={motion}
          data-moving={moving}
          data-phase={phase}
          data-quiet={!settled}
          data-arrive={arrive % 2 ? "b" : "a"}
          aria-hidden="true"
          style={{ "--fw": `${FIGURE_SIZE}px` } as CSSProperties}
        >
          {showLedge ? (
            <>
              <span className="tg-cable" style={{ left: boltX(FIGURE_SIZE) }} />
              <span className="tg-ledge" />
            </>
          ) : null}
          <Figure look={look} size={FIGURE_SIZE} frames={frames} walkRefs={walkRefs} />
        </div>
      ) : null}
      <ToolyGuideView stop={stop} pose={waiting ? "idle" : look} frames={frames} mode={mode} motion={motion} phase={phase} onHide={() => g.setHidden(true)} stripRef={strip} />
    </>
  );
}

/** The dotted trail down the right-hand gutter: drawn from the top of the page to wherever he has walked (clip scaled with transform). */
function Trail({ rectRef, x, motion }: { rectRef: Ref<SVGRectElement>; x: number; motion: boolean }) {
  const sheet = typeof document === "undefined" ? null : sheetRoot();
  const h = sheet ? sheet.scrollHeight : 0;
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
