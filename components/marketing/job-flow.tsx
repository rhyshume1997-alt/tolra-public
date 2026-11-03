"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { FLOW_HINT, FLOW_JOB, FLOW_STEPS, FLOW_TITLE, ILLUSTRATION_LABEL, SHEET_LABELS } from "@/lib/marketing";

const COUNT = FLOW_STEPS.length;
const FIRST_STAMP_MS = 350;
const STAMP_EVERY_MS = 420;

/**
 * The job traveller: one example job (J-0001) with an operation row per stage, each with a stamp box. When the traveller comes into
 * view the stages are stamped one after another; selecting a stage (click, tap or arrow keys) stamps it and every stage before it, and
 * shows what happens at it below. Someone who asks for reduced motion sees every stamp at once and nothing moves (the CSS shows all
 * stamps too, so this holds before the script runs).
 *
 * The rows are ARIA tabs (roving tabindex; arrows, Home and End) controlling one tab panel.
 */
export function JobFlow() {
  const [active, setActive] = useState(0);
  // The server render shows no stamps; the CSS shows every stamp for reduced motion, and the script stamps them in for everyone else.
  const [stamped, setStamped] = useState(0);
  const [animate, setAnimate] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches) {
      setStamped(COUNT);
      return;
    }
    setAnimate(true);
    const node = root.current;
    const timers: number[] = [];
    const run = () => {
      for (let i = 1; i <= COUNT; i += 1) {
        timers.push(window.setTimeout(() => setStamped((current) => Math.max(current, i)), FIRST_STAMP_MS + (i - 1) * STAMP_EVERY_MS));
      }
    };
    if (!node || typeof IntersectionObserver === "undefined") {
      run();
      return () => timers.forEach((timer) => window.clearTimeout(timer));
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        run();
      }
    }, { rootMargin: "0px 0px -30% 0px" }); // once its top is well inside the window, however tall the traveller is

    observer.observe(node);
    return () => {
      observer.disconnect();
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const select = useCallback((index: number, moveFocus: boolean) => {
    setActive(index);
    setStamped((current) => Math.max(current, index + 1));
    if (moveFocus) tabs.current[index]?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next: Record<string, number> = {
      ArrowDown: (active + 1) % COUNT,
      ArrowRight: (active + 1) % COUNT,
      ArrowUp: (active - 1 + COUNT) % COUNT,
      ArrowLeft: (active - 1 + COUNT) % COUNT,
      Home: 0,
      End: COUNT - 1,
    };
    if (!(event.key in next)) return;
    event.preventDefault();
    select(next[event.key], true);
  }

  const step = FLOW_STEPS[active];
  return (
    <div ref={root} className="border border-[#0b2a5b] bg-white">
      <div className="flex items-start justify-between gap-4 border-b border-[#0b2a5b] px-4 py-3">
        <h2 id="flow-title" className="mk-display scroll-mt-24 text-[1.625rem] uppercase sm:text-[1.875rem]">{FLOW_TITLE}</h2>
        <p className="shrink-0 pt-1 text-right">
          <span className="mk-mono block text-base font-medium">{FLOW_JOB.number}</span>
          <span className="mk-label block">{ILLUSTRATION_LABEL}</span>
        </p>
      </div>
      <dl className="grid grid-cols-[1.3fr_1.3fr_0.8fr] border-b border-[#0b2a5b]">
        {FLOW_JOB.fields.map(([label, value]) => (
          <div key={label} className="min-w-0 border-r border-[#0b2a5b]/30 px-4 py-2 last:border-r-0">
            <dt className="mk-label">{label}</dt>
            <dd className="text-[0.9375rem] leading-snug">{value}</dd>
          </div>
        ))}
      </dl>

      <div aria-hidden className="mk-label grid grid-cols-[3rem_1fr_6.75rem] border-b border-[#0b2a5b]/30 px-0 py-1.5">
        <span className="pl-4">{SHEET_LABELS.op}</span>
        <span>{SHEET_LABELS.stage}</span>
        <span className="pr-4 text-right">{SHEET_LABELS.stamp}</span>
      </div>
      <div role="tablist" aria-label={FLOW_TITLE} aria-orientation="vertical" onKeyDown={onKeyDown}>
        {FLOW_STEPS.map((s, index) => {
          const selected = index === active;
          const isStamped = index < stamped;
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
              className={`grid min-h-12 w-full grid-cols-[3rem_1fr_6.75rem] items-center border-b border-[#0b2a5b]/30 text-left focus-visible:outline-offset-[-3px] ${selected ? "bg-[#e7f2ff]" : "hover:bg-[#f3f6fa]"}`}
            >
              <span className={`mk-mono flex h-full items-center pl-4 text-sm ${selected ? "font-medium text-[#05193a]" : "text-[#3c5277]"}`}>
                <span className={selected ? "border-b-2 border-[#1e8fff]" : ""}>{s.op}</span>
              </span>
              <span className="mk-display text-[1.3125rem] font-semibold">{s.label}</span>
              <span className="flex justify-end pr-3">
                <span className="mk-stampbox" data-stamped={isStamped} data-fresh={animate}>
                  <span className="mk-stamp">
                    <span>{s.stamp}</span>
                    <span>{s.date}</span>
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id="flow-panel" aria-labelledby={`flow-tab-${step.id}`} tabIndex={0} className="grid gap-3 px-4 py-4">
        <div>
          <p className="mk-label">{SHEET_LABELS.op} {step.op}: {step.label}</p>
          <p className="mt-1.5 text-[0.9375rem] leading-relaxed">{step.caption}</p>
        </div>
        <dl className="self-start border-t border-[#0b2a5b]/30 text-sm">
          {step.record.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-3 border-b border-[#0b2a5b]/30 py-1.5">
              <dt className="text-[#3c5277]">{label}</dt>
              <dd className="mk-mono text-right font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="border-t border-[#0b2a5b]/30 px-4 py-2 text-sm text-[#3c5277]">{FLOW_HINT}</p>
    </div>
  );
}
