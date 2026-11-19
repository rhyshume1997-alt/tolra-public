"use client";

/**
 * The Cloudflare Turnstile box for the sign-in form (audit F1). Inputs: NEXT_PUBLIC_TURNSTILE_SITE_KEY. Output: Turnstile adds a
 * hidden `cf-turnstile-response` field to the enclosing form; the sign-in handler sends it. Renders nothing when no site key is set
 * (off by default). Must not change: it holds no sign-in logic and never blocks the form itself; the server decides.
 */
import { useEffect, useRef } from "react";

import { turnstileSiteKey } from "@/lib/auth/turnstile";

type TurnstileApi = { render: (el: HTMLElement, options: Record<string, unknown>) => string; reset: (id?: string) => void; remove: (id?: string) => void };
declare global { interface Window { turnstile?: TurnstileApi } }

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { scriptPromise = null; reject(new Error("turnstile script failed")); };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** Tokens are single use: call after every attempt that reached the server so the next one gets a fresh token. */
export function resetTurnstile() {
  try { window.turnstile?.reset(); } catch { /* widget not shown */ }
}

export function TurnstileWidget() {
  const siteKey = turnstileSiteKey();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!siteKey || !box.current) return;
    let widgetId: string | undefined;
    let cancelled = false;
    loadScript().then(() => {
      if (cancelled || !box.current || !window.turnstile) return;
      widgetId = window.turnstile.render(box.current, { sitekey: siteKey, theme: "auto", appearance: "always" });
    }).catch(() => undefined);
    return () => { cancelled = true; if (widgetId) try { window.turnstile?.remove(widgetId); } catch { /* gone */ } };
  }, [siteKey]);

  if (!siteKey) return null;
  return <div ref={box} className="flex min-h-[65px] justify-center" data-testid="turnstile-box" />;
}
