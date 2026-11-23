"use client";

/**
 * BOUNDARY (Tooly, game-style tour): the full-screen look of one tour step: the page dimmed, a spotlight cut-out around the thing to look
 * at, Tooly and a speech bubble with the step's words, its note and the buttons. Shown by admin-tour.tsx only when the company's
 * game marker is on (tour-switch.ts). Presentational only.
 * Inputs: the step's text, number, pose and note, the measured box of the target (viewport pixels) or null, whether it is a phone, and
 * the Back, Next, Skip and note callbacks. Outputs: markup. No I/O, no storage, no navigation, no AI.
 * The dim layer covers the whole screen and takes the mouse, so a click on the page behind lands on the layer and does nothing. Nothing
 * on the page is pressed, saved or sent; the only buttons are Tooly's own. Keys: Right arrow = Next, Left arrow = Back, Escape = Skip.
 * Motion is CSS only and switched off for people who ask for reduced motion.
 * Must not change: the "points, never clicks" rule, z-[60] (above dialogs z-50 and the float z-40), or the data-testids the tests use.
 */
import { useEffect, useRef } from "react";

import { ToolyFace } from "@/components/tooly/tooly-face";
import type { ToolyPose } from "@/components/tooly/poses";
import type { TourNote } from "@/components/tooly/tour/tour-notes";

export type StageBox = { top: number; left: number; width: number; height: number };

export type TourStageProps = {
  number: number;
  of: number;
  text: string;
  pose: ToolyPose;
  box: StageBox | null;
  phone: boolean;
  note: TourNote | null;
  noteOpen: boolean;
  canBack: boolean;
  last: boolean;
  onToggleNote: () => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
};

const PAD = 8;

/** The bubble sits at the top when the thing to look at is in the lower half of the screen, else at the bottom, so it never covers it. */
export function bubbleAtTop(box: StageBox | null, viewportHeight: number): boolean {
  return box !== null && box.top + box.height / 2 > viewportHeight / 2;
}

export function TourStage(props: TourStageProps) {
  const { number, of, text, pose, box, phone, note, noteOpen, canBack, last, onToggleNote, onBack, onNext, onSkip } = props;
  const nextRef = useRef<HTMLButtonElement>(null);
  const top = bubbleAtTop(box, typeof window === "undefined" ? 800 : window.innerHeight);

  useEffect(() => { nextRef.current?.focus(); }, [number]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSkip();
      else if (e.key === "ArrowRight") onNext();
      else if (e.key === "ArrowLeft" && canBack) onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canBack, onBack, onNext, onSkip]);

  return (
    <div className="print:hidden fixed inset-0 z-[60]" data-testid="tooly-tour" data-mode="game" data-step={number}>
      {box ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed rounded-xl ring-4 ring-brand shadow-[0_0_0_9999px_rgba(15,23,42,0.7)] transition-[top,left,width,height] duration-300 motion-reduce:transition-none"
          style={{ top: box.top - PAD, left: box.left - PAD, width: box.width + PAD * 2, height: box.height + PAD * 2 }}
          data-testid="tooly-tour-spotlight"
        />
      ) : (
        <div aria-hidden="true" className="absolute inset-0 bg-slate-900/70" data-testid="tooly-tour-dim" />
      )}
      <div
        key={number}
        role="dialog"
        aria-modal="true"
        aria-label="Tooly tour"
        aria-live="polite"
        data-testid="tooly-tour-bubble"
        data-position={top ? "top" : "bottom"}
        className={`animate-in fade-in slide-in-from-bottom-4 duration-300 motion-reduce:animate-none fixed inset-x-3 flex items-end gap-2 sm:inset-x-auto sm:right-6 sm:w-[32rem] ${top ? "top-4" : "bottom-4"}`}
      >
        <div className="animate-in zoom-in duration-300 motion-reduce:animate-none shrink-0">
          <ToolyFace pose={pose} size={phone ? 56 : 112} />
        </div>
        <div className="relative min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-2xl">
          <p className="text-xs font-medium text-slate-500" data-testid="tooly-tour-count">{`Step ${number} of ${of}`}</p>
          <p className="mt-1 text-slate-900" data-testid="tooly-tour-text">{text}</p>
          {note ? (
            <div className="mt-2">
              <button type="button" onClick={onToggleNote} aria-expanded={noteOpen} className="text-xs font-medium text-brand underline" data-testid="tooly-tour-note-toggle">{noteOpen ? "Hide the note" : "What happens here and how it gets produced"}</button>
              {noteOpen ? (
                <div className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded-md bg-slate-50 p-2 text-xs text-slate-700" data-testid="tooly-tour-note">
                  <p><span className="font-medium">What happens here: </span>{note.happens}</p>
                  <p><span className="font-medium">How it gets produced: </span>{note.produced}</p>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={onBack} disabled={!canBack} className="rounded-md border px-3 py-1.5 text-xs text-slate-600 disabled:opacity-40" data-testid="tooly-tour-back">Back</button>
            <button ref={nextRef} type="button" onClick={onNext} className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-hover" data-testid="tooly-tour-next">{last ? "Finish" : "Next"}</button>
            <button type="button" onClick={onSkip} className="ml-auto rounded-md border px-3 py-1.5 text-xs text-slate-600" data-testid="tooly-tour-stop">Skip tour</button>
          </div>
        </div>
      </div>
    </div>
  );
}
