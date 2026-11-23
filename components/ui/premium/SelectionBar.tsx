"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: count (selected), filteredTotal, noun, onSelectAll, onClear, children (the action Buttons), idleNote?.
 * Output: when nothing is selected a quiet single line (no box, no band); when something is selected a navy bar with the live count,
 * Select all N, Clear, and the actions. Buttons inside it pick up the on-dark look through OnDarkContext.
 * v2: selectAll and clear say WHEN each button shows ("active" default = only while something is selected, "always" = also at idle, "never"); idle Clear is disabled at 0, idle Select all is hidden when
 * there is nothing to select; statusText replaces the active line (a string or a function of {count, filteredTotal, noun}). Defaults draw exactly what v1 drew.
 * v3: when the bar wraps (narrow screens) its rows are 16 px apart, so the 48 px hit areas of buttons on different rows never overlap.
 * Must not change: actions are the caller's and decide their own disabled state from count; this bar never selects, deletes or finishes anything.
 */
import type { ReactNode } from "react";
import styles from "./premium.module.css";
import { Button, OnDarkContext } from "./Button";
import { cx, premiumTokens, tabularNumbers } from "./tokens";

export interface SelectionBarProps {
  count: number;
  filteredTotal: number;
  noun?: string;
  onSelectAll: () => void;
  onClear: () => void;
  children?: ReactNode;
  idleNote?: string;
  stickyTop?: string;
  /** When "Select all N" shows. Default "active": only while something is selected and more can be chosen. */
  selectAll?: BarWhen;
  /** When "Clear selection" shows. Default "active". At idle with "always" it is shown disabled. */
  clear?: BarWhen;
  /** Replaces "N rows selected". */
  statusText?: string | ((info: { count: number; filteredTotal: number; noun: string }) => string);
}

export type BarWhen = "active" | "always" | "never";

/** Pure: which of the two buttons show, and whether Clear is disabled (exported for tests). */
export function selectionControls(count: number, filteredTotal: number, selectAll: BarWhen = "active", clear: BarWhen = "active") {
  const on = count > 0;
  const moreToSelect = count < filteredTotal;
  return {
    showSelectAll: selectAll !== "never" && moreToSelect && (on || selectAll === "always"),
    showClear: clear !== "never" && (on || clear === "always"),
    clearDisabled: !on,
  };
}

export function SelectionBar({ count, filteredTotal, noun = "row", onSelectAll, onClear, children, idleNote, stickyTop, selectAll, clear, statusText }: SelectionBarProps) {
  const on = count > 0;
  const ctl = selectionControls(count, filteredTotal, selectAll, clear);
  const plural = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  return (
    <OnDarkContext.Provider value={on}>
      <div className={cx(premiumTokens, styles.bar, on ? styles.barOn : styles.barIdle)} style={on && stickyTop ? { top: stickyTop } : undefined} data-selection={on ? "active" : "idle"}>
        <span role="status" className={cx(styles.barCount, tabularNumbers)}>
          {on ? (typeof statusText === "function" ? statusText({ count, filteredTotal, noun }) : statusText ?? `${plural(count)} selected`) : idleNote ?? `Nothing selected. Tick rows to use bulk actions.`}
        </span>
        <span className={styles.barSpacer} />
        <div className={styles.barActions}>
          {ctl.showSelectAll ? <Button size="sm" variant="quiet" onClick={onSelectAll}>Select all {filteredTotal} filtered</Button> : null}
          {ctl.showClear ? <Button size="sm" variant="quiet" onClick={onClear} disabled={ctl.clearDisabled}>Clear selection</Button> : null}
          {children}
        </div>
      </div>
    </OnDarkContext.Provider>
  );
}
