/**
 * BOUNDARY (Tooly tour, shared Replay action): a tiny typed store so "Replay tour" can be started from Account Settings on any page.
 * Inputs: the tour host (admin-tour.tsx, mounted by the dashboard shell on every dashboard route) calls `setTourReplayHost` while it can
 * replay (switch on, person has seen the tour, role has a plan) and passes the function that starts it; Account Settings calls
 * `requestTourReplay()` and reads `useTourReplayAvailable()`.
 * Outputs: `requestTourReplay()` returns true when a host started the replay, false when none is available (nothing happens then).
 * Must not change: it holds no tour content, no gating rules (those stay in tour-switch.ts / admin-tour.tsx), and never clicks anything.
 */
import { useSyncExternalStore } from "react";

type Start = () => void;

let host: Start | null = null;
const listeners = new Set<() => void>();

/** The tour host registers its start function while a replay is offered, and passes null when it is not. Returns nothing. */
export function setTourReplayHost(start: Start | null): void {
  if (host === start) return;
  host = start;
  listeners.forEach((l) => l());
}

/** Starts the tour again from step 1. True if a host did; false (and nothing happens) when no replay is on offer. */
export function requestTourReplay(): boolean {
  if (!host) return false;
  host();
  return true;
}

export function tourReplayAvailable(): boolean {
  return host !== null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** True while the tour host offers a replay (same availability as before: switch on, seen once, role has a tour). */
export function useTourReplayAvailable(): boolean {
  return useSyncExternalStore(subscribe, tourReplayAvailable, () => false);
}
