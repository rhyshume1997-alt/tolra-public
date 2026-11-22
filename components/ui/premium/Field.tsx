"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW v2). Inputs: Field {label, hint?, error?, required?, optional?, wide?, children}; Input, Textarea, Select: every native attribute of the element, plus invalid?.
 * Output: a labelled form row. The label is a real <label for>; the control inside a Field gets its id, aria-describedby (hint, then error), aria-invalid (when there is an error)
 * and aria-required from the Field, so the wiring cannot be forgotten. The visible control is 40 px high inside a 48 px box (a transparent 4 px top and bottom border is the hit area); states: hover,
 * focus ring, error (red edge, tint AND the error words, never colour alone), disabled. Input, Textarea and Select also work alone (give them an aria-label).
 * Must not change: it validates nothing and stores nothing: error is text the caller decides on. Inside a Field do not pass id (the Field owns it). Native controls only, so autofill,
 * mobile keyboards and date pickers keep working. Select is the browser's own list.
 */
import { createContext, forwardRef, useContext, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import styles from "./premium.module.css";
import { cx, premiumTokens, srOnly } from "./tokens";

interface FieldCtx { id: string; describedBy?: string; invalid: boolean; required: boolean }
const FieldContext = createContext<FieldCtx | null>(null);

/** Pure: the aria-describedby value for a field (hint first, then error), or undefined when it has neither. */
export function fieldDescribedBy(id: string, parts: { hint?: boolean; error?: boolean }): string | undefined {
  const ids = [parts.hint ? `${id}-hint` : "", parts.error ? `${id}-error` : ""].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  /** Adds "(required)" to the label and aria-required to the control. */
  required?: boolean;
  /** Adds "(optional)" to the label. */
  optional?: boolean;
  /** Spans every column of a grid parent. */
  wide?: boolean;
  className?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, required, optional, wide, className, children }: FieldProps) {
  const id = useId();
  const ctx: FieldCtx = { id, describedBy: fieldDescribedBy(id, { hint: !!hint, error: !!error }), invalid: !!error, required: !!required };
  return (
    <div className={cx(premiumTokens, styles.field, className)} style={wide ? { gridColumn: "1 / -1" } : undefined}>
      <label htmlFor={id} className={styles.fieldLabel}>
        {label}
        {required ? <span className={styles.fieldNote}> (required)</span> : optional ? <span className={styles.fieldNote}> (optional)</span> : null}
      </label>
      <FieldContext.Provider value={ctx}>{children}</FieldContext.Provider>
      {hint ? <p id={`${id}-hint`} className={styles.fieldHint}>{hint}</p> : null}
      {error ? <p id={`${id}-error`} className={styles.fieldError}><span className={srOnly}>Error: </span>{error}</p> : null}
    </div>
  );
}

/** What a control takes from its Field (or from its own props when used alone). */
function wire<P extends { id?: string; invalid?: boolean; required?: boolean; "aria-describedby"?: string; "aria-invalid"?: unknown }>(ctx: FieldCtx | null, p: P) {
  const own = p["aria-invalid"] === true || p["aria-invalid"] === "true";
  const invalid = p.invalid ?? (ctx?.invalid || own);
  return {
    id: ctx?.id ?? p.id,
    "aria-describedby": [ctx?.describedBy, p["aria-describedby"]].filter(Boolean).join(" ") || undefined,
    "aria-invalid": invalid ? (true as const) : undefined,
    "aria-required": (p.required ?? ctx?.required) ? (true as const) : undefined,
  };
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> { invalid?: boolean }
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ invalid, className, required, ...rest }, ref) {
  const ctx = useContext(FieldContext);
  return <input {...rest} required={required} {...wire(ctx, { ...rest, invalid, required })} ref={ref} className={cx(premiumTokens, styles.input, className)} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> { invalid?: boolean }
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ invalid, className, required, ...rest }, ref) {
  const ctx = useContext(FieldContext);
  return <textarea {...rest} required={required} {...wire(ctx, { ...rest, invalid, required })} ref={ref} className={cx(premiumTokens, styles.input, styles.inputArea, className)} />;
});

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> { invalid?: boolean }
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ invalid, className, required, children, ...rest }, ref) {
  const ctx = useContext(FieldContext);
  return <select {...rest} required={required} {...wire(ctx, { ...rest, invalid, required })} ref={ref} className={cx(premiumTokens, styles.input, styles.inputSelect, className)}>{children}</select>;
});
