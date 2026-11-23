"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW v4). Inputs: Tabs {label, value, onChange, tabs[{value, label, count?, disabled?, disabledReason?, controls?, testId?}], className, data-testid}; TabPanel {id, tabId?, hidden?, children}.
 * Output: underline tabs for the sections of one screen: 44 px high, a 2 px navy bar under the selected tab, a hairline across the whole width, and the first label starts exactly on the content edge (no left padding) so it lines up with the grid.
 * WAI-ARIA tabs pattern: role=tablist, role=tab with aria-selected and aria-controls, roving tabindex (Tab enters on the selected tab), Left and Right move AND select (wrap), Home and End jump, disabled tabs stay visible and are skipped.
 * 48 px hit area by pseudo element (2 px above and below the 44 px tab). The selected tab is weight 600; the bold width is reserved by a hidden copy so selecting never shifts a neighbour. count is shown as words-after-the-label (a figure, tabular).
 * Must not change: it is controlled (the caller owns value and renders the panel); it fetches and saves nothing; for a choice that is a view of the SAME data use SegmentedControl (radio) instead of Tabs.
 */
import { useRef, type ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens, tabularNumbers } from "./tokens";
import { nextSegmentIndex, tabStopIndex } from "./SegmentedControl";

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
  className?: string;
  "data-testid"?: string;
}

/** Pure: the keys a horizontal tablist answers to (Up and Down are for the page, not the tabs). */
export function isTabKey(key: string): boolean {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End";
}

export function Tabs<T extends string>({ label, value, tabs, onChange, className, ...rest }: TabsProps<T>) {
  const list = useRef<HTMLDivElement>(null);
  const off = tabs.map((t) => !!t.disabled);
  const selected = tabs.findIndex((t) => t.value === value);
  const stop = tabStopIndex(selected, off);
  const move = (to: number) => {
    if (to < 0) return;
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[to]?.focus();
    if (to !== selected) onChange(tabs[to].value);
  };
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      data-testid={rest["data-testid"]}
      className={cx(premiumTokens, styles.tabs, className)}
      onKeyDown={(e) => {
        if (!isTabKey(e.key)) return;
        e.preventDefault();
        const idx = Array.from(list.current?.querySelectorAll('[role="tab"]') ?? []).indexOf(document.activeElement as Element);
        move(nextSegmentIndex(idx < 0 ? selected : idx, off, e.key));
      }}
    >
      {tabs.map((t, i) => (
        <button
          key={t.value}
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
      ))}
    </div>
  );
}

/** The panel a tab controls. Give it the id the tab names in `controls`, and tabId (the tab's own id, if you set one) so it is labelled by its tab. */
export function TabPanel({ id, tabId, hidden, children }: { id: string; tabId?: string; hidden?: boolean; children: ReactNode }) {
  return <div role="tabpanel" id={id} aria-labelledby={tabId} hidden={hidden} tabIndex={0} className={premiumTokens}>{children}</div>;
}
