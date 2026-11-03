"use client";

/*
 * "How Tolra handles it": three live drawings, adapted from the ink-orbit features section (21st.dev). Kept from it: packets that travel
 * along the leaders, a stack of sheets that prints, one item lit at a time, a strip you can scrub, and registration marks that open on
 * hover. Redrawn for the Tolra sheet: navy ink on paper, 1px rules, square corners, signal blue only for what is active, no gradients,
 * glows or shadows, and only real Tolra flows with the page's example values (no people, counters, forecasts or integrations).
 * Every hover state also works on focus; with reduced motion nothing moves and each drawing shows a still, complete state.
 * The flow and the stages strip have a wide and a compact drawing; a container query shows the one that fits (the other is display:none,
 * so it is neither seen, focused nor read out).
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import {
  FLOW_JOB, FLOW_STEPS, HANDLES_FLOW, HANDLES_IN_TOLRA, HANDLES_SCHEDULE, HANDLES_STAGES, HANDLES_TODAY, ILLUSTRATION_LABEL,
} from "@/lib/marketing";

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduced;
}

/** True while the element is on screen, so nothing runs off screen. */
function useOnScreen<T extends Element>(threshold = 0.25) {
  const ref = useRef<T | null>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver(([entry]) => setOn(entry.isIntersecting), { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return [ref, on] as const;
}

const activate = (run: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
};

/** The Tolra bracket-T, drawn in the ink colour (same paths as components/marketing/bracket-t.tsx). */
function Mark({ x, y, size }: { x: number; y: number; size: number }) {
  return (
    <svg x={x} y={y} width={size} height={size} viewBox="150 150 724 724" aria-hidden="true">
      <path d="M180 180h233v59H239v547h174v59H180zM845 180H612v59h174v547H612v59h233z" fill="currentColor" />
      <path d="M285 265h455v114H576v402H449V379H285z" fill="currentColor" />
    </svg>
  );
}

/** A small sheet travelling along a leader. */
function Packet({ path, dur, begin = 0 }: { path: string; dur: number; begin?: number }) {
  return (
    <rect x="-3" y="-4" width="6" height="8" className="io-pkt">
      <animateMotion dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" path={path} />
    </rect>
  );
}

/** One drawing on the sheet: registration marks, the problem it answers, the drawing, and how Tolra handles it. */
function Cell({ pain, answer, className, children, status }: { pain: string; answer: string; className: string; children: ReactNode; status: ReactNode }) {
  return (
    <div className={`io-cell ${className}`}>
      <span className="io-c io-c-tl" aria-hidden />
      <span className="io-c io-c-tr" aria-hidden />
      <span className="io-c io-c-bl" aria-hidden />
      <span className="io-c io-c-br" aria-hidden />
      <div className="io-head">
        <p className="mk-label">{HANDLES_TODAY}</p>
        <h3 className="mk-display mt-1 text-[1.625rem]">{pain}</h3>
      </div>
      <div className="io-body">{children}</div>
      <p className="io-status mk-mono" aria-live="polite">{status}</p>
      <div className="io-foot">
        <p className="mk-label">{HANDLES_IN_TOLRA}</p>
        <p className="mt-1 max-w-[46ch]">{answer}</p>
      </div>
    </div>
  );
}

type Role = (typeof HANDLES_FLOW.roles)[number]["id"];
type Box = { x: number; y: number; w: number; h: number };
type FlowLayout = {
  variant: "wide" | "compact"; viewBox: string; office: Box; hub: Box; shop: Box; mark: number;
  fromOffice: string; toOffice: string; toShop: string; fromShop: string; down: string; stack: { x: number; y: number };
};

const FLOW_LAYOUTS: FlowLayout[] = [
  {
    variant: "wide", viewBox: "0 0 480 236", office: { x: 8, y: 18, w: 128, h: 64 }, hub: { x: 196, y: 14, w: 88, h: 72 }, shop: { x: 344, y: 18, w: 128, h: 64 }, mark: 36,
    fromOffice: "M136,40 H196", toOffice: "M196,60 H136", toShop: "M284,40 H344", fromShop: "M344,60 H284", down: "M240,86 V112", stack: { x: 176, y: 112 },
  },
  {
    variant: "compact", viewBox: "0 0 330 222", office: { x: 4, y: 12, w: 104, h: 56 }, hub: { x: 133, y: 10, w: 64, h: 60 }, shop: { x: 222, y: 12, w: 104, h: 56 }, mark: 30,
    fromOffice: "M108,32 H133", toOffice: "M133,50 H108", toShop: "M197,32 H222", fromShop: "M222,50 H197", down: "M165,70 V98", stack: { x: 101, y: 98 },
  },
];

/** Office and workshop either side of Tolra, sheets travelling both ways, and the job's documents coming off the stack in turn. */
function FlowDrawing({ reduced }: { reduced: boolean }) {
  const [ref, onScreen] = useOnScreen<HTMLDivElement>();
  const [side, setSide] = useState<Role | "">("");
  const [sheet, setSheet] = useState(0);
  const sheets = HANDLES_FLOW.sheets;
  useEffect(() => {
    if (reduced || !onScreen) return;
    const t = setInterval(() => setSheet((n) => (n + 1) % sheets.length), 2800);
    return () => clearInterval(t);
  }, [reduced, onScreen, sheets.length]);

  const role = HANDLES_FLOW.roles.find((r) => r.id === side);
  const front = sheets[sheet];
  const nextSheet = () => setSheet((n) => (n + 1) % sheets.length);

  return (
    <Cell className="io-flow" pain={HANDLES_FLOW.pain} answer={HANDLES_FLOW.answer} status={role ? `${role.name}: ${role.work}` : HANDLES_FLOW.prompt}>
      <div ref={ref}>
        {FLOW_LAYOUTS.map((L) => {
          const boxes = [
            { id: "office" as const, box: L.office, paths: [L.fromOffice, L.toOffice] },
            { id: "workshop" as const, box: L.shop, paths: [L.toShop, L.fromShop] },
          ];
          const compact = L.variant === "compact";
          const { x: sx, y: sy } = L.stack;
          return (
            <svg key={L.variant} className={`io-svg io-v-${L.variant}`} viewBox={L.viewBox} role="group" aria-label={HANDLES_FLOW.label}>
              {boxes.map((b) =>
                b.paths.map((d, i) => <path key={d} d={d} className={`io-lead${side === b.id ? " io-lead-on" : ""}${i ? " io-dash" : ""}`} />),
              )}
              <path d={L.down} className={`io-lead${side ? "" : " io-lead-on"}`} />
              {!reduced && onScreen
                ? [L.fromOffice, L.toOffice, L.toShop, L.fromShop].map((d, i) => <Packet key={d} path={d} dur={(compact ? 1.4 : 2.2) + (i % 2) * 0.5} begin={i * 0.4} />)
                : null}

              {boxes.map(({ id, box }) => {
                const r = HANDLES_FLOW.roles.find((item) => item.id === id)!;
                const on = side === id;
                return (
                  <g
                    key={id}
                    className={`io-hit${on ? " io-hit-on" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={on}
                    aria-label={`${r.name}: ${r.work}`}
                    onMouseEnter={() => setSide(id)}
                    onMouseLeave={() => setSide("")}
                    onFocus={() => setSide(id)}
                    onBlur={() => setSide("")}
                    onClick={() => setSide(on ? "" : id)}
                    onKeyDown={activate(() => setSide(on ? "" : id))}
                  >
                    <rect x={box.x} y={box.y} width={box.w} height={box.h} className="io-node" />
                    <text x={box.x + 10} y={box.y + box.h / 2 + 1} className={`io-t-display${compact ? " io-t-sm" : ""}`}>{r.name.toUpperCase()}</text>
                    <text x={box.x + 10} y={box.y + box.h - 12} className="io-t-label">ROLE</text>
                  </g>
                );
              })}

              <g className="io-hub">
                <rect x={L.hub.x} y={L.hub.y} width={L.hub.w} height={L.hub.h} className="io-node io-node-hub" />
                <Mark x={L.hub.x + (L.hub.w - L.mark) / 2} y={L.hub.y + 7} size={L.mark} />
                <text x={L.hub.x + L.hub.w / 2} y={L.hub.y + L.hub.h - 9} textAnchor="middle" className="io-t-label">{HANDLES_FLOW.hub.toUpperCase()}</text>
              </g>

              <g className="io-hit" role="button" tabIndex={0} aria-label={`${HANDLES_FLOW.nextSheet}. Showing ${front.kind} ${front.number}`} onClick={nextSheet} onKeyDown={activate(nextSheet)}>
                {[2, 1].map((k) => (
                  <rect key={k} x={sx + k * 7} y={sy - k * 5} width="128" height="112" className="io-sheet-back" />
                ))}
                <g key={sheet} className={reduced ? undefined : "io-sheet-new"}>
                  <rect x={sx} y={sy} width="128" height="112" className="io-sheet" />
                  <text x={sx + 12} y={sy + 22} className="io-t-label">{front.kind.toUpperCase()}</text>
                  <text x={sx + 12} y={sy + 46} className="io-t-mono">{front.number}</text>
                  <path d={`M${sx + 12} ${sy + 64}h104M${sx + 12} ${sy + 76}h84M${sx + 12} ${sy + 88}h96M${sx + 12} ${sy + 100}h60`} className="io-rule" />
                </g>
              </g>
            </svg>
          );
        })}
      </div>
    </Cell>
  );
}

/** Tolra in the middle of four machines; one is lit at a time, with what is booked on it. */
function ScheduleDrawing({ reduced }: { reduced: boolean }) {
  const [ref, onScreen] = useOnScreen<HTMLDivElement>();
  const [hover, setHover] = useState(-1);
  const [auto, setAuto] = useState(0);
  const machines = HANDLES_SCHEDULE.machines;
  useEffect(() => {
    if (reduced || !onScreen || hover >= 0) return;
    const t = setInterval(() => setAuto((a) => (a + 1) % machines.length), 1900);
    return () => clearInterval(t);
  }, [reduced, onScreen, hover, machines.length]);
  const on = hover >= 0 ? hover : reduced ? -1 : auto;
  const spots = [
    { x: 4, y: 14, lead: "M126,90 H64 V62" },
    { x: 172, y: 14, lead: "M174,90 H236 V62" },
    { x: 4, y: 150, lead: "M126,110 H64 V150" },
    { x: 172, y: 150, lead: "M174,110 H236 V150" },
  ];
  const booked = (i: number) => (machines[i].jobs.length ? machines[i].jobs.join(", ") : HANDLES_SCHEDULE.free);
  const status = on >= 0 ? `${machines[on].name}: ${booked(on)}` : machines.map((m, i) => `${m.name}: ${booked(i)}`).join(" · ");

  return (
    <Cell className="io-schedule" pain={HANDLES_SCHEDULE.pain} answer={HANDLES_SCHEDULE.answer} status={status}>
      <div ref={ref}>
        <svg className="io-svg" viewBox="0 0 300 200" role="group" aria-label={HANDLES_SCHEDULE.label}>
          {spots.map((s, i) => (
            <path key={s.lead} d={s.lead} className={`io-lead${on === i ? " io-lead-on" : ""}`} />
          ))}
          {!reduced && on >= 0 ? <Packet key={on} path={spots[on].lead} dur={1.1} /> : null}
          <g className="io-hub">
            <rect x="126" y="76" width="48" height="48" className="io-node io-node-hub" />
            <Mark x={136} y={86} size={28} />
          </g>
          {spots.map((s, i) => {
            const m = machines[i];
            const lit = on === i;
            return (
              <g
                key={m.name}
                className={`io-hit${lit ? " io-hit-on" : ""}`}
                role="button"
                tabIndex={0}
                aria-pressed={lit}
                aria-label={`${m.name}: ${booked(i)}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(-1)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(-1)}
                onClick={() => setHover(i)}
              >
                <rect x={s.x} y={s.y} width="124" height="48" className={`io-node${m.jobs.length ? "" : " io-node-free"}`} />
                <text x={s.x + 10} y={s.y + 22} className="io-t-display io-t-sm">{m.name.toUpperCase()}</text>
                <text x={s.x + 10} y={s.y + 39} className="io-t-label io-t-tight">{booked(i).toUpperCase()}</text>
              </g>
            );
          })}
        </svg>
      </div>
    </Cell>
  );
}

const STAGE_LAYOUTS = [
  { variant: "wide", w: 600, h: 112, base: 50 },
  { variant: "compact", w: 330, h: 104, base: 50 },
] as const;

/** Job J-0001 on a dimension line, stage by stage; the invoice box stays empty until the last stage. Drag, hover or use the arrow keys. */
function StagesDrawing({ reduced }: { reduced: boolean }) {
  const [ref, onScreen] = useOnScreen<HTMLDivElement>(0.5);
  const last = FLOW_STEPS.length - 1;
  const [stage, setStage] = useState(0);
  const [touched, setTouched] = useState(false);
  const id = useId();
  useEffect(() => {
    if (reduced) setStage(last);
  }, [reduced, last]);
  useEffect(() => {
    if (reduced || touched || !onScreen || stage >= last) return;
    const t = setTimeout(() => setStage((n) => Math.min(last, n + 1)), 1500);
    return () => clearTimeout(t);
  }, [reduced, touched, onScreen, stage, last]);

  // Stage positions as a share of the strip's width, the same in both drawings.
  const at = (i: number) => 0.04 + (0.92 * i) / last;
  const step = FLOW_STEPS[stage];
  const invoiced = stage === last;
  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const share = (e.clientX - r.left) / r.width;
    let best = 0;
    for (let i = 1; i <= last; i++) if (Math.abs(at(i) - share) < Math.abs(at(best) - share)) best = i;
    setTouched(true);
    setStage(best);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === "ArrowRight" || e.key === "ArrowUp" ? stage + 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? stage - 1 : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    setTouched(true);
    setStage(Math.max(0, Math.min(last, next)));
  };
  const invoiceText = invoiced ? HANDLES_STAGES.drafted : HANDLES_STAGES.notYet;

  return (
    <Cell
      className="io-stages"
      pain={HANDLES_STAGES.pain}
      answer={HANDLES_STAGES.answer}
      status={`${FLOW_JOB.number} · Op ${step.op} ${step.label}: ${step.stamp} · ${HANDLES_STAGES.invoice}: ${invoiceText}`}
    >
      <div ref={ref} className="io-stages-grid">
        <div
          className="io-scrub"
          role="slider"
          tabIndex={0}
          aria-label={HANDLES_STAGES.label}
          aria-describedby={id}
          aria-valuemin={1}
          aria-valuemax={last + 1}
          aria-valuenow={stage + 1}
          aria-valuetext={`Op ${step.op}, ${step.label}: ${step.stamp}`}
          onKeyDown={onKey}
          onPointerMove={(e) => {
            if (e.pointerType === "mouse" || e.buttons) pick(e);
          }}
          onPointerDown={pick}
        >
          {STAGE_LAYOUTS.map((L) => {
            const x = (i: number) => L.w * at(i);
            const y = L.base;
            const compact = L.variant === "compact";
            return (
              <svg key={L.variant} className={`io-svg io-v-${L.variant}`} viewBox={`0 0 ${L.w} ${L.h}`} aria-hidden="true">
                <path d={`M${x(0)},${y - 32} V${y + 32} M${x(last)},${y - 32} V${y + 32}`} className="io-rule" />
                <path d={`M${x(0)},${y} H${x(last)}`} className="io-lead" />
                <path d={`M${x(0)},${y} H${x(stage)}`} className="io-lead io-lead-on io-progress" />
                {FLOW_STEPS.map((s, i) => (
                  <g key={s.id}>
                    <path d={`M${x(i)},${y - 6} V${y + 6}`} className={i <= stage ? "io-tick io-tick-on" : "io-tick"} />
                    <text x={x(i)} y={y + 26} textAnchor="middle" className={`io-t-label${i === stage ? " io-t-on" : ""}`}>{s.op}</text>
                  </g>
                ))}
                <g className="io-handle" style={{ transform: `translateX(${x(stage)}px)` }}>
                  <path d={`M0,${y} L-7,${y - 14} H7 Z`} className="io-handle-mark" />
                </g>
                <text x={Math.min(Math.max(x(stage), compact ? 60 : 80), L.w - (compact ? 60 : 80))} y={y - 26} textAnchor="middle" className="io-t-display io-t-sm">
                  {step.label.toUpperCase()}
                </text>
              </svg>
            );
          })}
        </div>
        <div id={id} className={`io-invoice${invoiced ? " io-invoice-on" : ""}`}>
          <p className="mk-label">{HANDLES_STAGES.invoice}</p>
          <p className="mk-mono mt-1 text-[0.9375rem] font-medium">{invoiceText}</p>
        </div>
      </div>
    </Cell>
  );
}

/** The section's three drawings on one asymmetric sheet grid, labelled once as an illustration with example values. */
export default function InkOrbitFeatures() {
  const reduced = useReducedMotion();
  return (
    <div className="io-grid">
      <FlowDrawing reduced={reduced} />
      <ScheduleDrawing reduced={reduced} />
      <StagesDrawing reduced={reduced} />
      <p className="io-illustration mk-label">{ILLUSTRATION_LABEL}</p>
    </div>
  );
}
