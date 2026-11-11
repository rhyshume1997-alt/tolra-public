"use client";

/*
 * "The Tolra Machine" (public home page, "How Tolra handles it"): seven meshed steel gears, one per stage of a job. Selecting a gear
 * (click, tap, arrow keys, or the Previous / Next buttons) turns the whole train, in mechanically correct directions and ratios, and
 * shows what happens at that stage.
 *
 * Inputs: GEAR_STAGES, GEAR_COPY and the two layouts from lib/marketing/gear-workflow.ts. Output: one section of markup, no data.
 * Must not change: the copy (it lives in the marketing module), the booking links and anything outside this section. The gears turn
 * only when someone selects a stage (no autoplay) and never under prefers-reduced-motion; the content reads the same without motion.
 * The hero traveller stays the page's only tablist: the gears are a radio group.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";

import {
  COMPACT_LAYOUT, GEAR_COPY, GEAR_STAGES, STAGE_COUNT, WIDE_LAYOUT, clampStage, driveFor, gearAngle, stepTo, type Gear, type GearLayout,
} from "@/lib/marketing/gear-workflow";

const LAYOUTS: GearLayout[] = [WIDE_LAYOUT, COMPACT_LAYOUT];

function Arrow({ back = false }: { back?: boolean }) {
  return (
    <svg className="gw-arrow" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" style={back ? { transform: "scaleX(-1)" } : undefined}>
      <path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
const pct = (n: number, of: number) => `${(n / of) * 100}%`;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

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
      <linearGradient id={`gw-${v}-light`} x1="0" y1="0" x2="1" y2="1">
        <stop offset={0} stopColor="#ffffff" stopOpacity={0.42} />
        <stop offset={0.42} stopColor="#ffffff" stopOpacity={0} />
        <stop offset={0.7} stopColor="#0b1626" stopOpacity={0} />
        <stop offset={1} stopColor="#0b1626" stopOpacity={0.38} />
      </linearGradient>
      <radialGradient id={`gw-${v}-web`} cx="58%" cy="62%" r="72%">
        <stop offset={0} stopColor="#9aa3ae" />
        <stop offset={0.7} stopColor="#828b97" />
        <stop offset={1} stopColor="#6c7581" />
      </radialGradient>
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

/** One gear: the turning parts (teeth, web, lightening holes, bore and keyway) and the still parts (turned rings, light, hub cap). */
function GearShape({ g, v, angle, active, hot, setRef }: { g: Gear; v: string; angle: number; active: boolean; hot: boolean; setRef: (node: SVGGElement | null) => void }) {
  const holes = Array.from({ length: g.holes.count }, (_, k) => (360 / g.holes.count) * k);
  const web = g.rr * 0.84;
  const boss = Math.max(g.hub + 1.5, Math.min(g.hub * 1.32, g.holes.at - g.holes.size - 1.6));
  const rings = [0.93, 0.7, 0.55].map((f) => f * (g.rr - 2));
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
        {rings.map((rad) => <circle key={rad} cx={g.cx} cy={g.cy} r={rad} fill="none" stroke="#ffffff" strokeOpacity={0.07} strokeWidth={0.6} />)}
        <circle cx={g.cx} cy={g.cy} r={g.ra} fill={`url(#gw-${v}-light)`} />
        <circle className="gw-cap" cx={g.cx} cy={g.cy} r={g.hub * 0.62} />
        <text className="gw-num" x={g.cx} y={g.cy} textAnchor="middle" dominantBaseline="central" style={{ fontSize: Math.max(8, g.hub * 0.62) }}>
          {String(g.index + 1).padStart(2, "0")}
        </text>
        <circle className="gw-ring" cx={g.cx} cy={g.cy} r={g.ra + 5} />
      </g>
    </g>
  );
}

function Assembly({ layout, active, hot, setHot, onPick, gearRefs, interactive }: {
  layout: GearLayout; active: number; hot: number; setHot: (i: number) => void; onPick: (i: number, focus: boolean) => void;
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
    onPick(next, false);
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
          <GearShape key={g.index} g={g} v={v} angle={gearAngle(g, 0)} active={g.index === active} hot={g.index === hot} setRef={(node) => { gearRefs.current[g.index] = node; }} />
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
              onClick={() => onPick(g.index, false)}
              onPointerEnter={() => setHot(g.index)}
              onPointerLeave={() => setHot(-1)}
            />
          );
        })}
      </div>
    </div>
  );
}

export function GearWorkflow() {
  const [active, setActive] = useState(0);
  const [hot, setHot] = useState(-1);
  const drive = useRef(0);
  const frame = useRef(0);
  const wideRefs = useRef<Array<SVGGElement | null>>([]);
  const compactRefs = useRef<Array<SVGGElement | null>>([]);
  const chips = useRef<Array<HTMLButtonElement | null>>([]);

  const activeRef = useRef(0);

  // The train only turns while a selection is animating; stop any frame still queued when the section unmounts.
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const paint = useCallback((value: number) => {
    for (const layout of LAYOUTS) {
      const nodes = layout.variant === "wide" ? wideRefs.current : compactRefs.current;
      layout.gears.forEach((g) => nodes[g.index]?.setAttribute("transform", `rotate(${gearAngle(g, value).toFixed(3)} ${g.cx} ${g.cy})`));
    }
  }, []);

  const pick = useCallback((index: number) => {
    const next = clampStage(index);
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
    if (event.key in moves) next = stepTo(active, moves[event.key]);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = STAGE_COUNT - 1;
    if (next === null) return;
    event.preventDefault();
    pick(next);
    chips.current[next]?.focus();
  };

  const stage = GEAR_STAGES[active];
  return (
    <div className="gw">
      <div className="gw-machine">
        <span className="gw-screw gw-screw-tl" aria-hidden="true" />
        <span className="gw-screw gw-screw-tr" aria-hidden="true" />
        <span className="gw-screw gw-screw-bl" aria-hidden="true" />
        <span className="gw-screw gw-screw-br" aria-hidden="true" />
        <div className="gw-plate-head">
          <span className="mk-label gw-plate-label">The Tolra machine</span>
          <span className="mk-label gw-plate-label">{GEAR_COPY.illustration}, {GEAR_COPY.example}</span>
        </div>
        <Assembly layout={WIDE_LAYOUT} active={active} hot={hot} setHot={setHot} onPick={pick} gearRefs={wideRefs} interactive />
        <Assembly layout={COMPACT_LAYOUT} active={active} hot={hot} setHot={setHot} onPick={pick} gearRefs={compactRefs} interactive={false} />
      </div>

      <div className="gw-chips" role="radiogroup" aria-label={GEAR_COPY.selector} onKeyDown={onChipKey}>
        {GEAR_STAGES.map((s, i) => (
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

      <div className="gw-panel">
        {/* Every stage is laid out in the same place and only the selected one is shown, so the panel keeps the height of its
            tallest stage and nothing below the section moves when the stage changes. */}
        <p className="sr-only" aria-live="polite">Stage {active + 1} of {STAGE_COUNT}: {stage.label}</p>
        <div className="gw-stack">
          {GEAR_STAGES.map((s, i) => (
            <div key={s.id} className={i === active ? "gw-slide gw-slide-on" : "gw-slide"} aria-hidden={i !== active} inert={i !== active}>
              <p className="mk-label">Op {s.op} · Stage {i + 1} of {STAGE_COUNT}</p>
              <h4 className="mk-display gw-title">{s.label}</h4>
              <p className="gw-caption">{s.caption}</p>
              {s.solves ? (
                <p className="gw-fixes"><span className="mk-label">{GEAR_COPY.fixes}</span><span>{s.solves}</span></p>
              ) : null}
            </div>
          ))}
        </div>
        <div className="gw-stack">
          {GEAR_STAGES.map((s, i) => (
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
            {GEAR_STAGES.map((s, i) => <span key={s.id} className={i <= active ? "gw-tick gw-tick-on" : "gw-tick"} />)}
          </span>
          <button type="button" className="gw-step" onClick={() => pick(active + 1)} disabled={active === STAGE_COUNT - 1}>
            {GEAR_COPY.next} <Arrow />
          </button>
        </div>
      </div>
    </div>
  );
}
