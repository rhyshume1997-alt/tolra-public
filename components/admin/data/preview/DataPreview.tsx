"use client";

/**
 * BOUNDARY (Admin > Data, PREVIEW ONLY: nothing here is wired to anything, and nothing here can import, undo, discard or export anything).
 * v2 (claude/portal-admin-v2, owner approved STRUCTURAL-CHANGES-BRIEF items 4, 7, 9, 10, 11): shared PreviewBar and PageHeader replace the local preview pill and h1, text uses the v4 type scale, a row with several actions shows one primary and a More menu, narrow records use the shared StackedRows. Presentation only: wording, controls, states, roles and rules are unchanged.
 * OWNERSHIP ASSUMPTION FOR THE OWNER TO CONFIRM: docs/MODULES.md gives /admin/data no module. By the coordinator's decision it is treated as a company-admin screen under
 * Module 1 (Auth / Company / Users / Admin). If it belongs elsewhere, move these four files; nothing else depends on them.
 * Inputs: none from the server and NO file is ever read: the file button only draws a sample file. Everything shown is fictional (a made-up company, made-up sheets, rows and import
 * history, as of 23/11/2026) held in this file, plus the person's clicks. Outputs: the Admin > Data look-and-feel prototype: Upload a file, the sheet cards (what each sheet is, its
 * columns), Check the file (progress), the check result (clean small, clean large, problems), a failed part with Retry and Undo, Import history and the SliQ go-live import card (its
 * first screen). It calls NO Supabase, rpc, fetch, file-reader or auth code. Every committing control (Check the file, Confirm import, Retry this part, Undo, Discard, Choose files)
 * answers with the neutral "Preview only ... Nothing was saved." toast; Undo and Discard first show the real confirmation wording, then only the toast. The Role control only
 * changes which screen is drawn; it grants nothing.
 * NOT DRAWN, ON PURPOSE: the real "Imported" result and the "Undone" note (they would show an import succeeding), and the later SliQ phases (checked, preflight, importing, failed,
 * reconciliation). Run-time imports from lib/ are pure modules only (import-targets, import-preview, sliq-validate/validate); the history labels (runState in
 * components/data-import-history.tsx, which reaches Supabase) are mirrored here and pinned to that source text by tests/unit/adminDataPreview.test.ts.
 * MUST NOT CHANGE: wording, the admin-only rule, "nothing is written until you have seen the check and confirmed" and "a matched row is never overwritten" mirror today's page. Do not
 * wire this to real data, a file, a session or an action, do not add a control the real page lacks (no export, no delete beyond the real Undo and Discard), keep every control at a 48 px
 * hit area. Delete the four preview files to remove it completely.
 */

import { useCallback, useState } from "react";
import {
  Button, Callout, Checkbox, Dialog, Disclosure, EmptyState, FailedState, Field, LoadingState, Panel, Popover, ScrollTable, SegmentedControl, Select, StatusBadge, ToastProvider, cx,
  premiumTokens, tabularNumbers, useToast, PageHeader, PreviewBar } from "@/components/ui/premium";
import { fmtDateTime } from "@/lib/dates";
import { describeMessage, isClean, totalCreated } from "@/lib/import-preview";
import type { PreviewRow } from "@/lib/import-preview";
import { IMPORT_KINDS, KIND_LABEL, targetsFor, type ImportKind } from "@/lib/import-targets";
import { ALL_ENTITIES } from "@/lib/sliq-validate/validate";
import type { UserRole } from "@/types";

import s from "./DataPreview.module.css";

export type Role = UserRole;
export type Phase = "idle" | "reading" | "review" | "checking" | "preview-small" | "preview-large" | "preview-problems" | "committing" | "failed";
export type HistoryState = "ready" | "loading" | "empty" | "error";

/* ---------- the real page's wording (app/(dashboard)/admin/data/page.tsx, components/data-import.tsx, data-import-history.tsx, sliq-import.tsx), pinned by the test ---------- */
export const PAGE_TITLE = "Data";
export const SUBTITLE = "Bring records in from a spreadsheet. The database checks every row first and writes nothing if any row has a problem.";
export const UPLOAD_TITLE = "Upload a file";
export const UPLOAD_TEXT = "An Excel workbook (.xlsx) or a .csv. Each sheet is read as customers, suppliers, stock, quotes, sales orders, jobs, purchase orders, invoices (with their lines), payments, credit notes or delivery notes, and imported in that order. Nothing is written until you have seen the check and confirmed.";
export const IMPORT_ORDER = "Import order: customers, suppliers, stock, quotes, sales orders, jobs, purchase orders, invoices, payments, credit notes, then delivery notes.";
export const CHOOSE_FIRST = "Choose what each sheet is first.";
export const NOT_CHOSEN = "Choose what this sheet is before checking the file. A sheet is never guessed.";
export const CLEAN_SMALL = "Small enough to go in as one step: all of it, or none of it.";
export const NOTHING_WRITTEN = "Nothing was written. Fix the file (or the column choices above) and check it again.";
export const MATCHED_NOTE = "A matched row is already in Tolra and is skipped: nothing in Tolra is ever overwritten.";
export const CONFIRM_NEEDS_CLEAN = "Confirm is available when the check is clean.";
export const UNDO_TITLE = "Undo this import?";
export const UNDO_TEXT = "Everything this import added is removed, last part first. A record that was changed or used after the import is kept and reported.";
export const DISCARD_TITLE = "Discard this checked file?";
export const DISCARD_TEXT = "It was checked but never imported. Discarding removes the staged file.";
export const HISTORY_EMPTY = "No imports yet.";
export const HISTORY_ERROR = "Couldn't load the import history.";
export const SLIQ_TITLE = "SliQ go-live import";
export const SLIQ_TEXT = "Choose the confirmed mapping (.json) and the original SliQ export files together. They are read and checked here and are not uploaded. Keep the untouched originals and their signed SHA-256 sheet outside Tolra.";
export const SLIQ_FILES_LABEL = "SliQ files and mapping";
export const SLIQ_FILES_HINT = "The confirmed mapping (.json) and every SliQ export file (.csv), chosen together. Only .csv and .json files can be chosen: save an .xls or .xlsx export as CSV first.";
export const SLIQ_GAP = "Invoice numbers really do jump by more than 1,000 (only tick after checking: a typo would carry the INV counter there for good)";
export const SLIQ_STATUS = `Mapping: not chosen. Files: ${ALL_ENTITIES.filter((e) => e !== "creditNotes").map((e) => `${e} no`).join(", ")}.`;
export const ROLES: Role[] = ["admin", "office", "workshop", "viewer"];
export const canUseData = (role: Role): boolean => role === "admin";
export const progressLabel = (phase: "checking" | "committing") => (phase === "checking" ? "Checking the whole file" : "Importing");

/** What a large import's state means for the admin: mirrors runState in components/data-import-history.tsx. */
export function runState(run: { status: string; parts: number | null; parts_committed: number; parts_undone: number }): { label: string; action: "undo" | "discard" | null } {
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

/* ---------- sample data (fictional) ---------- */
export type SamplePlan = { id: string; sheetName: string; rows: number; kind: ImportKind | null; suggestion: ImportKind | null; source: "saved" | "headers" | null; columns: Array<{ header: string; sample: string; target: string | null }> };
export const FILE_NAME = "fernhill-legacy-export-2026-11.xlsx";
export const initialPlans = (allChosen: boolean): SamplePlan[] => [
  { id: "sh1", sheetName: "Customers", rows: 120, kind: "customers", suggestion: null, source: "headers", columns: [
    { header: "Name", sample: "Wexcombe Plastics Ltd", target: "name" }, { header: "E-mail", sample: "accounts@wexcombe.example", target: "email" },
    { header: "Telephone", sample: "01632 960101", target: "phone" }, { header: "Account manager", sample: "C. Reeve", target: null },
  ] },
  { id: "sh2", sheetName: "Orders 2026", rows: 342, kind: allChosen ? "sales_orders" : null, suggestion: "sales_orders", source: allChosen ? "headers" : null, columns: [
    { header: "Order no", sample: "SO-0612", target: "so_number" }, { header: "Customer", sample: "Wexcombe Plastics Ltd", target: "customer" }, { header: "Delivery", sample: "2026-12-02", target: "delivery_date" },
  ] },
  { id: "sh3", sheetName: "Invoices", rows: 1210, kind: "invoices", suggestion: null, source: "saved", columns: [
    { header: "Invoice", sample: "INV-1187", target: "invoice_ref" }, { header: "Customer", sample: "Wexcombe Plastics Ltd", target: "customer" },
  ] },
];
const row = (kind: ImportKind, rows: number, created: number, matched: number, linked: number | null, problems: number, warnings: number): PreviewRow => ({ kind, rows, created, matched, linked, problems, warnings });
export const CLEAN_ROWS: PreviewRow[] = [row("customers", 120, 112, 8, null, 0, 0), row("sales_orders", 342, 342, 0, 330, 0, 2), row("invoices", 1210, 1190, 20, 1190, 0, 0)];
export const SMALL_ROWS: PreviewRow[] = [row("customers", 24, 21, 3, null, 0, 0), row("suppliers", 9, 9, 0, null, 0, 0)];
export const PROBLEM_ROWS: PreviewRow[] = [row("customers", 120, 112, 8, null, 0, 0), row("invoices", 1210, 0, 0, 0, 3, 1)];
export const PROBLEM_LINES = [
  { kind: "invoices", row: 4, field: "invoice_ref", message: "Invoice number is required." },
  { kind: "invoices", row: 19, field: "invoice_date", message: "That date could not be read." },
  { kind: "invoices", row: 207, field: "customer", message: "No customer is named." },
].map((m) => describeMessage(m as Parameters<typeof describeMessage>[0]));
export const WARNING_LINES = [{ kind: "invoices", row: 33, field: null, message: "Not linked to a job: no job has this number." }].map((m) => describeMessage(m as Parameters<typeof describeMessage>[0]));
export const RESULT_CLEAN = { ok: true, error_count: 0, counts: { customers: { created: 112, matched_existing: 8 }, sales_orders: { created: 342 }, invoices: { created: 1190, matched_existing: 20 } } };
export const RESULT_PROBLEMS = { ok: false, error_count: 3, counts: { customers: { created: 112 } } };
export const FAILURE_TEXT = "Part 3 of 6 did not go in: The database stopped. The parts before it are in. Retry this part, or undo this import to put things back as they were.";

export type Run = { id: string; status: string; file: string; parts: number | null; parts_committed: number; parts_undone: number; at: string; large: boolean; kept?: number };
export const RUNS: Run[] = [
  { id: "r1", status: "committing", file: "stock-update-2026-11.xlsx", parts: 6, parts_committed: 3, parts_undone: 0, at: "2026-11-22T15:10:00Z", large: true },
  { id: "r2", status: "validated", file: "customers-extra.csv", parts: 4, parts_committed: 0, parts_undone: 0, at: "2026-11-21T09:30:00Z", large: true },
  { id: "r3", status: "committed", file: "fernhill-legacy-export-2026-10.xlsx", parts: 8, parts_committed: 8, parts_undone: 0, at: "2026-10-30T11:02:00Z", large: true },
  { id: "r4", status: "undone", file: "test-run.xlsx", parts: 5, parts_committed: 5, parts_undone: 5, at: "2026-10-12T08:45:00Z", large: true, kept: 2 },
  { id: "r5", status: "cancelled", file: "old-quotes.xlsx", parts: 3, parts_committed: 0, parts_undone: 0, at: "2026-10-02T14:20:00Z", large: true },
];
export const SMALL_RUNS = [{ id: "s1", file: "suppliers-2026.csv", created: 84, at: "2026-11-05T10:15:00Z" }];

const PHASES: Array<{ v: Phase; label: string }> = [
  { v: "idle", label: "Start (nothing chosen)" }, { v: "reading", label: "Reading the file" }, { v: "review", label: "Sheets to review" }, { v: "checking", label: "Checking the file" },
  { v: "preview-small", label: "Check clean, small import" }, { v: "preview-large", label: "Check clean, large import" }, { v: "preview-problems", label: "Check found problems" },
  { v: "committing", label: "Importing (progress)" }, { v: "failed", label: "A part did not go in" },
];
const HISTORIES: Array<{ v: HistoryState; label: string }> = [
  { v: "ready", label: "History with imports" }, { v: "loading", label: "Loading history" }, { v: "empty", label: "No imports yet" }, { v: "error", label: "History couldn't load" },
];
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: r.charAt(0).toUpperCase() + r.slice(1) }));

export default function DataPreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

type Ask = { kind: "undo" | "discard"; run?: Run } | null;

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [phase, setPhase] = useState<Phase>("idle");
  const [history, setHistory] = useState<HistoryState>("ready");
  const [plans, setPlans] = useState<SamplePlan[]>(() => initialPlans(false));
  const [ask, setAsk] = useState<Ask>(null);
  const [gap, setGap] = useState(false);
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const denied = !canUseData(role);
  const ready = plans.every((p) => p.kind);
  const showSheets = phase === "review" || phase === "checking" || phase === "preview-small" || phase === "preview-large" || phase === "preview-problems" || phase === "committing" || phase === "failed";
  const showResult = phase === "preview-small" || phase === "preview-large" || phase === "preview-problems" || phase === "committing" || phase === "failed";
  const busy = phase === "reading" || phase === "checking" || phase === "committing";
  const problems = phase === "preview-problems";
  const rows = problems ? PROBLEM_ROWS : phase === "preview-small" ? SMALL_ROWS : CLEAN_ROWS;
  const result = problems ? RESULT_PROBLEMS : RESULT_CLEAN;
  const clean = isClean(result, 0);
  const created = totalCreated(result);
  const large = phase !== "preview-small" && !problems;
  const pickPhase = (v: Phase) => { toast.clear(); setAsk(null); if (v === "review") setPlans(initialPlans(false)); else if (v !== "idle" && v !== "reading") setPlans(initialPlans(true)); setPhase(v); };
  const reset = () => { toast.clear(); setAsk(null); setRole("admin"); setPhase("idle"); setHistory("ready"); setPlans(initialPlans(false)); setGap(false); };
  const chooseFile = () => { preview("No file was read. A sample file is shown instead."); setPlans(initialPlans(false)); setPhase("review"); };
  const setKind = (id: string, kind: ImportKind | null) => setPlans((list) => list.map((p) => (p.id === id ? { ...p, kind, source: null } : p)));
  const setTarget = (id: string, index: number, target: string | null) => setPlans((list) => list.map((p) => (p.id === id ? { ...p, columns: p.columns.map((c, i) => (i === index ? { ...c, target } : c)) } : p)));
  const confirmAsk = () => {
    const a = ask; setAsk(null);
    if (!a) return;
    preview(a.kind === "undo" ? "The import would be undone, last part first." : "The checked file would be discarded.");
  };

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="data-preview" data-role={role} data-phase={phase}>
      <PreviewBar
        data-testid="preview-bar"
        controls={
          <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
            <div className={s.dock}>
              <p className={s.dockNote}>Not part of Tolra. Sample data; states are simulated, nothing is granted, no file is read and no request is made.</p>
              <p className={s.dockLabel}>Who is looking (changes the drawing only)</p>
              <SegmentedControl label="Role" value={role} options={ROLE_OPTIONS} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
              <p className={s.dockLabel}>Import stage</p>
              <div className={s.dockStates} role="group" aria-label="Import stage">
                {PHASES.map((x) => <button key={x.v} type="button" aria-pressed={phase === x.v} className={s.dockBtn} onClick={() => pickPhase(x.v)}>{x.label}</button>)}
              </div>
              <p className={s.dockLabel}>Import history</p>
              <div className={s.dockStates} role="group" aria-label="Import history state">
                {HISTORIES.map((x) => <button key={x.v} type="button" aria-pressed={history === x.v} className={s.dockBtn} onClick={() => setHistory(x.v)}>{x.label}</button>)}
              </div>
              <Button size="sm" variant="secondary" data-testid="dock-reset" onClick={reset}>Reset preview</Button>
            </div>
          </Popover>
        }
      />
      <PageHeader
        title={denied ? "Access Denied" : PAGE_TITLE}
        description={denied ? "Redirecting you back to the dashboard." : SUBTITLE}
      />

      {denied ? (
        <section className={s.denied} data-testid="access-denied" aria-label="Access denied">
          <p className={s.deniedNote}>Only an admin can bring records in.</p>
          <p className={s.deniedPreview}>Preview only: no redirect happens here. Data is for Admin only; Office, Workshop and Viewer see &quot;Access Denied&quot; and are sent to the dashboard after two seconds.</p>
        </section>
      ) : (
        <div className={s.stack}>
          <Panel title={UPLOAD_TITLE} data-testid="upload-panel">
            <div className={s.section}>
              <p className={s.body}>{UPLOAD_TEXT}</p>
              <div className={s.uploadRow}>
                <Button variant="secondary" disabled={busy} aria-label="Choose a file to import" data-testid="import-file" onClick={chooseFile}>Choose a file</Button>
                <span className={s.fileState}>{phase === "reading" ? "Reading the file…" : "No file chosen"}</span>
              </div>
            </div>
          </Panel>

          {showSheets ? (
            <section className={s.section} aria-label="Sheets in the file" data-testid="sheets">
              <div>
                <h2 className={s.h2}>{FILE_NAME}</h2>
                <p className={s.small}>{plans.length} sheets. {IMPORT_ORDER}</p>
              </div>
              {plans.map((plan) => <SheetCard key={plan.id} plan={plan} disabled={phase === "failed"} onKind={(k) => setKind(plan.id, k)} onTarget={(i, t) => setTarget(plan.id, i, t)} />)}
              <div className={s.actions}>
                <Button variant="primary" disabled={!ready || busy || phase === "failed"} data-testid="check-file" onClick={() => preview("The file would be checked against the database. Nothing was written.")}>{phase === "checking" ? "Checking…" : "Check the file"}</Button>
                {!ready ? <span className={s.small}>{CHOOSE_FIRST}</span> : null}
              </div>
              {phase === "checking" ? <Progress phase="checking" done={2} total={5} /> : null}
            </section>
          ) : null}

          {showResult ? (
            <section className={s.section} aria-label="Check result" data-testid="import-preview">
              <div className={s.titleLine}>
                <h2 className={s.h2}>{clean ? "The file is clean" : "The file has problems"}</h2>
                {large && !problems ? <span className={s.large} data-testid="import-large">Large import</span> : null}
              </div>
              <p className={s.body}>
                {clean ? (created > 0 ? (large ? "This is a large import: it goes in 6 parts, with a progress bar, and can be undone." : CLEAN_SMALL) : "Nothing new: everything in this file is already in Tolra, so there is nothing to import.") : NOTHING_WRITTEN}
              </p>
              <ScrollTable label="Check result table" dense>
                <thead><tr><th scope="col">Kind</th><th scope="col" className={s.right}>Rows</th><th scope="col" className={s.right}>Created</th><th scope="col" className={s.right}>Matched (skipped)</th><th scope="col" className={s.right}>Linked</th><th scope="col" className={s.right}>Problems</th><th scope="col" className={s.right}>Warnings</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.kind} data-testid={`import-count-${r.kind}`}>
                      <td><strong>{KIND_LABEL[r.kind]}</strong></td>
                      <td className={cx(s.right, tabularNumbers)}>{r.rows}</td><td className={cx(s.right, tabularNumbers)}>{r.created}</td><td className={cx(s.right, tabularNumbers)}>{r.matched}</td>
                      <td className={cx(s.right, tabularNumbers)}>{r.linked ?? "–"}</td><td className={cx(s.right, tabularNumbers)}>{r.problems}</td><td className={cx(s.right, tabularNumbers)}>{r.warnings}</td>
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>
              <p className={s.small}>{MATCHED_NOTE}</p>
              {problems ? <Messages title="Problems" items={PROBLEM_LINES} tone="red" testId="import-problems" /> : null}
              {problems || phase === "preview-large" ? <Messages title="Warnings (these don't stop the import)" items={WARNING_LINES} tone="amber" testId="import-warnings" /> : null}
              {phase === "committing" ? <Progress phase="committing" done={3} total={6} /> : null}
              {phase === "failed" ? (
                <Callout tone="error" lead="" role="alert" data-testid="import-failed">
                  <p style={{ margin: "0 0 10px" }}>{FAILURE_TEXT}</p>
                  <div className={s.actions}>
                    <Button variant="primary" onClick={() => preview("Part 3 would be retried.")}>Retry this part</Button>
                    <Button variant="danger" data-testid="undo-failed" onClick={() => setAsk({ kind: "undo" })}>Undo this import</Button>
                  </div>
                </Callout>
              ) : (
                <div className={s.actions}>
                  <Button variant="primary" disabled={!clean || created === 0 || busy} data-testid="confirm-import" onClick={() => preview("The import would run.")}>{phase === "committing" ? "Importing…" : "Confirm import"}</Button>
                  {!clean ? <span className={s.small}>{CONFIRM_NEEDS_CLEAN}</span> : null}
                </div>
              )}
            </section>
          ) : null}

          <section className={s.section} aria-label="Import history" data-testid="import-history">
            <h2 className={s.h2}>Import history</h2>
            {history === "error" ? <Callout tone="error" lead="" role="alert">{HISTORY_ERROR}</Callout> : null}
            {history === "loading" ? <LoadingState label="Loading the import history" rows={3} /> : history === "error" ? null : history === "empty" ? <EmptyState compact headingLevel={3} title={HISTORY_EMPTY} /> : (
              <Panel label="Imports" bare>
                <ul className={s.history}>
                  {[...RUNS.map((r) => ({ at: r.at, run: r, small: null as null | (typeof SMALL_RUNS)[number] })), ...SMALL_RUNS.map((x) => ({ at: x.at, run: null as null | Run, small: x }))].sort((a, b) => b.at.localeCompare(a.at)).map((it) => {
                    if (it.run) {
                      const st = runState(it.run);
                      return (
                        <li key={it.run.id} className={s.run} data-testid="history-row" data-status={it.run.status}>
                          <div className={s.runMain}>
                            <span className={s.runName}>{it.run.file}<span className={s.large}>Large import</span></span>
                            <span className={s.runMeta} data-testid="history-state">{st.label}{it.run.kept ? `; ${it.run.kept} kept (changed or used since)` : ""}</span>
                            <span className={cx(s.runWhen, tabularNumbers)}>{fmtDateTime(it.at)}</span>
                          </div>
                          {st.action ? <Button size="sm" variant="secondary" onClick={() => setAsk({ kind: st.action!, run: it.run! })}>{st.action === "undo" ? "Undo" : "Discard"}</Button> : null}
                        </li>
                      );
                    }
                    return (
                      <li key={it.small!.id} className={s.run} data-testid="history-row" data-status="committed-small">
                        <div className={s.runMain}>
                          <span className={s.runName}>{it.small!.file}</span>
                          <span className={s.runMeta} data-testid="history-state">Imported in one step ({it.small!.created} created). A small import goes in whole or not at all.</span>
                          <span className={cx(s.runWhen, tabularNumbers)}>{fmtDateTime(it.at)}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Panel>
            )}
          </section>

          <Panel title={SLIQ_TITLE} data-testid="sliq-import">
            <div className={s.section}>
              <p className={s.body}>{SLIQ_TEXT}</p>
              <Field label={SLIQ_FILES_LABEL} hint={SLIQ_FILES_HINT}>
                <div><Button variant="secondary" aria-label={`Choose files: ${SLIQ_FILES_LABEL}`} data-testid="sliq-files-input" onClick={() => preview("No file was read.")}>Choose files</Button></div>
              </Field>
              <p className={s.small} data-testid="sliq-files">{SLIQ_STATUS}</p>
              <label className={s.checkRow}>
                <Checkbox checked={gap} onChange={(e) => setGap(e.target.checked)} />
                <span className={s.body}>{SLIQ_GAP}</span>
              </label>
              <div className={s.actions}>
                <Button variant="secondary" disabled data-testid="sliq-check">Check files</Button>
                <Button variant="secondary" disabled data-testid="sliq-preflight">Preflight (writes nothing)</Button>
              </div>
            </div>
          </Panel>
        </div>
      )}

      <Dialog
        open={ask !== null}
        title={ask?.kind === "discard" ? DISCARD_TITLE : UNDO_TITLE}
        description={ask?.kind === "discard" ? DISCARD_TEXT : UNDO_TEXT}
        confirmLabel={ask?.kind === "discard" ? "Discard" : "Undo import"}
        onConfirm={confirmAsk}
        onClose={() => setAsk(null)}
      />
    </div>
  );
}

function Progress({ phase, done, total }: { phase: "checking" | "committing"; done: number; total: number }) {
  const pct = Math.round((done / total) * 100);
  const label = progressLabel(phase);
  return (
    <div className={s.progress} data-testid="import-progress">
      <p className={s.body}>{label}: {done} of {total} parts done</p>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className={s.bar}><div className={s.barFill} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function Messages({ title, items, tone, testId }: { title: string; items: string[]; tone: "red" | "amber"; testId: string }) {
  if (!items.length) return null;
  return (
    <div className={cx(s.messages, tone === "red" ? s.messagesRed : s.messagesAmber)} data-testid={testId}>
      <p className={s.messagesTitle}>{title} ({items.length})</p>
      <ul>{items.map((line, i) => <li key={i}>{line}</li>)}</ul>
    </div>
  );
}

function SheetCard({ plan, disabled, onKind, onTarget }: { plan: SamplePlan; disabled: boolean; onKind: (k: ImportKind | null) => void; onTarget: (index: number, target: string | null) => void }) {
  const unknown = plan.columns.filter((c) => !c.target).length;
  return (
    <Panel data-testid="import-sheet" label={plan.sheetName}>
      <div className={s.section}>
        <div className={s.sheetHead}>
          <div>
            <p className={s.sheetName}>{plan.sheetName}</p>
            <p className={s.small}>{plan.rows} rows{plan.kind && plan.source === "saved" ? " · known from your saved mapping" : plan.kind && plan.source === "headers" ? " · recognised from its headers" : ""}</p>
          </div>
          <Field label="This sheet is" className={s.kindField}>
            <Select aria-label={`What is ${plan.sheetName}?`} value={plan.kind ?? ""} disabled={disabled} onChange={(e) => onKind((e.target.value || null) as ImportKind | null)}>
              <option value="">{plan.suggestion ? `Choose (looks like ${KIND_LABEL[plan.suggestion].toLowerCase()})` : "Choose what it is"}</option>
              {IMPORT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </Select>
          </Field>
        </div>
        {!plan.kind ? <p className={s.warnText}>{NOT_CHOSEN}</p> : null}
        {plan.kind === "customers" ? <p className={s.small}>The contact person is kept as free text, not a Tolra user. No user and no signature is created.</p> : null}
        {plan.kind ? (
          <Disclosure key={plan.kind} summary={`Columns${unknown ? ` (${unknown} not recognised)` : ""}`} defaultOpen={unknown > 0}>
            <div className={s.cols}>
              {plan.columns.map((c, i) => (
                <div key={c.header} className={s.col} data-testid="import-column">
                  <span className={s.colHead}>{c.header}</span>
                  <span className={s.colSample}>{c.sample || "(empty)"}</span>
                  <Select aria-label={`Column ${c.header} goes to`} value={c.target ?? ""} disabled={disabled} onChange={(e) => onTarget(i, e.target.value || null)}>
                    <option value="">{!c.target ? "Ignore (not recognised)" : "Ignore"}</option>
                    {targetsFor(plan.kind!).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </Select>
                </div>
              ))}
            </div>
          </Disclosure>
        ) : null}
      </div>
    </Panel>
  );
}
