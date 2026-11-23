"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: open, title, description?, children?, confirmLabel, onConfirm, onClose, busy?, error?, confirmDisabled?.
 * Output: a modal on the native <dialog> element (focus is trapped, the page behind is inert, Escape asks to close, focus returns to the opener).
 * ONE pattern only: a navy primary button on the right, an outlined Cancel beside it, 40 px high, 14 px radius. No tones, no yellow, no blue.
 * v2: optional middle action (secondaryLabel + onSecondary + secondaryDisabled?): order is Cancel, secondary, primary; without it the dialog is exactly as before. With it Cancel turns quiet so
 * the navy primary stays the one strong choice. Busy disables Cancel and the secondary too.
 * v3 nesting: a Dialog inside a Sheet (or another Dialog) handles only its OWN cancel and Tab events (target check, and the Tab wrap counts only its own controls), so Escape closes just the inner one.
 * v4: it scales in from 0.95 with a fade (200 ms, centred) and leaves in 120 ms: the content stays rendered while it leaves, then the native dialog closes (data-state on the dialog drives the CSS transition).
 * v5 (optional, defaults unchanged): tone="danger" is the destructive-confirm convention: the title names the verb and the thing ("Delete job J-0431?"), the description (and children) say what is lost, the confirm is the RED solid button named with that verb
 * ("Delete job", never "OK" or "Yes"), Cancel is the first focus (a destructive dialog never lands on the red button), the dialog is role="alertdialog", and a thin red top edge repeats it. Navy primary stays for every non-destructive confirm.
 * description may now hold several lines: a line break ("\n") in the text is kept (white-space: pre-line), and a React node is accepted for richer text (a list of what will be lost goes in children). confirmTestId and cancelTestId pass a data-testid to the two buttons.
 * Must not change: it is controlled (it closes only when the caller sets open to false); the first focus is Cancel for plain confirmations; an
 * `error` is shown inside the dialog and never turns into a success message. It performs nothing: onConfirm is the caller's real action.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import styles from "./premium.module.css";
import { Button } from "./Button";
import { cx, premiumTokens } from "./tokens";
import { useModalPresence } from "./usePresence";

export interface DialogProps {
  open: boolean;
  title: string;
  /** v5: a string (a "\n" starts a new line) or a node. */
  description?: ReactNode;
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
  /** v5: "danger" = the destructive confirm: red solid confirm, first focus on Cancel, role alertdialog. Default "default" is exactly v4. */
  tone?: "default" | "danger";
  /** v5: data-testid for the confirm and cancel buttons. */
  confirmTestId?: string;
  cancelTestId?: string;
}

export function Dialog({ open, title, description, children, confirmLabel, cancelLabel = "Cancel", onConfirm, onClose, busy, error, confirmDisabled, secondaryLabel, onSecondary, secondaryDisabled, tone = "default", confirmTestId, cancelTestId }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const hasSecondary = !!secondaryLabel && !!onSecondary;
  const danger = tone === "danger";
  const { shown, state } = useModalPresence(open);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (shown && !d.open) {
      d.showModal();
      // v5: a destructive dialog always starts on Cancel, even when it holds fields before the buttons.
      if (danger) d.querySelector<HTMLElement>("[data-dialog-cancel]")?.focus();
    }
    if (!shown && d.open) d.close();
  }, [shown, danger]);
  return (
    <dialog
      ref={ref}
      className={cx(premiumTokens, styles.dialog, danger && styles.dialogDanger)}
      role={danger ? "alertdialog" : undefined}
      aria-labelledby={`${id}-t`}
      aria-describedby={description ? `${id}-d` : undefined}
      data-state={state}
      onCancel={(e) => { if (e.target !== e.currentTarget) return; e.preventDefault(); if (!busy) onClose(); }}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const self = ref.current;
        if (!self || (e.target as HTMLElement).closest("dialog") !== self) return;
        const f = Array.from(self.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select, textarea, [href], [tabindex]:not([tabindex="-1"])')).filter((el) => el.closest("dialog") === self);
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        // Keep Tab inside the dialog: wrap at both ends.
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }}
    >
      {shown ? (
        <>
          <h2 id={`${id}-t`} className={styles.dialogTitle}>{title}</h2>
          {description ? <p id={`${id}-d`} className={styles.dialogDesc}>{description}</p> : null}
          {children ? <div className={styles.dialogBody}>{children}</div> : null}
          {error ? <p role="alert" className={styles.dialogError}>{error}</p> : null}
          <div className={styles.dialogActions}>
            <Button variant={hasSecondary ? "quiet" : "secondary"} onClick={onClose} disabled={busy} data-dialog-cancel="true" data-testid={cancelTestId}>{cancelLabel}</Button>
            {hasSecondary ? <Button variant="secondary" onClick={onSecondary} disabled={busy || secondaryDisabled}>{secondaryLabel}</Button> : null}
            <Button variant={danger ? "dangerSolid" : "primary"} onClick={onConfirm} loading={busy} disabled={confirmDisabled} data-testid={confirmTestId}>{confirmLabel}</Button>
          </div>
        </>
      ) : null}
    </dialog>
  );
}
