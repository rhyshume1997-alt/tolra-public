"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: label (names the scroll region for assistive technology) and children (<thead>/<tbody> markup).
 * Output: the table finish: sticky first column that takes its row's exact background, a soft scroll shadow on that column ONLY once the
 * table has been scrolled sideways, a 28 px right edge fade ONLY while more columns are hidden, 64 px rows, hover and selected row tints
 * (set data-selected="true" on a <tr>), a focusable scroll region (keyboard scrolling works).
 * Must not change: it never reads or sorts data. Column choice, sorting and row content belong to the page that uses it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";

export interface ScrollEdges { scrolled: boolean; more: boolean }

/** Pure edge maths (exported for tests): scrolled once away from the left edge, more while there is hidden width on the right. */
export function scrollEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): ScrollEdges {
  return { scrolled: scrollLeft > 1, more: scrollLeft + clientWidth < scrollWidth - 1 };
}

export function ScrollTable({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<ScrollEdges>({ scrolled: false, more: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = scrollEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
    setEdges((p) => (p.scrolled === next.scrolled && p.more === next.more ? p : next));
  }, []);
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
    <div className={cx(premiumTokens, styles.tableWrap, className)} data-scrolled={edges.scrolled} data-more={edges.more}>
      <div ref={ref} className={styles.tableScroll} role="region" aria-label={label} tabIndex={0} onScroll={update}>
        <table className={styles.table}>{children}</table>
      </div>
      <span className={styles.edgeFade} aria-hidden="true" />
    </div>
  );
}
