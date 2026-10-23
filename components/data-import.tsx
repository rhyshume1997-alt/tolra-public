"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, FileSpreadsheet, Upload } from "lucide-react";

import { DataImportHistory } from "@/components/data-import-history";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  type ImportResult, type Progress, type Rpc, commitParts, commitSingle, runDryRun, undoImport,
} from "@/lib/data-import";
import { type BuiltImport, buildImport } from "@/lib/import-build";
import {
  type SavedMapping, type SheetPlan, chooseKind, chooseTarget, missingKeyField, peopleColumns, planSheet, unrecognisedColumns,
} from "@/lib/import-detect";
import { ImportFileError, type ReadFile, readImportFile } from "@/lib/import-file";
import { mappingsStore, saveMappings } from "@/lib/import-mappings";
import { describeMessage, isClean, nextNumbers, previewRows, totalCreated } from "@/lib/import-preview";
import { IMPORT_KINDS, type ImportKind, KIND_LABEL, targetsFor } from "@/lib/import-targets";
import { friendlyError } from "@/lib/friendly-error";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";

const selectClass = "h-9 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm";
const SHOWN = 100;

type Phase = "idle" | "reading" | "review" | "checking" | "preview" | "committing" | "done" | "failed";

const rpc: Rpc = (fn, args) => {
  if (!supabase) return Promise.resolve({ data: null, error: { message: "Supabase is not configured." } });
  return supabase.rpc(fn, args) as unknown as ReturnType<Rpc>;
};

function ProgressBar({ progress }: { progress: Progress | null }) {
  if (!progress) return null;
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const label = { staging: "Sending the file", checking: "Checking the whole file", committing: "Importing", undoing: "Undoing" }[progress.phase];
  return (
    <div className="space-y-1" data-testid="import-progress">
      <p className="text-sm text-slate-700">{label}: {progress.done} of {progress.total} parts done</p>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 w-full overflow-hidden rounded bg-slate-200">
        <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SheetCard({ plan, onKind, onTarget }: { plan: SheetPlan; onKind: (kind: ImportKind | null) => void; onTarget: (index: number, target: string | null) => void }) {
  const rows = plan.rows.length;
  const unknown = unrecognisedColumns(plan);
  const people = peopleColumns(plan).filter((c) => c.hasData);
  const missing = missingKeyField(plan);
  const sample = (index: number) => {
    const cell = plan.rows.find((r) => r[index] !== null && r[index] !== undefined && String(r[index]).trim() !== "")?.[index];
    return cell instanceof Date ? cell.toISOString().slice(0, 10) : cell === null || cell === undefined ? "" : String(cell);
  };
  return (
    <Card data-testid="import-sheet" data-kind={plan.kind ?? ""}>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <FileSpreadsheet className="size-5 text-slate-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-slate-950">{plan.sheetName}</p>
            <p className="text-xs text-slate-500">
              {rows} row{rows === 1 ? "" : "s"}
              {plan.fromKindColumn ? " (rows of one Kind from a mixed sheet)" : ""}
              {plan.kind && plan.kindSource === "saved" ? " · known from your saved mapping" : plan.kind && plan.kindSource === "headers" ? " · recognised from its headers" : ""}
            </p>
          </div>
          <label className="grid gap-1 text-xs text-slate-500">This sheet is
            <select aria-label={`What is ${plan.sheetName}?`} className={`${selectClass} w-48`} value={plan.kind ?? ""} onChange={(event) => onKind((event.target.value || null) as ImportKind | null)} disabled={plan.fromKindColumn}>
              <option value="">{plan.suggestion ? `Choose (looks like ${KIND_LABEL[plan.suggestion].toLowerCase()})` : "Choose what it is"}</option>
              {IMPORT_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>)}
            </select>
          </label>
        </div>

        {!plan.kind ? <p className="text-sm text-amber-800">Choose what this sheet is before checking the file. A sheet is never guessed.</p> : null}
        {missing ? <p role="alert" className="text-sm text-red-700">No column is the {missing.toLowerCase()}. Every row will be a problem until you pick one below.</p> : null}
        {plan.kind === "customers" || plan.kind === "suppliers" ? (
          <p className="text-xs text-slate-500">The contact person is kept as free text, not a Tolra user. No user and no signature is created.</p>
        ) : null}
        {plan.kind === "credit_notes" ? (
          <p className="text-xs text-slate-500" data-testid="import-credit-note-help">Each credit note goes in issued and applied in full to its invoice, which must be in this file. Its number is kept as written; Tolra&apos;s own credit notes carry on after the highest CRD number.</p>
        ) : null}
        {plan.kind === "purchase_orders" || plan.kind === "invoices" || plan.kind === "delivery_notes" ? (
          <p className="text-xs text-slate-500" data-testid="import-people-help">Who sent it{plan.kind === "delivery_notes" ? " or signed it" : ""} is kept as text, marked &ldquo;not a Tolra user&rdquo;, unless exactly one person in Tolra has that name. No user is created.</p>
        ) : null}
        {plan.kind ? people.map((c) => (
          <p key={c.index} className="text-xs text-slate-600" data-testid="import-people-column">The column &ldquo;{c.header}&rdquo; ({c.detail}) is not part of {KIND_LABEL[plan.kind!].toLowerCase()}, so it is not imported.</p>
        )) : null}

        {plan.kind ? <ColumnsPanel key={plan.kind} plan={plan} kind={plan.kind} needsChoosing={unknown.length > 0 || Boolean(missing)} unknown={unknown.length} sample={sample} onTarget={onTarget} /> : null}
      </CardContent>
    </Card>
  );
}

/**
 * A sheet's columns. Open at first when something needs choosing (a header nobody recognised, or no match key), then as the admin leaves
 * it: choosing a field for the last unknown column must not fold the list away.
 */
function ColumnsPanel({ plan, kind, needsChoosing, unknown, sample, onTarget }: {
  plan: SheetPlan; kind: ImportKind; needsChoosing: boolean; unknown: number; sample: (index: number) => string; onTarget: (index: number, target: string | null) => void;
}) {
  const [open, setOpen] = useState(needsChoosing);
  const shown = plan.columns.filter((c) => c.hasData || c.target);
  return (
    <details open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)} className="rounded-lg border border-slate-200">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-800">
        Columns{unknown ? ` (${unknown} not recognised)` : ""}
      </summary>
      <div className="divide-y divide-slate-100">
        {shown.map((c) => (
          <div key={c.index} className="grid gap-2 px-3 py-2 sm:grid-cols-[1fr_1fr_1.4fr] sm:items-center" data-testid="import-column">
            <p className="truncate text-sm font-medium text-slate-900">{c.header || `Column ${c.index + 1}`}</p>
            <p className="truncate text-xs text-slate-500" title={sample(c.index)}>{sample(c.index) || "(empty)"}</p>
            <div>
              <select
                aria-label={`Column ${c.header || c.index + 1} goes to`}
                className={selectClass}
                value={c.target ?? ""}
                disabled={c.reason === "kind"}
                onChange={(event) => onTarget(c.index, event.target.value || null)}
              >
                <option value="">{c.reason === "kind" ? "The Kind of each row" : c.reason === "derived" ? "Calculated in Tolra, not imported" : c.reason === "people" ? "Not part of this kind" : c.hasData && !c.target ? "Ignore (not recognised)" : "Ignore"}</option>
                {targetsFor(kind).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              {c.reason === "duplicate" ? <p className="mt-1 text-xs text-slate-500">Also matched {c.detail}: the other column is used.</p> : null}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function MessageList({ title, items, tone, testId }: { title: string; items: string[]; tone: "red" | "amber"; testId: string }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const color = tone === "red" ? "border-red-200 bg-red-50 text-red-900" : "border-amber-200 bg-amber-50 text-amber-900";
  return (
    <div className={`space-y-2 rounded-lg border p-3 text-sm ${color}`} data-testid={testId}>
      <p className="font-semibold">{title} ({items.length})</p>
      <ul className="space-y-1">
        {(all ? items : items.slice(0, SHOWN)).map((line, i) => <li key={i} data-testid={`${testId}-line`}>{line}</li>)}
      </ul>
      {items.length > SHOWN && !all ? <button type="button" className="underline" onClick={() => setAll(true)}>Show all {items.length}</button> : null}
    </div>
  );
}

export function DataImport() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<ReadFile | null>(null);
  const [plans, setPlans] = useState<SheetPlan[]>([]);
  const [saved, setSaved] = useState<SavedMapping[]>([]);
  const [built, setBuilt] = useState<BuiltImport | null>(null);
  const [dry, setDry] = useState<{ result: ImportResult; large: boolean; importId: string } | null>(null);
  const [done, setDone] = useState<{ result: ImportResult; large: boolean; mappingsSaved: number; mappingError: string | null } | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [failure, setFailure] = useState<{ message: string; importId: string; part: number } | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [undoNote, setUndoNote] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const commitKey = useRef<string | null>(null);
  const partKeys = useRef<Map<number, string>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);

  // The saved mappings are loaded as the page opens and awaited before a file is planned (a quick upload must not be planned without them).
  const mappings = useRef(mappingsStore(supabase as never));
  useEffect(() => { void mappings.current.refresh().then(setSaved); }, []);

  /** A staged large file nobody confirmed is cancelled (the database also removes it after 24 hours). */
  const discardStaged = useCallback(async (importId: string | null) => {
    if (!importId) return;
    try { await undoImport(rpc, importId); } catch { /* nothing was committed: the 24 hour clean-up covers it */ }
  }, []);

  const invalidate = useCallback(() => {
    setDry((current) => {
      if (current?.large) void discardStaged(current.importId);
      return null;
    });
    setBuilt(null);
    setPhase((p) => (p === "preview" || p === "failed" ? "review" : p));
  }, [discardStaged]);

  async function onFile(next: File | undefined) {
    if (!next) return;
    setError(null);
    setDone(null);
    setFailure(null);
    invalidate();
    setPhase("reading");
    try {
      const [read, savedNow] = await Promise.all([readImportFile(next), mappings.current.ready()]);
      setSaved(savedNow);
      const all: SheetPlan[] = [];
      for (const sheet of read.sheets) all.push(...(await planSheet(sheet, savedNow)));
      setFile(read);
      setPlans(all);
      setPhase("review");
    } catch (err) {
      setFile(null);
      setPlans([]);
      setPhase("idle");
      setError(err instanceof ImportFileError ? err.message : friendlyError(err, "Couldn't read that file."));
    }
    if (inputRef.current) inputRef.current.value = "";
  }

  const ready = plans.length > 0 && plans.every((p) => p.kind);
  const hasWork = plans.some((p) => p.kind);

  async function check() {
    if (!file) return;
    setError(null);
    const next = buildImport(plans, { name: file.name, sha256: file.sha256 });
    setBuilt(next);
    if (dry?.large) void discardStaged(dry.importId);
    setDry(null);
    if (!Object.values(next.records).some((n) => n > 0)) {
      setPhase("review");
      setError("There is nothing to import: no sheet has rows to read as records.");
      return;
    }
    setPhase("checking");
    setProgress(null);
    commitKey.current = crypto.randomUUID();
    partKeys.current = new Map();
    const importId = crypto.randomUUID();
    try {
      const { result, path } = await runDryRun(rpc, next.payload, { importId, opId: crypto.randomUUID() }, setProgress);
      setDry({ result, large: path.mode === "parts", importId });
      setPhase("preview");
    } catch (err) {
      setPhase("review");
      setError(friendlyError(err, "Couldn't check the file. Nothing was imported."));
    } finally {
      setProgress(null);
    }
  }

  async function afterCommit(result: ImportResult, large: boolean) {
    let mappingsSaved = 0;
    let mappingError: string | null = null;
    try {
      const organizationId = await getCurrentOrganizationId();
      const outcome = await saveMappings(supabase as never, plans, organizationId);
      mappingsSaved = outcome.saved;
      mappingError = outcome.error;
      if (outcome.saved) void mappings.current.refresh().then(setSaved);
    } catch (err) {
      mappingError = err instanceof Error ? err.message : "not saved";
    }
    setDone({ result, large, mappingsSaved, mappingError });
    setPhase("done");
    setHistoryKey((k) => k + 1);
  }

  /** Confirm import; with `startPart`, the retry of the part that failed (same key, so a part that did go in is not committed twice). */
  async function confirm(startPart = 1) {
    if (!built || !dry) return;
    setError(null);
    setFailure(null);
    setPhase("committing");
    setProgress(null);
    try {
      if (!dry.large) {
        const result = await commitSingle(rpc, built.payload, commitKey.current ?? crypto.randomUUID());
        if (!result.ok) {
          setDry({ ...dry, result });
          setPhase("preview");
          setError("The database found a problem on the way in, so nothing was imported. The list below says what.");
          return;
        }
        await afterCommit(result, false);
        return;
      }
      const outcome = await commitParts(rpc, dry.importId, partKeys.current, setProgress, startPart);
      if (outcome.failed) {
        const part = outcome.part;
        const detail = outcome.error ? friendlyError(outcome.error, "The database stopped.") : outcome.last?.errors?.[0]?.message ?? "The database stopped.";
        setFailure({ importId: dry.importId, part, message: `Part ${part} of ${outcome.last?.parts ?? dry.result.parts ?? "?"} did not go in: ${detail} The parts before it are in. Retry this part, or undo this import to put things back as they were.` });
        setHistoryKey((k) => k + 1);
        setPhase("failed");
        return;
      }
      // The last part answers for itself only: the whole import's counts are the validated file's.
      await afterCommit({ ...outcome.last!, counts: dry.result.counts }, true);
    } catch (err) {
      if (dry.large) {
        setFailure({ importId: dry.importId, part: startPart, message: `${friendlyError(err, "The import stopped.")} Parts already imported stay until you undo this import.` });
        setHistoryKey((k) => k + 1);
        setPhase("failed");
      } else {
        setPhase("preview");
        setError(friendlyError(err, "Couldn't import the file. Nothing was imported: press Confirm import to try again."));
      }
    } finally {
      setProgress(null);
    }
  }

  async function runUndo() {
    if (!failure) return;
    setUndoOpen(false);
    setPhase("committing");
    try {
      const result = await undoImport(rpc, failure.importId, setProgress);
      const kept = result.refused_count ?? 0;
      setUndoNote(kept ? `Undone. ${kept} record${kept === 1 ? " was" : "s were"} changed or used after the import, so ${kept === 1 ? "it was" : "they were"} kept.` : "Undone: what this import added has been removed.");
      setFailure(null);
      setDry(null);
      setPhase("review");
    } catch (err) {
      setPhase("failed");
      setError(friendlyError(err, "The undo did not finish. Press Undo again."));
    } finally {
      setProgress(null);
      setHistoryKey((k) => k + 1);
    }
  }

  const clientProblems = built?.problems ?? [];
  const clean = isClean(dry?.result ?? null, clientProblems.length);
  const created = totalCreated(dry?.result ?? null);
  const preview = dry && built ? previewRows(built, dry.result) : [];
  const problemLines = [
    ...clientProblems.map((p) => `${p.sheet}, row ${p.row}${p.field ? `, ${p.field}` : ""}: ${p.message}`),
    ...(dry?.result.errors ?? []).map(describeMessage),
  ];
  const warningLines = (dry?.result.warnings ?? []).map(describeMessage);
  const busy = phase === "reading" || phase === "checking" || phase === "committing";

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <Upload className="size-5 text-slate-500" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-slate-950">Upload a file</p>
              <p className="text-sm text-slate-500">An Excel workbook (.xlsx) or a .csv. Each sheet is read as customers, suppliers, stock, quotes, sales orders, jobs, purchase orders, invoices (with their lines), payments, credit notes or delivery notes, and imported in that order. Nothing is written until you have seen the check and confirmed.</p>
            </div>
          </div>
          <input
            ref={inputRef}
            type="file"
            aria-label="Choose a file to import"
            data-testid="import-file"
            accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={busy}
            onChange={(event) => void onFile(event.target.files?.[0])}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm"
          />
          {phase === "reading" ? <p className="text-sm text-slate-500">Reading the file…</p> : null}
          {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" data-testid="import-error">{error}</p> : null}
          {undoNote ? <p role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900" data-testid="import-undone">{undoNote}</p> : null}
        </CardContent>
      </Card>

      {file && (phase === "review" || phase === "checking" || phase === "preview" || phase === "committing" || phase === "failed") ? (
        <section className="space-y-3" aria-label="Sheets in the file">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">{file.name}</h2>
            <p className="text-sm text-slate-500">{plans.length} sheet{plans.length === 1 ? "" : "s"}. Import order: customers, suppliers, stock, quotes, sales orders, jobs, purchase orders, invoices, payments, credit notes, then delivery notes.</p>
          </div>
          {[...plans].sort((a, b) => (a.kind ? IMPORT_KINDS.indexOf(a.kind) : 99) - (b.kind ? IMPORT_KINDS.indexOf(b.kind) : 99)).map((plan) => (
            <SheetCard
              key={plan.id}
              plan={plan}
              onKind={(kind) => { invalidate(); setPlans((list) => list.map((p) => (p.id === plan.id ? chooseKind(p, kind, saved) : p))); }}
              onTarget={(index, target) => { invalidate(); setPlans((list) => list.map((p) => (p.id === plan.id ? chooseTarget(p, index, target) : p))); }}
            />
          ))}
          {plans.some((p) => p.unplaced.length) ? <p className="text-sm text-amber-800">Some rows have a Kind Tolra doesn&apos;t know. They are listed as problems when you check the file.</p> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={!ready || !hasWork || busy || phase === "failed"} onClick={() => void check()}>
              {phase === "checking" ? "Checking…" : "Check the file"}
            </Button>
            {!ready ? <span className="text-sm text-slate-500">Choose what each sheet is first.</span> : null}
          </div>
          {phase === "checking" ? <ProgressBar progress={progress} /> : null}
        </section>
      ) : null}

      {built?.notices.length && (phase === "preview" || phase === "review" || phase === "failed") ? (
        <div className="space-y-2" data-testid="import-notices">
          {built.notices.map((n, i) => (
            <p key={i} className={`rounded-lg border p-3 text-sm ${n.tone === "warning" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-700"}`}>{n.message}</p>
          ))}
        </div>
      ) : null}

      {dry && built && (phase === "preview" || phase === "committing" || phase === "failed") ? (
        <section className="space-y-3" aria-label="Check result" data-testid="import-preview">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-950">{clean ? "The file is clean" : "The file has problems"}</h2>
            {dry.large ? <span className="rounded bg-slate-900 px-2 py-0.5 text-xs font-medium text-white" data-testid="import-large">Large import</span> : null}
          </div>
          <p className="text-sm text-slate-600">
            {clean
              ? created > 0
                ? dry.large
                  ? `This is a large import: it goes in ${dry.result.parts ?? "several"} parts, with a progress bar, and can be undone.`
                  : "Small enough to go in as one step: all of it, or none of it."
                : "Nothing new: everything in this file is already in Tolra, so there is nothing to import."
              : "Nothing was written. Fix the file (or the column choices above) and check it again."}
          </p>
          <div className="overflow-x-auto rounded-lg border bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="px-3 py-2">Kind</th><th className="px-3 py-2 text-right">Rows</th><th className="px-3 py-2 text-right">Created</th>
                  <th className="px-3 py-2 text-right">Matched (skipped)</th><th className="px-3 py-2 text-right">Linked</th><th className="px-3 py-2 text-right">Problems</th><th className="px-3 py-2 text-right">Warnings</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((row) => (
                  <tr key={row.kind} className="border-t" data-testid={`import-count-${row.kind}`}>
                    <td className="px-3 py-2 font-medium">{KIND_LABEL[row.kind]}</td>
                    <td className="px-3 py-2 text-right tabular-nums" data-col="rows">{row.rows}</td>
                    <td className="px-3 py-2 text-right tabular-nums" data-col="created">{row.created}</td>
                    <td className="px-3 py-2 text-right tabular-nums" data-col="matched">{row.matched}</td>
                    <td className="px-3 py-2 text-right tabular-nums" data-col="linked">{row.linked ?? "–"}</td>
                    <td className="px-3 py-2 text-right tabular-nums" data-col="problems">{row.problems}</td>
                    <td className="px-3 py-2 text-right tabular-nums" data-col="warnings">{row.warnings}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">A matched row is already in Tolra and is skipped: nothing in Tolra is ever overwritten.</p>
          <MessageList title="Problems" items={problemLines} tone="red" testId="import-problems" />
          <MessageList title="Warnings (these don't stop the import)" items={warningLines} tone="amber" testId="import-warnings" />
          {phase === "committing" ? <ProgressBar progress={progress} /> : null}
          {phase === "failed" && failure ? (
            <div role="alert" className="space-y-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900" data-testid="import-failed">
              <p>{failure.message}</p>
              <div className="flex flex-wrap gap-2">
                <Button className="bg-brand text-brand-ink hover:bg-brand-hover" onClick={() => void confirm(failure.part)}>Retry this part</Button>
                <Button variant="destructive" onClick={() => setUndoOpen(true)}>Undo this import</Button>
              </div>
            </div>
          ) : null}
          {phase !== "failed" ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={!clean || created === 0 || busy} onClick={() => void confirm()}>
                {phase === "committing" ? "Importing…" : "Confirm import"}
              </Button>
              {!clean ? <span className="text-sm text-slate-500">Confirm is available when the check is clean.</span> : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {phase === "done" && done ? (
        <Card data-testid="import-done">
          <CardContent className="space-y-3 p-5">
            <p className="flex items-center gap-2 text-lg font-semibold text-slate-950"><CheckCircle2 className="size-5 text-green-600" /> Imported{done.large ? " (large import)" : ""}</p>
            <ul className="text-sm text-slate-700">
              {IMPORT_KINDS.filter((k) => (done.result.counts?.[k]?.created ?? 0) > 0 || (done.result.counts?.[k]?.matched_existing ?? 0) > 0).map((k) => (
                <li key={k} data-testid={`import-done-${k}`}>{KIND_LABEL[k]}: {done.result.counts?.[k]?.created ?? 0} created, {done.result.counts?.[k]?.matched_existing ?? 0} already in Tolra</li>
              ))}
            </ul>
            {nextNumbers(done.result.doc_counters).length ? <p className="text-sm text-slate-600">Next numbers Tolra issues: {nextNumbers(done.result.doc_counters).join(", ")}.</p> : null}
            {done.mappingsSaved ? <p className="text-sm text-slate-600">Your column choices were saved for this company: the next file with these headers needs none.</p> : null}
            {done.mappingError ? <p className="text-sm text-amber-800">The import is done, but your column choices could not be saved.</p> : null}
            {done.large ? <p className="text-sm text-slate-600">This was a large import: it can be undone below.</p> : null}
            <Button variant="outline" onClick={() => { setDone(null); setFile(null); setPlans([]); setBuilt(null); setDry(null); setPhase("idle"); }}>Import another file</Button>
          </CardContent>
        </Card>
      ) : null}

      <DataImportHistory refreshKey={historyKey} />

      <ConfirmDialog
        open={undoOpen}
        title="Undo this import?"
        description="Everything this import added is removed, last part first. A record that was changed or used after the import is kept and reported."
        confirmLabel="Undo import"
        destructive
        onCancel={() => setUndoOpen(false)}
        onConfirm={() => void runUndo()}
      />
    </div>
  );
}
