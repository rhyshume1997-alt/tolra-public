"use client";

import { useCallback, useEffect, useState } from "react";
import { History } from "lucide-react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { type Progress, type Rpc, undoImport } from "@/lib/data-import";
import { friendlyError } from "@/lib/friendly-error";
import { fmtDateTime } from "@/lib/dates";
import { supabase } from "@/lib/supabase";

type Run = { import_id: string; status: string; file_name: string | null; parts: number | null; parts_committed: number; parts_undone: number; refused: unknown; created_at: string };
type Small = { id: string; file_name: string | null; counts: Record<string, { created?: number }> | null; created_at: string };

const rpc: Rpc = (fn, args) => {
  if (!supabase) return Promise.resolve({ data: null, error: { message: "Supabase is not configured." } });
  return supabase.rpc(fn, args) as unknown as ReturnType<Rpc>;
};

/** What a large import's state means for the admin: where it is, and whether Undo applies. */
export function runState(run: Pick<Run, "status" | "parts" | "parts_committed" | "parts_undone">): { label: string; action: "undo" | "discard" | null } {
  switch (run.status) {
    case "staging": case "validated": return { label: "Checked, not imported", action: "discard" };
    case "committing": return { label: `Stopped part way: ${run.parts_committed} of ${run.parts ?? "?"} parts are in`, action: "undo" };
    case "committed": return { label: "Imported", action: "undo" };
    case "undoing": return { label: `Being undone: ${run.parts_undone} of ${run.parts_committed} parts removed`, action: "undo" };
    case "undone": return { label: "Undone", action: null };
    case "cancelled": return { label: "Cancelled, nothing was imported", action: null };
    default: return { label: run.status, action: null };
  }
}

const refusedCount = (refused: unknown) => (Array.isArray(refused) ? refused.length : 0);
const createdTotal = (counts: Small["counts"]) => Object.values(counts ?? {}).reduce((sum, c) => sum + (c?.created ?? 0), 0);

/** Import history for this company: large imports with their undo state (Undo while it applies), and small ones imported in one step. */
export function DataImportHistory({ refreshKey }: { refreshKey: number }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [small, setSmall] = useState<Small[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [asking, setAsking] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [r, s] = await Promise.all([
      supabase.from("import_runs").select("import_id, status, file_name, parts, parts_committed, parts_undone, refused, created_at").order("created_at", { ascending: false }).limit(20),
      supabase.from("import_batches").select("id, file_name, counts, created_at").eq("status", "committed").eq("large", false).order("created_at", { ascending: false }).limit(20),
    ]);
    if (r.error || s.error) {
      setError("Couldn't load the import history.");
    } else {
      setError(null);
      setRuns((r.data ?? []) as Run[]);
      setSmall((s.data ?? []) as Small[]);
    }
    setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);

  async function undo(run: Run) {
    setAsking(null);
    setBusy(true);
    setNote(null);
    try {
      const result = await undoImport(rpc, run.import_id, setProgress);
      const kept = result.refused_count ?? 0;
      setNote(result.status === "cancelled" ? "Discarded: nothing had been imported." : kept ? `Undone. ${kept} record${kept === 1 ? " was" : "s were"} changed or used after the import, so ${kept === 1 ? "it was" : "they were"} kept.` : "Undone: what this import added has been removed.");
    } catch (err) {
      setNote(friendlyError(err, "The undo did not finish. Press Undo again."));
    } finally {
      setBusy(false);
      setProgress(null);
      await load();
    }
  }

  type Row = { key: string; at: string; run: Run; small?: undefined } | { key: string; at: string; small: Small; run?: undefined };
  const rows: Row[] = [
    ...runs.map((run): Row => ({ key: run.import_id, at: run.created_at, run })),
    ...small.map((s): Row => ({ key: s.id, at: s.created_at, small: s })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <section className="space-y-3" aria-label="Import history" data-testid="import-history">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-950"><History className="size-5 text-slate-500" /> Import history</h2>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {note ? <p role="status" className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800" data-testid="history-note">{note}</p> : null}
      {busy && progress ? <p className="text-sm text-slate-600">Undoing: {progress.done} of {progress.total} parts done</p> : null}
      <Card>
        <CardContent className="p-0">
          {!loaded ? <p className="p-4 text-sm text-slate-500">Loading…</p> : !rows.length ? <p className="p-4 text-sm text-slate-500">No imports yet.</p> : (
            <ul className="divide-y divide-slate-100">
              {rows.map((row) => {
                if (row.run) {
                  const state = runState(row.run);
                  const kept = refusedCount(row.run.refused);
                  return (
                    <li key={row.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm" data-testid="history-row" data-status={row.run.status}>
                      <span className="min-w-0 flex-1 truncate font-medium text-slate-900">{row.run.file_name ?? "File"} <span className="ml-1 rounded-none bg-slate-900 px-1.5 py-0.5 text-xs font-normal text-white">Large import</span></span>
                      <span className="text-xs text-slate-500">{fmtDateTime(row.at)}</span>
                      <span className="text-slate-700" data-testid="history-state">{state.label}{kept ? `; ${kept} kept (changed or used since)` : ""}</span>
                      {state.action ? <Button size="sm" variant="outline" disabled={busy} onClick={() => setAsking(row.run)}>{state.action === "undo" ? "Undo" : "Discard"}</Button> : null}
                    </li>
                  );
                }
                const s = row.small;
                return (
                  <li key={row.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm" data-testid="history-row" data-status="committed-small">
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-900">{s.file_name ?? "File"}</span>
                    <span className="text-xs text-slate-500">{fmtDateTime(row.at)}</span>
                    <span className="text-slate-700" data-testid="history-state">Imported in one step ({createdTotal(s.counts)} created). A small import goes in whole or not at all.</span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={Boolean(asking)}
        title={asking && runState(asking).action === "discard" ? "Discard this checked file?" : "Undo this import?"}
        description={asking && runState(asking).action === "discard" ? "It was checked but never imported. Discarding removes the staged file." : "Everything this import added is removed, last part first. A record that was changed or used after the import is kept and reported."}
        confirmLabel={asking && runState(asking).action === "discard" ? "Discard" : "Undo import"}
        destructive
        onCancel={() => setAsking(null)}
        onConfirm={() => asking && void undo(asking)}
      />
    </section>
  );
}
