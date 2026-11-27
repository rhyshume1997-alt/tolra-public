/**
 * BOUNDARY (Tooly, scripted tours). Inputs: the tour's step index and replay flag. Output: the same pair kept in this tab's sessionStorage and read back
 * after a full document load. Why: a tour step on /settings (and the step after it) crosses the Settings CSP boundary, which reloads the page
 * (components/security/settings-csp-boundary.tsx); without this the tour would start again at step 1.
 * Must not change: tab-only (sessionStorage), no network, no account data; cleared when the tour closes; a bad value reads as "nothing saved".
 */
import { consumeBoundaryReload } from "@/lib/full-document-load";

const KEY = "tooly-tour-resume";

export type TourResume = { index: number; replay: boolean };

/** Only right after the Settings CSP boundary's own reload (consumeBoundaryReload); any other visit starts normally. */
export function readTourResume(storage: Pick<Storage, "getItem"> | null = typeof window === "undefined" ? null : safe(() => window.sessionStorage), consume: () => boolean = consumeBoundaryReload): TourResume | null {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw || !consume()) return null;
    const v = JSON.parse(raw) as Partial<TourResume>;
    return Number.isInteger(v.index) && (v.index as number) >= 0 && (v.index as number) < 1000 ? { index: v.index as number, replay: v.replay === true } : null;
  } catch {
    return null;
  }
}

export function writeTourResume(resume: TourResume | null, storage: Pick<Storage, "setItem" | "removeItem"> | null = typeof window === "undefined" ? null : safe(() => window.sessionStorage)): void {
  try {
    if (!storage) return;
    if (resume) storage.setItem(KEY, JSON.stringify(resume));
    else storage.removeItem(KEY);
  } catch {
    // Storage unavailable: the tour still works for this page load.
  }
}

function safe<T>(get: () => T): T | null {
  try { return get(); } catch { return null; }
}
