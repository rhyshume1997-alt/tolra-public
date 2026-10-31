"use client";

import { loadExportPdfCode } from "@/lib/export-records";

/** How long the browser may stay busy before the code is fetched anyway (requestIdleCallback's timeout). */
const IDLE_TIMEOUT_MS = 10_000;
/** Browsers without requestIdleCallback (Safari): fetch this long after the page has loaded. */
const NO_IDLE_DELAY_MS = 2_000;

/** Set once the fetch has started, so it happens once per page load; cleared again if it failed. */
let started = false;

/**
 * The Job Board's Export PDF must work with no signal, even on a device that has never made a PDF. Its code is not part of the
 * page (it is the largest library in the app), so once the page has loaded, the device is online and the browser is idle, this
 * fetches the same modules the export loads (loadExportPdfCode), once. The service worker keeps the files for this deploy, and the
 * page keeps them in memory, so a later Export PDF needs no connection. Offline at the time: it waits for the device to come back
 * online. Failures are ignored: the export loads the code itself on the press, as before.
 * Marks <html data-pdf-warm="ready"> when done (read by tests/e2e/job-board-offline-pdf.spec.ts). Returns the effect's cleanup.
 */
export function warmPdfExport(): () => void {
  if (started || typeof window === "undefined") return () => undefined;
  let cancel: (() => void) | null = null;
  let disposed = false;

  const wait = (event: "online" | "load") => {
    window.addEventListener(event, arm, { once: true });
    cancel = () => window.removeEventListener(event, arm);
  };

  const warm = () => {
    cancel = null;
    if (started || disposed) return;
    if (!navigator.onLine) return wait("online");
    started = true;
    loadExportPdfCode().then(
      () => { document.documentElement.dataset.pdfWarm = "ready"; },
      () => {
        started = false;
        if (!disposed) wait("online");
      },
    );
  };

  function arm() {
    cancel = null;
    if (started || disposed) return;
    if (!navigator.onLine) return wait("online");
    if (document.readyState !== "complete") return wait("load");
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm, { timeout: IDLE_TIMEOUT_MS });
      cancel = () => window.cancelIdleCallback(id);
    } else {
      const id = window.setTimeout(warm, NO_IDLE_DELAY_MS);
      cancel = () => window.clearTimeout(id);
    }
  }

  arm();
  return () => {
    disposed = true;
    cancel?.();
  };
}
