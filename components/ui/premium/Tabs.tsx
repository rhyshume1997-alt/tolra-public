"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW v4). Inputs: Tabs {label, value, onChange, tabs[{value, label, count?, disabled?, disabledReason?, controls?, testId?}], className, data-testid}; TabPanel {id, tabId?, hidden?, children}.
 * Output: underline tabs for the sections of one screen: 44 px high, a 2 px navy bar under the selected tab, a hairline across the whole width, and the first label starts exactly on the content edge (no left padding) so it lines up with the grid.
 * WAI-ARIA tabs pattern: role=tablist, role=tab with aria-selected and aria-controls, roving tabindex (Tab enters on the selected tab), Left and Right move AND select (wrap), Home and End jump, disabled tabs stay visible and are skipped.
 * 48 px hit area by pseudo element (2 px above and below the 44 px tab). The selected tab is weight 600; the bold width is reserved by a hidden copy so selecting never shifts a neighbour. count is shown as words-after-the-label (a figure, tabular).
 * v6 NO SIDEWAYS SCROLLING: the row never scrolls. By default (overflow="wrap") tabs that do not fit wrap onto more rows (rows 4 px apart, so the 48 px hit areas touch but never overlap) and a label that is longer than the screen wraps inside its tab. With overflow="more" the tabs that do
 * not fit are taken out of the row and listed in a "More" menu at its end (the selected tab always stays in the row); measured from the real widths, so it follows the container, not a fixed breakpoint. The More menu sits next to the tablist (not inside it), so the tablist holds only tabs.
 * Must not change: it is controlled (the caller owns value and renders the panel); it fetches and saves nothing; for a choice that is a view of the SAME data use SegmentedControl (radio) instead of Tabs.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens, tabularNumbers } from "./tokens";
import { nextSegmentIndex, tabStopIndex } from "./SegmentedControl";
import { Menu, type MenuItem } from "./Menu";

export interface TabItem<T extends string> {
  value: T;
  label: string;
  /** The tab's own id, so a TabPanel can name itself by it (aria-labelledby). */
  id?: string;
  count?: number;
  disabled?: boolean;
  disabledReason?: string;
  /** The id of the panel this tab controls. */
  controls?: string;
  testId?: string;
}

export interface TabsProps<T extends string> {
  label: string;
  value: T;
  tabs: Array<TabItem<T>>;
  onChange: (value: T) => void;
  /** v6: "wrap" (default): extra tabs wrap onto more rows. "more": extra tabs move into a More menu at the end of the row. */
  overflow?: "wrap" | "more";
  /** v6: the text of the More trigger (default "More"). */
  moreLabel?: string;
  className?: string;
  "data-testid"?: string;
}

/** Pure: the keys a horizontal tablist answers to (Up and Down are for the page, not the tabs). */
export function isTabKey(key: string): boolean {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End";
}

/** Pure (v6, exported for tests): which tabs stay in the row. widths are the tab widths (with their gap), `available` the row width, `moreWidth` what the More trigger needs. All fit: every index. Otherwise the selected tab is always kept, then tabs in order while they fit beside the More trigger. */
export function fitTabs(widths: number[], selected: number, available: number, moreWidth: number): number[] {
  const all = widths.reduce((a, b) => a + b, 0);
  if (all <= available) return widths.map((_, i) => i);
  const room = Math.max(0, available - moreWidth);
  const keep = new Set<number>();
  let used = 0;
  if (selected >= 0 && selected < widths.length) { keep.add(selected); used += widths[selected]; }
  for (let i = 0; i < widths.length; i++) { if (keep.has(i)) continue; if (used + widths[i] > room) break; keep.add(i); used += widths[i]; }
  return Array.from(keep).sort((a, b) => a - b);
}

const tabKey = (t: { value: string; label: string; count?: number }) => `${t.value}|${t.label}|${t.count ?? ""}`;

export function Tabs<T extends string>({ label, value, tabs, onChange, overflow = "wrap", moreLabel = "More", className, ...rest }: TabsProps<T>) {
  const list = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const [kept, setKept] = useState<number[] | null>(null);
  const more = overflow === "more";
  const selected = tabs.findIndex((t) => t.value === value);
  const visible = more && kept ? kept.filter((i) => i < tabs.length) : tabs.map((_, i) => i);
  const hidden = tabs.map((_, i) => i).filter((i) => !visible.includes(i));
  const off = visible.map((i) => !!tabs[i].disabled);
  const visSelected = visible.indexOf(selected);
  const stop = tabStopIndex(visSelected, off);
  const measure = useCallback(() => {
    const w = wrapRef.current;
    const l = list.current;
    if (!w || !l) return;
    l.querySelectorAll<HTMLElement>('[role="tab"]').forEach((b) => widths.current.set(b.dataset.tabKey ?? "", b.offsetWidth + 4));
    const ws = tabs.map((t) => widths.current.get(tabKey(t)) ?? t.label.length * 8 + 36);
    const next = fitTabs(ws, selected, w.clientWidth, 96);
    const nv = next.length === tabs.length ? null : next;
    setKept((p) => (JSON.stringify(p) === JSON.stringify(nv) ? p : nv));
  }, [tabs, selected]);
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useLayoutEffect(() => { if (more) measure(); });
  useEffect(() => {
    if (!more || !wrapRef.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureRef.current());
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [more]);
  const move = (to: number) => {
    if (to < 0) return;
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[to]?.focus();
    if (to !== visSelected) onChange(tabs[visible[to]].value);
  };
  const moreItems: MenuItem[] = hidden.map((i) => ({ id: `tab-more-${tabs[i].value}`, label: tabs[i].count === undefined ? tabs[i].label : `${tabs[i].label} (${tabs[i].count})`, disabled: tabs[i].disabled, hint: tabs[i].disabled ? tabs[i].disabledReason : undefined, testId: tabs[i].testId ? `${tabs[i].testId}-more` : undefined, onSelect: () => onChange(tabs[i].value) }));
  const tablist = (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      data-testid={rest["data-testid"]}
      className={cx(premiumTokens, styles.tabs, more && styles.tabsMore, !more && className)}
      onKeyDown={(e) => {
        if (!isTabKey(e.key)) return;
        e.preventDefault();
        const idx = Array.from(list.current?.querySelectorAll('[role="tab"]') ?? []).indexOf(document.activeElement as Element);
        move(nextSegmentIndex(idx < 0 ? visSelected : idx, off, e.key));
      }}
    >
      {visible.map((ti, i) => { const t = tabs[ti]; return (
        <button
          key={t.value}
          data-tab-key={tabKey(t)}
          type="button"
          role="tab"
          id={t.id}
          aria-selected={value === t.value}
          aria-controls={t.controls}
          aria-disabled={t.disabled || undefined}
          tabIndex={i === stop ? 0 : -1}
          title={t.disabled ? t.disabledReason : undefined}
          data-testid={t.testId}
          className={styles.tab}
          onClick={() => { if (!t.disabled && t.value !== value) onChange(t.value); }}
        >
          <span className={styles.tabLabel} data-text={t.label}>{t.label}</span>
          {t.count === undefined ? null : <span className={cx(styles.tabCount, tabularNumbers)}>{t.count}</span>}
          <span className={styles.tabBar} aria-hidden="true" />
        </button>
      ); })}
    </div>
  );
  if (!more) return tablist;
  return (
    <div ref={wrapRef} className={cx(premiumTokens, styles.tabsMoreWrap, className)}>
      {tablist}
      {hidden.length ? <div className={styles.tabMore}><Menu label={moreLabel} aria-label={`${moreLabel} ${label}`} variant="quiet" items={moreItems} data-testid={rest["data-testid"] ? `${rest["data-testid"]}-more` : undefined} /></div> : null}
    </div>
  );
}

/** The panel a tab controls. Give it the id the tab names in `controls`, and tabId (the tab's own id, if you set one) so it is labelled by its tab. */
export function TabPanel({ id, tabId, hidden, children }: { id: string; tabId?: string; hidden?: boolean; children: ReactNode }) {
  return <div role="tabpanel" id={id} aria-labelledby={tabId} hidden={hidden} tabIndex={0} className={premiumTokens}>{children}</div>;
}
