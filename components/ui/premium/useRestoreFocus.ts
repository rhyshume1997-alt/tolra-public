"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW v2). Inputs: open. Output: while open, remembers the element that had focus when it opened and gives focus back to it when it closes
 * or unmounts (a native dialog only does this itself when the same <dialog> element stays mounted). Declare it BEFORE the effect that calls showModal.
 * Must not change: it moves focus only back to an element that is still in the document; it reads and writes nothing else.
 */
import { useEffect, useRef } from "react";

export function useRestoreFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    // Kept across the development double-run of effects (the first cleanup cannot focus through the modal, so the opener must survive it).
    if (!opener.current || !opener.current.isConnected) opener.current = document.activeElement as HTMLElement | null;
    return () => {
      const o = opener.current;
      if (o && o.isConnected) { o.focus(); if (document.activeElement === o) opener.current = null; }
    };
  }, [open]);
}
