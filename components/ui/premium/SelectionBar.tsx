"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: count (selected), filteredTotal, noun, onSelectAll, onClear, children (the action Buttons), idleNote?.
 * Output: when nothing is selected a quiet single line (no box, no band); when something is selected a navy bar with the live count,
 * Select all N, Clear, and the actions. Buttons inside it pick up the on-dark look through OnDarkContext.
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
}

export function SelectionBar({ count, filteredTotal, noun = "row", onSelectAll, onClear, children, idleNote, stickyTop }: SelectionBarProps) {
  const on = count > 0;
  const plural = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  return (
    <OnDarkContext.Provider value={on}>
      <div className={cx(premiumTokens, styles.bar, on ? styles.barOn : styles.barIdle)} style={on && stickyTop ? { top: stickyTop } : undefined} data-selection={on ? "active" : "idle"}>
        <span role="status" className={cx(styles.barCount, tabularNumbers)}>
          {on ? `${plural(count)} selected` : idleNote ?? `Nothing selected. Tick rows to use bulk actions.`}
        </span>
        <span className={styles.barSpacer} />
        <div className={styles.barActions}>
          {on && count < filteredTotal ? <Button size="sm" variant="quiet" onClick={onSelectAll}>Select all {filteredTotal} filtered</Button> : null}
          {on ? <Button size="sm" variant="quiet" onClick={onClear}>Clear selection</Button> : null}
          {children}
        </div>
      </div>
    </OnDarkContext.Provider>
  );
}
