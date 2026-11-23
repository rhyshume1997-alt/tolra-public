"use client";

import { useEffect, useRef } from "react";

import { useToolyGuide } from "@/components/marketing/tooly-guide-state";
import { FLOW_JOB, FLOW_TITLE, ILLUSTRATION_LABEL, SEE_HOW_LABEL } from "@/lib/marketing";
import { GUIDE_LABELS, MENU_STAGES } from "@/lib/marketing/tooly-guide";

// Inputs: the shared guide state (tooly-guide-state.tsx) and the stage list in lib/marketing/tooly-guide.ts (MENU_STAGES = FLOW_STEPS).
// Output: in the header, the "Job stages" button and the panel it opens at the top right (the real stages with their stamps, as plain text; opening
// it also plays the spanner scene in the caption strip, where the same stages are stamped in order), and,
// while Tooly is hidden, the "Show Tooly" button (so nothing floats over the page to bring him back).
// Must not change: the panel opens only when the person presses the button (an owner-opened menu may lie over the page like any menu), and
// closes with Escape or a click outside; nothing traps focus; the button is a real disclosure (aria-expanded); the example carries its
// Illustration label; the stages are never a second list; nothing moves for reduced motion (nothing here animates).

export function ToolyMenu() {
  const g = useToolyGuide();
  const button = useRef<HTMLButtonElement | null>(null);
  const show = useRef<HTMLButtonElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const open = Boolean(g?.menuOpen);
  const close = g?.setMenuOpen;
  const hidden = Boolean(g?.hidden);

  useEffect(() => {
    if (!open || !close) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { close(false); button.current?.focus(); } };
    const onDown = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) close(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onDown); };
  }, [open, close]);

  // After Hide Tooly the keyboard lands on Show Tooly, so it never loses its place.
  const wasHidden = useRef(false);
  useEffect(() => { if (hidden && !wasHidden.current) show.current?.focus(); wasHidden.current = hidden; }, [hidden]);

  return (
    <div ref={root} className="tm-root" data-tg>
      {hidden ? (
        <button ref={show} type="button" className="tm-launch mk-link" onClick={() => g?.setHidden(false)}>{GUIDE_LABELS.show}</button>
      ) : null}
      <button
        ref={button}
        type="button"
        className="tm-launch mk-link"
        aria-expanded={open}
        aria-controls="tm-panel"
        onClick={() => { g?.setMenuOpen(!open); if (!open) g?.replay(); }}
      >
        {GUIDE_LABELS.menu}
      </button>
      {open ? (
        <div className="tm-stage">
          <div id="tm-panel" className="tm-panel" role="group" aria-label={FLOW_TITLE}>
            <div className="tm-head">
              <span className="tm-no mk-mono">{FLOW_JOB.number}</span>
              <span className="mk-label">{ILLUSTRATION_LABEL}</span>
            </div>
            <ol className="tm-rows">
              {MENU_STAGES.map((stage) => (
                <li key={stage.id} className="tm-row">
                  <span aria-hidden className="tm-lane" />
                  <span className="tm-op mk-mono">{stage.op}</span>
                  <span className="tm-label mk-display">{stage.label}</span>
                  <span className="tm-stamp mk-mono" data-on="true">{stage.stamp}</span>
                </li>
              ))}
            </ol>
            <p className="tm-foot"><a href="#flow-title" className="mk-link" onClick={() => close?.(false)}>{SEE_HOW_LABEL}</a></p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
