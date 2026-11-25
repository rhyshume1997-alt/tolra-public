"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: open, the anchor element, a close callback. Output: a position (fixed, flips above when
 * there is no room below, capped to the viewport) and a portal into the page's <main> (else document.body), so a menu is never clipped
 * by a scrolling table and still sits inside a landmark for assistive technology.
 * v4: the layer stays mounted for 120 ms after it closes so it can fade and scale out (state "closed" then unmount), it scales from the trigger (originX: px from the layer's left edge to the anchor centre, originY "0%" below the
 * anchor or "100%" above it), and when the person opened or closed it with the keyboard it does not animate at all (instant). `state` is the data-state for the layer ("open" | "closed"); `instant` goes to data-instant.
 * Must not change: the portal layer always gets the token class (it is outside the page root); Escape and an outside press close it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePresence, useEntered } from "./usePresence";

export interface LayerPosition { top: number; left: number; maxHeight: number; origin: string; /** v4: px from the layer's left edge to the anchor's centre (clamped into the layer). */ originX: number; /** v4: "0%" when the layer opens below the anchor, "100%" when it flipped above. */ originY: string }

/** Pure placement maths, exported for tests. */
export function placeLayer(anchor: { top: number; bottom: number; left: number; right: number }, size: { width: number; height: number }, viewport: { width: number; height: number }, gap = 6): LayerPosition {
  const below = viewport.height - anchor.bottom - gap - 8;
  const above = anchor.top - gap - 8;
  const flip = size.height > below && above > below;
  const room = flip ? above : below;
  const height = Math.min(size.height, Math.max(room, 120));
  const top = flip ? Math.max(8, anchor.top - gap - height) : anchor.bottom + gap;
  const left = Math.min(Math.max(8, anchor.left), Math.max(8, viewport.width - size.width - 8));
  const originX = Math.round(Math.min(Math.max((anchor.left + anchor.right) / 2 - left, 12), Math.max(size.width - 12, 12)));
  return { top, left, maxHeight: Math.max(room, 120), origin: `${flip ? "bottom" : "top"} left`, originX, originY: flip ? "100%" : "0%" };
}

/** Pure: the inline custom properties that make a layer scale in from its trigger (exported for tests). */
export function layerOriginStyle(pos: LayerPosition | null): CSSProperties {
  return { ["--origin" as string]: pos?.origin, ["--origin-x" as string]: pos ? `${pos.originX}px` : undefined, ["--origin-y" as string]: pos?.originY };
}

export function useAnchoredLayer(open: boolean, anchorRef: RefObject<HTMLElement | null>, layerRef: RefObject<HTMLElement | null>, onClose: () => void) {
  const [pos, setPos] = useState<LayerPosition | null>(null);
  const [mounted, setMounted] = useState(false);
  const keyboard = useRef(false);
  const [instant, setInstant] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  /** Call before opening or closing: true when a key (not a pointer) caused it, so the layer appears and goes without animation. */
  const markKeyboard = useCallback((viaKeyboard: boolean) => { keyboard.current = viaKeyboard; setInstant(viaKeyboard); }, []);
  const present = usePresence(open, keyboard.current ? 0 : undefined);
  const entered = useEntered(open && !!pos);

  const measure = useCallback(() => {
    const a = anchorRef.current;
    const l = layerRef.current;
    if (!a || !l) return;
    const r = a.getBoundingClientRect();
    setPos(placeLayer(r, { width: l.offsetWidth, height: l.scrollHeight + 10 }, { width: window.innerWidth, height: window.innerHeight }));
  }, [anchorRef, layerRef]);

  useLayoutEffect(() => { if (open) measure(); }, [open, measure]);
  useLayoutEffect(() => { if (!present) setPos(null); }, [present]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      keyboard.current = false; setInstant(false);
      const t = e.target as Node;
      if (layerRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { keyboard.current = true; if (e.key === "Escape") { e.stopPropagation(); setInstant(true); onClose(); } };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, measure, onClose, anchorRef, layerRef]);

  const portal = useCallback((node: ReactNode) => (mounted && present ? createPortal(node, anchorRef.current?.closest("main") ?? document.body) : null), [mounted, present, anchorRef]);
  return { pos, portal, state: (open && (entered || instant) ? "open" : "closed") as "open" | "closed", instant, markKeyboard };
}
