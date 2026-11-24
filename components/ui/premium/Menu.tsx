"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: Menu {label, items[{id,label,onSelect,disabled?,separatorBefore?}]}; Popover {label, title, children}.
 * Output: a trigger button plus a layer in a portal. Menu is role="menu": arrows, Home/End, Escape (focus returns to the trigger), Tab closes.
 * Popover is a non-modal role="dialog" panel for controls such as a list of Switches: Escape or an outside press closes, focus returns.
 * Must not change: 32 px items (44 px on touch), 190 px minimum width, never taller than 420 px or the viewport, token class on the layer.
 * v2: a Popover puts first focus on the first ENABLED control (a disabled Switch or button is skipped; with none, the panel itself), and its Tab wrap uses the same list.
 * v4: the layer scales in from the trigger (transform origin from the placement) and fades out in 120 ms; opened or closed with the keyboard (Enter, Space, arrows, Escape) it does not animate at all. Hover only on a fine pointer.
 * It runs no action itself: onSelect is the caller's, and a disabled item says so by aria-disabled and stays out of the arrow order.
 * v3 (all optional, defaults unchanged): the trigger takes aria-label (name it for what it acts on, e.g. "More actions for Tomas Whitcombe"; keep the visible text inside it), fullWidth and className;
 * v5 (optional per item, defaults unchanged): danger (red words and a red tint on hover and focus; the LABEL must say what is destroyed, "Delete job J-0431", because colour is never the only signal; a screen reader also hears "destructive"; a separator is drawn before the first danger item unless one is already there),
 * testId (data-testid on the item button) and elementId (the DOM id of the item button; the item's own `id` stays its key and the base of its hint id).
 * an item takes hint (words shown under the label and read as its description: use it to say WHY an item is disabled) and title (a tooltip). The layer is named by aria-label when given.
 */
import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import styles from "./premium.module.css";
import { Button, type ButtonVariant } from "./Button";
import { cx, premiumTokens, srOnly } from "./tokens";
import { layerOriginStyle, useAnchoredLayer } from "./useAnchoredLayer";

export interface MenuItem {
  id: string; label: string; onSelect: () => void; disabled?: boolean; separatorBefore?: boolean;
  /** v3: visible reason or detail under the label. */ hint?: string;
  /** v3: tooltip. */ title?: string;
  /** v5: a destructive item (delete, remove, archive for good): red words, red tint on hover and focus, read as destructive. The label must say what is destroyed. */ danger?: boolean;
  /** v5: data-testid on the item button. */ testId?: string;
  /** v5: DOM id of the item button. */ elementId?: string;
}

/** Pure (v5): the items with a separator before the first danger item when it does not already have one and is not first (exported for tests). */
export function withDangerSeparator(items: MenuItem[]): MenuItem[] {
  const first = items.findIndex((i) => i.danger);
  if (first <= 0 || items[first].separatorBefore || items[first - 1].danger) return items;
  return items.map((it, i) => (i === first ? { ...it, separatorBefore: true } : it));
}

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

interface TriggerProps { label: string; variant?: ButtonVariant; size?: "sm" | "md" | "lg"; "data-testid"?: string; "aria-label"?: string; fullWidth?: boolean; className?: string }

export function Menu({ label, items, variant = "secondary", size = "md", ...rest }: TriggerProps & { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback((refocus = false) => { setOpen(false); if (refocus) trigger.current?.focus(); }, []);
  const { pos, portal, state, instant, markKeyboard } = useAnchoredLayer(open, trigger, layer, useCallback(() => close(true), [close]));

  const buttons = () => Array.from(layer.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  const focusAt = (i: number) => { if (i >= 0) buttons()[i]?.focus(); };
  const disabledFlags = items.map((i) => !!i.disabled);

  const openAndFocus = (which: "first" | "last", viaKeyboard = true) => {
    markKeyboard(viaKeyboard);
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
        aria-label={rest["aria-label"]}
        fullWidth={rest.fullWidth}
        className={cx(rest.fullWidth && styles.menuBlock, rest.className)}
        data-testid={rest["data-testid"]}
        onClick={(e) => (open ? close() : openAndFocus("first", e.detail === 0))}
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
          aria-label={rest["aria-label"] ?? label}
          className={cx(premiumTokens, styles.layer)}
          data-state={state}
          data-instant={instant ? "true" : undefined}
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, maxHeight: pos?.maxHeight, visibility: pos ? "visible" : "hidden", ...layerOriginStyle(pos) }}
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
          {withDangerSeparator(items).map((it) => (
            <div key={it.id} role="none">
              {it.separatorBefore ? <div className={styles.menuSep} role="separator" /> : null}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={it.disabled || undefined}
                aria-describedby={it.hint ? `${id}-h-${it.id}` : undefined}
                title={it.title}
                id={it.elementId}
                data-testid={it.testId}
                data-danger={it.danger ? "true" : undefined}
                className={cx(styles.menuItem, it.danger && styles.menuItemDanger)}
                onClick={() => { if (it.disabled) return; close(true); it.onSelect(); }}
              >
                {it.hint ? <span className={styles.menuItemText}><span>{it.label}</span><span id={`${id}-h-${it.id}`} className={styles.menuHint}>{it.hint}</span></span> : it.label}
                {it.danger ? <span className={srOnly}>, destructive</span> : null}
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
  const { pos, portal, state, instant, markKeyboard } = useAnchoredLayer(open, trigger, layer, close);

  return (
    <>
      <Button
        ref={trigger}
        variant={variant}
        size={size}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={rest["aria-label"]}
        fullWidth={rest.fullWidth}
        className={cx(rest.fullWidth && styles.menuBlock, rest.className)}
        data-testid={rest["data-testid"]}
        onClick={(e) => {
          markKeyboard(e.detail === 0);
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
          data-state={state}
          data-instant={instant ? "true" : undefined}
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, maxHeight: pos?.maxHeight, visibility: pos ? "visible" : "hidden", ...layerOriginStyle(pos) }}
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
