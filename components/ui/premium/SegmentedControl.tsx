"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW v2). Inputs: label (names the group for assistive technology), value, options[{value,label,disabled?,disabledReason?,controls?,testId?}],
 * onChange(value), size ("md" 40 px track with 32 px segments | "sm" 32 px track with 24 px segments), kind ("radio" default | "tabs"), disabled?.
 * Output: ONE choice out of a few. kind "radio" is role=radiogroup with role=radio and aria-checked (use for a filter, a role switch, a view that is just a
 * different way to look at the same data). kind "tabs" is role=tablist with role=tab and aria-selected (use only when each option shows its own panel;
 * give each option controls="panel id"). Roving tabindex: Tab enters on the selected segment, Left/Up and Right/Down move AND select, Home/End jump,
 * disabled segments stay in view (aria-disabled, with disabledReason as a tooltip) but are skipped by the arrows. 48 px hit area by pseudo element.
 * v3: the track wraps instead of scrolling (visible overflow, so the 48 px hit area is never clipped under 640 px); a wrapped second row sits 16 px lower so hit areas do not overlap.
 * Must not change: it is controlled (the caller owns value); it never fetches or saves anything; no icons; names stay words (never colour alone).
 */
import { useRef, type ReactNode } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";
import { nextMenuIndex } from "./Menu";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** Why it is off; shown as a tooltip and kept out of the arrow order. */
  disabledReason?: string;
  /** Tabs only: the id of the panel this tab controls. */
  controls?: string;
  testId?: string;
}

export interface SegmentedControlProps<T extends string> {
  label: string;
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  kind?: "radio" | "tabs";
  /** Disables the whole control (every segment is out of the arrow order and nothing can change). */
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
}

/** Pure: the index to move to for an arrow, Home or End key (wraps, skips disabled), or -1 when the key is not a segment key or nothing is enabled. */
export function nextSegmentIndex(current: number, disabled: boolean[], key: string): number {
  if (key === "ArrowRight" || key === "ArrowDown") return nextMenuIndex(current, disabled, "ArrowDown");
  if (key === "ArrowLeft" || key === "ArrowUp") return nextMenuIndex(current, disabled, "ArrowUp");
  if (key === "Home" || key === "End") return nextMenuIndex(current, disabled, key);
  return -1;
}

/** Pure: which segment sits in the tab order (the selected one, or the first enabled one when the selected one is disabled). */
export function tabStopIndex(selected: number, disabled: boolean[]): number {
  if (selected >= 0 && !disabled[selected]) return selected;
  return disabled.findIndex((d) => !d);
}

export function SegmentedControl<T extends string>({ label, value, options, onChange, size = "md", kind = "radio", disabled, className, ...rest }: SegmentedControlProps<T>) {
  const group = useRef<HTMLDivElement>(null);
  const tabs = kind === "tabs";
  const off = options.map((o) => !!disabled || !!o.disabled);
  const selected = options.findIndex((o) => o.value === value);
  const stop = tabStopIndex(selected, off);

  const move = (to: number) => {
    if (to < 0) return;
    group.current?.querySelectorAll<HTMLButtonElement>("button")[to]?.focus();
    if (to !== selected) onChange(options[to].value);
  };

  return (
    <div
      ref={group}
      role={tabs ? "tablist" : "radiogroup"}
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-testid={rest["data-testid"]}
      className={cx(premiumTokens, styles.seg, size === "sm" && styles.segSm, className)}
      onKeyDown={(e) => {
        if (disabled || !["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const idx = Array.from(group.current?.querySelectorAll("button") ?? []).indexOf(document.activeElement as HTMLButtonElement);
        move(nextSegmentIndex(idx < 0 ? selected : idx, off, e.key));
      }}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role={tabs ? "tab" : "radio"}
          aria-checked={tabs ? undefined : value === o.value}
          aria-selected={tabs ? value === o.value : undefined}
          aria-controls={tabs ? o.controls : undefined}
          aria-disabled={off[i] || undefined}
          tabIndex={i === stop ? 0 : -1}
          title={o.disabled ? o.disabledReason : undefined}
          data-testid={o.testId}
          className={styles.segBtn}
          onClick={() => { if (!off[i] && o.value !== value) onChange(o.value); }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
