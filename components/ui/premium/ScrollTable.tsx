"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: label (names the scroll region for assistive technology) and children (<thead>/<tbody> markup).
 * Output: the table finish: sticky first column that takes its row's exact background, a soft scroll shadow on that column ONLY once the
 * table has been scrolled sideways, a 28 px right edge fade ONLY while more columns are hidden, 64 px rows, hover and selected row tints
 * (set data-selected="true" on a <tr>), a focusable scroll region (keyboard scrolling works).
 * v3 (all optional; without them the output is exactly v2): dense (48 px rows), pinLast (the last column, normally Actions, stays in view; its left shadow shows only while columns are hidden), and markup the stylesheet
 * understands: <tfoot> is a totals row; <tr data-clickable="true"> is a clickable row (the row must still hold a real link or button for the keyboard; use rowClickIsForRow in the handler so clicks on controls inside
 * the row do not also trigger it); <tbody data-record="true"> is one record (a main row plus <tr data-sub="true"> sub-rows) that hovers, selects (data-selected on the tbody) and is separated as one;
 * a full-width <td colSpan> no longer leaks the first-column shadow (it made the table scroll sideways), and the content of a <tr data-sub="true"> colSpan cell stays pinned to the left and is no wider than the visible width (the wrapper publishes --ui-scroll-w), so a note under a record never needs a sideways scroll to read. A th scope="row" in tbody or tfoot is a plain cell.
 * v4 (optional): flush removes the card chrome (no ring, shadow, radius or background) so a table inside a Panel is not a card in a card; narrowHidden hides the table under 640 px, for a screen that shows StackedRows there instead.
 * v5 (optional, default unchanged): pinFirst={0..4} pins the first N columns (default 1 = v4; 0 = none). The widths of the pinned columns are measured and published as --ui-pin-1 to --ui-pin-3, each pinned column sticks at the sum of those before it, and ONLY the last pinned column carries
 * the soft scroll shadow, and only once the table is scrolled (the earlier ones draw none, so there is no stack of shadows and nothing leaks into a full-width row). When the pinned columns would take more than 60% of the visible width nothing is pinned (data-pin-fit="false"), so there is always room to scroll.
 * pinLast and pinFirst can be used together. Give pinned columns a fixed width (a width on the th) so they do not change size while scrolling. A <td colSpan> is never pinned.
 * Header cells are the table-header style (12 px, uppercase, tracked, weight 600); body cells are 14 px weight 400, so put the typeScale.name class on a name cell to get weight 600.
 * Must not change: it never reads or sorts data. Column choice, sorting and row content belong to the page that uses it.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";

export interface ScrollEdges { scrolled: boolean; more: boolean }

/** Pure edge maths (exported for tests): scrolled once away from the left edge, more while there is hidden width on the right. */
export function scrollEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): ScrollEdges {
  return { scrolled: scrollLeft > 1, more: scrollLeft + clientWidth < scrollWidth - 1 };
}

const CONTROLS = "a, button, input, select, textarea, label, summary, [role='button'], [role='menuitem'], [role='switch'], [role='checkbox'], [role='radio'], [role='tab'], [contenteditable='true']";

/** Pure-ish helper for a clickable row's onClick: true when the click landed on the row itself or plain text, false when it landed on (or inside) a control. */
export function rowClickIsForRow(target: EventTarget | null, row: Element): boolean {
  const el = target as (Element & { closest?: (s: string) => Element | null }) | null;
  if (!el || typeof el.closest !== "function") return true;
  const control = el.closest(CONTROLS);
  return !control || !row.contains(control) || control === row;
}

/** Pure (v5, exported for tests): the left offsets of the first N columns from their measured widths (offsets[k] = sum of widths before column k), and whether the pinned set fits (at most 60% of the visible width). */
export function pinOffsets(widths: number[], n: number, viewWidth: number): { offsets: number[]; fits: boolean } {
  const count = Math.max(0, Math.min(4, Math.floor(n)));
  const offsets: number[] = [];
  let sum = 0;
  for (let k = 0; k < count; k++) { offsets.push(Math.round(sum * 100) / 100); sum += widths[k] ?? 0; }
  return { offsets, fits: viewWidth <= 0 || sum <= viewWidth * 0.6 };
}

export function ScrollTable({ label, children, className, dense, pinLast, flush, narrowHidden, pinFirst }: { label: string; children: ReactNode; className?: string; /** v3: 48 px rows. */ dense?: boolean; /** v3: pin the last column (Actions). */ pinLast?: boolean; /** v4: no card chrome (inside a Panel). */ flush?: boolean; /** v4: hide under 640 px (pair with StackedRows narrowOnly). */ narrowHidden?: boolean; /** v5: how many leading columns stay in view while scrolling sideways (0 to 4, default 1). */ pinFirst?: 0 | 1 | 2 | 3 | 4 }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<ScrollEdges>({ scrolled: false, more: false });
  const [viewW, setViewW] = useState(0);
  const [pin, setPin] = useState<{ key: string; offsets: number[]; fits: boolean }>({ key: "", offsets: [], fits: true });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setViewW((w) => (w === el.clientWidth ? w : el.clientWidth));
    if (pinFirst !== undefined && pinFirst >= 2) {
      const cells = Array.from(el.querySelector("tr")?.children ?? []) as HTMLElement[];
      const m = pinOffsets(cells.slice(0, pinFirst).map((c) => c.getBoundingClientRect().width), pinFirst, el.clientWidth);
      const key = `${m.offsets.join(",")}|${m.fits}`;
      setPin((p) => (p.key === key ? p : { key, ...m }));
    }
    const next = scrollEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
    setEdges((p) => (p.scrolled === next.scrolled && p.more === next.more ? p : next));
  }, [pinFirst]);
  useEffect(() => {
    update();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [update]);
  return (
    <div className={cx(premiumTokens, styles.tableWrap, flush && styles.tableFlush, narrowHidden && styles.tableNarrowHidden, className)} data-scrolled={edges.scrolled} data-more={edges.more} data-pin-last={pinLast ? "true" : undefined} data-pin-first={pinFirst !== undefined && pinFirst !== 1 ? pinFirst : undefined} data-pin-fit={pinFirst !== undefined && pinFirst >= 2 && !pin.fits ? "false" : undefined} style={viewW || pin.offsets.length ? ({ ...(viewW ? { ["--ui-scroll-w" as string]: `${viewW}px` } : {}), ...Object.fromEntries(pin.offsets.map((o, k) => [`--ui-pin-${k}`, `${o}px`])) } as CSSProperties) : undefined}>
      <div ref={ref} className={styles.tableScroll} role="region" aria-label={label} tabIndex={0} onScroll={update}>
        <table className={cx(styles.table, dense && styles.tableDense)}>{children}</table>
      </div>
      <span className={styles.edgeFade} aria-hidden="true" />
    </div>
  );
}
