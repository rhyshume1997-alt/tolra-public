"use client";

/*
 * "The Tolra Machine" (public home page, "How Tolra handles it"): seven meshed steel gears, one per stage of a job. Selecting a gear
 * (click, tap, arrow keys, the stage chips or Previous / Next) turns the whole train, in mechanically correct directions and ratios,
 * opens a viewer beside that gear with what the stage looks like in Tolra (a document it produces or a screen, example data), and
 * shows what happens at that stage.
 *
 * Inputs: GEAR_STAGES, GEAR_COPY and the two layouts from lib/marketing/gear-workflow.ts; the stage images in
 * public/marketing/workflow/. Output: one section of markup, no data.
 * Must not change: the copy (it lives in the marketing module), the booking links and anything outside this section. The gears turn
 * only when someone selects a stage (no autoplay) and never under prefers-reduced-motion; the content reads the same without motion.
 * The hero traveller stays the page's only tablist: the gears are a radio group. The word "Screenshot" is reserved for the
 * "What it does" figures (the page's tests count it), so the viewer says where the image comes from instead.
 *
 * Version B is the default: the machine in 3D (components/marketing/gear-workflow-3d.tsx), with an eighth gear for Analytics. The
 * server renders its shell (heading, a still of the machine, chips, panel); the 3D code downloads when the page is idle and starts
 * when the section is near, then takes over from the still without moving anything. Version A, the 2D drawing above, is shown on
 * ?gears=2d and wherever WebGL is missing (and if the 3D fails). ?compare adds a switch between the two.
 */
import dynamic from "next/dynamic";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";


import {
  COMPACT_LAYOUT, GEAR_COPY, GEAR_STAGES, SCENE_STAGES, STAGE_COUNT, VERSION_COPY, WIDE_LAYOUT, chooseTier, clampStage,
  driveFor, gearAngle, parseGearsParam, stepTo, type Gear, type GearLayout, type GearStage, type GearsMode, type RenderTier, type SceneStage,
  type StageId,
} from "@/lib/marketing/gear-workflow";

const LAYOUTS: GearLayout[] = [WIDE_LAYOUT, COMPACT_LAYOUT];
const pct = (n: number, of: number) => `${(n / of) * 100}%`;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Share of the machine bay the gears take on wide screens; the viewer takes the rest, beside them. Kept in step with .gw-bay. */
const GEAR_SHARE = 65;

/** Version B: the 3D machine, in its own chunk (three.js): fetched once the page is idle, started when the section is near. */
const load3D = () => import("./gear-workflow-3d");
const GearWorkflow3D = dynamic(load3D, { ssr: false });
/** Stills of the machine as it first appears, shown at once (and kept for anyone without script) while the 3D starts. */
const POSTERS = {
  wide: { src: "/marketing/workflow/machine-wide.webp", width: 1600, height: 889 },
  square: { src: "/marketing/workflow/machine-square.webp", width: 900, height: 857 },
} as const;

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Stage marks engraved on each hub cap (24 x 24, one stroke weight). */
const ICONS: Record<StageId, string> = {
  enquiry: "M3 13l2.5-7h13L21 13v5H3zM3 13h5l1.5 2.5h5L16 13h5",
  quote: "M6 3h9l4 4v14H6zM15 3v4h4M9 11h7M9 14.5h7M9 18h4",
  po: "M5 4h14v16H5zM8 9h8M8 12.5h8M8 16l2 2 4-4",
  worksheet: "M4 4h16v16H4zM4 9h16M9 9v11M12.5 13h4.5M12.5 16.5h4.5",
  schedule: "M4 4v16h16M7 8h7M10 12h8M7 16h5",
  signoff: "M12 3l7 3v6c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6zM8.5 12l2.5 2.5 4.5-5",
  invoice: "M6 3h12v18l-2.5-1.6L13 21l-2.5-1.6L8 21l-2-1.6zM9 8h6M9 11.5h6M9 15h3.5",
};

function Arrow({ back = false }: { back?: boolean }) {
  return (
    <svg className="gw-arrow" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" style={back ? { transform: "scaleX(-1)" } : undefined}>
      <path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/** The static (non-turning) shading, sized from the gear's own radii so it reads as machined steel lit from the top left. */
function GearDefs({ layout }: { layout: GearLayout }) {
  const v = layout.variant;
  return (
    <defs>
      {layout.gears.map((g) => {
        const root = g.rr / g.ra;
        return (
          <radialGradient key={g.index} id={`gw-${v}-teeth-${g.index}`} cx="50%" cy="50%" r="50%">
            <stop offset={0} stopColor="#6f7884" />
            <stop offset={Math.max(0, root - 0.04)} stopColor="#7d8692" />
            <stop offset={root} stopColor="#5e6773" />
            <stop offset={root + (1 - root) * 0.45} stopColor="#a3acb7" />
            <stop offset={root + (1 - root) * 0.82} stopColor="#e4e8ed" />
            <stop offset={0.985} stopColor="#b3bbc5" />
            <stop offset={1} stopColor="#6d7581" />
          </radialGradient>
        );
      })}
      <radialGradient id={`gw-${v}-face`} cx="42%" cy="38%" r="70%">
        <stop offset={0} stopColor="#c9d0d8" />
        <stop offset={0.55} stopColor="#a5aeb9" />
        <stop offset={1} stopColor="#7f8894" />
      </radialGradient>
      <radialGradient id={`gw-${v}-web`} cx="58%" cy="62%" r="72%">
        <stop offset={0} stopColor="#9aa3ae" />
        <stop offset={0.7} stopColor="#828b97" />
        <stop offset={1} stopColor="#6c7581" />
      </radialGradient>
      <linearGradient id={`gw-${v}-light`} x1="0" y1="0" x2="1" y2="1">
        <stop offset={0} stopColor="#ffffff" stopOpacity={0.42} />
        <stop offset={0.42} stopColor="#ffffff" stopOpacity={0} />
        <stop offset={0.7} stopColor="#0b1626" stopOpacity={0} />
        <stop offset={1} stopColor="#0b1626" stopOpacity={0.38} />
      </linearGradient>
      <radialGradient id={`gw-${v}-hole`} cx="40%" cy="35%" r="70%">
        <stop offset={0} stopColor="#0a1322" />
        <stop offset={0.75} stopColor="#111c2e" />
        <stop offset={1} stopColor="#2a3446" />
      </radialGradient>
      <linearGradient id={`gw-${v}-hub`} x1="0" y1="0" x2="1" y2="1">
        <stop offset={0} stopColor="#eef1f4" />
        <stop offset={0.5} stopColor="#a9b2bd" />
        <stop offset={1} stopColor="#6b7480" />
      </linearGradient>
      <filter id={`gw-${v}-shadow`} x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation={layout.module * 0.9} />
      </filter>
    </defs>
  );
}

/**
 * One gear: the turning parts (teeth, rim, recessed web, lightening holes, boss, bore and keyway) and the still parts (turned
 * finish, light, hub cap with the stage's mark, selection ring).
 */
function GearShape({ g, v, angle, active, hot, mark, setRef }: {
  g: Gear; v: string; angle: number; active: boolean; hot: boolean; mark: StageId | null; setRef: (node: SVGGElement | null) => void;
}) {
  const holes = Array.from({ length: g.holes.count }, (_, k) => (360 / g.holes.count) * k);
  const web = g.rr * 0.84;
  const boss = Math.max(g.hub + 1.5, Math.min(g.hub * 1.32, g.holes.at - g.holes.size - 1.6));
  // Fine turning marks: many faint concentric lines, as a face turned on a lathe catches the light.
  const turns = Array.from({ length: 9 }, (_, k) => (g.rr - 2.5) * (0.97 - k * 0.075));
  const cap = g.hub * 0.72;
  const icon = cap * 1.25;
  return (
    <g className={`gw-gear${active ? " gw-on" : ""}${hot ? " gw-hot" : ""}`}>
      <g ref={setRef} transform={`rotate(${angle} ${g.cx} ${g.cy})`}>
        <g transform={`translate(${g.cx} ${g.cy})`}>
          <path d={g.path} fill={`url(#gw-${v}-teeth-${g.index})`} stroke="#4b535e" strokeWidth={0.6} />
          <circle r={g.rr - 1.6} fill={`url(#gw-${v}-face)`} />
          {/* The web is turned down below the rim: a shadowed step on its upper edge, a lit step on its lower edge. */}
          <circle r={web} fill={`url(#gw-${v}-web)`} />
          <circle r={web} fill="none" stroke="#4e5763" strokeWidth={1.4} />
          <circle r={web - 1.4} fill="none" stroke="#ffffff" strokeOpacity={0.18} strokeWidth={0.7} />
          {holes.map((a) => (
            <circle key={a} cx={g.holes.at * Math.cos((a * Math.PI) / 180)} cy={g.holes.at * Math.sin((a * Math.PI) / 180)} r={g.holes.size} fill={`url(#gw-${v}-hole)`} stroke="#d6dbe1" strokeOpacity={0.55} strokeWidth={0.7} />
          ))}
          <circle r={boss} fill={`url(#gw-${v}-face)`} stroke="#5a636e" strokeWidth={0.9} />
          <circle r={g.hub} fill={`url(#gw-${v}-hub)`} stroke="#59626d" strokeWidth={0.8} />
          <circle r={g.bore} fill="#0b1626" />
          <rect x={g.bore - g.bore * 0.35} y={-g.bore * 0.32} width={g.bore * 0.75} height={g.bore * 0.64} fill="#0b1626" />
        </g>
      </g>
      <g pointerEvents="none">
        {turns.map((rad, k) => <circle key={rad} cx={g.cx} cy={g.cy} r={rad} fill="none" stroke="#ffffff" strokeOpacity={k % 2 ? 0.045 : 0.08} strokeWidth={0.5} />)}
        <circle cx={g.cx} cy={g.cy} r={g.ra} fill={`url(#gw-${v}-light)`} />
        <circle className="gw-cap" cx={g.cx} cy={g.cy} r={cap} />
        {mark ? (
          <g transform={`translate(${g.cx - icon / 2} ${g.cy - icon / 2}) scale(${icon / 24})`}>
            <path className="gw-mark" d={ICONS[mark]} />
          </g>
        ) : (
          <text className="gw-num" x={g.cx} y={g.cy} textAnchor="middle" dominantBaseline="central" style={{ fontSize: Math.max(8, g.hub * 0.62) }}>
            {String(g.index + 1).padStart(2, "0")}
          </text>
        )}
        <circle className="gw-ring" cx={g.cx} cy={g.cy} r={g.ra + 5} />
      </g>
    </g>
  );
}

/** The stage's image, framed as what it is: a sheet of paper for a document, an app window for a screen. */
function StageImage({ stage, sizes, priority = false }: { stage: Pick<GearStage, "shot">; sizes: string; priority?: boolean }) {
  const shot = stage.shot;
  return (
    <div className={shot.kind === "document" ? "gw-paper" : "gw-window"}>
      {shot.kind === "screen" ? (
        <div className="gw-window-bar" aria-hidden="true">
          <span className="gw-window-dot" />
          <span className="mk-mono">Tolra · {shot.source}</span>
        </div>
      ) : null}
      <div className={shot.kind === "screen" && shot.height > shot.width ? "gw-shot gw-shot-tall" : "gw-shot"}>
        <Image src={shot.src} width={shot.width} height={shot.height} alt={shot.alt} sizes={sizes} priority={priority} />
      </div>
    </div>
  );
}

function Assembly({ layout, active, hot, setHot, onPick, gearRefs, interactive }: {
  layout: GearLayout; active: number; hot: number; setHot: (i: number) => void; onPick: (i: number) => void;
  gearRefs: MutableRefObject<Array<SVGGElement | null>>; interactive: boolean;
}) {
  const v = layout.variant;
  const radios = useRef<Array<HTMLButtonElement | null>>([]);
  const mid = layout.height / 2;
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let next: number | null = null;
    if (event.key in moves) next = stepTo(active, moves[event.key]);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = STAGE_COUNT - 1;
    if (next === null) return;
    event.preventDefault();
    onPick(next);
    radios.current[next]?.focus();
  };
  return (
    <div className={`gw-assembly gw-${v}`} style={{ aspectRatio: `${layout.width} / ${layout.height}` }}>
      <svg className="gw-svg" viewBox={layout.viewBox} aria-hidden="true" focusable="false">
        <GearDefs layout={layout} />
        {layout.gears.map((g) => (
          <circle key={`s${g.index}`} cx={g.cx + layout.module * 0.8} cy={g.cy + layout.module * 1.3} r={g.ra} fill="#020611" opacity={0.55} filter={`url(#gw-${v}-shadow)`} />
        ))}
        {layout.gears.map((g) => (
          <GearShape key={g.index} g={g} v={v} angle={gearAngle(g, 0)} active={g.index === active} hot={g.index === hot} mark={v === "wide" ? GEAR_STAGES[g.index].id : null} setRef={(node) => { gearRefs.current[g.index] = node; }} />
        ))}
        {v === "wide"
          ? layout.gears.map((g) => {
              const above = g.cy < mid;
              const y = above ? g.cy - g.ra - 26 : g.cy + g.ra + 22;
              const s = GEAR_STAGES[g.index];
              return (
                <g key={`l${g.index}`} className={`gw-lab${g.index === active ? " gw-lab-on" : ""}`}>
                  <text x={g.cx} y={y} textAnchor="middle" className="gw-lab-op">OP {s.op}</text>
                  <text x={g.cx} y={y + 16} textAnchor="middle" className="gw-lab-name">{s.label.toUpperCase()}</text>
                </g>
              );
            })
          : null}
      </svg>
      <div
        className="gw-hits"
        role={interactive ? "radiogroup" : undefined}
        aria-label={interactive ? GEAR_COPY.selector : undefined}
        aria-hidden={interactive ? undefined : true}
        onKeyDown={interactive ? onKey : undefined}
      >
        {layout.gears.map((g) => {
          const s = GEAR_STAGES[g.index];
          const on = g.index === active;
          return (
            <button
              key={g.index}
              ref={(node) => { radios.current[g.index] = node; }}
              type="button"
              className="gw-hit"
              role={interactive ? "radio" : undefined}
              aria-checked={interactive ? on : undefined}
              aria-label={interactive ? `Stage ${g.index + 1} of ${STAGE_COUNT}: ${s.label}` : undefined}
              tabIndex={interactive ? (on ? 0 : -1) : -1}
              style={{ left: pct(g.cx - g.ra, layout.width), top: pct(g.cy - g.ra, layout.height), width: pct(g.ra * 2, layout.width) }}
              onClick={() => onPick(g.index)}
              onPointerEnter={() => setHot(g.index)}
              onPointerLeave={() => setHot(-1)}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * `defaultView` is what the server renders: the 3D machine's shell (heading, a still of the machine, the stage chips and panel), which
 * the 3D scene then takes over without moving anything. The 2D drawing replaces it on ?gears=2d or where WebGL is missing.
 */
export function GearWorkflow({ defaultView = "3d" }: { defaultView?: GearsMode }) {
  const [active, setActive] = useState(0);
  const [hot, setHot] = useState(-1);
  const drive = useRef(0);
  const frame = useRef(0);
  const activeRef = useRef(0);
  const wideRefs = useRef<Array<SVGGElement | null>>([]);
  const compactRefs = useRef<Array<SVGGElement | null>>([]);
  const chips = useRef<Array<HTMLButtonElement | null>>([]);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const [view, setView] = useState<GearsMode>(defaultView);
  // How much 3D the device gets: set on the client only, from what it can do; null until then.
  const [tier, setTier] = useState<Exclude<RenderTier, "none"> | null>(null);
  const [compare, setCompare] = useState<{ asked: GearsMode; fellBack: boolean } | null>(null);
  const [near, setNear] = useState(false);
  const [motion, setMotion] = useState(true);
  const slot = useRef<HTMLDivElement | null>(null);
  // Version A shows the seven stages of a job; version B adds Analytics after them.
  const list: readonly SceneStage[] = view === "3d" ? SCENE_STAGES : SCENE_STAGES.slice(0, STAGE_COUNT);
  const count = useRef(STAGE_COUNT);
  count.current = list.length;

  useEffect(() => {
    const { mode, compare: wanted } = parseGearsParam(window.location.search);
    let fellBack = false;
    if (mode === "2d") setView("2d");
    else {
      const nav = navigator as Navigator & { deviceMemory?: number };
      const chosen = chooseTier({
        webgl: webglAvailable(),
        width: window.innerWidth,
        cores: nav.hardwareConcurrency || undefined,
        memory: nav.deviceMemory,
      });
      if (chosen === "none") {
        fellBack = true;
        setView("2d");
      } else {
        setView("3d");
        setTier(chosen);
        setMotion(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
        // Download the 3D code while the page is idle, so it is ready before anyone scrolls down to it.
        const warm = () => { void load3D(); };
        if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(warm); else window.setTimeout(warm, 1500);
      }
    }
    if (wanted) setCompare({ asked: mode, fellBack });
  }, []);

  // Fetch the 3D chunk only once the section is within a screen or so of the viewport, so it never delays the page above.
  useEffect(() => {
    const node = slot.current;
    if (!tier || !node) return;
    const io = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setNear(true); io.disconnect(); } }, { rootMargin: "700px 0px" });
    io.observe(node);
    return () => io.disconnect();
  }, [tier]);

  const fallBack = useCallback(() => {
    // Version A has no Analytics view: come back to the last stage of the job if that was on screen.
    if (activeRef.current >= STAGE_COUNT) {
      activeRef.current = STAGE_COUNT - 1;
      setActive(STAGE_COUNT - 1);
    }
    setTier(null);
    setView("2d");
    setCompare((c) => (c ? { ...c, fellBack: true } : c));
  }, []);

  // The train only turns while a selection is animating; stop any frame still queued when the section unmounts.
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const paint = useCallback((value: number) => {
    for (const layout of LAYOUTS) {
      const nodes = layout.variant === "wide" ? wideRefs.current : compactRefs.current;
      layout.gears.forEach((g) => nodes[g.index]?.setAttribute("transform", `rotate(${gearAngle(g, value).toFixed(3)} ${g.cx} ${g.cy})`));
    }
  }, []);

  const pick = useCallback((index: number) => {
    const next = clampStage(index, count.current);
    const current = activeRef.current;
    if (next === current) return;
    activeRef.current = next;
    setActive(next);
    // Turn the train: the first gear moves three teeth per stage, forwards or backwards; every other gear follows its ratio.
    const from = drive.current;
    const to = from + driveFor(next - current);
    drive.current = to;
    cancelAnimationFrame(frame.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      paint(to);
      return;
    }
    const duration = Math.min(1500, 650 + 140 * Math.abs(next - current));
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      paint(from + (to - from) * ease(t));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [paint]);

  const onChipKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let next: number | null = null;
    if (event.key in moves) next = stepTo(active, moves[event.key], list.length);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = list.length - 1;
    if (next === null) return;
    event.preventDefault();
    pick(next);
    chips.current[next]?.focus();
  };

  const stage = list[Math.min(active, list.length - 1)];
  const openFull = () => dialog.current?.showModal();
  // The pointer on the viewer's edge sits level with the selected gear: the bay centres the gears, so offset from the middle by the
  // gear's distance from the drawing's middle, scaled to the gears' share of the bay width (container query units).
  const sel = WIDE_LAYOUT.gears[Math.min(active, STAGE_COUNT - 1)];
  const notch = `calc(50% + ${(((sel.cy - WIDE_LAYOUT.height / 2) / WIDE_LAYOUT.width) * GEAR_SHARE).toFixed(3)}cqw)`;
  const viewer = (
    <section className="gw-view" key={stage.id} aria-label={`${stage.label} in Tolra`}>
      <div className="gw-view-head">
        <p className="mk-label gw-view-op">Op {stage.op} · {stage.label}</p>
      </div>
      <button type="button" className="gw-view-open" onClick={openFull} aria-label={`${GEAR_COPY.fullSize}: ${stage.shot.source}`}>
        <StageImage stage={stage} sizes="(min-width: 1240px) 440px, 36vw" />
      </button>
      <p className="gw-view-foot"><span className="mk-label">{stage.shot.source} · {GEAR_COPY.shotNote}</span><button type="button" className="mk-link gw-view-link" onClick={openFull}>{GEAR_COPY.fullSize}</button></p>
    </section>
  );

  return (
    <div className={view === "3d" ? "gw gw-3d" : "gw"}>
      {view === "3d" ? (
        <div className="gw3-slot" ref={slot} data-tier={tier ?? undefined}>
          <div className="gw3-poster">
            <Image className="gw3-poster-wide" src={POSTERS.wide.src} width={POSTERS.wide.width} height={POSTERS.wide.height} alt={VERSION_COPY.poster} sizes="(min-width: 1240px) 1160px, 94vw" />
            <Image className="gw3-poster-square" src={POSTERS.square.src} width={POSTERS.square.width} height={POSTERS.square.height} alt={VERSION_COPY.poster} sizes="94vw" />
          </div>
          {tier && near ? (
            <GearWorkflow3D active={active} tier={tier} motion={motion} onPick={pick} onOpenFull={openFull} onRestart={() => pick(0)} onFail={fallBack} />
          ) : null}
          <div className="gw3-head" aria-hidden="true">
            <span className="mk-label">{VERSION_COPY.head}</span>
            <span className="mk-label">{GEAR_COPY.illustration}, {GEAR_COPY.example}</span>
          </div>
        </div>
      ) : (
        <div className="gw-machine">
          <span className="gw-screw gw-screw-tl" aria-hidden="true" />
          <span className="gw-screw gw-screw-tr" aria-hidden="true" />
          <span className="gw-screw gw-screw-bl" aria-hidden="true" />
          <span className="gw-screw gw-screw-br" aria-hidden="true" />
          <div className="gw-plate-head">
            <span className="mk-label gw-plate-label">The Tolra machine</span>
            <span className="mk-label gw-plate-label">{GEAR_COPY.illustration}, {GEAR_COPY.example}</span>
          </div>
          <div className="gw-bay">
            <Assembly layout={WIDE_LAYOUT} active={active} hot={hot} setHot={setHot} onPick={pick} gearRefs={wideRefs} interactive />
            <div className="gw-side" style={{ ["--gw-notch" as string]: notch }}>{viewer}</div>
          </div>
          <Assembly layout={COMPACT_LAYOUT} active={active} hot={hot} setHot={setHot} onPick={pick} gearRefs={compactRefs} interactive={false} />
        </div>
      )}

      <div className="gw-chips" role="radiogroup" aria-label={GEAR_COPY.selector} onKeyDown={onChipKey}>
        {list.map((s, i) => (
          <button
            key={s.id}
            ref={(node) => { chips.current[i] = node; }}
            type="button"
            role="radio"
            aria-checked={i === active}
            tabIndex={i === active ? 0 : -1}
            className="gw-chip"
            onClick={() => pick(i)}
          >
            <span className="mk-mono gw-chip-n">{String(i + 1).padStart(2, "0")}</span>
            <span>{s.label}</span>
          </button>
        ))}
      </div>

      {/* Below 1100px: the stage's image in a fixed-size frame above the details, so nothing moves when it changes. */}
      <div className="gw-mview">
        <button type="button" className="gw-mview-open" onClick={openFull} aria-label={`${GEAR_COPY.fullSize}: ${stage.shot.source}`}>
          <StageImage stage={stage} sizes="100vw" key={stage.id} />
        </button>
        <p className="gw-view-foot"><span className="mk-label">{stage.shot.source} · {GEAR_COPY.shotNote}</span><button type="button" className="mk-link gw-view-link" onClick={openFull}>{GEAR_COPY.fullSize}</button></p>
      </div>

      <div className="gw-panel">
        {/* Every stage is laid out in the same place and only the selected one is shown, so the panel keeps the height of its
            tallest stage and nothing below the section moves when the stage changes. */}
        <p className="sr-only" aria-live="polite">{`Stage ${active + 1} of ${list.length}: ${stage.label}`}</p>
        <div className="gw-stack">
          {list.map((s, i) => (
            <div key={s.id} className={i === active ? "gw-slide gw-slide-on" : "gw-slide"} aria-hidden={i !== active} inert={i !== active}>
              <p className="mk-label">Op {s.op} · Stage {i + 1} of {list.length}</p>
              <h4 className="mk-display gw-title">{s.label}</h4>
              <p className="gw-caption">{s.caption}</p>
              {s.solves ? (
                <p className="gw-fixes"><span className="mk-label">{GEAR_COPY.fixes}</span><span>{s.solves}</span></p>
              ) : null}
            </div>
          ))}
        </div>
        <div className="gw-stack">
          {list.map((s, i) => (
            <div key={s.id} className={i === active ? "gw-slide gw-slide-on" : "gw-slide"} aria-hidden={i !== active} inert={i !== active}>
              <ul className="gw-details">
                {s.details.map((line) => <li key={line}>{line}</li>)}
              </ul>
              <p className="mk-label gw-record-label">{GEAR_COPY.record}</p>
              <dl className="gw-record">
                {s.record.map(([k, value]) => (
                  <div key={k}><dt>{k}</dt><dd className="mk-mono">{value}</dd></div>
                ))}
              </dl>
            </div>
          ))}
        </div>
        <div className="gw-nav">
          <button type="button" className="gw-step" onClick={() => pick(active - 1)} disabled={active === 0}>
            <Arrow back /> {GEAR_COPY.previous}
          </button>
          <span className="mk-label gw-progress" aria-hidden="true">
            {list.map((s, i) => <span key={s.id} className={i <= active ? "gw-tick gw-tick-on" : "gw-tick"} />)}
          </span>
          <button type="button" className="gw-step" onClick={() => pick(active + 1)} disabled={active === list.length - 1}>
            {GEAR_COPY.next} <Arrow />
          </button>
        </div>
      </div>

      <dialog ref={dialog} className="gw-dialog" aria-label={`${stage.shot.source}, ${GEAR_COPY.shotNote}`} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
        <div className="gw-dialog-bar">
          <span className="mk-label">Op {stage.op} · {stage.shot.source} · {GEAR_COPY.shotNote}</span>
          <button type="button" className="gw-step" onClick={() => dialog.current?.close()}>{GEAR_COPY.close}</button>
        </div>
        <div className="gw-dialog-body">
          <Image src={stage.shot.src} width={stage.shot.width} height={stage.shot.height} alt={stage.shot.alt} sizes="(min-width: 1200px) 1100px, 96vw" />
        </div>
      </dialog>

      {compare ? (
        <nav className="gw3-compare" aria-label={VERSION_COPY.compare}>
          <span className="mk-label">{VERSION_COPY.compare}</span>
          <span className="gw3-compare-row">
            <a href="?gears=2d&compare#handles-title" aria-current={view === "3d" ? undefined : "page"}>{VERSION_COPY.versionA}</a>
            <a href="?gears=3d&compare#handles-title" aria-current={view === "3d" ? "page" : undefined}>{VERSION_COPY.versionB}</a>
          </span>
          {compare.asked === "3d" && compare.fellBack ? <span className="gw3-compare-note">{VERSION_COPY.fallback}</span> : null}
        </nav>
      ) : null}
    </div>
  );
}
