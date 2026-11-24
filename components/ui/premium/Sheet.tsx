"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW v2). Inputs: open, title (node), description?, size ("sm" 520 | "md" 680 | "lg" 860 px wide), children (the scrolling body), footer (the caller's own buttons),
 * onClose, closeButton? (default true: a quiet Close in the header), closeLabel?, dismissible? (default true), testId?.
 * Output: a wide modal on the native <dialog>: header, a body that scrolls on its own (and is reachable by keyboard when it does), a footer of the caller's choosing. Focus is trapped (Tab wraps),
 * the page behind is inert, Escape asks to close through onClose, and focus goes back to the element that opened it, even when the caller unmounts the sheet to close it.
 * Must not change: it is controlled (it closes only when the caller stops rendering it or sets open to false); it performs nothing itself, the footer buttons are the caller's real actions;
 * dismissible={false} (for an action in flight) blocks Escape and hides the Close button but never traps the person without the caller's own way out.
 * v4: same entrance as Dialog (scale from 0.95 with a fade, 240 ms, centred) and a 120 ms exit; when the caller sets open to false the content stays rendered while it leaves (a caller that unmounts it simply removes it).
 * v3 nesting: a Sheet or Dialog rendered INSIDE a Sheet is a nested modal. Its cancel (Escape) and Tab events travel up the React tree, so each handler first checks that the event came from its OWN dialog
 * (target check) and the Tab wrap only counts controls that belong to its own dialog (nesting-aware trap): Escape closes only the inner one, Tab never escapes it, and the outer one is left alone.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import styles from "./premium.module.css";
import { Button } from "./Button";
import { cx, premiumTokens } from "./tokens";
import { useRestoreFocus } from "./useRestoreFocus";
import { useModalPresence } from "./usePresence";

export interface SheetProps {
  open: boolean;
  title: ReactNode;
  description?: string;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  closeButton?: boolean;
  closeLabel?: string;
  dismissible?: boolean;
  testId?: string;
}

const TABBABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function Sheet({ open, title, description, size = "md", children, footer, onClose, closeButton = true, closeLabel = "Close", dismissible = true, testId }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const uid = useId();
  const [scrolls, setScrolls] = useState(false);
  const { shown, state } = useModalPresence(open);
  useRestoreFocus(shown);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (shown && !d.open) d.showModal();
    if (!shown && d.open) d.close();
  }, [shown]);
  // A body that overflows must be reachable by keyboard (so it can be scrolled with the arrow keys).
  useEffect(() => {
    const b = body.current;
    if (!shown || !b) return;
    const check = () => setScrolls(b.scrollHeight > b.clientHeight + 1);
    check();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(check) : null;
    ro?.observe(b);
    return () => ro?.disconnect();
  }, [shown, children]);
  return (
    <dialog
      ref={ref}
      className={cx(premiumTokens, styles.sheet, styles[`sheet_${size}`])}
      aria-labelledby={`${uid}-t`}
      aria-describedby={description ? `${uid}-d` : undefined}
      data-testid={testId}
      data-state={state}
      onCancel={(e) => { if (e.target !== e.currentTarget) return; e.preventDefault(); if (dismissible) onClose(); }}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const self = ref.current;
        if (!self || (e.target as HTMLElement).closest("dialog") !== self) return;
        const f = Array.from(self.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => el.closest("dialog") === self);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }}
    >
      {shown ? (
        <div className={styles.sheetInner}>
          <header className={styles.sheetHead}>
            <div className={styles.sheetHeadText}>
              <h2 id={`${uid}-t`} className={styles.sheetTitle}>{title}</h2>
              {description ? <p id={`${uid}-d`} className={styles.sheetDesc}>{description}</p> : null}
            </div>
            {closeButton && dismissible ? <Button size="sm" variant="quiet" onClick={onClose}>{closeLabel}</Button> : null}
          </header>
          <div
            ref={body}
            className={styles.sheetBody}
            tabIndex={scrolls ? 0 : undefined}
            role={scrolls ? "region" : undefined}
            aria-labelledby={scrolls ? `${uid}-t` : undefined}
          >
            {children}
          </div>
          <footer className={styles.sheetFoot}>{footer}</footer>
        </div>
      ) : null}
    </dialog>
  );
}
