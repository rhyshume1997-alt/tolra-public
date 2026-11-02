"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { FLOW_STEPS } from "@/lib/marketing";

const ADVANCE_MS = 6000;

/** One small mock panel per step. Everything in them is made-up demo data. */
function MockPanel({ step }: { step: (typeof FLOW_STEPS)[number]["id"] }) {
  const row = "flex items-center justify-between gap-3 border-b border-slate-200 py-2 text-sm last:border-0";
  const label = "text-slate-600";
  const value = "font-medium text-[#0b2a5b]";
  switch (step) {
    case "enquiry":
      return (
        <div>
          <div className={row}><span className={label}>From</span><span className={value}>Example Plant Co</span></div>
          <div className={row}><span className={label}>Subject</span><span className={value}>Mounting brackets, 20 off</span></div>
          <div className={row}><span className={label}>Attached</span><span className={value}>bracket-rev-b.pdf</span></div>
          <div className={row}><span className={label}>Status</span><span className="rounded-full bg-[#dcebff] px-2.5 py-0.5 text-xs font-semibold text-[#0b2a5b]">New enquiry</span></div>
        </div>
      );
    case "quote":
      return (
        <div>
          <div className={row}><span className={label}>Quote</span><span className={value}>Q-0001</span></div>
          <div className={row}><span className={label}>Laser cut and fold</span><span className={value}>20 off</span></div>
          <div className={row}><span className={label}>Materials</span><span className={value}>S355 plate, 6 mm</span></div>
          <div className={row}><span className={label}>VAT and terms</span><span className={value}>From your template</span></div>
        </div>
      );
    case "po":
      return (
        <div>
          <div className={row}><span className={label}>Customer PO</span><span className={value}>PO-DEMO-01</span></div>
          <div className={row}><span className={label}>Matches</span><span className={value}>Quote Q-0001</span></div>
          <div className={row}><span className={label}>Status</span><span className="rounded-full bg-[#dcf5e6] px-2.5 py-0.5 text-xs font-semibold text-[#0a5a31]">Order confirmed</span></div>
        </div>
      );
    case "worksheet":
      return (
        <div>
          <div className={row}><span className={label}>Job</span><span className={value}>J-0001 Mounting bracket</span></div>
          <div className={row}><span className={label}>Drawing</span><span className={value}>bracket-rev-b.pdf</span></div>
          <div className={row}><span className={label}>1 Laser cut</span><span className={value}>Laser 1</span></div>
          <div className={row}><span className={label}>2 Fold</span><span className={value}>Press brake</span></div>
        </div>
      );
    case "schedule":
      return (
        <div className="space-y-2 text-sm" aria-label="Machine schedule, demo">
          {[["Laser 1", "J-0001 Brackets", "w-3/5 bg-[#0b2a5b] text-white"], ["Press brake", "J-0001 Fold", "ml-[30%] w-2/5 bg-[#0b2a5b] text-white"], ["Mill 1", "Free", "w-full border border-dashed border-[#1e8fff] bg-slate-50 text-slate-700"]].map(([machine, job, bar]) => (
            <div key={machine} className="grid grid-cols-[5.5rem_1fr] items-center gap-3">
              <span className={label}>{machine}</span>
              <div className="h-8 rounded bg-slate-100"><div className={`flex h-8 items-center rounded px-2 text-xs font-semibold ${bar}`}>{job}</div></div>
            </div>
          ))}
        </div>
      );
    case "signoff":
      return (
        <div>
          <div className={row}><span className={label}>Job</span><span className={value}>J-0001 Mounting bracket</span></div>
          <div className={row}><span className={label}>Checked by</span><span className={value}>Demo operator</span></div>
          <div className={row}><span className={label}>Status</span><span className="rounded-full bg-[#dcf5e6] px-2.5 py-0.5 text-xs font-semibold text-[#0a5a31]">Signed off</span></div>
        </div>
      );
    case "invoice":
      return (
        <div>
          <div className={row}><span className={label}>Invoice</span><span className={value}>INV-0001 (draft)</span></div>
          <div className={row}><span className={label}>From job</span><span className={value}>J-0001</span></div>
          <div className={row}><span className={label}>Status</span><span className="rounded-full bg-[#fff1d1] px-2.5 py-0.5 text-xs font-semibold text-[#6b4300]">Waiting for your approval</span></div>
        </div>
      );
  }
}

/**
 * The job flow, as ARIA tabs (roving tabindex; arrows, Home and End). It steps on by itself, but only for someone who has not asked
 * for reduced motion, and never while the pointer or focus is inside it. Under the md breakpoint the tabs stack as a vertical stepper.
 */
export function JobFlow() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(true); // off until the browser says motion is fine (also the server render)
  const [vertical, setVertical] = useState(false);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const count = FLOW_STEPS.length;

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const narrow = window.matchMedia("(max-width: 767px)");
    const sync = () => { setReduced(motion.matches); setVertical(narrow.matches); };
    sync();
    motion.addEventListener("change", sync);
    narrow.addEventListener("change", sync);
    return () => { motion.removeEventListener("change", sync); narrow.removeEventListener("change", sync); };
  }, []);

  useEffect(() => {
    if (reduced || paused) return;
    const timer = window.setInterval(() => setActive((current) => (current + 1) % count), ADVANCE_MS);
    return () => window.clearInterval(timer);
  }, [reduced, paused, count, active]);

  const select = useCallback((index: number, moveFocus: boolean) => {
    setActive(index);
    if (moveFocus) tabs.current[index]?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next: Record<string, number> = {
      ArrowRight: (active + 1) % count,
      ArrowDown: (active + 1) % count,
      ArrowLeft: (active - 1 + count) % count,
      ArrowUp: (active - 1 + count) % count,
      Home: 0,
      End: count - 1,
    };
    if (!(event.key in next)) return;
    event.preventDefault();
    select(next[event.key], true);
  }

  const step = FLOW_STEPS[active];
  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false); }}
      className="grid gap-6 md:gap-8"
    >
      <div role="tablist" aria-label="From enquiry to invoice" aria-orientation={vertical ? "vertical" : "horizontal"} onKeyDown={onKeyDown}
        className="relative flex flex-col gap-1 md:flex-row md:gap-2">
        {FLOW_STEPS.map((s, index) => {
          const selected = index === active;
          return (
            <button
              key={s.id}
              ref={(node) => { tabs.current[index] = node; }}
              role="tab"
              type="button"
              id={`flow-tab-${s.id}`}
              aria-selected={selected}
              aria-controls="flow-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => select(index, false)}
              className={`flex min-h-12 flex-1 items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0b5fc4] md:flex-col md:justify-center md:text-center ${selected ? "border-[#0b2a5b] bg-[#0b2a5b] text-white" : "border-slate-300 bg-white text-[#0b2a5b] hover:border-[#1e8fff]"}`}
            >
              <span aria-hidden className={`grid size-7 shrink-0 place-items-center rounded-full text-xs ${selected ? "bg-[#1e8fff] text-[#05193a]" : "bg-[#dcebff] text-[#0b2a5b]"}`}>{index + 1}</span>
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id="flow-panel" aria-labelledby={`flow-tab-${step.id}`} tabIndex={0}
        className="grid gap-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0b5fc4] md:grid-cols-2 md:p-7">
        <div>
          <h3 className="text-xl font-bold text-[#0b2a5b]">{step.label}</h3>
          <p className="mt-3 text-base leading-relaxed text-slate-700">{step.caption}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="mb-2 inline-block rounded-full bg-[#0b2a5b] px-2.5 py-0.5 text-xs font-semibold text-white">Demo data</p>
          <MockPanel step={step.id} />
        </div>
      </div>
    </div>
  );
}
