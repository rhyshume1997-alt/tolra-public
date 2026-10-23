"use client";

import { useEffect, useState } from "react";

/** Calls `onTick` with the time every `intervalMs`, and at once when the tab becomes visible again (timers are throttled in a hidden tab). Returns the stop function. */
export function startNowTicker(onTick: (now: Date) => void, intervalMs: number, doc?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">): () => void {
  const tick = () => onTick(new Date());
  const timer = setInterval(tick, intervalMs);
  const onVisible = () => { if (doc?.visibilityState === "visible") tick(); };
  doc?.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    doc?.removeEventListener("visibilitychange", onVisible);
  };
}

/** The current time, refreshed every `intervalMs` (a minute by default): one call per page so every timer on it moves together. */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    setNow(new Date());
    return startNowTicker(setNow, intervalMs, typeof document === "undefined" ? undefined : document);
  }, [intervalMs]);
  return now;
}
