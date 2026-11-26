/**
 * BOUNDARY (module 7, shared UI). Inputs: the current path and the hrefs of the sidebar items that are VISIBLE to this person.
 * Output: which item is "the page you are on" (aria-current=page: the longest href that is the path or a path-prefix of it) and which visible items are its
 * parents (a visible item whose href is a proper path-prefix of the current item, for example Job Board while on the NCR register).
 * Must not change: pure (no React, no I/O); no item is current unless the path is on it or under it; an item that is hidden is never current, so its page
 * lights its nearest visible parent instead (a sub-page such as /admin/iso/<document> lights ISO templates, /jobs/ncr lights Job Board when the NCR item is off).
 */
export function navActive(pathname: string, hrefs: readonly string[]): { current: string | null; parents: string[] } {
  const on = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const matches = hrefs.filter(on).sort((a, b) => b.length - a.length);
  const current = matches[0] ?? null;
  const parents = current ? hrefs.filter((h) => h !== current && (current === h || current.startsWith(`${h}/`))) : [];
  return { current, parents };
}
