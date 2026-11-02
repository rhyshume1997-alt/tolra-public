"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { MAX_QUERY, MIN_QUERY, type SearchAnswer, type SearchGroup, normaliseQuery } from "@/lib/global-search";
import { cn } from "@/lib/utils";

export const SEARCH_DEBOUNCE_MS = 250;

export type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; answer: SearchAnswer };

/** The results panel: grouped lists of links, or one line saying why there are none. Presentational (tested without a browser). */
export function SearchResults({ state, query, activeHref, onPick }: { state: SearchState; query: string; activeHref?: string | null; onPick?: (href: string) => void }) {
  if (state.kind === "idle") return <p className="px-4 py-3 text-sm text-muted-foreground">Type at least {MIN_QUERY} characters.</p>;
  if (state.kind === "loading") return <p className="px-4 py-3 text-sm text-muted-foreground" role="status">Searching...</p>;
  if (state.kind === "error") return <p className="px-4 py-3 text-sm text-red-700" role="alert">{state.message}</p>;
  const { groups, unavailable } = state.answer;
  return (
    <div>
      {groups.length === 0 ? <p className="px-4 py-3 text-sm text-muted-foreground" data-testid="global-search-empty">No matches for &ldquo;{query}&rdquo;.</p> : null}
      {groups.map((group: SearchGroup) => (
        <section key={group.key} aria-label={group.label} data-testid={`global-search-group-${group.key}`}>
          <h3 className="label-mono px-4 pb-1 pt-3 text-muted-foreground">{group.label}</h3>
          <ul>
            {group.results.map((result) => (
              <li key={`${group.key}-${result.id}`}>
                <Link
                  href={result.href}
                  data-testid="global-search-result"
                  aria-current={activeHref === result.href ? "true" : undefined}
                  onClick={(event) => { if (onPick && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); onPick(result.href); } }}
                  className={cn("flex min-h-11 flex-col justify-center px-4 py-1.5 text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none", activeHref === result.href && "bg-muted")}
                >
                  <span className="truncate font-medium text-ink">{result.title}</span>
                  {result.subtitle ? <span className="truncate text-xs text-muted-foreground">{result.subtitle}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {unavailable.length ? <p className="px-4 py-2 text-xs text-muted-foreground" data-testid="global-search-partial">Some results could not be loaded. Try again.</p> : null}
    </div>
  );
}

/** "/" or Ctrl/Cmd+K focuses the search; "/" is left alone while typing in a field. */
export function isSearchShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "target">): boolean {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") return true;
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return false;
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable);
}

/**
 * The top bar's search box: wide screens show the input; below that an icon opens it across the bar. Debounced, at least two
 * characters, answers from /api/search (grouped). Purely additive: nothing else on the page changes.
 */
export function GlobalSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false); // the narrow-screen bar is open / the results panel is showing
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [active, setActive] = useState(-1);
  const query = normaliseQuery(value);

  const close = useCallback(() => { setOpen(false); setActive(-1); inputRef.current?.blur(); }, []);

  // Shortcut: "/" or Ctrl+K from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      setOpen(true);
      // The narrow-screen input is not shown until open, so focus after it renders.
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A click or tap outside closes the panel.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (boxRef.current && !boxRef.current.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open, close]);

  // Moving to another page closes it.
  useEffect(() => { setOpen(false); setActive(-1); }, [pathname]);

  // Debounced fetch; a newer query cancels the older one.
  useEffect(() => {
    if (query.length < MIN_QUERY) { setState({ kind: "idle" }); setActive(-1); return; }
    const controller = new AbortController();
    setState({ kind: "loading" });
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal, credentials: "same-origin" });
        if (!response.ok) {
          setState({ kind: "error", message: response.status === 401 || response.status === 403 ? "Search isn't available for this sign-in." : "Search failed. Try again." });
          return;
        }
        setState({ kind: "done", answer: (await response.json()) as SearchAnswer });
        setActive(-1);
      } catch (error) {
        if ((error as { name?: string })?.name === "AbortError") return;
        setState({ kind: "error", message: "Search needs a connection. Try again." });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  const hrefs = state.kind === "done" ? state.answer.groups.flatMap((group) => group.results.map((result) => result.href)) : [];

  /** The pages read their ?quote= / ?invoice= / ?job= / ?po= / ?customer= link once, when they load: on the page already open, load it afresh. */
  function go(href: string) {
    close();
    setValue("");
    if (new URL(href, window.location.origin).pathname === window.location.pathname) window.location.assign(href);
    else router.push(href);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") { close(); return; }
    if (event.key === "ArrowDown" && hrefs.length) { event.preventDefault(); setActive((index) => (index + 1) % hrefs.length); return; }
    if (event.key === "ArrowUp" && hrefs.length) { event.preventDefault(); setActive((index) => (index <= 0 ? hrefs.length - 1 : index - 1)); return; }
    if (event.key === "Enter" && hrefs.length) { event.preventDefault(); go(hrefs[active >= 0 ? active : 0]); }
  }

  const showPanel = open;

  return (
    <div ref={boxRef} className="contents">
      {/* Narrow screens: an icon (44px) that opens the input across the whole bar. */}
      <button
        type="button"
        aria-label="Search"
        onClick={() => { setOpen(true); requestAnimationFrame(() => inputRef.current?.focus()); }}
        className={cn("inline-flex size-11 items-center justify-center rounded-lg text-ink hover:bg-muted desk:hidden", open && "hidden")}
      >
        <Search className="size-[18px]" strokeWidth={1.75} />
      </button>
      <div className={cn(open ? "absolute inset-x-0 top-0 z-10 flex h-16 items-center gap-1 bg-canvas px-2" : "hidden", "desk:static desk:flex desk:h-auto desk:w-72 desk:bg-transparent desk:p-0")}>
        <div className="relative min-w-0 flex-1 desk:flex-none desk:w-full">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={showPanel}
            aria-controls={listId}
            aria-label="Search"
            placeholder="Search (press /)"
            autoComplete="off"
            enterKeyHint="search"
            maxLength={MAX_QUERY}
            value={value}
            onChange={(event) => { setValue(event.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            data-testid="global-search-input"
            className="h-11 w-full rounded-lg border border-input bg-surface pl-9 pr-3 text-base text-ink outline-none placeholder:text-muted-foreground focus-visible:border-brand-accent focus-visible:ring-3 focus-visible:ring-brand-accent/15 desk:h-10 md:text-sm"
          />
        </div>
        <button type="button" aria-label="Close search" onClick={close} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-ink hover:bg-muted desk:hidden">
          <X className="size-[18px]" strokeWidth={1.75} />
        </button>
        {showPanel ? (
          <div
            id={listId}
            data-testid="global-search-panel"
            className="absolute inset-x-0 top-full max-h-[70vh] overflow-y-auto border border-line bg-surface shadow-lg desk:inset-x-auto desk:right-0 desk:mt-1 desk:w-[30rem] desk:rounded-lg"
          >
            <SearchResults state={state} query={query} activeHref={active >= 0 ? hrefs[active] : null} onPick={go} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
