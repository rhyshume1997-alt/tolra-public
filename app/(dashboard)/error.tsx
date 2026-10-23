"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { reloadOnceForChunkError } from "@/lib/chunk-reload";
import { reportClientError } from "@/lib/report-client-error";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // A tab still running the previous deploy: reload once to pick up the new build (lib/chunk-reload.ts).
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    // Logged for diagnostics only; nothing from the error is rendered.
    console.error(error);
    if (reloadOnceForChunkError(error)) setUpdating(true);
    else reportClientError(error);
  }, [error]);

  if (updating) return <p className="mx-auto mt-16 max-w-md text-center text-sm text-slate-600 dark:text-slate-300">Loading the latest version...</p>;

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-4 text-center">
      <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Something went wrong</h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">This page could not be shown. Your data has not been changed. Try again, and if it keeps happening contact your administrator.</p>
      <Button onClick={reset} className="bg-brand text-brand-ink hover:bg-brand-hover">Retry</Button>
    </div>
  );
}
