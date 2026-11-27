/**
 * Routes whose own response headers differ from the global ones, so an in-app link to them must be a normal document load.
 * Input: a link target (path, may carry a #hash). Output: true when it must not use client-side navigation.
 * Why: a client-side navigation keeps the previous page's Content-Security-Policy; /settings alone allows data: fetches and a blob: frame
 * for the Document designs PDF preview (next.config.mjs settingsCsp). Must not change: add a path here only when next.config.mjs gives it
 * its own header; never widen the global policy instead.
 */
const FULL_LOAD_PATHS = ["/settings"];

export function needsFullDocumentLoad(href: string): boolean {
  const path = href.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  return FULL_LOAD_PATHS.includes(path);
}

const RELOAD_KEY = "settings-csp-reload";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const tabStore = (): Store | null => { try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; } };

/** Called just before the Settings CSP boundary reloads the page, so the next page load knows it is that reload (this tab only). */
export function markBoundaryReload(store: Store | null = tabStore()): void {
  try { store?.setItem(RELOAD_KEY, "1"); } catch { /* storage unavailable */ }
}

/** True once after a boundary reload (and forgets it), so state kept for that reload is never used by an ordinary visit. */
export function consumeBoundaryReload(store: Store | null = tabStore()): boolean {
  try {
    if (store?.getItem(RELOAD_KEY) !== "1") return false;
    store.removeItem(RELOAD_KEY);
    return true;
  } catch { return false; }
}
