"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW v3). Inputs: FormGroup {title, headingLevel (default 3), hint?, columns (1 | 2), as ("group" default | "fieldset"), children (Fields)};
 * ErrorSummary {errors[{fieldId, message, label?}], title?, headingLevel?, focusSignal?}; DateRangeGroup {label, from, to, onFromChange, onToChange, onApply, applyLabel?, fromLabel?, toLabel?, error?, disabled?, large?}.
 * Output: FormGroup is a titled set of related fields (role="group" named by a real heading, or a <fieldset> with a <legend>) with a hairline above. ErrorSummary lists every problem as a link to its field (give each Field an id) and,
 * when focusSignal changes (increment it on each failed submit; it also fires when the summary first appears with a value above 0), moves focus to the FIRST invalid control, in the order you list them. DateRangeGroup is From, To and
 * Apply as native date inputs: when From is after To both inputs are aria-invalid and described by one error sentence, and Apply focuses From instead of calling onApply.
 * Must not change: none of them validates a business rule or stores anything: the caller decides which fields are invalid and what the words are (DateRangeGroup only checks the order of the two dates, or shows the error you pass);
 * an error is always words; the summary never claims success.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import styles from "./premium.module.css";
import { Button } from "./Button";
import { Field, Input } from "./Field";
import type { HeadingLevel } from "./StatePanels";
import { cx, premiumTokens, srOnly } from "./tokens";

const tag = (n: HeadingLevel) => `h${n}` as "h2" | "h3" | "h4" | "h5" | "h6";

/* ------------------------------ FormGroup ------------------------------ */

export interface FormGroupProps {
  title: string;
  headingLevel?: HeadingLevel;
  hint?: string;
  columns?: 1 | 2;
  /** "group" (default): role=group with a heading; "fieldset": a native fieldset with a legend (for a set of radios or checkboxes). */
  as?: "group" | "fieldset";
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}

export function FormGroup({ title, headingLevel = 3, hint, columns = 1, as = "group", className, children, ...rest }: FormGroupProps) {
  const id = useId();
  const H = tag(headingLevel);
  const body = <div className={styles.groupBody} style={{ ["--cols" as string]: columns }}>{children}</div>;
  const hintEl = hint ? <p id={`${id}-h`} className={styles.groupHint}>{hint}</p> : null;
  if (as === "fieldset") {
    return (
      <fieldset aria-describedby={hint ? `${id}-h` : undefined} data-testid={rest["data-testid"]} className={cx(premiumTokens, styles.group, className)}>
        <legend className={styles.groupTitle}>{title}</legend>
        {hintEl}
        {body}
      </fieldset>
    );
  }
  return (
    <div role="group" aria-labelledby={`${id}-t`} aria-describedby={hint ? `${id}-h` : undefined} data-testid={rest["data-testid"]} className={cx(premiumTokens, styles.group, className)}>
      <H id={`${id}-t`} className={styles.groupTitle}>{title}</H>
      {hintEl}
      {body}
    </div>
  );
}

/* ------------------------------ ErrorSummary ------------------------------ */

export interface ErrorSummaryItem { fieldId: string; message: string; label?: string }

/** Pure: the first candidate that exists and is not disabled (null entries are controls that were not found). Exported for tests. */
export function pickInvalidTarget<T extends { disabled?: boolean }>(candidates: ReadonlyArray<T | null>): T | null {
  for (const c of candidates) if (c && !c.disabled) return c;
  return null;
}

/** Moves focus to the first invalid control: the first listed error whose control exists, else the first [aria-invalid="true"] inside scope. Returns the element focused, or null. */
export function focusFirstInvalid(errors: ReadonlyArray<ErrorSummaryItem>, scope: ParentNode = document): HTMLElement | null {
  const byId = errors.map((e) => document.getElementById(e.fieldId) as HTMLElement | null);
  const target = pickInvalidTarget(byId as Array<(HTMLElement & { disabled?: boolean }) | null>) ?? (scope.querySelector('[aria-invalid="true"]') as HTMLElement | null);
  target?.focus();
  return target;
}

export interface ErrorSummaryProps {
  errors: ReadonlyArray<ErrorSummaryItem>;
  title?: string;
  headingLevel?: HeadingLevel;
  /** Increment on every failed submit. Focus moves to the first invalid control when it changes (and on first show when above 0). */
  focusSignal?: number;
  className?: string;
  "data-testid"?: string;
}

export function ErrorSummary({ errors, title = "Fix these before saving", headingLevel = 3, focusSignal, className, ...rest }: ErrorSummaryProps) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const H = tag(headingLevel);
  useEffect(() => {
    if (!focusSignal || errors.length === 0) return;
    focusFirstInvalid(errors, (ref.current?.closest("form, dialog") as ParentNode | null) ?? document);
    // errors is read when the signal fires; a re-render with the same signal must not steal focus again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSignal]);
  if (errors.length === 0) return null;
  return (
    <section ref={ref} aria-labelledby={`${id}-t`} data-testid={rest["data-testid"]} className={cx(premiumTokens, styles.callout, styles.callout_error, className)}>
      <div className={styles.calloutText}>
        <H id={`${id}-t`} className={styles.errTitle}>{title}</H>
        <ul className={styles.errList}>
          {errors.map((e) => (
            <li key={e.fieldId + e.message}>
              <a
                href={`#${e.fieldId}`}
                className={styles.errLink}
                onClick={(ev) => { ev.preventDefault(); document.getElementById(e.fieldId)?.focus(); }}
              >
                {e.label ? <><span className={styles.errLabel}>{e.label}</span>: </> : null}{e.message}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------ DateRangeGroup ------------------------------ */

/** Pure: the sentence for a range whose start is after its end (ISO yyyy-mm-dd strings compare as text), or undefined. Exported for tests. */
export function rangeError(from: string, to: string, names: { from?: string; to?: string } = {}): string | undefined {
  if (from && to && from > to) return `${names.from ?? "From"} must be on or before ${names.to ?? "To"}.`;
  return undefined;
}

export interface DateRangeGroupProps {
  label: string;
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onApply: () => void;
  applyLabel?: string;
  fromLabel?: string;
  toLabel?: string;
  /** Your own error sentence (for example from the server); otherwise the order check above is used. */
  error?: string;
  disabled?: boolean;
  /** 16 px text and 48 px visible controls. */
  large?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function DateRangeGroup({ label, from, to, onFromChange, onToChange, onApply, applyLabel = "Apply", fromLabel = "From", toLabel = "To", error, disabled, large, className, ...rest }: DateRangeGroupProps) {
  const id = useId();
  const fromRef = useRef<HTMLInputElement>(null);
  const err = error ?? rangeError(from, to, { from: fromLabel, to: toLabel });
  const errId = err ? `${id}-e` : undefined;
  return (
    <div role="group" aria-label={label} data-testid={rest["data-testid"]} className={cx(premiumTokens, styles.range, className)}>
      <div className={styles.rangeRow}>
        <Field label={fromLabel} large={large}>
          <Input ref={fromRef} type="date" value={from} disabled={disabled} invalid={!!err} aria-describedby={errId} onChange={(e) => onFromChange(e.target.value)} data-testid={rest["data-testid"] ? `${rest["data-testid"]}-from` : undefined} />
        </Field>
        <Field label={toLabel} large={large}>
          <Input type="date" value={to} disabled={disabled} invalid={!!err} aria-describedby={errId} onChange={(e) => onToChange(e.target.value)} data-testid={rest["data-testid"] ? `${rest["data-testid"]}-to` : undefined} />
        </Field>
        <div className={styles.rangeApply} style={large ? { paddingBottom: 0 } : undefined}>
          <Button variant="secondary" size={large ? "lg" : "md"} disabled={disabled} onClick={() => { if (err) { fromRef.current?.focus(); return; } onApply(); }}>{applyLabel}</Button>
        </div>
      </div>
      {err ? <p id={errId} className={styles.rangeError}><span className={srOnly}>Error: </span>{err}</p> : null}
    </div>
  );
}
