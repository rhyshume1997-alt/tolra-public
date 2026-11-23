"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW v4). Inputs: usePresence(open, exitMs): keeps something mounted for exitMs after open turns false; useEntered(active, key): true one painted frame after it mounted
 * (so a CSS transition has a closed state to start from); useModalPresence(open, exitMs): the same for a native dialog (content stays while it leaves, data-state closed or open).
 * Output: the three booleans and the data-state string that premium.module.css transitions on (opacity and transform, enter 160 to 240 ms, exit 120 ms: exits are faster than entrances).
 * Must not change: no animation library, no layout reads, nothing leaves the folder. Under prefers-reduced-motion the CSS removes the movement and keeps a short fade; this file does not need to know.
 */
import { useEffect, useState } from "react";

/** Time an exit takes (CSS token --ui-t-exit is 120 ms; keep the two equal). */
export const EXIT_MS = 120;

/** True while `open`, and for `exitMs` after it turns false (so the exit transition can finish before the node unmounts). */
export function usePresence(open: boolean, exitMs: number = EXIT_MS): boolean {
  const [present, setPresent] = useState(false);
  useEffect(() => {
    if (open) { setPresent(true); return; }
    const t = setTimeout(() => setPresent(false), exitMs);
    return () => clearTimeout(t);
  }, [open, exitMs]);
  return open || present;
}

/** True once the node has been painted in its closed state for `key` (two animation frames after it became active). Resets when `active` or `key` changes. */
export function useEntered(active: boolean, key: unknown = 0): boolean {
  const [done, setDone] = useState<unknown>(undefined);
  useEffect(() => {
    if (!active) { setDone(undefined); return; }
    let r2 = 0;
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setDone(key)); });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  }, [active, key]);
  return active && done === key;
}

/** For a native dialog: `shown` is true while open and until the exit has finished (render the content while shown); `state` is "open" only once entered and while open. */
export function useModalPresence(open: boolean, exitMs: number = EXIT_MS): { shown: boolean; state: "open" | "closed" } {
  const shown = usePresence(open, exitMs);
  const entered = useEntered(open);
  return { shown, state: open && entered ? "open" : "closed" };
}
