/**
 * After a deploy, a tab that is still running the previous build can ask for a code chunk that no longer exists
 * ("ChunkLoadError: Loading chunk 9305 failed"). A full reload fetches the new build and fixes it, so the error
 * pages do that once instead of showing "Something went wrong".
 *
 * Loop guard: the time of the last automatic reload is kept in sessionStorage (this tab only). Another automatic
 * reload is only allowed after RELOAD_GUARD_MS, so a chunk that is genuinely broken shows the error page instead of
 * reloading forever.
 */
const KEY = "chunk-reload-at";
export const RELOAD_GUARD_MS = 5 * 60 * 1000;

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  const text = typeof message === "string" ? message : "";
  return /Loading (CSS )?chunk [\w-]+ failed/i.test(text) || /Failed to fetch dynamically imported module/i.test(text) || /error loading dynamically imported module/i.test(text);
}

/** Reloads the page once for a chunk load error; returns true when a reload was started. */
export function reloadOnceForChunkError(error: unknown, now = Date.now(), storage: Pick<Storage, "getItem" | "setItem"> | null = safeSessionStorage(), reload: () => void = () => window.location.reload()): boolean {
  if (!isChunkLoadError(error) || !storage) return false;
  const last = Number(storage.getItem(KEY) || 0);
  if (last && now - last < RELOAD_GUARD_MS) return false;
  try {
    storage.setItem(KEY, String(now));
  } catch {
    return false; // can't record the guard: don't risk a loop
  }
  reload();
  return true;
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
