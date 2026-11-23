"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW v5). Inputs: RemovableChip {children (the visible words, for example "Status: Open"), onRemove, removeLabel? (the accessible name; default "Remove filter: <words>", which always starts with the visible words' text), disabled?, data-testid};
 * RemovableChips {label (names the list, for example "Active filters"), children (the chips)}.
 * Output: a 32 px chip with its words and a small cross, ONE button (a 48 px hit area by pseudo element, at least 48 px wide); pressing it calls onRemove. RemovableChips is a list (ul) that wraps with 16 px between rows so hit areas never overlap.
 * Must not change: it removes nothing itself (the caller drops the filter); the cross is a functional mark and the words say what is removed; the accessible name contains the visible words.
 */
import { Children, type ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";

export interface RemovableChipProps {
  children: ReactNode;
  onRemove: () => void;
  /** Accessible name. Keep the visible words inside it (label in name). */
  removeLabel?: string;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
  /** Free data attribute for the caller (for example the filter id). */
  "data-chip"?: string;
}

export function RemovableChip({ children, onRemove, removeLabel, disabled, className, ...rest }: RemovableChipProps) {
  const words = typeof children === "string" ? children : undefined;
  return (
    <button
      type="button"
      className={cx(premiumTokens, styles.chipX, className)}
      aria-label={removeLabel ?? (words ? `Remove filter: ${words}` : undefined)}
      disabled={disabled}
      data-testid={rest["data-testid"]}
      data-chip={rest["data-chip"]}
      onClick={onRemove}
    >
      <span>{children}</span>
      <svg className={styles.chipXMark} width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
    </button>
  );
}

export function RemovableChips({ label, children, className, ...rest }: { label: string; children: ReactNode; className?: string; "data-testid"?: string }) {
  return (
    <ul aria-label={label} className={cx(premiumTokens, styles.chipRow, className)} data-testid={rest["data-testid"]}>
      {Children.toArray(children).map((c, i) => <li key={i}>{c}</li>)}
    </ul>
  );
}
