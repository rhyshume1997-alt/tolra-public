"use client";

import { redact, safeRoute } from "@/lib/error-alert";

const reported = new Set<string>();

/**
 * Tells the server that an error screen was shown (app/global-error.tsx, app/error.tsx, the dashboard's error screen). The
 * message is redacted here as well as on the server, only the path is sent (never the query), and an error is reported once
 * per page load. Best effort: it never throws and never delays the screen. Only a signed-in person's report is accepted.
 */
export function reportClientError(error: Error & { digest?: string }) {
  try {
    const message = redact(error?.message);
    const path = safeRoute(typeof window !== "undefined" ? window.location.pathname : "");
    const key = `${path}|${error?.digest ?? message}`;
    if (reported.has(key)) return;
    reported.add(key);
    void fetch("/api/report-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, digest: error?.digest, path }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Reporting must never make the failure worse.
  }
}
