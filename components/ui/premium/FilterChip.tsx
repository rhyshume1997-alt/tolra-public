"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: selected, onToggle, children (the label), count?, disabled?. Output: a 32 px toggle button
 * (aria-pressed) with a 44 px hit area; selected = navy fill plus a check mark, so selection never relies on colour alone.
 * Must not change: ChipGroup rows use a 12 px row gap so neighbouring hit areas never overlap. It filters nothing itself.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens, tabularNumbers } from "./tokens";

export interface FilterChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onToggle" | "children"> {
  selected: boolean;
  onToggle?: () => void;
  children: ReactNode;
  count?: number;
}

export function FilterChip({ selected, onToggle, children, count, className, onClick, type = "button", ...rest }: FilterChipProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-pressed={selected}
      className={cx(premiumTokens, styles.chip, className)}
      onClick={(e) => { onClick?.(e); if (!e.defaultPrevented) onToggle?.(); }}
    >
      {selected ? (
        <svg className={styles.chipTick} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 6.2 5 8.6 9.6 3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
      <span>{children}</span>
      {count === undefined ? null : <span className={cx(styles.chipCount, tabularNumbers)}>({count})</span>}
    </button>
  );
}

/** Wrapping row of chips with the right gaps. */
export function ChipGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <div role="group" aria-label={label} className={cx(premiumTokens, styles.chips, className)}>{children}</div>;
}
