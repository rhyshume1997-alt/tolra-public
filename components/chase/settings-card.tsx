"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export type ChaseTone = "before_due" | "friendly" | "firm" | "final";
export type ChaseStep = { days: number; tone: ChaseTone };
export type ChaseSettingsCardProps = {
  /** Initial company settings. Remount with a company key when switching company. */
  initialSteps: readonly ChaseStep[];
  onSave: (steps: ChaseStep[]) => void | Promise<void>;
  disabled?: boolean;
};
const TONES: Record<ChaseTone, string> = {
  before_due: "Before the due date", friendly: "Friendly", firm: "Firm", final: "Final reminder",
};

/** No storage or sending: the parent saves these settings for the company. */
export function ChaseSettingsCard({ initialSteps, onSave, disabled = false }: ChaseSettingsCardProps) {
  const prefix = useId();
  const nextId = useRef(initialSteps.length);
  const busy = useRef(false);
  const [rows, setRows] = useState(() => initialSteps.map((step, id) => ({ id, days: String(step.days), tone: step.tone })));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const locked = disabled || saving;
  function changed() { setMessage(""); setError(""); }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || busy.current) return;
    changed();
    if (rows.some((row) => !/^-?\d+$/.test(row.days) || !Number.isSafeInteger(Number(row.days)))) {
      setError("Enter a whole number of days for each step.");
      return;
    }
    busy.current = true;
    setSaving(true);
    try {
      await onSave(rows.map(({ days, tone }) => ({ days: Number(days), tone })));
      setMessage("Chase steps saved.");
    } catch {
      setError("Could not save the chase steps. Please try again.");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Payment chasing</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4" aria-label="Payment chasing settings" noValidate>
          <p className="text-sm text-slate-600">Choose when to chase an invoice. Use a negative number for days before the due date, 0 for the due date, and a positive number for days after.</p>
          <p className="rounded-lg border p-3 text-sm">Chasers are drafts for approval. You check and approve each email before it is sent.</p>
          {rows.length === 0 && <p className="text-sm text-slate-600">No chase steps. Add a step to start chasing.</p>}
          {rows.map((row, index) => (
            <div key={row.id} className="grid items-end gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto]">
              <label htmlFor={`${prefix}-${row.id}-days`} className="text-sm font-medium">Days from due date — step {index + 1}
                <Input id={`${prefix}-${row.id}-days`} type="number" step="1" value={row.days} disabled={locked} onChange={(e) => { changed(); setRows((current) => current.map((item) => item.id === row.id ? { ...item, days: e.target.value } : item)); }} />
              </label>
              <label htmlFor={`${prefix}-${row.id}-tone`} className="text-sm font-medium">Tone — step {index + 1}
                <select id={`${prefix}-${row.id}-tone`} value={row.tone} disabled={locked} className="h-10 w-full rounded-lg border border-input bg-surface px-3 text-sm text-ink disabled:opacity-50" onChange={(e) => { changed(); setRows((current) => current.map((item) => item.id === row.id ? { ...item, tone: e.target.value as ChaseTone } : item)); }}>
                  {Object.entries(TONES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <Button type="button" variant="outline" disabled={locked} aria-label={`Remove step ${index + 1}`} onClick={() => { changed(); setRows((current) => current.filter((item) => item.id !== row.id)); }}>Remove</Button>
            </div>
          ))}
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          {message && <p role="status" className="text-sm">{message}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={locked} onClick={() => { changed(); const id = nextId.current++; setRows((current) => [...current, { id, days: "7", tone: "friendly" }]); }}>Add step</Button>
            <Button type="submit" disabled={locked}>{saving ? "Saving…" : "Save chase steps"}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
