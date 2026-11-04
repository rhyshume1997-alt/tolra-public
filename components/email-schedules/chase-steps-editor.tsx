"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type ChaseTone, CHASE_TONES, DEFAULT_CHASE_STEPS, MAX_STEPS, TONE_LABEL, offsetLabel, stepsProblem, toneFor } from "@/lib/email/chase/steps";
import { supabase } from "@/lib/supabase";

/**
 * Settings > Email schedules > Chase steps (migration 138): when each owed invoice is chased, counted in days from its due date, and in
 * what tone. Every chase is a DRAFT in the Approval Queue: nothing is e-mailed until someone approves it. Admin and office may change
 * the steps (the database's rule); with none saved, the suggested four are shown, not saved, until Save.
 */
type When = "before" | "on" | "after";
type Row = { key: string; id?: string; days: string; when: When; tone: ChaseTone };

let nextKey = 0;
const newKey = () => `row-${(nextKey += 1)}`;
const rowFrom = (offset: number, tone: ChaseTone, id?: string): Row => ({ key: newKey(), id, days: String(Math.abs(offset)), when: offset < 0 ? "before" : offset === 0 ? "on" : "after", tone });
const signed = (row: Row) => (row.when === "on" ? "0" : row.when === "before" ? `-${row.days.trim()}` : row.days.trim());

export function ChaseStepsEditor({ organizationId, canEdit }: { organizationId: string; canEdit: boolean }) {
  const [phase, setPhase] = useState<"loading" | "unavailable" | "error" | "ready">("loading");
  const [rows, setRows] = useState<Row[]>([]);
  const [saved, setSaved] = useState<Array<{ id: string; offset_days: number; tone: ChaseTone }>>([]);
  const [suggested, setSuggested] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!supabase) return setPhase("unavailable");
    const { data, error: failure } = await supabase.from("chase_steps").select("id, offset_days, tone").eq("organization_id", organizationId).order("offset_days");
    if (failure) return setPhase(["PGRST205", "42P01"].includes(String(failure.code ?? "")) ? "unavailable" : "error");
    const list = (data ?? []) as Array<{ id: string; offset_days: number; tone: ChaseTone }>;
    setSaved(list);
    setSuggested(!list.length);
    setRows(list.length ? list.map((s) => rowFrom(s.offset_days, s.tone, s.id)) : DEFAULT_CHASE_STEPS.map((s) => rowFrom(s.offset_days, s.tone)));
    setPhase("ready");
  }
  useEffect(() => { void load(); }, [organizationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (key: string, patch: Partial<Row>) => {
    setError(null);
    setRows((current) => current.map((row) => {
      if (row.key !== key) return row;
      const next = { ...row, ...patch };
      const offset = Number(signed(next));
      return Number.isFinite(offset) ? { ...next, tone: toneFor(offset, next.tone) } : next;
    }));
  };

  async function save() {
    if (!supabase || saving) return;
    const drafts = rows.map((row) => ({ id: row.id, offset: signed(row), tone: row.tone }));
    const problem = stepsProblem(drafts);
    if (problem) return setError(problem);
    setSaving(true);
    try {
      const kept = new Set(drafts.map((d) => d.id).filter(Boolean));
      const removed = saved.filter((s) => !kept.has(s.id)).map((s) => s.id);
      if (removed.length) {
        const { error: failure } = await supabase.from("chase_steps").delete().in("id", removed);
        if (failure) throw failure;
      }
      for (const d of drafts.filter((d) => d.id)) {
        const before = saved.find((s) => s.id === d.id);
        if (before && before.offset_days === Number(d.offset) && before.tone === d.tone) continue;
        const { error: failure } = await supabase.from("chase_steps").update({ offset_days: Number(d.offset), tone: d.tone }).eq("id", d.id as string);
        if (failure) throw failure;
      }
      const added = drafts.filter((d) => !d.id).map((d) => ({ organization_id: organizationId, offset_days: Number(d.offset), tone: d.tone }));
      if (added.length) {
        const { error: failure } = await supabase.from("chase_steps").insert(added);
        if (failure) throw failure;
      }
      toast.success("Chase steps saved");
      await load();
    } catch (failure) {
      const code = String((failure as { code?: string })?.code ?? "");
      const message = code === "42501" ? "Only admin and office users can change the chase steps." : code === "23505" ? "Two steps can't have the same number of days." : "Couldn't save the chase steps. Reload the page and try again.";
      setError(message);
      toast.error(message);
      await load();
    } finally {
      setSaving(false);
    }
  }

  if (phase === "loading") return <p className="text-slate-500">Loading chase steps...</p>;
  if (phase === "unavailable") return <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-950" role="status">Payment reminder settings are not available yet. Ask your admin to contact Tolra support.</p>;
  if (phase === "error") return <p className="text-red-600" role="alert">Couldn&apos;t load the chase steps. Reload the page to try again.</p>;

  return (
    <div className="space-y-3" data-testid="chase-steps">
      <div>
        <p className="text-sm font-semibold text-slate-900">Chase steps</p>
        <p className="mt-1 text-xs text-slate-500">
          When each unpaid invoice is chased, counted from its due date. Each step is drafted at most once per invoice and waits in the Approval Queue: nothing is e-mailed until you approve it. Paid, void, credited, written-off and paused invoices, and payments still to confirm, are never chased. The wording is in Email templates.
        </p>
        {suggested ? <p className="mt-1 text-xs font-medium text-amber-700" data-testid="chase-steps-suggested">Suggested steps, not saved yet: nothing is chased until you save them.</p> : null}
      </div>
      <ol className="space-y-2">
        {rows.map((row, index) => (
          <li key={row.key} className="grid gap-2 sm:grid-cols-[auto_6rem_10rem_10rem_auto] sm:items-center" data-testid="chase-step">
            <span className="text-xs font-semibold text-slate-500">Step {index + 1}</span>
            {row.when === "on" ? <span className="text-sm text-slate-500">-</span> : (
              <Input aria-label={`Step ${index + 1} days`} inputMode="numeric" disabled={!canEdit} value={row.days} onChange={(e) => change(row.key, { days: e.target.value.replace(/[^0-9]/g, "").slice(0, 3) })} />
            )}
            <select aria-label={`Step ${index + 1} when`} className="h-10 rounded-lg border border-input bg-surface px-3 text-sm text-ink disabled:opacity-50" disabled={!canEdit} value={row.when} onChange={(e) => change(row.key, { when: e.target.value as When })}>
              <option value="before">days before due</option>
              <option value="on">on the due date</option>
              <option value="after">days after due</option>
            </select>
            <select aria-label={`Step ${index + 1} tone`} className="h-10 rounded-lg border border-input bg-surface px-3 text-sm text-ink disabled:opacity-50" disabled={!canEdit || row.when !== "after"} value={row.tone} onChange={(e) => change(row.key, { tone: e.target.value as ChaseTone })}>
              {CHASE_TONES.filter((t) => (row.when === "after" ? t !== "before_due" : t === "before_due")).map((t) => <option key={t} value={t}>{TONE_LABEL[t]}</option>)}
            </select>
            <Button variant="ghost" size="sm" aria-label={`Remove step ${index + 1} (${offsetLabel(Number(signed(row)) || 0)})`} disabled={!canEdit} onClick={() => { setError(null); setRows((current) => current.filter((r) => r.key !== row.key)); }}><Trash2 className="size-4" /></Button>
          </li>
        ))}
      </ol>
      {!rows.length ? <p className="text-xs text-slate-500">No steps: nothing will be chased.</p> : null}
      {error ? <p className="text-sm text-red-600" role="alert">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!canEdit || rows.length >= MAX_STEPS} onClick={() => setRows((current) => [...current, rowFrom(Math.max(0, ...current.map((r) => Number(signed(r)) || 0)) + 7, "friendly")])}><Plus className="size-4" /> Add step</Button>
        <Button size="sm" className="bg-brand text-brand-ink" aria-label="Save chase steps" disabled={!canEdit || saving} onClick={() => void save()}>{saving ? "Saving..." : "Save chase steps"}</Button>
      </div>
    </div>
  );
}
