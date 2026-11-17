"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { anyFeatureOn, useAiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import { ToolyFace } from "@/components/tooly/tooly-face";
import { useUser } from "@/lib/use-user";

const HIDE_KEY = "tooly-hidden";
const AI_SETUP_HREF = "/admin/integrations#ai";

/**
 * Small floating Tooly on every signed-in page. Hide is this browser only and does not turn company AI off.
 * When AI is on, the button opens the existing AI helper. When AI is off, a short panel explains and (for admins)
 * links to the Integrations AI card without switching anything on.
 */
export function ToolyFloat() {
  const router = useRouter();
  const { activeRole } = useUser();
  const { status, loaded } = useAiHelperStatus();
  const [hidden, setHidden] = useState(true);
  const [open, setOpen] = useState(false);
  const isAdmin = activeRole === "admin";
  const aiOn = Boolean(loaded && status && anyFeatureOn(status));

  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(HIDE_KEY) === "1");
    } catch {
      setHidden(false);
    }
  }, []);

  function hide() {
    try {
      window.localStorage.setItem(HIDE_KEY, "1");
    } catch {
      /* ignore */
    }
    setHidden(true);
    setOpen(false);
  }

  function showAgain() {
    try {
      window.localStorage.removeItem(HIDE_KEY);
    } catch {
      /* ignore */
    }
    setHidden(false);
  }

  function onTap() {
    if (aiOn) {
      router.push("/ai-helper");
      return;
    }
    setOpen((v) => !v);
  }

  if (hidden) {
    return (
      <button
        type="button"
        onClick={showAgain}
        className="fixed bottom-4 right-4 z-40 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm print:hidden"
        data-testid="tooly-show-again"
      >
        Show Tooly
      </button>
    );
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-end p-4 print:hidden">
      <div className="pointer-events-auto flex max-w-[min(100%,20rem)] flex-col items-end gap-2">
        {open && !aiOn ? (
          <div
            className="w-full rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700 shadow-lg"
            data-testid="tooly-off-panel"
            role="dialog"
            aria-label="Tooly"
          >
            <div className="mb-2 flex items-start gap-2">
              <ToolyFace pose="wave" size={48} />
              <div className="min-w-0 space-y-1">
                <p className="font-medium text-slate-900">Hi, I'm Tooly.</p>
                <p>I can do more when the AI is switched on.</p>
                <p>I can draft emails and notes for you, and answer questions about your recent quotes and jobs.</p>
                <p>Soon I will also walk you through the app, tell you what you have missed, and draft a Monday and Friday email for your admins about what is still outstanding in reports.</p>
                {isAdmin ? (
                  <p className="pt-1">
                    <Link
                      href={AI_SETUP_HREF}
                      className="inline-flex rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover"
                      data-testid="tooly-ai-setup-link"
                    >
                      Open AI settings
                    </Link>
                  </p>
                ) : (
                  <p className="pt-1">Ask your admin to switch the AI on.</p>
                )}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md border px-2 py-1 text-xs text-slate-600"
              >
                Close
              </button>
              <button
                type="button"
                onClick={hide}
                className="rounded-md border px-2 py-1 text-xs text-slate-600"
                data-testid="tooly-hide"
              >
                Hide Tooly
              </button>
            </div>
          </div>
        ) : null}

        <button
          type="button"
          onClick={onTap}
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white shadow-md"
          aria-label={aiOn ? "Open AI helper" : "Talk to Tooly"}
          data-testid="tooly-float"
          data-ai-on={aiOn ? "1" : "0"}
        >
          <ToolyFace pose={open ? "wave" : "idle"} size={48} />
        </button>

        {!open ? (
          <button
            type="button"
            onClick={hide}
            className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] text-slate-500 shadow-sm"
            data-testid="tooly-hide-chip"
          >
            Hide
          </button>
        ) : null}
      </div>
    </div>
  );
}
