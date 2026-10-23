"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Download, Upload } from "lucide-react";

import { CustomerSignOff } from "@/components/customer-signoff";
import { JobSignOff } from "@/components/job-signoff";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { auditEvent } from "@/lib/audit";
import { useCompanyProfile } from "@/lib/company";
import { DEMO_MODE } from "@/lib/demo";
import { friendlyError } from "@/lib/friendly-error";
import { PREFILL_LABELS, type WorksheetPrefillKey, loadWorksheetPrefillSource, prefillWorksheet } from "@/lib/job-machine-plan";
import {
  CHECKLIST_ITEMS, type DrawingFile, type JobWorksheet, type WorksheetJobInfo,
  drawingUrl, emptyWorksheet, isOverrun, currentWorksheetVersion, listDrawings, loadMachineNames, loadWorksheet, saveWorksheet, setDrawingRevision, setInspectionRequirements, missingTraceability, uploadDrawing, uploadNewRevision, validateDrawing,
  WorksheetConflictError, WorksheetMissingError,
  signOffState,
} from "@/lib/job-worksheet";
import { type CustomerPoFile, listCustomerPos } from "@/lib/job-files";
import { supabase } from "@/lib/supabase";
import { useSaving } from "@/lib/use-saving";
import { useUser } from "@/lib/use-user";

// Same colours and layout as the printed worksheet (components/job-worksheet-print.tsx), so the screen matches the sheet.
const BG = { grey: "bg-[#b8c0cc]", paleYellow: "bg-[#fff6c2]", green: "bg-[#b5dca0]", yellow: "bg-[#ffe44d]", peach: "bg-[#f8caa4]", blueGrey: "bg-[#cfd9e8]" };
/** Inputs sit inside the sheet's cells: no box of their own. */
const CELL_INPUT = "h-8 rounded-none border-0 bg-transparent px-1.5 text-black shadow-none focus-visible:ring-2 dark:bg-transparent";
/** Text boxes under a section bar; the sheet stays black on white in dark mode too, like the paper. */
const SHEET_TEXT = "rounded-none border-t-0 bg-white text-black dark:bg-white";

/** One labelled row of the sheet: coloured label cell, then the value. */
function Field({ label, bg, wide, children }: { label: string; bg: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className="flex min-h-9 border-b border-black last:border-b-0">
      <span className={`flex ${wide ? "w-[34%]" : "w-[38%]"} shrink-0 items-center border-r border-black px-1.5 py-1 text-[10px] font-bold uppercase text-slate-900 ${bg}`}>{label}</span>
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
    </label>
  );
}

/** A full-width section heading bar, as on the printed sheet. */
function Bar({ className = BG.blueGrey, children }: { className?: string; children: React.ReactNode }) {
  return <p className={`flex items-center justify-center gap-1 border border-black px-2 py-1 text-center text-[11px] font-bold uppercase ${className}`}>{children}</p>;
}

export function JobWorksheetForm({ job, onSaved, onDirtyChange }: {
  job: WorksheetJobInfo;
  /** Called with the worksheet and the row the database acknowledged. */
  onSaved?: (ws: JobWorksheet, row: Record<string, unknown> | null) => void;
  /** True while there are edits that haven't been saved (audit D5): the parent guards closing. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [ws, setWs] = useState<JobWorksheet>(() => emptyWorksheet(job));
  /** Last loaded or saved worksheet, and its version (audit D7). */
  const [baseline, setBaseline] = useState<string>(() => JSON.stringify(emptyWorksheet(job)));
  /**
   * The worksheet as first shown: the saved one with its EMPTY fields filled from the job's machines, bookings and machine runs (lib/
   * job-machine-plan prefillWorksheet; a saved value is never replaced). Those filled values are not saved until Save: closing without
   * editing doesn't ask (no edit of yours), but signing off asks to save first, so a sign-off always covers what is on screen.
   */
  const [shown, setShown] = useState<string>(() => JSON.stringify(emptyWorksheet(job)));
  const [prefilled, setPrefilled] = useState<WorksheetPrefillKey[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const [demo, setDemo] = useState(false);
  const [offlineCopy, setOfflineCopy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { saving, run } = useSaving();
  const { activeRole } = useUser();
  const { profile: company } = useCompanyProfile();
  const [machines, setMachines] = useState<string[]>([]);
  const [drawings, setDrawings] = useState<DrawingFile[]>((job.drawings || []).map((name) => ({ name })));
  /** The customer's PO carried from the quote (migration 067): part of the job pack, read-only here. */
  const [customerPos, setCustomerPos] = useState<CustomerPoFile[]>([]);
  useEffect(() => {
    let active = true;
    if (DEMO_MODE) return;
    listCustomerPos(job.id).then((rows) => { if (active) setCustomerPos(rows); }).catch(() => { if (active) setCustomerPos([]); });
    return () => { active = false; };
  }, [job.id]);
  const fileRef = useRef<HTMLInputElement>(null);
  /** A newer revision of this drawing is being uploaded (migration 034): its label and file. */
  const [revising, setRevising] = useState<DrawingFile | null>(null);
  const [newRevision, setNewRevision] = useState("");
  /** What the inspection of this job requires before a pass (migration 034). */
  const [required, setRequired] = useState({ certs: false, checklist: false });
  /** Whether the job is traceable (migration 082: cert no. and heat/cast no. before a pass); null before 082 (not shown). */
  const [traceable, setTraceable] = useState<boolean | null>(null);
  const [newRevisionFile, setNewRevisionFile] = useState<File | null>(null);
  const overrun = isOverrun(ws);
  const jobRef = useRef(job);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setLoadError(null);
      const [loaded, names, stored, source] = await Promise.all([
        loadWorksheet(jobRef.current), loadMachineNames(), listDrawings(jobRef.current.id),
        // Reads only; null (no prefill) when it can't be read, e.g. offline.
        supabase && !DEMO_MODE ? loadWorksheetPrefillSource(supabase, jobRef.current.id).catch(() => null) : Promise.resolve(null),
      ]);
      if (!active) return;
      if (loaded.error !== undefined) {
        setLoadError(loaded.error);
        setLoading(false);
        return;
      }
      const filled = source && !loaded.demo ? prefillWorksheet(loaded.worksheet, source) : { worksheet: loaded.worksheet, filled: [] as WorksheetPrefillKey[] };
      setWs(filled.worksheet);
      setBaseline(JSON.stringify(loaded.worksheet));
      setShown(JSON.stringify(filled.worksheet));
      setPrefilled(filled.filled);
      setVersion(loaded.version);
      setRequired({ certs: Boolean(loaded.row?.certs_required), checklist: Boolean(loaded.row?.checklist_required) });
      setTraceable(typeof loaded.row?.traceable === "boolean" ? loaded.row.traceable : null);
      setConflict(false);
      setDemo(loaded.demo);
      setOfflineCopy(Boolean(loaded.offline));
      setMachines(names);
      if (stored && !loaded.demo) setDrawings(stored);
      setLoading(false);
    }
    void load();
    return () => { active = false; };
  }, [job.id, attempt]);

  /** Edits made here (the close guard). */
  const dirty = !loading && !loadError && JSON.stringify(ws) !== shown;
  /** Anything on screen that isn't saved, prefilled values included (sign-off asks to save first). */
  const unsaved = !loading && !loadError && JSON.stringify(ws) !== baseline;
  const pendingPrefill = unsaved ? prefilled.filter((key) => ws[key] !== "" && JSON.parse(baseline)[key] === "") : [];
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  // Closing or reloading the tab with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Saving is only safe when the worksheet really came from the database (or demo mode is on).
  const canEdit = activeRole !== "viewer";
  /** Approving a drawing revision is for admins; what an inspection requires is set by admin and office (migration 034). */
  const canApprove = activeRole === "admin";
  const canRequire = activeRole === "admin" || activeRole === "office";
  const canSave = canEdit && !loading && !loadError && (!demo || DEMO_MODE);

  const set = <K extends keyof JobWorksheet>(key: K, value: JobWorksheet[K]) => {
    if (!canEdit) return; // viewers read the worksheet; their controls are read only (audit D29)
    // A sign-off covers the checklist as it was: changing the checklist afterwards clears it (audit A7).
    const clearsSignOff = key === "checklist" && Boolean(ws.signed_off_at);
    if (clearsSignOff) toast.info("Checklist changed after sign-off: sign off again before saving.");
    setWs((current) => ({ ...current, [key]: value, ...(clearsSignOff ? { signed_off_at: "" } : {}) }));
  };
  const text = (key: keyof JobWorksheet, props: React.ComponentProps<typeof Input> = {}) => (
    <Input value={String(ws[key] ?? "")} onChange={(event) => set(key, event.target.value as never)} readOnly={!canEdit} className={CELL_INPUT} {...props} />
  );

  async function save() {
    if (!canSave) return;
    await run(async () => {
      try {
        const result = await saveWorksheet(job.id, ws, version);
        setBaseline(JSON.stringify(ws));
        setShown(JSON.stringify(ws));
        setVersion(result.version);
        if ("queued" in result && result.queued) {
          // Offline: kept in this device's outbox and sent when the connection is back (lib/offline).
          toast.success("Saved on this device. It will sync when you're back online.");
          onSaved?.(ws, null);
          return;
        }
        void auditEvent({ action: "UPDATE_WORKSHEET", entityTable: "jobs", entityId: job.id, metadata: { job_no: ws.job_no, signed_off: Boolean(ws.signed_off_at) } });
        toast.success(result.demo ? "Worksheet saved locally (demo mode)" : "Worksheet saved");
        onSaved?.(ws, result.row);
      } catch (error) {
        // Nothing was saved: keep every local edit and say why.
        if (error instanceof WorksheetConflictError) setConflict(true);
        toast.error(error instanceof WorksheetConflictError || error instanceof WorksheetMissingError ? error.message : friendlyError(error, "Could not save worksheet"));
      }
    });
  }

  async function onUpload(files: FileList | null) {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      const problem = validateDrawing(file);
      if (problem) {
        toast.error(problem);
        continue;
      }
      try {
        const stored = await uploadDrawing(job.id, file);
        setDrawings((current) => [...current, stored]);
        void auditEvent({ action: "UPLOAD_DRAWING", entityTable: "jobs", entityId: job.id, metadata: { file: stored.name } });
        toast.success(`${stored.name} uploaded`);
      } catch (error) {
        toast.error(friendlyError(error, `Couldn't upload ${file.name}. Try again.`));
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  /** A drawing revision raises the job's version; the open worksheet follows it so its own next save isn't taken for a clash. */
  async function takeNewVersion() {
    const next = await currentWorksheetVersion(job.id);
    if (next !== null) setVersion(next);
  }

  async function changeRequirement(key: "certs" | "checklist", value: boolean) {
    const before = required;
    setRequired({ ...required, [key]: value });
    try {
      await setInspectionRequirements(job.id, key === "certs" ? { certs_required: value } : { checklist_required: value });
    } catch (error) {
      setRequired(before);
      toast.error(friendlyError(error, "Couldn't save that."));
    }
  }

  async function changeTraceable(value: boolean) {
    const before = traceable;
    setTraceable(value);
    try {
      await setInspectionRequirements(job.id, { traceable: value });
    } catch (error) {
      setTraceable(before);
      toast.error(friendlyError(error, "Couldn't save that."));
    }
  }

  async function saveRevisionLabel(file: DrawingFile, label: string) {
    if (!file.id || label.trim() === (file.revision ?? "")) return;
    try {
      await setDrawingRevision(file.id, label);
      setDrawings((current) => current.map((item) => (item.id === file.id ? { ...item, revision: label.trim() || null } : item)));
      await takeNewVersion();
      void auditEvent({ action: "UPDATE", entityTable: "jobs", entityId: job.id, metadata: { drawing: file.name, revision: label.trim() } });
      toast.success(`${file.name}: revision ${label.trim()}`);
    } catch (error) {
      toast.error(friendlyError(error, "Couldn't save the revision."));
    }
  }

  async function submitNewRevision() {
    if (!revising || !newRevisionFile) {
      toast.error("Choose the file for the new revision.");
      return;
    }
    try {
      const done = await uploadNewRevision(revising, job.id, newRevisionFile, newRevision);
      setDrawings((current) => current.map((item) => (item.id === revising.id ? done : item)));
      await takeNewVersion();
      void auditEvent({ action: "UPLOAD_DRAWING", entityTable: "jobs", entityId: job.id, metadata: { file: done.name, revision: done.revision } });
      toast.success(`${done.name} is now revision ${done.revision}. A job that had been released goes back to awaiting inspection.`);
      setRevising(null);
      setNewRevision("");
      setNewRevisionFile(null);
    } catch (error) {
      toast.error(friendlyError(error, "Couldn't upload the new revision."));
    }
  }

  async function download(file: DrawingFile) {
    try {
      if (!file.path) throw new Error("This drawing is a demo entry with no stored file.");
      window.open(await drawingUrl(file.path, file.name, file.bucket), "_blank", "noopener");
    } catch (error) {
      toast.error(friendlyError(error, "Could not download drawing"));
    }
  }

  /** The old typed box (before migration 045), shown as an earlier typed record until a hashed sign-off exists. */
  const legacySignOff = signOffState(ws);

  const datalist = <datalist id="worksheet-machines">{machines.map((name) => <option key={name} value={name} />)}</datalist>;

  return (
    <div className="space-y-4 text-sm">
      {datalist}
      {conflict ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <span>Someone else saved this worksheet after you opened it. Your changes are still on screen and have not been saved.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>Load their version (discards yours)</Button>
        </div>
      ) : null}
      {loadError ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-800">
          <span>{loadError} Saving is disabled so the stored worksheet can&apos;t be overwritten.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : null}
      {offlineCopy && !loadError ? <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">Offline: showing this device&apos;s copy. Changes you save are kept here and sync when you&apos;re back online.</p> : null}
      {demo && !loadError ? <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">{DEMO_MODE ? "Demo mode: changes are kept in this session only." : "Supabase is not configured, so this worksheet can't be saved."}</p> : null}
      {loading ? <p className="text-xs text-slate-500">Loading worksheet...</p> : null}
      {pendingPrefill.length && !loadError ? <p data-testid="worksheet-prefill" className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">Filled in from the job&apos;s machines, schedule bookings and machine runs: {pendingPrefill.map((key) => PREFILL_LABELS[key]).join(", ")}. Check them and Save the worksheet to keep them.</p> : null}
      {loadError ? null : <>

      <div className="space-y-1.5 bg-white text-black" style={{ fontFamily: "Arial, Helvetica, sans-serif" }}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="text-[16px] font-black tracking-wide">{company ? company.name.toUpperCase() : "Company details not set"}</p>
        <p className="text-[13px] font-bold">JOB No <span className="ml-1 inline-block min-w-[10rem] border-b border-black px-1 text-center font-mono text-[14px]">{ws.job_no}</span></p>
      </div>
      <p className="text-center text-[18px] font-black tracking-wide">(SINGLE PART) WORKSHEET</p>

      <div className="grid border border-black md:grid-cols-2">
        <div className="border-b border-black md:border-r md:border-b-0">
          <Field label="Customer" bg={BG.grey}><Input value={ws.customer} readOnly className={CELL_INPUT} /></Field>
          <Field label="Date Received" bg={BG.paleYellow}>{text("date_received", { type: "date" })}</Field>
          <Field label="Quote #" bg={BG.green}>{text("quote_ref")}</Field>
          <Field label="Material Cert #" bg={BG.yellow}>{text("material_cert_no")}</Field>
          <Field label="Job Time Quoted (hr)" bg={BG.peach}>{text("job_time_quoted_hr", { type: "number", step: "0.25", min: "0" })}</Field>
        </div>
        <div>
          <Field label="Purchase Order #" bg={BG.grey}>{text("customer_po")}</Field>
          <Field label="Date Required" bg={BG.paleYellow}>{text("date_required", { type: "date" })}</Field>
          <Field label="Dimension Report #" bg={BG.green}>{text("dimension_report_no")}</Field>
          <Field label="Heat / Cast #" bg={BG.yellow}>{text("heat_cast_no")}</Field>
          <Field label="Job Time Taken (hr)" bg={BG.peach}>{text("job_time_taken_hr", { type: "number", step: "0.25", min: "0" })}</Field>
        </div>
      </div>

      <div><Bar>Job Description</Bar><Textarea readOnly={!canEdit} value={ws.description} onChange={(event) => set("description", event.target.value)} className={`min-h-20 border-black ${SHEET_TEXT}`} /></div>

      <div className="border border-black">
        <Field wide label="Drawing #" bg={BG.blueGrey}>{text("drawing_no")}</Field>
        <Field wide label="Quantity Req" bg={BG.blueGrey}>{text("quantity_required", { type: "number", min: "0", step: "1" })}</Field>
        <Field wide label="Material Required" bg={BG.blueGrey}>{text("material_required")}</Field>
        <div className="flex min-h-9 border-b border-black">
          <span className={`flex w-[34%] shrink-0 items-center border-r border-black px-1.5 py-1 text-[10px] font-bold uppercase ${BG.blueGrey}`}>Material Ordered</span>
          <div className="grid min-w-0 flex-1 items-center sm:grid-cols-[auto_10rem_1fr]">
            <label className="flex items-center gap-2 px-1.5"><input type="checkbox" disabled={!canEdit} checked={ws.material_ordered} onChange={(event) => set("material_ordered", event.target.checked)} /> Yes</label>
            {text("material_ordered_at", { type: "date", "aria-label": "Date ordered" })}
            {text("material_ordered_notes", { placeholder: "Notes (PO, delivery, etc.)" })}
          </div>
        </div>
        <Field wide label="Material Supplier" bg={BG.blueGrey}>{text("material_supplier")}</Field>
        {([1, 2, 3] as const).map((n) => (
          <div key={n} className="flex min-h-9 border-b border-black">
            <span className={`flex w-[34%] shrink-0 items-center border-r border-black px-1.5 py-1 text-[10px] font-bold uppercase ${BG.blueGrey}`}>Machine # {n} / Program #</span>
            <div className="grid min-w-0 flex-1 grid-cols-2 items-center">
              <div className="border-r border-black">{text(`machine_${n}`, { list: "worksheet-machines", placeholder: "Machine", "aria-label": `Machine ${n}` })}</div>
              <div>{text(`program_${n}`, { placeholder: "Program #", "aria-label": `Program ${n}` })}</div>
            </div>
          </div>
        ))}
        <Field wide label="Set Up Time (hr)" bg={BG.blueGrey}>{text("setup_time_hr", { type: "number", step: "0.25", min: "0" })}</Field>
        <Field wide label="Run Time (hr)" bg={BG.blueGrey}>{text("run_time_hr", { type: "number", step: "0.25", min: "0" })}</Field>
      </div>

      <div><Bar>Comments for Improvement</Bar><Textarea readOnly={!canEdit} value={ws.improvement_comments} onChange={(event) => set("improvement_comments", event.target.value)} className={`min-h-16 border-black ${SHEET_TEXT}`} /></div>

      <div>
        <Bar className={overrun ? "bg-[#fde2e2] text-[#c00000]" : BG.blueGrey}>{overrun ? <AlertTriangle className="size-4" /> : null}Reasons for Overrun / Delays{overrun ? ` - taken ${ws.job_time_taken_hr} hr vs quoted ${ws.job_time_quoted_hr} hr` : ""}</Bar>
        <Textarea readOnly={!canEdit} value={ws.overrun_reasons} onChange={(event) => set("overrun_reasons", event.target.value)} className={`min-h-16 ${SHEET_TEXT} ${overrun ? "border-2 border-t-0 border-[#c00000]" : "border-black"}`} placeholder={overrun ? "Job has overrun - please explain why." : ""} />
      </div>

      {customerPos.length ? (
        <div className="border border-black px-2 py-1.5" aria-label="Customer PO">
          <p className="mb-1 text-[10px] font-bold uppercase">Customer PO</p>
          <ul className="space-y-1">
            {customerPos.map((file) => (
              <li key={file.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="truncate text-brand">{file.file_name}</span>
                <Button type="button" size="sm" variant="ghost" onClick={() => void download({ name: file.file_name, path: file.storage_path, bucket: file.storage_bucket })}><Download className="size-4" /> Open</Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="border border-black px-2 py-1.5">
        <div className="mb-1 flex items-center justify-between"><p className="text-[10px] font-bold uppercase">Drawings</p>{canEdit ? <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}><Upload className="size-4" /> Upload</Button> : null}</div>
        <input ref={fileRef} type="file" multiple accept="application/pdf,image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => void onUpload(event.target.files)} />
        {drawings.length ? (
          <ul className="space-y-1">
            {drawings.map((file) => (
              <li key={file.id ?? file.path ?? file.name} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
                <span className="truncate text-brand">{file.name}</span>
                <span className="flex items-center gap-1 text-slate-600">
                  <span>Rev</span>
                  {canApprove && file.id && !file.revision ? (
                    <input aria-label={`Revision of ${file.name}`} defaultValue={file.revision ?? ""} maxLength={20} placeholder="-" onBlur={(event) => void saveRevisionLabel(file, event.target.value)} className="h-6 w-14 border border-black px-1 text-xs" />
                  ) : <span className="font-semibold">{file.revision || "-"}</span>}
                  {file.earlier?.length ? <span title="Earlier revisions">(replaces {file.earlier.join(", ")})</span> : null}
                </span>
                <span className="flex items-center gap-1">
                  {canApprove && file.id ? <Button type="button" size="sm" variant="ghost" onClick={() => { setRevising(file); setNewRevision(""); setNewRevisionFile(null); }}>New revision</Button> : null}
                  <Button type="button" size="sm" variant="ghost" onClick={() => void download(file)}><Download className="size-4" /> Download</Button>
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-slate-500">No drawings uploaded yet.</p>}
        {revising ? (
          <div role="group" aria-label={`New revision of ${revising.name}`} className="mt-2 flex flex-wrap items-center gap-2 border border-black p-2 text-xs">
            <span className="font-semibold">New revision of {revising.name}</span>
            <input aria-label="New revision label" value={newRevision} maxLength={20} placeholder="e.g. C" onChange={(event) => setNewRevision(event.target.value)} className="h-7 w-20 border border-black px-1" />
            <input aria-label="New revision file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(event) => setNewRevisionFile(event.target.files?.[0] ?? null)} />
            <Button type="button" size="sm" variant="outline" onClick={() => void submitNewRevision()}>Upload revision</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRevising(null)}>Cancel</Button>
          </div>
        ) : null}
      </div>

      <div>
        <Bar className="bg-[#c00000] text-white">Part Checklist Must Be Completed</Bar>
        <div className="grid gap-x-2 gap-y-1 border border-t-0 border-black px-2 py-1.5 text-[12px] sm:grid-cols-3">
          {CHECKLIST_ITEMS.map((item) => (
            <label key={item.key} className="flex items-center gap-1.5"><input type="checkbox" disabled={!canEdit} className="size-4" checked={Boolean(ws.checklist[item.key])} onChange={(event) => set("checklist", { ...ws.checklist, [item.key]: event.target.checked })} />{item.label}</label>
          ))}
          {canRequire ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600 sm:col-span-3">
              <label className="flex items-center gap-1.5"><input type="checkbox" className="size-4" checked={required.certs} onChange={(event) => void changeRequirement("certs", event.target.checked)} />Inspection needs material certificates attached</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" className="size-4" checked={required.checklist} onChange={(event) => void changeRequirement("checklist", event.target.checked)} />Inspection needs every checklist item ticked</label>
              {traceable !== null ? <label className="flex items-center gap-1.5"><input type="checkbox" className="size-4" data-testid="job-traceable" checked={traceable} onChange={(event) => void changeTraceable(event.target.checked)} />Traceable: inspection needs Material Cert # and Heat / Cast #</label> : null}
            </div>
          ) : null}
          {traceable && missingTraceability(ws).length ? (
            <p role="status" data-testid="traceability-required" className="text-[11px] font-semibold text-[#c00000] sm:col-span-3">Traceable job: enter {missingTraceability(ws).join(" and ")} before the inspection can pass.</p>
          ) : null}
          <label className="flex items-center gap-2 sm:col-span-3"><span className="shrink-0">Signed off by:</span><span className="min-w-0 flex-1 border-b border-black">{text("checked_by", { placeholder: "Name" })}</span></label>
        </div>
      </div>
      <p className="text-center text-[10.5px] font-bold text-[#c00000]">ALL PARTS MUST BE CHECKED AND MARKED FOR IDENTIFICATION BEFORE SIGN OFF (e.g. Black Ink Marker)<br />ANY EXCESS MATERIAL MUST BE MARKED WITH MATERIAL GRADE AND HEAT/CAST NUMBER.</p>

      <div className="border border-black">
        <p className="bg-[#ffe44d] px-2 py-1 text-center text-[11px] font-bold uppercase">INTERNAL SIGN OFF (All Worksheets Must Be Signed Off)</p>
        <div className="border-t border-black"><JobSignOff jobId={job.id} jobNo={job.job_no} version={version} dirty={unsaved} demo={demo} legacy={legacySignOff.status === "signed" ? legacySignOff : null} /></div>
      </div>
      <CustomerSignOff jobId={job.id} jobNo={job.job_no} version={version} dirty={unsaved} demo={demo} />
      </div>

      {canEdit ? (
        <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-white pt-3">
          <Button type="button" className="bg-brand text-brand-ink" disabled={saving || !canSave} onClick={() => void save()}>{saving ? "Saving..." : "Save Worksheet"}</Button>
        </div>
      ) : null}
      </>}
    </div>
  );
}
