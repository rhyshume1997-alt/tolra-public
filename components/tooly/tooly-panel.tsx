"use client";

import { useCallback, useEffect, useState } from "react";

import { TOOLY_POSES, type ToolyPose } from "@/components/tooly/poses";

const STORAGE_KEY = "tolra-tooly-enabled";
const FIRST_OPEN_KEY = "tolra-tooly-seen";

function readEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === null) return true;
    return v !== "0" && v !== "false";
  } catch {
    return true;
  }
}

function writeEnabled(on: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function hasSeenBefore(): boolean {
  try {
    return window.localStorage.getItem(FIRST_OPEN_KEY) === "1";
  } catch {
    return true;
  }
}

function markSeen() {
  try {
    window.localStorage.setItem(FIRST_OPEN_KEY, "1");
  } catch {
    /* ignore */
  }
}

/**
 * Tooly helper panel (Step 2 only).
 * Separate from the AI helper: this is the blue spanner guide on every signed-in page.
 * Toggle is per browser (localStorage). No walkthrough, emails or summaries yet.
 */
export function ToolyPanel() {
  const [enabled, setEnabled] = useState(true);
  const [open, setOpen] = useState(false);
  const [pose, setPose] = useState<ToolyPose>("idle");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const on = readEnabled();
    setEnabled(on);
    setReady(true);
    if (!on) return;
    // First open this browser: wave once, then settle to idle.
    if (!hasSeenBefore()) {
      setPose("wave");
      setOpen(true);
      markSeen();
      const t = window.setTimeout(() => setPose("idle"), 2200);
      return () => window.clearTimeout(t);
    }
  }, []);

  // Gentle blink while idle and visible.
  useEffect(() => {
    if (!enabled || !open || pose !== "idle") return;
    const id = window.setInterval(() => {
      setPose("blink");
      window.setTimeout(() => setPose("idle"), 180);
    }, 4500 + Math.random() * 2500);
    return () => window.clearInterval(id);
  }, [enabled, open, pose]);

  const toggleEnabled = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      writeEnabled(next);
      if (!next) {
        setOpen(false);
        setPose("sleep");
      } else {
        setPose("wave");
        setOpen(true);
        window.setTimeout(() => setPose("idle"), 1800);
      }
      return next;
    });
  }, []);

  if (!ready) return null;

  // Collapsed launcher when the panel is closed but Tooly is still on.
  if (enabled && !open) {
    return (
      <div className="fixed bottom-4 right-4 z-40 print:hidden" data-testid="tooly-launcher">
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setPose("wave");
            window.setTimeout(() => setPose("idle"), 1600);
          }}
          className="flex h-14 w-14 items-center justify-center rounded-full border border-slate-200 bg-white shadow-lg hover:bg-slate-50"
          aria-label="Open Tooly"
        >
          <img src={TOOLY_POSES.idle} alt="" width={48} height={48} className="h-12 w-12 object-contain" />
        </button>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="fixed bottom-4 right-4 z-40 print:hidden" data-testid="tooly-off-chip">
        <button
          type="button"
          onClick={toggleEnabled}
          className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm hover:bg-slate-50"
        >
          Show Tooly
        </button>
      </div>
    );
  }

  return (
    <div
      className="fixed bottom-4 right-4 z-40 flex w-[min(100vw-2rem,20rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl print:hidden"
      data-testid="tooly-panel"
      role="complementary"
      aria-label="Tooly helper"
    >
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
        <p className="flex-1 text-sm font-semibold text-slate-900">Tooly</p>
        <button
          type="button"
          onClick={toggleEnabled}
          className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          data-testid="tooly-toggle-off"
        >
          Hide
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          aria-label="Minimise Tooly"
        >
          —
        </button>
      </div>
      <div className="flex flex-col items-center gap-3 px-4 py-4">
        <img
          src={TOOLY_POSES[pose]}
          alt="Tooly"
          width={160}
          height={160}
          className="h-40 w-40 object-contain"
          data-testid="tooly-pose"
          data-pose={pose}
        />
        <p className="text-center text-sm text-slate-600">
          {pose === "wave"
            ? "Hello. I'm Tooly — your workshop helper."
            : pose === "think"
              ? "Working on it..."
              : pose === "oops"
                ? "That didn't work. Nothing was changed."
                : pose === "celebrate"
                  ? "Done. Have a look."
                  : pose === "sleep"
                    ? "I'm resting. Open me when you need a hand."
                    : "Ask me about jobs, quotes or invoices when you're ready."}
        </p>
        <p className="text-center text-xs text-slate-400">
          Guides and drafts only. Separate from AI. More coming in the next steps.
        </p>
      </div>
    </div>
  );
}
