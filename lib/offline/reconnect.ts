/**
 * A dialog's prerequisites (machines, schedule) after a load attempt, and reloading them when the connection comes back. A network
 * failure marks the dialog offline (its action disabled); the `online` event, or an explicit Retry, loads again, and a successful load
 * clears both the offline mark and any error, so reconnecting never leaves the action disabled until the dialog is reopened.
 */
import { isNetworkError } from "@/lib/offline/store";

export type PrereqState = { offline: boolean; loadError: string | null };

/** The state after a load: success clears everything; a network failure (or the browser saying it's offline) is "offline". */
export function prereqOutcome(error: unknown, browserOnline: boolean, describe: (error: unknown) => string): PrereqState {
  if (!error) return { offline: false, loadError: null };
  if (!browserOnline || isNetworkError(error)) return { offline: true, loadError: null };
  return { offline: false, loadError: describe(error) };
}

/** Calls `reload` each time `target` (the window) fires `online`; returns the cleanup. */
export function onReconnect(target: Pick<EventTarget, "addEventListener" | "removeEventListener"> | undefined, reload: () => void): () => void {
  if (!target) return () => undefined;
  const handler = () => reload();
  target.addEventListener("online", handler);
  return () => target.removeEventListener("online", handler);
}
