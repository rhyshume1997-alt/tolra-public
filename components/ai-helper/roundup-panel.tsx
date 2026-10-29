"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RoundupFacts, RoundupPeriod } from "@/lib/ai-helper/roundup";

/**
 * The round-up (read only). The figures are the dashboard's own "Needs attention" rules and are always shown as they are; the AI only
 * words a short summary above them, and that summary is left out if it doesn't match the figures. Nothing is changed by it.
 */
export function AiRoundupPanel({ onUsed }: { onUsed?: () => void }) {
  const [period, setPeriod] = useState<RoundupPeriod>("daily");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ facts?: RoundupFacts; summary?: string | null; notice?: string | null; error?: string } | null>(null);

  async function make() {
    setBusy(true);
    try {
      const response = await fetch("/api/ai-helper/roundup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ period }) });
      const payload = (await response.json().catch(() => ({}))) as NonNullable<typeof result>;
      setResult(response.ok ? payload : { error: payload.error || "The AI helper is not available right now." });
    } catch {
      setResult({ error: "The AI helper is not available right now." });
    } finally {
      setBusy(false);
      onUsed?.();
    }
  }

  return (
    <Card data-testid="ai-roundup-panel">
      <CardHeader><CardTitle>Round-up</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-500">What is late, waiting or not yet invoiced, from your own records. Read only.</p>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Round-up period" className="h-9 rounded-md border px-2 text-sm" value={period} onChange={(e) => setPeriod(e.target.value as RoundupPeriod)}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
          <Button type="button" onClick={() => void make()} disabled={busy}>Make round-up</Button>
        </div>
        {result?.error ? <p role="alert" className="text-sm text-amber-800">{result.error}</p> : null}
        {result?.summary ? <p className="whitespace-pre-line rounded-lg border bg-slate-50 p-3 text-sm text-slate-800" data-testid="ai-roundup-summary">{result.summary}</p> : null}
        {result?.notice ? <p className="text-sm text-slate-600" data-testid="ai-roundup-notice">{result.notice}</p> : null}
        {result?.facts ? (
          <ul className="space-y-2" aria-label="Round-up figures">
            {result.facts.sections.map((section) => (
              <li key={section.title} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-slate-800">{section.title}</span>
                  <span>{section.failed ? "Couldn't load" : section.count} <Link className="ml-2 underline" href={section.href}>View all</Link></span>
                </div>
                {section.items.length ? <ul className="mt-1 list-disc pl-5 text-slate-600">{section.items.map((item) => <li key={item.title}>{item.title} ({item.ageDays} days)</li>)}</ul> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
