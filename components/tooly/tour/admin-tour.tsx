"use client";

/**
 * BOUNDARY (Tooly, scripted tours): the on-screen tour card for the admin, office and workshop views (the file and export keep their first
 * name because the shell mounts <AdminTour envOn />, which is not changed here). Mounted by the shell.
 * Inputs: `envOn` (the server flag as a boolean), the signed-in person (lib/use-user), the company's hidden_nav (lib/org-settings), the
 * saved "done" flag (lib/auth/tour-flag). Outputs: a small card and a ring around the thing being pointed at; on Skip or Finish it saves
 * the done flag. It renders nothing unless the env flag and the company marker for the person's view (admin, office or workshop) both
 * agree; a viewer never sees one. It opens by itself until the person has seen it once (the done flag, saved per person), and each step has
 * a note the person can open ("What happens here and how it gets produced", tour-notes.ts). "Skip tour" closes it and saves the same
 * flag. Once seen, a small "Replay tour" button shows on the Dashboard only; replaying starts at step 1 and saves the flag again.
 * It POINTS only: the ring ignores the mouse, no app button is ever pressed, no dialog is opened, no form is touched. Moving to the
 * next page is plain navigation. It works with AI off and calls no API.
 * Game look: when the company's third marker (tooly-game-tour:on) is also on, the same steps, notes, Skip and Replay are shown by
 * tour-stage.tsx (full-screen dim, spotlight, Tooly and a speech bubble) instead of the small card; the target is scrolled into view
 * (scrolling only). Without that marker the small card is used, unchanged.
 * Must not change: the "points, never clicks" rule, the off-by-default gate (tour-switch.ts), or that all 23 steps are mandatory
 * (Back, Next, the note toggle and Skip tour are offered; there is no skipping a single step). The Replay button lives here, never in
 * the float, the sidebar or the middleware.
 */
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { type PlannedStep, planTour } from "@/components/tooly/tour/tour-plan";
import { tourNoteFor } from "@/components/tooly/tour/tour-notes";
import { poseForStep } from "@/components/tooly/tour/tour-poses";
import { TourStage } from "@/components/tooly/tour/tour-stage";
import { toolyGameTourOn, toolyTourEnabledFor } from "@/components/tooly/tour/tour-switch";
import type { TourTarget } from "@/components/tooly/tour/tour-steps";
import { isTourDone, markTourDone } from "@/lib/auth/tour-flag";
import { useOrgSettings } from "@/lib/org-settings";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";
import { useIsWide } from "@/lib/view-mode";

/** The element a target names, or null. Looks only; never clicks or focuses. */
export function findTourTarget(doc: Document, target: TourTarget): Element | null {
  if (target.kind === "css") {
    try {
      return doc.querySelector(target.selector);
    } catch {
      return null;
    }
  }
  if (target.kind === "text") {
    const wanted = target.text.trim().toLowerCase();
    return Array.from(doc.querySelectorAll(target.tag)).find((el) => (el.textContent ?? "").trim().toLowerCase() === wanted) ?? null;
  }
  return null;
}

type Box = { top: number; left: number; width: number; height: number };

function useTargetBox(planned: PlannedStep | undefined, pathname: string, scrollTo: boolean): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    setBox(null);
    if (!planned || planned.route !== pathname || planned.target.kind === "none") return;
    const target = planned.target;
    let tries = 0;
    let scrolled = false;
    const measure = () => {
      const el = findTourTarget(document, target);
      if (!el) return false;
      if (scrollTo && !scrolled) {
        scrolled = true;
        // Scrolling only (never a click or focus). Smooth unless the person asked for reduced motion.
        if (typeof el.scrollIntoView === "function") {
          const calm = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          el.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
        }
      }
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
      return true;
    };
    // The page may still be loading: look for a few seconds, then show the step centred.
    const timer = window.setInterval(() => { tries += 1; if (measure() || tries >= 15) window.clearInterval(timer); }, 200);
    measure();
    const again = () => { measure(); };
    window.addEventListener("resize", again);
    window.addEventListener("scroll", again, true);
    return () => { window.clearInterval(timer); window.removeEventListener("resize", again); window.removeEventListener("scroll", again, true); };
  }, [planned, pathname, scrollTo]);
  return box;
}

export function AdminTour({ envOn }: { envOn: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, activeRole, hiddenSections } = useUser();
  const { hiddenNav } = useOrgSettings();
  const wide = useIsWide();
  const [index, setIndex] = useState(0);
  const [closed, setClosed] = useState(false);
  const [replay, setReplay] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  const enabled = toolyTourEnabledFor({ envOn, hiddenNav, role: activeRole });
  const done = !user || isTourDone(user.id, user.user_metadata);
  const plan = useMemo(
    () => (enabled ? planTour({ activeRole, hiddenSections, hiddenNav, phone: !wide }) : []),
    [enabled, activeRole, hiddenSections, hiddenNav, wide],
  );
  const planned = plan[Math.min(index, Math.max(plan.length - 1, 0))];
  const active = enabled && (!done || replay) && !closed && plan.length > 0;
  const game = toolyGameTourOn(hiddenNav);
  const box = useTargetBox(active ? planned : undefined, pathname, game);

  // Moving to the step's page is navigation only.
  useEffect(() => {
    if (active && planned && planned.route !== pathname) router.push(planned.route);
  }, [active, planned, pathname, router]);

  // The note starts closed on every step.
  useEffect(() => { setNoteOpen(false); }, [index]);

  const startReplay = () => { setIndex(0); setNoteOpen(false); setClosed(false); setReplay(true); };

  if (enabled && done && !active && plan.length > 0 && pathname === "/dashboard") {
    return (
      <button type="button" onClick={startReplay} className="print:hidden fixed bottom-24 left-3 z-40 rounded-md border bg-white px-3 py-1.5 text-xs text-slate-600 shadow" data-testid="tooly-tour-replay">Replay tour</button>
    );
  }
  if (!active || !planned) return null;
  const note = tourNoteFor(planned.step.id);

  const last = index >= plan.length - 1;
  const finish = () => {
    setClosed(true);
    setReplay(false);
    void markTourDone(supabase, user?.id);
  };

  if (game) {
    return (
      <TourStage
        number={planned.number}
        of={planned.of}
        text={planned.text}
        pose={poseForStep(planned.step.id, planned.target.kind !== "none" && !planned.closed)}
        box={box}
        phone={!wide}
        note={note}
        noteOpen={noteOpen}
        canBack={index > 0}
        last={last}
        onToggleNote={() => setNoteOpen((o) => !o)}
        onBack={() => setIndex((i) => Math.max(0, i - 1))}
        onNext={last ? finish : () => setIndex((i) => i + 1)}
        onSkip={finish}
      />
    );
  }

  return (
    <div className="print:hidden" data-testid="tooly-tour" data-step={planned.number}>
      {box ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[60] rounded-lg ring-4 ring-brand ring-offset-2"
          style={{ top: box.top - 4, left: box.left - 4, width: box.width + 8, height: box.height + 8 }}
          data-testid="tooly-tour-ring"
        />
      ) : null}
      <div
        role="region"
        aria-label="Tooly tour"
        aria-live="polite"
        className="fixed inset-x-3 bottom-24 z-[60] rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-xl sm:inset-x-auto sm:right-4 sm:w-96"
      >
        <p className="text-xs font-medium text-slate-500" data-testid="tooly-tour-count">{`Step ${planned.number} of ${planned.of}`}</p>
        <p className="mt-1 text-slate-900" data-testid="tooly-tour-text">{planned.text}</p>
        {note ? (
          <div className="mt-2">
            <button type="button" onClick={() => setNoteOpen((o) => !o)} aria-expanded={noteOpen} className="text-xs font-medium text-brand underline" data-testid="tooly-tour-note-toggle">{noteOpen ? "Hide the note" : "What happens here and how it gets produced"}</button>
            {noteOpen ? (
              <div className="mt-1 space-y-1 rounded-md bg-slate-50 p-2 text-xs text-slate-700" data-testid="tooly-tour-note">
                <p><span className="font-medium">What happens here: </span>{note.happens}</p>
                <p><span className="font-medium">How it gets produced: </span>{note.produced}</p>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} className="rounded-md border px-3 py-1.5 text-xs text-slate-600 disabled:opacity-40" data-testid="tooly-tour-back">Back</button>
          <button type="button" onClick={last ? finish : () => setIndex((i) => i + 1)} className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-hover" data-testid="tooly-tour-next">{last ? "Finish" : "Next"}</button>
          <button type="button" onClick={finish} className="ml-auto rounded-md border px-3 py-1.5 text-xs text-slate-600" data-testid="tooly-tour-stop">Skip tour</button>
        </div>
      </div>
    </div>
  );
}
