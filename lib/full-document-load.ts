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
