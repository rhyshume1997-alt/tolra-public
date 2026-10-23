"use client";

import { useState, useSyncExternalStore } from "react";
import { CloudCheck, CloudOff, CloudUpload, RefreshCw, TriangleAlert } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { outboxState, useOfflineStatus } from "@/lib/offline/scope";
import { syncNow } from "@/lib/offline/sync";
import { describeChange, queuedAtLabel, retryOutcome, syncIndicator, type SyncIndicator, type SyncKind } from "@/lib/sync-status";
import { cn } from "@/lib/utils";

const subscribeOnline = (callback: () => void) => {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
};
/** navigator.onLine, kept current; true on the server and where the browser doesn't say. */
function useBrowserOnline() {
  return useSyncExternalStore(subscribeOnline, () => (typeof navigator === "undefined" ? true : navigator.onLine !== false), () => true);
}

const ICON: Record<SyncKind, typeof CloudCheck> = { synced: CloudCheck, offline: CloudOff, pending: CloudUpload, failed: TriangleAlert };
/** The chip's text colour per tone; pending uses the colour map's blue (sync_pending, lib/status-colours.ts). */
export const SYNC_TONE: Record<SyncIndicator["tone"], string> = {
  good: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  pending: "text-[#2563EB] dark:text-[#60A5FA]",
  bad: "text-red-700 dark:text-red-400",
};

/**
 * Always-visible sync state in the top bar (every width): Online and synced / Offline / N waiting to upload / Upload failed.
 * Driven by the IndexedDB outbox (lib/offline). It sits in the bar's own row, so it never covers a control; tapping it opens a
 * small panel listing what is waiting, with Retry. Changes of state are announced politely to assistive technology.
 */
export function SyncStatus({ className }: { className?: string }) {
  const status = useOfflineStatus();
  const browserOnline = useBrowserOnline();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const held = [...status.conflicts, ...status.rejected];
  const state = syncIndicator({ offline: status.offline, browserOnline, pending: status.pending, held: held.length });
  const Icon = ICON[state.kind];

  async function retry() {
    setBusy(true);
    let threw = false;
    let ran = false;
    try {
      ran = (await syncNow()) !== null;
    } catch {
      threw = true;
    }
    try {
      // The pass's own result leaves out changes held by earlier passes: say what the whole outbox looks like now.
      const outcome = retryOutcome({ ran, threw, outbox: await outboxState() });
      const action = outcome.showDetails ? { label: "Show details", onClick: showDetails } : undefined;
      if (outcome.tone === "success") toast.success(outcome.message);
      else if (outcome.tone === "info") toast.info(outcome.message);
      else toast.warning(outcome.message, { action });
    } finally {
      setBusy(false);
    }
  }

  function showDetails() {
    setOpen(false);
    document.getElementById("offline-notice")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          data-testid="sync-status"
          data-sync={state.kind}
          aria-label={`Sync status: ${state.label}`}
          title={state.label}
          className={cn(
            "flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-2 text-xs font-medium outline-none transition hover:bg-ink/[0.06] focus-visible:ring-3 focus-visible:ring-brand-accent/35 pointer-coarse:h-11 pointer-coarse:min-w-11",
            SYNC_TONE[state.tone],
            className,
          )}
        >
          <Icon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden />
          <span className="hidden whitespace-nowrap sm:inline" data-testid="sync-status-text">{state.short}</span>
        </button>
      </PopoverPrimitive.Trigger>
      {/* Polite: a change of state is read out once, without interrupting. */}
      <span className="sr-only" aria-live="polite" data-testid="sync-status-live">{state.label}</span>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          collisionPadding={16}
          aria-label="Sync status"
          data-testid="sync-panel"
          className="z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-line bg-white p-3 text-sm text-slate-900 shadow-lg outline-none dark:bg-slate-900 dark:text-slate-100"
        >
          <p className={cn("flex items-center gap-2 font-semibold", SYNC_TONE[state.tone])}><Icon className="size-4 shrink-0" aria-hidden />{state.label}</p>
          {state.kind === "synced" ? <p className="mt-1 text-slate-500">Everything you changed on this device has reached the server.</p> : null}
          {state.kind === "offline" ? <p className="mt-1 text-slate-500">Keep working: changes are kept on this device and upload by themselves when the connection is back.</p> : null}

          {status.pendingItems.length ? (
            <>
              <p className="mt-3 text-xs font-medium uppercase tracking-wide text-slate-500">Waiting to upload</p>
              <ul aria-label="Changes waiting to upload" className="mt-1 max-h-48 space-y-1 overflow-y-auto">
                {status.pendingItems.map((item) => (
                  <li key={item.id} className="flex items-baseline justify-between gap-2 rounded-md bg-slate-50 px-2 py-1.5 dark:bg-slate-800">
                    <span className="min-w-0 truncate">{describeChange(item.op)}</span>
                    <span className="shrink-0 text-xs text-slate-500">{queuedAtLabel(item.queuedAt)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {held.length ? (
            <>
              <p className="mt-3 text-xs font-medium uppercase tracking-wide text-red-700 dark:text-red-400">Not saved – needs you</p>
              <ul aria-label="Changes that need attention" className="mt-1 max-h-48 space-y-1 overflow-y-auto">
                {held.map((item) => (
                  <li key={item.id} className="rounded-md bg-red-50 px-2 py-1.5 dark:bg-red-950/40">{describeChange(item.op)}</li>
                ))}
              </ul>
            </>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void retry()}><RefreshCw className={cn("size-3.5", busy && "animate-spin")} /> Retry</Button>
            {held.length || status.pendingPhotos.length ? <Button size="sm" variant="ghost" onClick={showDetails}>Show details</Button> : null}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
