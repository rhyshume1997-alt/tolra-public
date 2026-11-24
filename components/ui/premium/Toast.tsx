"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: ToastProvider wraps a page; useToast() gives show({title, detail?, tone}) and clear().
 * Output: ONE neutral toast layer at a time (a new message replaces the old one, nothing stacks, nothing lingers across a state change
 * because the caller can clear()). White card, 3 px navy bar; tone "error" uses a red bar and role="alert" and stays until dismissed.
 * Info auto-dismisses after 5 s, and pauses while hovered or focused. Placed below the top bar (top 76 px) so shell controls stay reachable.
 * v2: ToastProvider takes placement ("top-right" default | "bottom-right" | "bottom-left" | "bottom-centre") and offset (px from the top edge, or from the bottom edge for bottom
 * placements; defaults 76 and 16) so a page can park the layer where it covers no header button (Log out, the bell, New quote). Still one layer, still never stacked.
 * v4: the toast slides and fades in (160 ms) and out (120 ms) by transition (data-state), so replacing or dismissing one mid-way never snaps; a new message replaces the old at once.
 * Must not change: there is no green success tone on purpose. Callers must never use a toast to say something saved when nothing was saved.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";
import { EXIT_MS, useEntered } from "./usePresence";

export interface ToastInput { title: string; detail?: string; tone?: "info" | "error" }
interface ToastState extends ToastInput { id: number }
interface ToastApi { show: (t: ToastInput) => void; clear: () => void }

const ToastContext = createContext<ToastApi | null>(null);

export const TOAST_MS = 5000;

export type ToastPlacement = "top-right" | "bottom-right" | "bottom-left" | "bottom-centre";

/** Pure: the inline position for the toast layer. Top placements move `top`; bottom placements move `bottom`. No offset keeps the stylesheet defaults. */
export function toastRegionStyle(placement: ToastPlacement, offset?: number): { top?: number; bottom?: number } | undefined {
  if (offset === undefined) return undefined;
  return placement.startsWith("bottom") ? { bottom: offset } : { top: offset };
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast needs a ToastProvider above it.");
  return api;
}

export function ToastProvider({ children, placement = "top-right", offset }: { children: ReactNode; placement?: ToastPlacement; offset?: number }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [leaving, setLeaving] = useState<ToastState | null>(null);
  const [mounted, setMounted] = useState(false);
  const [paused, setPaused] = useState(false);
  const seq = useRef(0);
  useEffect(() => { setMounted(true); }, []);

  const show = useCallback((t: ToastInput) => { seq.current += 1; setPaused(false); setToast({ ...t, id: seq.current }); }, []);
  const clear = useCallback(() => setToast(null), []);
  const api = useMemo<ToastApi>(() => ({ show, clear }), [show, clear]);

  // keep the last message on screen for the exit transition
  useEffect(() => {
    if (toast) { setLeaving(toast); return; }
    const t = setTimeout(() => setLeaving(null), EXIT_MS);
    return () => clearTimeout(t);
  }, [toast]);
  const shown = toast ?? leaving;
  const entered = useEntered(!!toast, toast?.id);

  useEffect(() => {
    if (!toast || toast.tone === "error" || paused) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast, paused]);

  const region = (
    <div
      className={cx(premiumTokens, styles.toastRegion, placement.startsWith("bottom") && styles.toastBottom, placement === "bottom-left" && styles.toastLeft, placement === "bottom-centre" && styles.toastCentre)}
      style={toastRegionStyle(placement, offset)}
      data-placement={placement}
      aria-live="polite"
      aria-atomic="true"
    >
      {shown ? (
        <div
          key={shown.id}
          data-state={toast && entered ? "open" : "closed"}
          className={cx(styles.toast, shown.tone === "error" && styles.toastError)}
          role={shown.tone === "error" ? "alert" : undefined}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
        >
          <div className={styles.toastText}>
            <p className={styles.toastTitle}>{shown.title}</p>
            {shown.detail ? <p className={styles.toastDetail}>{shown.detail}</p> : null}
          </div>
          <button type="button" className={styles.toastClose} aria-label="Dismiss message" onClick={clear}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
      ) : null}
    </div>
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      {mounted ? createPortal(region, document.body) : null}
    </ToastContext.Provider>
  );
}
