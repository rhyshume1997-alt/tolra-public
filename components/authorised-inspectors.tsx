"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fmtDateTime } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import {
  type InspectorCandidate, type InspectorChange, REASON_MAX, SCOPE_MAX, currentAuthorisations, eligible, loadInspectorHistory, reasonProblem,
  scopeProblem, setAuthorisedInspector,
} from "@/lib/inspectors";

const selectClass = "h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm";

type Pending = { kind: "add" } | { kind: "remove"; person: InspectorCandidate };

/**
 * Admin > Users > Inspectors (ISO 9001 7.2, migration 083): who may record an inspection pass or co-sign as the inspector. Adding
 * or removing someone needs a reason; every change is kept (who, when, why) and shown under History.
 */
export function AuthorisedInspectors({ people, onChanged }: { people: InspectorCandidate[]; onChanged: () => void }) {
  const [history, setHistory] = useState<InspectorChange[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [personId, setPersonId] = useState("");
  const [scope, setScope] = useState("");
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setHistory(await loadInspectorHistory());
      setLoadError(null);
    } catch (err) {
      setLoadError(friendlyError(err, "Couldn't load the inspectors list's history."));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const byId = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);
  const onList = useMemo(() => people.filter((person) => person.inspector && !person.support), [people]);
  const current = useMemo(() => currentAuthorisations(history ?? [], new Set(onList.map((person) => person.id))), [history, onList]);
  const addable = useMemo(() => people.filter((person) => eligible(person) && !person.inspector), [people]);
  const nameOf = (id: string | null) => (id ? byId.get(id)?.name ?? "Former member" : "System");

  function open(next: Pending) {
    setPending(next);
    setPersonId(next.kind === "add" ? addable[0]?.id ?? "" : next.person.id);
    setScope("");
    setReason("");
    setProblem(null);
  }

  async function submit() {
    if (!pending) return;
    const userId = pending.kind === "add" ? personId : pending.person.id;
    const issue = (pending.kind === "add" && !userId ? "Choose who to add." : null) ?? reasonProblem(reason) ?? (pending.kind === "add" ? scopeProblem(scope) : null);
    if (issue) { setProblem(issue); return; }
    setSaving(true);
    try {
      await setAuthorisedInspector(userId, pending.kind === "add", reason, pending.kind === "add" ? scope : "");
      toast.success(pending.kind === "add" ? `${nameOf(userId)} added to the inspectors list` : `${nameOf(userId)} removed from the inspectors list`);
      setPending(null);
      onChanged();
      void load();
    } catch (err) {
      setProblem(friendlyError(err, "The inspectors list wasn't changed. Try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-testid="authorised-inspectors" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900"><ShieldCheck className="size-5" /> Inspectors</h2>
          <p className="mt-1 text-sm text-slate-500">Only the people on this list can record an inspection pass or co-sign as the inspector. Each change needs a reason and is kept.</p>
        </div>
        <Button variant="outline" disabled={!addable.length} onClick={() => open({ kind: "add" })}>Add inspector</Button>
      </div>
      {loadError ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{loadError}</p> : null}
      <Card><CardContent className="p-0">
        {onList.length ? (
          <ul className="divide-y divide-slate-100">
            {onList.map((person) => {
              const since = current.get(person.id);
              return (
                <li key={person.id} data-testid="inspector-row" className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900">{person.name} {person.active ? null : <Badge className="ml-1 bg-slate-100 text-slate-600">Inactive</Badge>}</p>
                    <p className="text-xs text-slate-500">
                      {since ? `Added ${fmtDateTime(since.changed_at)} by ${nameOf(since.changed_by)}` : "Added before the list's history began"}
                      {since?.scope ? ` · Scope: ${since.scope}` : ""}
                    </p>
                    {since ? <p className="mt-0.5 break-words text-xs text-slate-600">Reason: {since.reason}</p> : null}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => open({ kind: "remove", person })}>Remove</Button>
                </li>
              );
            })}
          </ul>
        ) : <p className="p-4 text-sm text-slate-500">Nobody is on the list yet, so nobody can record an inspection pass.</p>}
      </CardContent></Card>
      {history?.length ? (
        <details open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
          <summary className="cursor-pointer font-medium text-slate-700">History ({history.length})</summary>
          {historyOpen ? <ul className="mt-2 space-y-1.5">
            {history.map((row) => (
              <li key={row.id} data-testid="inspector-history-row" className="text-xs text-slate-600">
                <span className="font-medium text-slate-800">{fmtDateTime(row.changed_at)}</span> · {nameOf(row.user_id)} {row.change === "added" ? "added" : "removed"} by {nameOf(row.changed_by)}
                {row.scope ? ` (scope: ${row.scope})` : ""}: {row.reason}
              </li>
            ))}
          </ul> : null}
        </details>
      ) : null}

      <Dialog open={pending !== null} onOpenChange={(value) => { if (!value) setPending(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending?.kind === "remove" ? `Remove ${pending.person.name} from the inspectors list` : "Add an inspector"}</DialogTitle>
            <DialogDescription>{pending?.kind === "remove" ? "They can no longer record a pass. Passes they recorded before stay as they are." : "They can record inspection passes and co-sign as the inspector."}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            {pending?.kind === "add" ? (
              <>
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">Person
                  <select aria-label="Person to add" className={selectClass} value={personId} onChange={(event) => setPersonId(event.target.value)}>
                    {addable.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium text-slate-700">Scope (optional)
                  <Input aria-label="Scope" value={scope} maxLength={SCOPE_MAX} placeholder="e.g. Dimensional and visual checks" className="h-11" onChange={(event) => setScope(event.target.value)} />
                </label>
              </>
            ) : null}
            <label className="grid gap-1.5 text-sm font-medium text-slate-700">Reason
              <Textarea aria-label="Reason" value={reason} maxLength={REASON_MAX} rows={3}
                placeholder={pending?.kind === "remove" ? "e.g. Moved to stores, no longer inspecting" : "e.g. Trained on bore gauges and the CMM, signed off by the JNR controller"}
                onChange={(event) => setReason(event.target.value)} />
            </label>
            {problem ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{problem}</p> : null}
            <Button disabled={saving} className="h-11 bg-brand text-brand-ink" onClick={() => void submit()}>{saving ? "Saving..." : pending?.kind === "remove" ? "Remove" : "Add"}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
