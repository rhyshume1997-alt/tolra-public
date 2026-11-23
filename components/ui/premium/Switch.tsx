"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: Switch {checked, onChange(next), label, hint?, disabled?}; Checkbox {native input props, label for AT}.
 * Output: a role="switch" button (aria-checked) with an On/Off word beside it, and a native checkbox with a 48 px hit box around a 20 px mark.
 * Must not change: state is always shown as a word as well as a position, the whole row (48 px) toggles, and both are fully controlled:
 * the caller owns the value and must only flip it after the real thing has happened.
 * v3: any data-* attribute you pass (data-testid, data-col, data-key ...) lands on the switch button; the hit area no longer reaches past the row (it caused a 2 px sideways scroll at 390 px).
 */
import { forwardRef, useId, type InputHTMLAttributes } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens } from "./tokens";

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** Hide the On/Off word (keep it for anything that is not obvious from the label). */
  hideState?: boolean;
  className?: string;
  "data-testid"?: string;
  /** v3: any data-* attribute is passed to the button. */
  [dataAttr: `data-${string}`]: string | number | boolean | undefined;
}

export function Switch({ checked, onChange, label, hint, disabled, hideState, className, ...rest }: SwitchProps) {
  const id = useId();
  const labelId = `${id}-l`;
  const hintId = `${id}-h`;
  return (
    <label className={cx(premiumTokens, styles.switchRow, className)} data-disabled={disabled ? "true" : undefined}>
      <span className={styles.switchText}>
        <span id={labelId} className={styles.switchLabel}>{label}</span>
        {hint ? <span id={hintId} className={styles.switchHint}>{hint}</span> : null}
      </span>
      {hideState ? null : <span className={styles.switchState} aria-hidden="true">{checked ? "On" : "Off"}</span>}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : undefined}
        disabled={disabled}
        className={styles.switch}
        {...dataAttributes(rest)}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.thumb} aria-hidden="true" />
      </button>
    </label>
  );
}

/** Pure: keeps only the data-* entries of a props object (exported for tests). */
export function dataAttributes(props: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const k of Object.keys(props)) {
    const v = props[k];
    if (k.startsWith("data-") && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) out[k] = v;
  }
  return out;
}

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size">;

/** Row checkbox: 48 x 48 hit box, 20 px mark. Give it an aria-label that names the row. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ className, ...rest }, ref) {
  return <input {...rest} ref={ref} type="checkbox" className={cx(premiumTokens, styles.check, className)} />;
});
