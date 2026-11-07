"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { friendlyError } from "@/lib/friendly-error";
import { buildSliqPayload } from "@/lib/sliq-import-build";
import {
  type Rpc, type SliqBatchResult, type SliqPayload, type SliqPreflight, type SliqRunProgress, isRunLabel, planSliqBatches, sliqPreflight, sliqRunBatches,
} from "@/lib/sliq-import-route";
import type { Entity, SliqMapping, SourceFiles } from "@/lib/sliq-validate/validate";
import { supabase } from "@/lib/supabase";

// lib/sliq-validate's validateSliqExport hashes with node:crypto, which the browser bundle can't load; it is run before this page on the same
// files (state-machines/SLIQ-IMPORT-ROUTE.md). Here the builder re-reads the files and refuses anything malformed, and the preflight checks the rest.
const ENTITIES: Entity[] = ["customers", "suppliers", "invoices", "payments"];
const asMapping = (text: string): SliqMapping | null => {
  const m = JSON.parse(text) as SliqMapping;
  return m && m.confirmed === true && m.entities && ENTITIES.every((e) => typeof m.entities[e]?.file === "string") ? m : null;
};

const rpc: Rpc = (fn, args) => {
  if (!supabase) return Promise.resolve({ data: null, error: { message: "Supabase is not configured." } });
  return supabase.rpc(fn, args) as unknown as ReturnType<Rpc>;
};

type Phase = "idle" | "checked" | "preflighted" | "importing" | "done" | "failed";

/**
 * Admin > Data import > SliQ go-live import (proposal p152). The original SliQ export files and the CONFIRMED mapping are read in the
 * browser; nothing leaves the page until the preflight. The files themselves are never uploaded or stored by Tolra: keep the originals
 * and their SHA-256 sheet outside Tolra (state-machines/SLIQ-IMPORT-ROUTE.md, "Keeping the originals").
 */
export function SliqImport() {
  const [mappingText, setMappingText] = useState<string | null>(null);
  const [files, setFiles] = useState<SourceFiles>({});
  const [payload, setPayload] = useState<SliqPayload | null>(null);
  const [preflight, setPreflight] = useState<SliqPreflight | null>(null);
  const [label, setLabel] = useState("live");
  const [phase, setPhase] = useState<Phase>("idle");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [progress, setProgress] = useState<SliqRunProgress | null>(null);
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [results, setResults] = useState<SliqBatchResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setPayload(null); setPreflight(null); setPhase("idle"); setFailedAt(null); setFailure(null); setResults([]); };

  async function onFiles(list: FileList | null) {
    reset();
    setError(null);
    if (!list) return;
    const all = Array.from(list);
    const json = all.find((f) => f.name.toLowerCase().endsWith(".json"));
    const mapping = json ? await json.text() : mappingText;
    let parsed: SliqMapping | null = null;
    try { parsed = mapping ? asMapping(mapping) : null; } catch { setError("The mapping file is not JSON."); }
    if (mapping && !parsed) setError("The mapping is not a confirmed SliQ mapping (confirmed: true, a file for each of customers, suppliers, invoices and payments).");
    const next: SourceFiles = {};
    for (const f of all) {
      if (f === json || !parsed) continue;
      const entity = ENTITIES.find((e) => parsed.entities[e].file === f.name);
      if (entity) next[entity] = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    }
    setMappingText(mapping);
    setFiles(next);
  }

  async function check() {
    setError(null);
    setBusy(true);
    try {
      const mapping = mappingText ? asMapping(mappingText) : null;
      if (!mapping) throw new Error("Choose the confirmed mapping first.");
      const built = await buildSliqPayload(files, mapping);
      setPayload(built.payload);
      setPhase("checked");
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

  const plan = payload ? planSliqBatches(payload) : null;
  const ready = phase === "preflighted" && preflight?.ok && plan && plan.orphanPayments.length === 0 && isRunLabel(label);

  return (
    <Card>
      <CardContent className="space-y-4 p-4" data-testid="sliq-import">
        <div>
          <h2 className="text-base font-semibold">SliQ go-live import</h2>
          <p className="mt-1 text-sm text-slate-500">
            Choose the confirmed mapping (.json) and the four original SliQ export files together. They are read here and are not uploaded. Keep the
            untouched originals and their signed SHA-256 sheet outside Tolra.
          </p>
        </div>
        <input type="file" multiple accept=".csv,.json,text/csv,application/json" aria-label="SliQ files and mapping" onChange={(e) => void onFiles(e.target.files)} />
        <p className="text-xs text-slate-500" data-testid="sliq-files">
          Mapping: {mappingText ? "chosen" : "not chosen"}. Files: {ENTITIES.map((e) => `${e} ${files[e] ? "yes" : "no"}`).join(", ")}.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy || !mappingText} onClick={() => void check()}>Check files</Button>
          <Button type="button" variant="outline" disabled={busy || !payload} onClick={() => void runPreflight()}>Preflight (writes nothing)</Button>
        </div>
        {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
        {payload ? (
          <p className="break-all text-xs text-slate-500" data-testid="sliq-hashes">
            Source key {payload.source_sha256}. {payload.source_files.map((f) => `${f.name} ${f.sha256}`).join("; ")}
          </p>
        ) : null}
        {preflight ? (
          <div className="space-y-2 text-sm" data-testid="sliq-preflight">
            <p>
              {(["customers", "suppliers", "invoices", "payments"] as const).map((k) => `${k}: ${preflight.counts[k].to_create} to create, ${preflight.counts[k].already_imported} already imported, ${preflight.counts[k].problems} with problems`).join(" | ")}
            </p>
            <p>Invoiced {preflight.money.invoiced}, paid {preflight.money.paid}, owed {preflight.money.owed}, payment to confirm {preflight.money.payment_to_confirm}.</p>
            {preflight.errors.length ? (
              <ul className="list-disc pl-5 text-red-700">
                {preflight.errors.slice(0, 50).map((e, i) => <li key={i}>{e.source_row_id ?? e.kind}: {e.message}</li>)}
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
          <p className="text-sm text-emerald-700" data-testid="sliq-done">
            Imported: {results.reduce((s, r) => s + (r.created ?? 0), 0)} records created, {results.filter((r) => r.already_imported).length} batches already imported. Now run the reconciliation.
          </p>
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
