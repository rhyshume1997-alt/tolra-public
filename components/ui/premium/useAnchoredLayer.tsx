"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW). Inputs: open, the anchor element, a close callback. Output: a position (fixed, flips above when
 * there is no room below, capped to the viewport) and a portal into the page's <main> (else document.body), so a menu is never clipped
 * by a scrolling table and still sits inside a landmark for assistive technology.
 * Must not change: the portal layer always gets the token class (it is outside the page root); Escape and an outside press close it.
 */
import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export interface LayerPosition { top: number; left: number; maxHeight: number; origin: string }

/** Pure placement maths, exported for tests. */
export function placeLayer(anchor: { top: number; bottom: number; left: number; right: number }, size: { width: number; height: number }, viewport: { width: number; height: number }, gap = 6): LayerPosition {
  const below = viewport.height - anchor.bottom - gap - 8;
  const above = anchor.top - gap - 8;
  const flip = size.height > below && above > below;
  const room = flip ? above : below;
  const height = Math.min(size.height, Math.max(room, 120));
  const top = flip ? Math.max(8, anchor.top - gap - height) : anchor.bottom + gap;
  const left = Math.min(Math.max(8, anchor.left), Math.max(8, viewport.width - size.width - 8));
  return { top, left, maxHeight: Math.max(room, 120), origin: `${flip ? "bottom" : "top"} left` };
}

export function useAnchoredLayer(open: boolean, anchorRef: RefObject<HTMLElement | null>, layerRef: RefObject<HTMLElement | null>, onClose: () => void) {
  const [pos, setPos] = useState<LayerPosition | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const measure = useCallback(() => {
    const a = anchorRef.current;
    const l = layerRef.current;
    if (!a || !l) return;
    const r = a.getBoundingClientRect();
    setPos(placeLayer(r, { width: l.offsetWidth, height: l.scrollHeight + 10 }, { width: window.innerWidth, height: window.innerHeight }));
  }, [anchorRef, layerRef]);

  useLayoutEffect(() => { if (open) measure(); else setPos(null); }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (layerRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
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

  const portal = useCallback((node: ReactNode) => (mounted && open ? createPortal(node, anchorRef.current?.closest("main") ?? document.body) : null), [mounted, open, anchorRef]);
  return { pos, portal };
}
