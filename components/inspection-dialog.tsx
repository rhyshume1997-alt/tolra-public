"use client";

import { Paperclip } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fmtDateTime } from "@/lib/dates";
import { cleanName, UNKNOWN } from "@/lib/people";
import { friendlyError } from "@/lib/friendly-error";
import { DISPOSITION_LABELS, type Disposition, type FailureDetails, INSPECTION_LABELS, type InspectionContext, type InspectionRecord, type InspectionResult, loadInspectionContext, loadInspections, recordInspection } from "@/lib/inspection";
import { drawingUrl } from "@/lib/job-worksheet";
import { supabase } from "@/lib/supabase";

/** An order line of the job's sales order (despatch_lines, no prices): a failure names the line that failed (migration 037). */
type OrderLine = { line_id: string; description: string; ordered: number };

type Props = {
  job: { id: string; job_no: string; quantity_required?: number | string | null } | null;
  /** Only an admin can release a job on a concession. */
  isAdmin: boolean;
  onClose: () => void;
  onRecorded: (result: Awaited<ReturnType<typeof recordInspection>>) => void;
};

const RESULTS: { value: InspectionResult; label: string; hint: string }[] = [
  { value: "pass", label: "Pass", hint: "Meets the acceptance criteria: the job is Complete." },
  { value: "fail", label: "Fail", hint: "Doesn't meet them: the job is put back to Running, tagged Rework, and must be inspected again." },
  { value: "concession", label: "Concession", hint: "Out of tolerance but accepted by an admin: released with the reason recorded." },
];

/**
 * Records an inspection for a job (081): result, the acceptance criteria and the measured result, an optional photo or file, what
 * happens to what failed (rework, scrap, or an admin's concession), and, when an admin inspects their own work, the reason.
 */
export function InspectionDialog({ job, isAdmin, onClose, onRecorded }: Props) {
  const [result, setResult] = useState<InspectionResult>("pass");
  const [notes, setNotes] = useState("");
  const [criteria, setCriteria] = useState("");
  const [override, setOverride] = useState("");
  const [disposition, setDisposition] = useState<Disposition>("rework");
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // A failure records why, how many, and what the workshop should do about it (migration 037).
  const [failReason, setFailReason] = useState("");
  const [failScope, setFailScope] = useState<"all" | "part">("all");
  const [failQuantity, setFailQuantity] = useState("");
  const [instructions, setInstructions] = useState("");
  const [batch, setBatch] = useState("");
  /** The job's order lines (empty for a job not made from an order) and how many of each failed, for a part failure. */
  const [orderLines, setOrderLines] = useState<OrderLine[]>([]);
  const [lineFails, setLineFails] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<InspectionRecord[]>([]);
  /** The job as it was when the dialog opened: a result is recorded against this version, and refused if the job has changed since. */
  const [context, setContext] = useState<InspectionContext | null>(null);

  useEffect(() => {
    setResult("pass");
    setNotes("");
    setCriteria("");
    setOverride("");
    setDisposition("rework");
    setReason("");
    setFile(null);
    setFailReason("");
    setFailScope("all");
    setFailQuantity("");
    setInstructions("");
    setBatch("");
    setOrderLines([]);
    setLineFails({});
    setError(null);
    setHistory([]);
    setContext(null);
    if (!job) return;
    let cancelled = false;
    if (supabase) {
      void supabase.rpc("despatch_lines", { p_order: null, p_job: job.id }).then(({ data }) => {
        if (!cancelled) setOrderLines(((data ?? []) as Array<Record<string, unknown>>).map((row) => ({ line_id: String(row.line_id), description: String(row.description), ordered: Number(row.ordered) })));
      }, () => { /* without the lines, a part failure is entered as a quantity of the job */ });
    }
    loadInspectionContext(job.id, isAdmin).then((loaded) => { if (!cancelled) setContext(loaded); }).catch((err) => { if (!cancelled) setError(friendlyError(err, "Couldn't load the job. Close this and try again.")); });
    loadInspections(job.id).then((rows) => { if (!cancelled) setHistory(rows); }).catch(() => { /* the record is optional context */ });
    return () => { cancelled = true; };
  }, [job, isAdmin]);

  /** 081: the signed-in person finished this job (or its rework): only an admin may still pass it, with a reason. */
  const ownWork = Boolean(context?.finishedByMe);
  /** A part failure names the order line(s) when the job's order has more than one line, or its one line isn't the job's quantity. */
  const byLine = orderLines.length > 1 || (orderLines.length === 1 && String(orderLines[0].ordered) !== String(job?.quantity_required ?? ""));

  async function save() {
    if (!job || busy || !context) return;
    if (!notes.trim()) return setError("Add the measured notes: what was checked and the readings.");
    if ((result === "concession" || (result === "fail" && disposition === "concession")) && !reason.trim()) return setError("Give the reason for the concession.");
    const total = Number(job.quantity_required);
    let failure: FailureDetails | undefined;
    if (result === "fail") {
      if (!failReason.trim()) return setError("Give the reason it failed.");
      if (disposition === "rework" && !instructions.trim()) return setError("Give the rework instructions for the workshop.");
      let quantity: number | null = null;
      let lines: FailureDetails["lines"] = null;
      if (failScope === "part" && byLine) {
        const picked: NonNullable<FailureDetails["lines"]> = [];
        for (const line of orderLines) {
          const raw = (lineFails[line.line_id] ?? "").trim();
          if (!raw) continue;
          const count = Number(raw);
          if (!Number.isInteger(count) || count < 1) return setError(`Enter how many of "${line.description}" failed, as a whole number of 1 or more.`);
          if (count > line.ordered) return setError(`Only ${line.ordered} of "${line.description}" on the order: enter ${line.ordered} or fewer.`);
          picked.push({ line_id: line.line_id, quantity: count });
        }
        if (!picked.length) return setError("Enter how many failed on at least one order line.");
        lines = picked;
      } else if (failScope === "part") {
        quantity = Number(failQuantity);
        if (!Number.isInteger(quantity) || quantity < 1) return setError("Enter how many failed, as a whole number of 1 or more.");
        if (Number.isFinite(total) && total > 0 && quantity > total) return setError(`Only ${total} on the job: enter ${total} or fewer.`);
      }
      failure = { reason: failReason.trim(), quantity, instructions: instructions.trim(), lines, batch: batch.trim() || null };
    }
    // 081: the objective evidence is the criteria with the measured result (checked last, so the earlier messages read as before).
    if (!criteria.trim()) return setError("Add the acceptance criteria: what it was checked against (drawing, revision, tolerance).");
    if (result !== "fail" && ownWork && override.trim().length < 10) return setError("You finished this job: give the reason you are inspecting it yourself (at least 10 characters).");
    setBusy(true);
    setError(null);
    try {
      const done = await recordInspection({ jobId: job.id, jobNo: job.job_no, result, notes: notes.trim(), criteria: criteria.trim(), concessionReason: reason.trim(), file, expectedVersion: context.version, failure,
        disposition: result === "fail" ? disposition : undefined, overrideReason: result !== "fail" && ownWork ? override.trim() : undefined, me: context.me });
      onRecorded(done);
    } catch (err) {
      setError(friendlyError(err, "Couldn't record the inspection. Nothing was saved."));
    } finally {
      setBusy(false);
    }
  }

  async function open(record: InspectionRecord) {
    if (!record.attachment_path) return;
    try {
      window.open(await drawingUrl(record.attachment_path, record.attachment_name || "inspection"), "_blank", "noopener");
    } catch (err) {
      setError(friendlyError(err, "Couldn't open the file."));
    }
  }

  return (
    <Dialog open={Boolean(job)} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record inspection: {job?.job_no}</DialogTitle>
          <DialogDescription>A job is Complete when it passes, or when an admin records a concession. Changing the worksheet or the quantity afterwards withdraws it.</DialogDescription>
        </DialogHeader>
        <fieldset className="grid gap-2">
          <legend className="text-xs text-slate-500">Result</legend>
          {RESULTS.filter((item) => item.value !== "concession" || isAdmin).map((item) => (
            <label key={item.value} className="flex items-start gap-2 rounded-lg border p-3 text-sm has-[:checked]:border-brand">
              <input type="radio" name="inspection-result" className="mt-1" checked={result === item.value} onChange={() => setResult(item.value)} />
              <span><span className="font-semibold">{item.label}</span><span className="block text-xs text-slate-500">{item.hint}</span></span>
            </label>
          ))}
          {isAdmin ? null : <p className="text-xs text-slate-500">A concession can only be recorded by an admin.</p>}
        </fieldset>
        <label className="grid gap-1 text-xs text-slate-500">Acceptance criteria (required)
          <Textarea name="acceptance_criteria" rows={2} maxLength={2000} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="For example: drawing ACL-7 rev C, bore 25.00 +0.03 / 0" />
        </label>
        <label className="grid gap-1 text-xs text-slate-500">Measured notes (required)
          <Textarea name="measured_notes" rows={4} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="For example: bore 25.01 / 25.02 / 25.01 mm against 25.00 +0.03 / 0" />
        </label>
        {result === "fail" ? (
          <fieldset className="grid gap-3 rounded-lg border border-red-200 p-3">
            <legend className="px-1 text-xs font-semibold text-red-700">Rework</legend>
            <label className="grid gap-1 text-xs text-slate-500">Reason it failed (required)
              <Textarea name="fail_reason" rows={2} maxLength={1000} value={failReason} onChange={(event) => setFailReason(event.target.value)} placeholder="For example: bore oversize" />
            </label>
            <fieldset className="grid gap-1 text-sm">
              <legend className="text-xs text-slate-500">Quantity affected</legend>
              <label className="flex items-center gap-2"><input type="radio" name="fail-scope" checked={failScope === "all"} onChange={() => setFailScope("all")} /> All of the job{job?.quantity_required ? ` (${job.quantity_required})` : ""}</label>
              <label className="flex items-center gap-2"><input type="radio" name="fail-scope" checked={failScope === "part"} onChange={() => setFailScope("part")} /> Part of it
                {failScope === "part" && !byLine ? <Input name="fail_quantity" type="number" inputMode="numeric" min={1} step={1} aria-label="Quantity that failed" className="h-8 w-24" value={failQuantity} onChange={(event) => setFailQuantity(event.target.value)} /> : null}
              </label>
              {failScope === "part" && byLine ? (
                <div className="grid gap-1 pl-6" role="group" aria-label="Quantity that failed per order line">
                  <p className="text-xs text-slate-500">How many of each order line failed (leave the others empty). Only those are held; the rest can be despatched.</p>
                  {orderLines.map((line) => (
                    <label key={line.line_id} className="flex items-center justify-between gap-2 text-xs">
                      <span>{line.description} <span className="text-slate-500">(of {line.ordered})</span></span>
                      <Input type="number" inputMode="numeric" min={1} max={line.ordered} step={1} aria-label={`Quantity that failed: ${line.description}`} className="h-8 w-24"
                        value={lineFails[line.line_id] ?? ""} onChange={(event) => setLineFails((current) => ({ ...current, [line.line_id]: event.target.value }))} />
                    </label>
                  ))}
                </div>
              ) : null}
            </fieldset>
            <label className="grid gap-1 text-xs text-slate-500">Batch or heat number (optional)
              <Input name="fail_batch" maxLength={100} value={batch} onChange={(event) => setBatch(event.target.value)} placeholder="For example: heat 4471" />
            </label>
            <fieldset className="grid gap-1 text-sm">
              <legend className="text-xs text-slate-500">What happens to what failed</legend>
              {(Object.keys(DISPOSITION_LABELS) as Disposition[]).filter((value) => value !== "concession" || isAdmin).map((value) => (
                <label key={value} className="flex items-center gap-2"><input type="radio" name="fail-disposition" checked={disposition === value} onChange={() => setDisposition(value)} /> {DISPOSITION_LABELS[value]}</label>
              ))}
            </fieldset>
            {disposition === "concession" ? (
              <label className="grid gap-1 text-xs text-slate-500">Reason for the concession (required)
                <Textarea name="fail_concession_reason" rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
              </label>
            ) : null}
            <label className="grid gap-1 text-xs text-slate-500">Rework instructions for the workshop{disposition === "rework" ? " (required)" : " (optional)"}
              <Textarea name="rework_instructions" rows={3} maxLength={2000} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="What to do, for example: re-bore to 25.00 +0.03 and re-measure" />
            </label>
            <p className="text-xs text-slate-500">The job is put back to Running, tagged Rework, for the workshop. It is Complete only after a new inspection passes, or an admin records a concession.</p>
          </fieldset>
        ) : null}
        {result === "concession" ? (
          <label className="grid gap-1 text-xs text-slate-500">Reason for the concession (required)
            <Textarea name="concession_reason" rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
        ) : null}
        <div className="grid gap-1 text-xs text-slate-500">
          <span id="inspection-file-label">Photo or file (optional)</span>
          <input ref={fileInput} type="file" name="inspection_file" tabIndex={-1} aria-hidden className="sr-only" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" className="h-11 w-full sm:w-auto" aria-describedby="inspection-file-label" onClick={() => fileInput.current?.click()}><Paperclip className="size-4" /> Attach files</Button>
            {file ? <span className="min-w-0 break-all text-sm text-slate-950">{file.name}</span> : null}
          </div>
        </div>
        {context && ownWork && result !== "fail" ? (isAdmin ? (
          <label className="grid gap-1 text-xs text-slate-500">You finished this job. Reason you are inspecting it yourself (required, at least 10 characters)
            <Textarea name="override_reason" rows={2} maxLength={500} value={override} onChange={(event) => setOverride(event.target.value)} placeholder="For example: sole inspector on site today" />
          </label>
        ) : <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">You finished this job, so someone else must inspect it.</p>) : null}
        {context && !context.canInspect ? <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">An admin has to make you an inspector (Admin &gt; Users) before you can record inspections.</p> : null}
        {context && result === "pass" && context.certsRequired && context.certCount === 0 ? <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">This job needs its material certificates attached (on the delivery note screen) before it can pass.</p> : null}
        {context && result === "pass" && context.traceabilityMissing?.length ? <p role="status" data-testid="traceability-required" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">This job is traceable: enter its {context.traceabilityMissing.join(" and ")} on the worksheet before it can pass.</p> : null}
        {context && result === "pass" && context.checklistRequired ? <p role="status" className="text-xs text-slate-500">This job needs every item on its worksheet checklist ticked before it can pass.</p> : null}
        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
        {history.length ? (
          <section aria-label="Earlier inspections" className="space-y-1">
            <h3 className="text-xs font-semibold text-slate-600">Earlier inspections</h3>
            <ul className="divide-y rounded-lg border text-xs">
              {history.map((record) => (
                <li key={record.id} className="space-y-0.5 p-2">
                  <p className="font-medium">{INSPECTION_LABELS[record.result]} <span className="font-normal text-slate-500">by {cleanName(record.inspector_name) ?? UNKNOWN}, {fmtDateTime(record.inspected_at)}</span></p>
                  <p className="text-slate-600">{record.measured_notes}</p>
                  {record.acceptance_criteria ? <p className="text-slate-600">Criteria: {record.acceptance_criteria}</p> : null}
                  {record.disposition ? <p className="text-slate-600">Disposition: {DISPOSITION_LABELS[record.disposition]}</p> : null}
                  {record.concession_reason ? <p className="text-slate-600">Concession: {record.concession_reason}</p> : null}
                  {record.attachment_path ? <button type="button" className="text-brand underline" onClick={() => void open(record)}>{record.attachment_name || "Open file"}</button> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={busy || !context || !context.canInspect || (ownWork && !isAdmin && result !== "fail")} onClick={() => void save()}>{busy ? "Saving…" : "Record inspection"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
