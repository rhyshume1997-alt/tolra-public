"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: Menu {label, items[{id,label,onSelect,disabled?,separatorBefore?}]}; Popover {label, title, children}.
 * Output: a trigger button plus a layer in a portal. Menu is role="menu": arrows, Home/End, Escape (focus returns to the trigger), Tab closes.
 * Popover is a non-modal role="dialog" panel for controls such as a list of Switches: Escape or an outside press closes, focus returns.
 * Must not change: 32 px items (44 px on touch), 190 px minimum width, never taller than 420 px or the viewport, token class on the layer.
 * v2: a Popover puts first focus on the first ENABLED control (a disabled Switch or button is skipped; with none, the panel itself), and its Tab wrap uses the same list.
 * It runs no action itself: onSelect is the caller's, and a disabled item says so by aria-disabled and stays out of the arrow order.
 */
import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import styles from "./premium.module.css";
import { Button, type ButtonVariant } from "./Button";
import { cx, premiumTokens } from "./tokens";
import { useAnchoredLayer } from "./useAnchoredLayer";

export interface MenuItem { id: string; label: string; onSelect: () => void; disabled?: boolean; separatorBefore?: boolean }

/** Pure roving index for menu keys (exported for tests). Returns the next enabled index, or -1 when there is none. */
export function nextMenuIndex(current: number, disabled: boolean[], key: "ArrowDown" | "ArrowUp" | "Home" | "End"): number {
  const n = disabled.length;
  if (n === 0 || disabled.every(Boolean)) return -1;
  if (key === "Home") return disabled.findIndex((d) => !d);
  if (key === "End") { for (let i = n - 1; i >= 0; i--) if (!disabled[i]) return i; return -1; }
  const step = key === "ArrowDown" ? 1 : -1;
  let i = current;
  for (let k = 0; k < n; k++) { i = (i + step + n) % n; if (!disabled[i]) return i; }
  return -1;
}

const POP_FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Pure: the first element that is neither disabled nor aria-disabled (exported for tests; takes anything with the two attributes). */
export function pickFirstEnabled<E extends { disabled?: boolean; getAttribute(name: string): string | null }>(els: ArrayLike<E>): E | null {
  for (let i = 0; i < els.length; i++) {
    const e = els[i];
    if (!e.disabled && e.getAttribute("aria-disabled") !== "true") return e;
  }
  return null;
}
const enabledIn = (root: ParentNode | null) => Array.from(root?.querySelectorAll<HTMLElement>(POP_FOCUSABLE) ?? []).filter((e) => pickFirstEnabled([e as HTMLElement & { disabled?: boolean }]));

interface TriggerProps { label: string; variant?: ButtonVariant; size?: "sm" | "md" | "lg"; "data-testid"?: string }

export function Menu({ label, items, variant = "secondary", size = "md", ...rest }: TriggerProps & { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback((refocus = false) => { setOpen(false); if (refocus) trigger.current?.focus(); }, []);
  const { pos, portal } = useAnchoredLayer(open, trigger, layer, useCallback(() => close(true), [close]));

  const buttons = () => Array.from(layer.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  const focusAt = (i: number) => { if (i >= 0) buttons()[i]?.focus(); };
  const disabledFlags = items.map((i) => !!i.disabled);

  const openAndFocus = (which: "first" | "last") => {
    setOpen(true);
    requestAnimationFrame(() => requestAnimationFrame(() => focusAt(which === "first" ? nextMenuIndex(-1, disabledFlags, "Home") : nextMenuIndex(0, disabledFlags, "End"))));
  };

  return (
    <>
      <Button
        ref={trigger}
        variant={variant}
        size={size}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-testid={rest["data-testid"]}
        onClick={() => (open ? close() : openAndFocus("first"))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); openAndFocus("first"); }
          if (e.key === "ArrowUp") { e.preventDefault(); openAndFocus("last"); }
        }}
      >
        {label}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 3.6 5 6.6 8 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </Button>
      {portal(
        <div
          ref={layer}
          id={id}
          role="menu"
          aria-label={label}
          className={cx(premiumTokens, styles.layer)}
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, maxHeight: pos?.maxHeight, visibility: pos ? "visible" : "hidden", ["--origin" as string]: pos?.origin }}
          onKeyDown={(e) => {
            const idx = buttons().indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
              e.preventDefault();
              focusAt(nextMenuIndex(idx, disabledFlags, e.key));
            } else if (e.key === "Tab") {
              close();
            }
          }}
        >
          {items.map((it) => (
            <div key={it.id} role="none">
              {it.separatorBefore ? <div className={styles.menuSep} role="separator" /> : null}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={it.disabled || undefined}
                className={styles.menuItem}
                onClick={() => { if (it.disabled) return; close(true); it.onSelect(); }}
              >
                {it.label}
              </button>
            </div>
          ))}
        </div>,
      )}
    </>
  );
}

export function Popover({ label, title, children, variant = "secondary", size = "md", ...rest }: TriggerProps & { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => { setOpen(false); trigger.current?.focus(); }, []);
  const { pos, portal } = useAnchoredLayer(open, trigger, layer, close);

  return (
    <>
      <Button
        ref={trigger}
        variant={variant}
        size={size}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-testid={rest["data-testid"]}
        onClick={() => {
          if (open) { setOpen(false); return; }
          setOpen(true);
          requestAnimationFrame(() => requestAnimationFrame(() => { (enabledIn(layer.current)[0] ?? layer.current)?.focus(); }));
        }}
      >
        {label}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 3.6 5 6.6 8 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </Button>
      {portal(
        <div
          ref={layer}
          id={id}
          role="dialog"
          aria-label={title}
          tabIndex={-1}
          className={cx(premiumTokens, styles.layer, styles.popPanel)}
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, maxHeight: pos?.maxHeight, visibility: pos ? "visible" : "hidden", ["--origin" as string]: pos?.origin }}
          onKeyDown={(e) => {
            if (e.key !== "Tab") return;
            const f = enabledIn(layer.current);
            const first = f[0];
            const last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); close(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); close(); }
          }}
        >
          <p className={styles.popTitle}>{title}</p>
          {children}
        </div>,
      )}
    </>
  );
}
