"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { friendlyError } from "@/lib/friendly-error";
import { sourceTotalsFromValidated, validateAndBuild } from "@/lib/sliq-import-build";
import {
  type Rpc, type SliqBatchResult, type SliqPayload, type SliqPreflight, type SliqRunProgress, isRunLabel, planSliqBatches, sliqPreflight, sliqRunBatches,
} from "@/lib/sliq-import-route";
import { type DbRow, type ReconcileReport, reconcile } from "@/lib/sliq-reconcile/reconcile";
import { renderSigningSheet } from "@/lib/sliq-reconcile/sheet";
import { ALL_ENTITIES, type SliqMapping, type SourceFiles, type ValidationReport, checkMapping } from "@/lib/sliq-validate/validate";
import { supabase } from "@/lib/supabase";

const rpc: Rpc = (fn, args) => {
  if (!supabase) return Promise.resolve({ data: null, error: { message: "Supabase is not configured." } });
  return supabase.rpc(fn, args) as unknown as ReturnType<Rpc>;
};

/** The reconciliation rows for the session's company (release 152 import_sliq_reconcile; the same function the SQL-editor script reads). */
async function reconcileRows(): Promise<DbRow[]> {
  const { data, error } = await rpc("import_sliq_reconcile", {});
  if (error) throw new Error(error.message);
  const rows = (data as { rows?: DbRow[] } | null)?.rows;
  if (!Array.isArray(rows)) throw new Error("The database's reconciliation answer wasn't one this page understands.");
  return rows;
}
const counters = (rows: DbRow[]) => Object.fromEntries(rows.filter((r) => r.metric === "counter_last").map((r) => [r.key, Number(r.value)]));

type Phase = "idle" | "checked" | "preflighted" | "importing" | "done" | "failed";

/**
 * Admin > Data import > SliQ go-live import (release 152). The original SliQ export files and the CONFIRMED mapping are read and fully
 * checked in the browser (lib/sliq-validate); nothing leaves the page until the preflight. The files are never uploaded or stored by
 * Tolra: keep the originals and their SHA-256 sheet outside Tolra (state-machines/SLIQ-IMPORT-ROUTE.md, "Keeping the originals").
 */
export function SliqImport() {
  const [mapping, setMapping] = useState<SliqMapping | null>(null);
  const [files, setFiles] = useState<SourceFiles>({});
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [payload, setPayload] = useState<SliqPayload | null>(null);
  const [preflight, setPreflight] = useState<SliqPreflight | null>(null);
  const [countersBefore, setCountersBefore] = useState<Record<string, number> | null>(null);
  const [label, setLabel] = useState("live");
  const [phase, setPhase] = useState<Phase>("idle");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [progress, setProgress] = useState<SliqRunProgress | null>(null);
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [results, setResults] = useState<SliqBatchResult[]>([]);
  const [rec, setRec] = useState<{ report: ReconcileReport; sheet: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setReport(null); setPayload(null); setPreflight(null); setPhase("idle"); setFailedAt(null); setFailure(null); setResults([]); setRec(null); };

  async function onFiles(list: FileList | null) {
    reset();
    setError(null);
    if (!list) return;
    const all = Array.from(list);
    const json = all.find((f) => f.name.toLowerCase().endsWith(".json"));
    let parsed: SliqMapping | null = mapping;
    if (json) {
      try {
        const checked = checkMapping(JSON.parse(await json.text()));
        parsed = checked.mapping;
        if (!parsed) setError(`The mapping can't be used: ${checked.problems.join("; ")}`);
      } catch {
        parsed = null;
        setError("The mapping file is not JSON.");
      }
    }
    const next: SourceFiles = {};
    for (const f of all) {
      if (f === json || !parsed) continue;
      const entity = ALL_ENTITIES.find((e) => parsed.entities[e]?.file === f.name);
      if (entity) next[entity] = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    }
    setMapping(parsed);
    setFiles(next);
  }

  async function check() {
    setError(null);
    setBusy(true);
    try {
      if (!mapping) throw new Error("Choose the confirmed mapping first.");
      const out = await validateAndBuild(files, mapping);
      setReport(out.report);
      setPayload(out.payload);
      if (out.payload) setPhase("checked");
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function runPreflight() {
    if (!payload) return;
    setError(null);
    setBusy(true);
    try {
      const p = await sliqPreflight(rpc, payload);
      // The counters as they are before anything is imported: the reconciliation checks every one but INV is unchanged after.
      setCountersBefore(counters(await reconcileRows()));
      setPreflight(p);
      setPhase("preflighted");
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function runImport(startAt: number) {
    if (!payload) return;
    setConfirm(false);
    setBusy(true);
    setPhase("importing");
    setFailure(null);
    const out = await sliqRunBatches(rpc, payload, label, setProgress, startAt);
    setResults((prev) => [...prev.slice(0, startAt), ...out.results]);
    setBusy(false);
    if (out.failedAt === null) { setPhase("done"); setFailedAt(null); return; }
    setFailedAt(out.failedAt);
    setFailure(out.error ? friendlyError(out.error) : (out.last?.errors ?? []).slice(0, 5).map((m) => `${m.source_row_id ?? ""} ${m.message}`).join("; "));
    setPhase("failed");
  }

  async function runReconcile() {
    if (!payload || !report) return;
    setError(null);
    setBusy(true);
    try {
      const source = sourceTotalsFromValidated(report, payload);
      const r = reconcile(source, await reconcileRows(), { countersBefore: countersBefore ?? {} });
      setRec({ report: r, sheet: renderSigningSheet(source, r, { company: "this company (signed-in admin's)", importedOn: new Date().toISOString().slice(0, 10) }) });
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  const plan = payload ? planSliqBatches(payload) : null;
  const ready = phase === "preflighted" && preflight?.ok && plan && plan.orphanPayments.length === 0 && plan.orphanCredits.length === 0 && isRunLabel(label);
  const kinds = ["customers", "suppliers", "invoices", "payments", "credit_notes"] as const;

  return (
    <Card>
      <CardContent className="space-y-4 p-4" data-testid="sliq-import">
        <div>
          <h2 className="text-base font-semibold">SliQ go-live import</h2>
          <p className="mt-1 text-sm text-slate-500">
            Choose the confirmed mapping (.json) and the original SliQ export files together. They are read and checked here and are not uploaded.
            Keep the untouched originals and their signed SHA-256 sheet outside Tolra.
          </p>
        </div>
        <input type="file" multiple accept=".csv,.json,text/csv,application/json" aria-label="SliQ files and mapping" onChange={(e) => void onFiles(e.target.files)} />
        <p className="text-xs text-slate-500" data-testid="sliq-files">
          Mapping: {mapping ? "chosen" : "not chosen"}. Files: {ALL_ENTITIES.filter((e) => e !== "creditNotes" || mapping?.entities.creditNotes).map((e) => `${e} ${files[e] ? "yes" : "no"}`).join(", ")}.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy || !mapping} onClick={() => void check()}>Check files</Button>
          <Button type="button" variant="outline" disabled={busy || !payload} onClick={() => void runPreflight()}>Preflight (writes nothing)</Button>
        </div>
        {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
        {report ? (
          <div className="space-y-1 text-sm" data-testid="sliq-report">
            <p>{report.ok ? "Every file check passed." : `${report.errors.length} problem(s)${report.truncated ? " (more not shown)" : ""}: nothing can be imported until they are fixed.`}</p>
            {report.dateSample ? <p data-testid="sliq-date-sample">Dates read as signed off by {report.dateSample.confirmedBy}: &quot;{report.dateSample.raw}&quot; is {report.dateSample.means}.</p> : null}
            <ul className="list-disc pl-5 text-red-700">
              {report.errors.slice(0, 100).map((e, i) => (
                <li key={i} data-testid="sliq-report-error">{e.file}{e.row ? ` row ${e.row}` : ""}{e.field ? ` (${e.field})` : ""}: {e.reason}</li>
              ))}
            </ul>
            {report.warnings.length ? (
              <ul className="list-disc pl-5 text-amber-700">
                {report.warnings.slice(0, 100).map((e, i) => (
                  <li key={i} data-testid="sliq-report-warning">{e.file}{e.row ? ` row ${e.row}` : ""}{e.field ? ` (${e.field})` : ""}: {e.reason}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {payload ? (
          <p className="break-all text-xs text-slate-500" data-testid="sliq-hashes">
            Source key {payload.source_sha256}. {payload.source_files.map((f) => `${f.name} ${f.sha256}`).join("; ")}
          </p>
        ) : null}
        {preflight ? (
          <div className="space-y-2 text-sm" data-testid="sliq-preflight">
            <p>
              {kinds.map((k) => `${k}: ${preflight.counts[k]?.to_create ?? 0} to create, ${preflight.counts[k]?.already_imported ?? 0} already imported, ${preflight.counts[k]?.problems ?? 0} with problems`).join(" | ")}
            </p>
            <p>Invoiced {preflight.money.invoiced}, paid {preflight.money.paid}, credited {preflight.money.credited}, owed {preflight.money.owed}, customer credit {preflight.money.customer_credit}, payment to confirm {preflight.money.payment_to_confirm}.</p>
            {preflight.errors.length ? (
              <ul className="list-disc pl-5 text-red-700">
                {preflight.errors.slice(0, 50).map((e, i) => <li key={i}>{e.source_row_id ?? e.kind}: {e.message}</li>)}
              </ul>
            ) : null}
            {preflight.changed_since_import?.length ? (
              <ul className="list-disc pl-5 text-amber-700" data-testid="sliq-changed">
                {preflight.changed_since_import.slice(0, 50).map((e, i) => <li key={i}>{e.source_row_id}: {e.message}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}
        {phase === "preflighted" || phase === "failed" || phase === "importing" || phase === "done" ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm">Run label
              <input className="ml-2 h-9 rounded-lg border border-slate-300 px-2" value={label} onChange={(e) => setLabel(e.target.value.trim().toLowerCase())} disabled={busy} />
            </label>
            <Button type="button" disabled={!ready || busy} onClick={() => setConfirm(true)}>Import {plan?.batches.length ?? 0} batches</Button>
            {phase === "failed" && failedAt !== null ? <Button type="button" variant="outline" disabled={busy} onClick={() => void runImport(failedAt)}>Retry from batch {failedAt + 1}</Button> : null}
          </div>
        ) : null}
        {progress && phase === "importing" ? <p className="text-sm" data-testid="sliq-progress">Batch {Math.min(progress.done + 1, progress.total)} of {progress.total}</p> : null}
        {phase === "failed" ? <p className="text-sm text-red-700" role="alert">Batch {(failedAt ?? 0) + 1} was not imported, and nothing in it was written. {failure}</p> : null}
        {phase === "done" ? (
          <div className="space-y-2">
            <p className="text-sm text-emerald-700" data-testid="sliq-done">
              Imported: {results.reduce((s, r) => s + (r.created ?? 0), 0)} records created, {results.filter((r) => r.already_imported).length} batches already imported. Now run the reconciliation.
            </p>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void runReconcile()}>Run the reconciliation</Button>
          </div>
        ) : null}
        {rec ? (
          <div className="space-y-2">
            <table className="w-full text-xs" data-testid="sliq-reconcile">
              <thead><tr><th className="text-left">Check</th><th>Source</th><th>Tolra</th><th>Difference</th><th>Result</th></tr></thead>
              <tbody>
                {rec.report.rows.map((r, i) => (
                  <tr key={i} className={r.status === "PASS" ? "" : "text-red-700"}><td>{r.check}</td><td>{r.source}</td><td>{r.database}</td><td>{r.difference}</td><td>{r.status}</td></tr>
                ))}
              </tbody>
            </table>
            <pre className="overflow-x-auto whitespace-pre text-xs" data-testid="sliq-sheet">{rec.sheet}</pre>
          </div>
        ) : null}
        <ConfirmDialog
          open={confirm}
          title="Import the SliQ data?"
          description={`${plan?.batches.length ?? 0} batches, run "${label}". Each batch is all or nothing; a batch already imported is not written again.`}
          confirmLabel="Import"
          busy={busy}
          onConfirm={() => void runImport(0)}
          onCancel={() => setConfirm(false)}
        />
      </CardContent>
    </Card>
  );
}
