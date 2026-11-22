"use client";

/**
 * BOUNDARY (Tooly, scripted tours): the on-screen tour card for the admin, office and workshop views (the file and export keep their first
 * name because the shell mounts <AdminTour envOn />, which is not changed here). Mounted by the shell.
 * Inputs: `envOn` (the server flag as a boolean), the signed-in person (lib/use-user), the company's hidden_nav (lib/org-settings), the
 * saved "done" flag (lib/auth/tour-flag). Outputs: a small card and a ring around the thing being pointed at; on Stop or Finish it saves
 * the done flag. It renders nothing unless the env flag and the company marker for the person's view (admin, office or workshop) both
 * agree and the tour is not done; a viewer never sees one.
 * It POINTS only: the ring ignores the mouse, no app button is ever pressed, no dialog is opened, no form is touched. Moving to the
 * next page is plain navigation. It works with AI off and calls no API.
 * Must not change: the "points, never clicks" rule, the off-by-default gate (tour-switch.ts), or that all 23 steps are mandatory
 * (only Back, Next and Stop are offered; there is no skip for one step).
 */
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { type PlannedStep, planTour } from "@/components/tooly/tour/tour-plan";
import { toolyTourEnabledFor } from "@/components/tooly/tour/tour-switch";
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

function useTargetBox(planned: PlannedStep | undefined, pathname: string): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    setBox(null);
    if (!planned || planned.route !== pathname || planned.target.kind === "none") return;
    const target = planned.target;
    let tries = 0;
    const measure = () => {
      const el = findTourTarget(document, target);
      if (!el) return false;
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
  }, [planned, pathname]);
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

  const enabled = toolyTourEnabledFor({ envOn, hiddenNav, role: activeRole });
  const done = !user || isTourDone(user.id, user.user_metadata);
  const plan = useMemo(
    () => (enabled ? planTour({ activeRole, hiddenSections, hiddenNav, phone: !wide }) : []),
    [enabled, activeRole, hiddenSections, hiddenNav, wide],
  );
  const planned = plan[Math.min(index, Math.max(plan.length - 1, 0))];
  const active = enabled && !done && !closed && plan.length > 0;
  const box = useTargetBox(active ? planned : undefined, pathname);

  // Moving to the step's page is navigation only.
  useEffect(() => {
    if (active && planned && planned.route !== pathname) router.push(planned.route);
  }, [active, planned, pathname, router]);

  if (!active || !planned) return null;

  const last = index >= plan.length - 1;
  const finish = () => {
    setClosed(true);
    void markTourDone(supabase, user?.id);
  };

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
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} className="rounded-md border px-3 py-1.5 text-xs text-slate-600 disabled:opacity-40" data-testid="tooly-tour-back">Back</button>
          <button type="button" onClick={last ? finish : () => setIndex((i) => i + 1)} className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-hover" data-testid="tooly-tour-next">{last ? "Finish" : "Next"}</button>
          <button type="button" onClick={finish} className="ml-auto rounded-md border px-3 py-1.5 text-xs text-slate-600" data-testid="tooly-tour-stop">Stop tour</button>
        </div>
      </div>
    </div>
  );
}
