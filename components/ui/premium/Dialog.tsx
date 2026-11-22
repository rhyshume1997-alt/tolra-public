"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: open, title, description?, children?, confirmLabel, onConfirm, onClose, busy?, error?, confirmDisabled?.
 * Output: a modal on the native <dialog> element (focus is trapped, the page behind is inert, Escape asks to close, focus returns to the opener).
 * ONE pattern only: a navy primary button on the right, an outlined Cancel beside it, 40 px high, 14 px radius. No tones, no yellow, no blue.
 * v2: optional middle action (secondaryLabel + onSecondary + secondaryDisabled?): order is Cancel, secondary, primary; without it the dialog is exactly as before. With it Cancel turns quiet so
 * the navy primary stays the one strong choice. Busy disables Cancel and the secondary too.
 * Must not change: it is controlled (it closes only when the caller sets open to false); the first focus is Cancel for plain confirmations; an
 * `error` is shown inside the dialog and never turns into a success message. It performs nothing: onConfirm is the caller's real action.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import styles from "./premium.module.css";
import { Button } from "./Button";
import { cx, premiumTokens } from "./tokens";

export interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
  error?: string;
  confirmDisabled?: boolean;
  /** v2: a middle action such as "Save as draft". Needs secondaryLabel AND onSecondary; otherwise nothing extra is drawn. */
  secondaryLabel?: string;
  onSecondary?: () => void;
  secondaryDisabled?: boolean;
}

export function Dialog({ open, title, description, children, confirmLabel, cancelLabel = "Cancel", onConfirm, onClose, busy, error, confirmDisabled, secondaryLabel, onSecondary, secondaryDisabled }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const hasSecondary = !!secondaryLabel && !!onSecondary;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={cx(premiumTokens, styles.dialog)}
      aria-labelledby={`${id}-t`}
      aria-describedby={description ? `${id}-d` : undefined}
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const f = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select, textarea, [href], [tabindex]:not([tabindex="-1"])') ?? []);
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        // Keep Tab inside the dialog: wrap at both ends.
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }}
    >
      {open ? (
        <>
          <h2 id={`${id}-t`} className={styles.dialogTitle}>{title}</h2>
          {description ? <p id={`${id}-d`} className={styles.dialogDesc}>{description}</p> : null}
          {children ? <div className={styles.dialogBody}>{children}</div> : null}
          {error ? <p role="alert" className={styles.dialogError}>{error}</p> : null}
          <div className={styles.dialogActions}>
            <Button variant={hasSecondary ? "quiet" : "secondary"} onClick={onClose} disabled={busy}>{cancelLabel}</Button>
            {hasSecondary ? <Button variant="secondary" onClick={onSecondary} disabled={busy || secondaryDisabled}>{secondaryLabel}</Button> : null}
            <Button variant="primary" onClick={onConfirm} loading={busy} disabled={confirmDisabled}>{confirmLabel}</Button>
          </div>
        </>
      ) : null}
    </dialog>
  );
}
