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
 * v6 NO SIDEWAYS SCROLLING (the owner's rule for phone and tablet): at 1024 px and under the table is NEVER a scroll box. It reflows into stacked records using the same markup: every body row is a record block (primary cell = the title line, the other cells
 * label/value pairs taken from the header text, the actions cell as a row of buttons 16 px apart at the bottom), <tfoot> rows become a totals block, <tr data-sub> notes and colSpan cells are full-width notes, a selection checkbox cell sits left of the title,
 * the header row stays in the DOM for assistive technology but is visually hidden, pinFirst and pinLast are ignored, and a table role set is applied so the reflowed markup keeps its table semantics. Above 1024 px nothing changes (the scroll box, pinning and edge fade stay: desktop only).
 * Optional props: primary (0-based column index of the title cell; default the first column that is not a selection column; or put data-primary on a th), columnPriority (column indexes to show first, in that order; the rest follow in table order),
 * actionsColumn (index, "last" (default: the last column when its header is empty or "Actions") or "none"; or data-actions on a th), stackHide (column indexes not shown in the stacked record; or data-stack-hide on a th). A td may carry its own data-ui-label (not data-label: app/globals.css already styles td[data-label]::before for its own stacked tables) to override the header text.
 * A header cell holding a select-all checkbox is not shown when stacked: give the screen a SelectionBar (Select all) for that. The stacked layout needs the cell markup to be a real <td>/<th> per column; a colSpan cell is a full-width note; an empty cell is left out of the record.
 * Must not change: it never reads or sorts data. Column choice, sorting and row content belong to the page that uses it. It only adds data-ui-label, data-stack and order attributes (and, stacked, role attributes) to cells; it never moves or rewrites a cell's children.
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

export type StackRole = "title" | "select" | "field" | "actions" | "hidden";
export interface StackColumn { role: StackRole; order: number }
export interface StackOptions { primary?: number; columnPriority?: number[]; actionsColumn?: number | "last" | "none"; stackHide?: number[] }

/** Pure (v6, exported for tests): what each column of a table becomes in its stacked record. `labels` are the header texts, `selectCols[i]` is true when column i holds selection checkboxes. Title: the chosen or first non-select column; select: a checkbox column;
 *  actions: the chosen column, or by default the last column when its header is blank or says "Actions"; hidden: stackHide; field: everything else, ordered by columnPriority first, then table order. order: select -2, title -1, fields 10+, actions 1000. */
export function planStack(labels: string[], selectCols: boolean[], opts: StackOptions = {}): StackColumn[] {
  const n = labels.length;
  const isSel = (i: number) => !!selectCols[i];
  const firstNonSelect = Math.max(0, labels.findIndex((_, i) => !isSel(i)));
  const primary = opts.primary !== undefined && opts.primary >= 0 && opts.primary < n && !isSel(opts.primary) ? opts.primary : firstNonSelect;
  let actions = -1;
  if (typeof opts.actionsColumn === "number") actions = opts.actionsColumn < n ? opts.actionsColumn : -1;
  else if (opts.actionsColumn !== "none" && n > 1) {
    const last = n - 1;
    if (last !== primary && !isSel(last) && /^(actions?)?$/i.test(labels[last].trim())) actions = last;
  }
  if (actions === primary || isSel(actions)) actions = -1;
  const prio = opts.columnPriority ?? [];
  const hide = new Set(opts.stackHide ?? []);
  return labels.map((_, i): StackColumn => {
    if (isSel(i)) return { role: "select", order: -2 };
    if (i === primary) return { role: "title", order: -1 };
    if (i === actions) return { role: "actions", order: 1000 };
    if (hide.has(i)) return { role: "hidden", order: 5000 };
    const rank = prio.indexOf(i);
    return { role: "field", order: rank >= 0 ? 10 + rank : 100 + i };
  });
}

const STACK_MQ = "(max-width: 1024px)";

/** Applies the plan to the DOM: data-ui-label, data-stack and order on each cell, data-stack-select on rows with a selection cell, roles while stacked. Never touches a cell's children. */
function applyStack(table: HTMLTableElement, opts: StackOptions, stacked: boolean) {
  const headRow = (table.tHead?.rows[0] ?? table.querySelector("tr")) as HTMLTableRowElement | null;
  if (!headRow) return;
  const heads = Array.from(headRow.cells);
  const labels = heads.map((h) => h.getAttribute("data-ui-label") ?? (h.textContent ?? "").replace(/\s+/g, " ").trim());
  const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>("tbody tr, tfoot tr"));
  const cellAt = (tr: HTMLTableRowElement) => { const out: Array<{ cell: HTMLTableCellElement; start: number; span: number }> = []; let c = 0; for (const cell of Array.from(tr.cells)) { out.push({ cell, start: c, span: Math.max(1, cell.colSpan) }); c += Math.max(1, cell.colSpan); } return out; };
  const selectCols = labels.map((l, i) => /^(select.*)?$/i.test(l) && rows.some((tr) => { const x = cellAt(tr).find((y) => y.start === i && y.span === 1); return !!x?.cell.querySelector("input[type='checkbox'], [role='checkbox']"); }));
  const flag = (i: number, attr: string) => heads[i]?.hasAttribute(attr);
  const o: StackOptions = { ...opts };
  if (o.primary === undefined) { const k = heads.findIndex((_, i) => flag(i, "data-primary")); if (k >= 0) o.primary = k; }
  if (o.actionsColumn === undefined) { const k = heads.findIndex((_, i) => flag(i, "data-actions")); if (k >= 0) o.actionsColumn = k; }
  const hideAttr = heads.map((_, i) => i).filter((i) => flag(i, "data-stack-hide"));
  if (hideAttr.length) o.stackHide = [...(o.stackHide ?? []), ...hideAttr];
  const plan = planStack(labels, selectCols, o);
  for (const tr of rows) {
    let hasSelect = false;
    for (const { cell, start, span } of cellAt(tr)) {
      const covers = (i: number) => start <= i && i < start + span;
      const titleCol = plan.findIndex((p) => p.role === "title");
      let role: StackRole | "note";
      let order: number;
      if (span > 1) { role = covers(titleCol) && !tr.hasAttribute("data-sub") ? "title" : "note"; order = role === "title" ? -1 : 900; }
      else { const p = plan[start]; role = p ? p.role : "field"; order = p ? p.order : 100 + start; }
      if (role === "select") hasSelect = true;
      cell.setAttribute("data-stack", role);
      if (role === "field" && !cell.children.length && !(cell.textContent ?? "").trim()) cell.setAttribute("data-stack-empty", "true"); else cell.removeAttribute("data-stack-empty");
      cell.style.order = String(order);
      if (span === 1 && role !== "note") {
        if (cell.getAttribute("data-stack-auto") !== null || !cell.hasAttribute("data-ui-label")) { cell.setAttribute("data-ui-label", labels[start] ?? ""); cell.setAttribute("data-stack-auto", ""); }
      }
      if (stacked) cell.setAttribute("role", cell.tagName === "TH" ? "rowheader" : "cell"); else if (cell.hasAttribute("data-stack-aria")) cell.removeAttribute("role");
      if (stacked) cell.setAttribute("data-stack-aria", "");
    }
    if (hasSelect) tr.setAttribute("data-stack-select", "true"); else tr.removeAttribute("data-stack-select");
    if (stacked) { tr.setAttribute("role", "row"); tr.setAttribute("data-stack-aria", ""); } else if (tr.hasAttribute("data-stack-aria")) { tr.removeAttribute("role"); tr.removeAttribute("data-stack-aria"); }
  }
  const sections: HTMLElement[] = [table, ...(Array.from(table.children).filter((c) => /^(THEAD|TBODY|TFOOT)$/.test(c.tagName)) as HTMLElement[])];
  for (const el of sections) {
    const role = el === table ? "table" : "rowgroup";
    if (stacked) { el.setAttribute("role", role); el.setAttribute("data-stack-aria", ""); } else if (el.hasAttribute("data-stack-aria")) { el.removeAttribute("role"); el.removeAttribute("data-stack-aria"); }
  }
  if (table.tHead) for (const tr of Array.from(table.tHead.rows)) {
    if (stacked) { tr.setAttribute("role", "row"); tr.setAttribute("data-stack-aria", ""); } else if (tr.hasAttribute("data-stack-aria")) { tr.removeAttribute("role"); tr.removeAttribute("data-stack-aria"); }
    for (const th of Array.from(tr.cells)) { if (stacked) { th.setAttribute("role", "columnheader"); th.setAttribute("data-stack-aria", ""); } else if (th.hasAttribute("data-stack-aria")) { th.removeAttribute("role"); th.removeAttribute("data-stack-aria"); } }
  }
}

export function ScrollTable({ label, children, className, dense, pinLast, flush, narrowHidden, pinFirst, primary, columnPriority, actionsColumn, stackHide }: { label: string; children: ReactNode; className?: string; /** v6: 0-based column index of the stacked title cell (default: the first column that is not a selection column). */ primary?: number; /** v6: column indexes shown first in the stacked record, in order; the rest follow in table order. */ columnPriority?: number[]; /** v6: the actions column: an index, "last" (default; used when its header is blank or "Actions") or "none". */ actionsColumn?: number | "last" | "none"; /** v6: column indexes left out of the stacked record. */ stackHide?: number[]; /** v3: 48 px rows. */ dense?: boolean; /** v3: pin the last column (Actions). */ pinLast?: boolean; /** v4: no card chrome (inside a Panel). */ flush?: boolean; /** v4: hide under 640 px (pair with StackedRows narrowOnly). */ narrowHidden?: boolean; /** v5: how many leading columns stay in view while scrolling sideways (0 to 4, default 1). */ pinFirst?: 0 | 1 | 2 | 3 | 4 }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<ScrollEdges>({ scrolled: false, more: false });
  const [viewW, setViewW] = useState(0);
  const [pin, setPin] = useState<{ key: string; offsets: number[]; fits: boolean }>({ key: "", offsets: [], fits: true });
  const [stacked, setStacked] = useState(false);
  const optsKey = JSON.stringify([primary, columnPriority, actionsColumn, stackHide]);
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
  // v6: stacked at 1024 px and under (CSS does the layout; this only labels the cells and keeps the table roles).
  useEffect(() => {
    const table = ref.current?.querySelector("table");
    if (!table || typeof window === "undefined") return;
    const mq = window.matchMedia ? window.matchMedia(STACK_MQ) : null;
    let raf = 0;
    const opts: StackOptions = { primary, columnPriority, actionsColumn, stackHide };
    const run = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { setStacked(!!mq?.matches); applyStack(table, opts, !!mq?.matches); }); };
    setStacked(!!mq?.matches);
    applyStack(table, opts, !!mq?.matches);
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(run) : null;
    mo?.observe(table, { childList: true, subtree: true });
    mq?.addEventListener?.("change", run);
    return () => { cancelAnimationFrame(raf); mo?.disconnect(); mq?.removeEventListener?.("change", run); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optsKey]);
  return (
    <div className={cx(premiumTokens, styles.tableWrap, flush && styles.tableFlush, narrowHidden && styles.tableNarrowHidden, className)} data-scrolled={edges.scrolled} data-more={edges.more} data-pin-last={pinLast ? "true" : undefined} data-pin-first={pinFirst !== undefined && pinFirst !== 1 ? pinFirst : undefined} data-pin-fit={pinFirst !== undefined && pinFirst >= 2 && !pin.fits ? "false" : undefined} style={viewW || pin.offsets.length ? ({ ...(viewW ? { ["--ui-scroll-w" as string]: `${viewW}px` } : {}), ...Object.fromEntries(pin.offsets.map((o, k) => [`--ui-pin-${k}`, `${o}px`])) } as CSSProperties) : undefined}>
      <div ref={ref} className={styles.tableScroll} role="region" aria-label={label} tabIndex={stacked ? undefined : 0} onScroll={update}>
        <table className={cx(styles.table, dense && styles.tableDense)}>{children}</table>
      </div>
      <span className={styles.edgeFade} aria-hidden="true" />
    </div>
  );
}
