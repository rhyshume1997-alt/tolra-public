"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { reloadOnceForChunkError } from "@/lib/chunk-reload";
import { PRODUCT } from "@/lib/product";
import { reportClientError } from "@/lib/report-client-error";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // A tab still running the previous deploy: reload once to pick up the new build (lib/chunk-reload.ts).
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    if (reloadOnceForChunkError(error)) setUpdating(true);
    else reportClientError(error);
  }, [error]);

  if (updating) return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-sm text-slate-600">Loading the latest version...</main>;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Something went wrong</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-slate-600">{PRODUCT.name} could not complete that request. Retry the page, or sign out and back in if the problem continues.</p>
          {error.digest ? <p className="text-xs text-slate-500">Error reference: {error.digest}</p> : null}
          <Button onClick={reset} className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover">Retry</Button>
        </CardContent>
      </Card>
    </main>
  );
}
