"use client";

import { useEffect, useRef } from "react";

import { DocSheet } from "@/components/marketing/tooly-props";
import { useToolyGuide } from "@/components/marketing/tooly-guide-state";
import { FLOW_JOB, FLOW_TITLE, ILLUSTRATION_LABEL, SEE_HOW_LABEL } from "@/lib/marketing";
import { GUIDE_LABELS, MENU_STAGES } from "@/lib/marketing/tooly-guide";

// Inputs: the shared guide state (tooly-guide-state.tsx) and the stage list in lib/marketing/tooly-guide.ts (MENU_STAGES = FLOW_STEPS).
// Output: the "Job stages" button in the header and the panel it opens at the top right. The panel lists the real stages with their stamps.
// On the first visit of a session (wide screens, motion allowed) Tooly (his own spanner and bolt are in the frames) pulls the panel down in three notches and the
// example document J-0001 goes down the stages, stamping each; after that the button opens the same list as a plain, still panel.
// Must not change: the button is a real disclosure (aria-expanded, Escape and an outside click close it, nothing traps focus); the panel is a
// plain list (readable without the show: every stamp is in the text); the example carries its Illustration label; the show animates
// transform and opacity only and is entirely off for reduced motion; the stages are never a second list.

const SCENE_PHASES = ["drop", "land", "pull", "carry", "cheer", "lift"];

export function ToolyMenu() {
  const g = useToolyGuide();
  const button = useRef<HTMLButtonElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const scene = Boolean(g && g.stage && SCENE_PHASES.includes(g.intro.phase));
  const open = Boolean(g?.menuOpen);
  const visible = scene || open;
  const intro = g?.intro;
  const close = g?.setMenuOpen;

  useEffect(() => {
    if (!open || !close) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { close(false); button.current?.focus(); } };
    const onDown = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) close(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onDown); };
  }, [open, close]);

  return (
    <div ref={root} className="tm-root" data-tg>
      <button
        ref={button}
        type="button"
        className="tm-launch mk-link"
        aria-expanded={visible}
        aria-controls="tm-panel"
        onClick={() => { if (scene) g?.skip(); g?.setMenuOpen(!open && !scene); }}
      >
        {GUIDE_LABELS.menu}
      </button>
      {visible && intro ? (
        <div className="tm-stage" data-scene={scene} data-notch={intro.notch} data-phase={intro.phase} data-swing={intro.swing % 2 ? "b" : "a"}>
          <div className="tm-window">
            <div id="tm-panel" className="tm-panel" role="group" aria-label={FLOW_TITLE}>
              <div className="tm-head">
                <span className="tm-no mk-mono">{FLOW_JOB.number}</span>
                <span className="mk-label">{ILLUSTRATION_LABEL}</span>
              </div>
              <ol className="tm-rows">
                {MENU_STAGES.map((stage, i) => (
                  <li key={stage.id} className="tm-row" data-current={scene && intro.row === i}>
                    <span aria-hidden className="tm-lane" />
                    <span className="tm-op mk-mono">{stage.op}</span>
                    <span className="tm-label mk-display">{stage.label}</span>
                    <span className="tm-stamp mk-mono" data-on={!scene || intro.stamped > i}>{stage.stamp}</span>
                  </li>
                ))}
              </ol>
              {scene ? (
                <>
                  <span aria-hidden className="tm-doc" data-on={intro.row >= 0} style={{ transform: `translateY(${Math.max(0, intro.row) * 40}px)` }}><DocSheet /></span>
                  <span aria-hidden className="tm-deck" />
                  <span aria-hidden className="tm-cable" />
                  <span aria-hidden className="tm-floor" data-tm-floor />
                </>
              ) : (
                <p className="tm-foot"><a href="#flow-title" className="mk-link" onClick={() => close?.(false)}>{SEE_HOW_LABEL}</a></p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
