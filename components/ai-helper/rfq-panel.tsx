"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RFQ_MAX_CHARS } from "@/lib/ai-helper/limits";
import { costingPrices } from "@/lib/ai-helper/pricing";
import { ATTACHMENTS_REFUSED, type ReviewField, type RfqSuggestion } from "@/lib/ai-helper/rfq";
import { calculatePartCost, fetchCostingParts, isCostingEngineConfigured } from "@/lib/costing";
import { gbp } from "@/lib/money";

/** A stored suggestion line as the person is correcting it. `index` is its place in the stored suggestion (what Approve names). */
type EditLine = {
  index: number;
  description: string;
  partNumber: string;
  material: string;
  finish: string;
  dueDate: string;
  quantity: string;
  /** The costing calculation's price shown as a preview; null when it can't price the line or the part or quantity changed. */
  previewPrice: number | null;
  review: ReviewField[];
};

const browserCosting = { configured: isCostingEngineConfigured, parts: fetchCostingParts, calculate: calculatePartCost };

const FIELD_LABEL: Record<ReviewField, string> = {
  description: "description", part_number: "part number", material: "material", finish: "finish", quantity: "quantity", due_date: "due date", price: "price",
};

function ReviewFlag({ field }: { field: ReviewField }) {
  return <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">Needs human review: {FIELD_LABEL[field]}</span>;
}

/**
 * RFQ email to draft quote. The office pastes the email TEXT (no files: drawings come in a later version); the server reads it into a
 * suggestion with every missing or unclear field flagged "Needs human review". The person may correct a line's fields, remove a line or
 * correct the customer; there is no price box. The price shown is a preview from the existing costing calculation. Approve sends only the
 * request id and those corrections: the SERVER rebuilds the draft from the stored suggestion, prices it again from the company's own
 * costing records and creates a normal draft quote under the person's own session (a line it can't price is saved at £0.00, flagged, and
 * priced by the person in the draft). Reject records the decision and saves nothing.
 */
export function AiRfqPanel({ onUsed }: { onUsed?: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<RfqSuggestion | null>(null);
  const [customer, setCustomer] = useState("");
  const [lines, setLines] = useState<EditLine[]>([]);
  const [created, setCreated] = useState<{ id: string; ref: string } | null>(null);

  function reset() {
    setRequestId(null);
    setSuggestion(null);
    setLines([]);
    setCustomer("");
  }

  function refuseFiles(event: React.DragEvent | React.ClipboardEvent) {
    const files = "dataTransfer" in event ? event.dataTransfer?.files : event.clipboardData?.files;
    if (files && files.length > 0) {
      event.preventDefault();
      setError(ATTACHMENTS_REFUSED);
    }
  }

  async function read() {
    setBusy(true);
    setError(null);
    setCreated(null);
    reset();
    try {
      const response = await fetch("/api/ai-helper/rfq", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; requestId?: string; suggestion?: RfqSuggestion };
      if (!response.ok || !payload.suggestion || !payload.requestId) {
        setError(payload.error || "The AI helper is not available right now. Nothing was changed.");
        return;
      }
      const s = payload.suggestion;
      const prices = await costingPrices(s.lines, browserCosting);
      setRequestId(payload.requestId);
      setSuggestion(s);
      setCustomer(s.customer ?? "");
      setLines(s.lines.map((line, i) => ({
        index: i,
        description: line.description ?? "",
        partNumber: line.partNumber ?? "",
        material: line.material ?? "",
        finish: line.finish ?? "",
        dueDate: line.dueDate ?? "",
        quantity: line.quantity ? String(line.quantity) : "",
        previewPrice: prices[i] ?? null,
        review: prices[i] !== null ? line.review.filter((f) => f !== "price") : line.review,
      })));
    } catch {
      setError("The AI helper is not available right now. Nothing was changed.");
    } finally {
      setBusy(false);
      onUsed?.();
    }
  }

  const edit = (index: number, patch: Partial<EditLine>) => setLines((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  /** Approve: the request id and the person's corrections only (no line to copy, no price); the server builds and prices the draft. */
  async function approve() {
    if (!requestId) return;
    const missing = lines.findIndex((l) => !l.description.trim() || !/^\d+$/.test(l.quantity.trim()) || !(Number(l.quantity) > 0));
    if (!customer.trim()) { setError("Enter the customer before approving."); return; }
    if (!lines.length) { setError("There are no lines to quote."); return; }
    if (missing >= 0) { setError(`Line ${missing + 1}: fill in the description and a whole-number quantity (or remove the line) before approving.`); return; }
    setBusy(true);
    setError(null);
    try {
      const text = (value: string) => value.trim() || null;
      const edits = {
        customer: customer.trim(),
        lines: lines.map((l) => ({ index: l.index, description: text(l.description), partNumber: text(l.partNumber), material: text(l.material),
          finish: text(l.finish), dueDate: text(l.dueDate), quantity: Number(l.quantity) })),
      };
      const response = await fetch("/api/ai-helper/rfq/decision", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, decision: "approved", edits }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; quoteId?: string; ref?: string };
      if (payload.quoteId && payload.ref) {
        setCreated({ id: payload.quoteId, ref: payload.ref });
        if (response.ok) toast.success(`Draft quote ${payload.ref} created`);
        else toast.error(payload.error || `Draft quote ${payload.ref} was created, but the approval could not be recorded.`);
        reset();
        setText("");
        return;
      }
      setError(payload.error || "Could not create the draft quote. Nothing was saved.");
    } catch {
      setError("Could not create the draft quote. Nothing was saved.");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      const response = await fetch("/api/ai-helper/rfq/decision", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, decision: "rejected" }),
      });
      if (response.ok) toast.success("Suggestion rejected. Nothing was saved.");
      else toast.error("The rejection could not be recorded.");
      reset();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="ai-rfq-panel">
      <CardHeader><CardTitle>RFQ email to draft quote</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-500">Paste the customer&apos;s email text. Attachments and drawings are not read yet (a later version). Anything missing or unclear is marked &quot;Needs human review&quot;; prices come only from your costing calculation, worked out again when you approve. A line it can&apos;t price is saved at £0.00 and marked for you to price in the draft. Nothing is saved until you approve it, and it is only ever a draft.</p>
        <Textarea aria-label="RFQ email text" rows={8} maxLength={RFQ_MAX_CHARS} value={text} onChange={(e) => setText(e.target.value)} onDrop={refuseFiles} onPaste={refuseFiles} disabled={busy} />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void read()} disabled={busy || !text.trim()}>Read email</Button>
          <span className="text-xs text-slate-500">{text.length.toLocaleString("en-GB")} / {RFQ_MAX_CHARS.toLocaleString("en-GB")} characters</span>
        </div>
        {error ? <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{error}</p> : null}
        {created ? <p className="text-sm text-emerald-700" data-testid="ai-rfq-created">Draft quote {created.ref} created. <Link className="underline" href={`/quotes?quote=${encodeURIComponent(created.id)}`}>Open it in Quotes</Link>.</p> : null}
        {suggestion ? (
          <section aria-label="Suggested draft" className="space-y-3 rounded-lg border p-3">
            {suggestion.suspicious ? (
              <p className="flex items-start gap-2 rounded bg-red-50 p-2 text-sm text-red-800" data-testid="ai-rfq-suspicious">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> This email contains text that reads like instructions to the AI. It was treated as plain text and nothing was done because of it. Check every field.
              </p>
            ) : null}
            {suggestion.truncated ? <p className="text-sm text-amber-800">Only the first lines were read. Add the rest by hand.</p> : null}
            <label className="grid gap-1 text-sm">
              <span className="field-label">Customer</span>
              <Input aria-label="Customer" value={customer} onChange={(e) => setCustomer(e.target.value)} />
              {!suggestion.customerKnown ? <span><span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">Needs human review: customer {suggestion.customer ? "not found in your customers" : "not given"}</span></span> : null}
            </label>
            {lines.length === 0 ? <p className="text-sm text-amber-800">Needs human review: no items were found in this email.</p> : null}
            {lines.map((line, index) => (
              <div key={index} className="space-y-2 rounded-lg border bg-slate-50 p-3" data-testid={`ai-rfq-line-${index + 1}`}>
                <div className="flex flex-wrap gap-1">{line.review.map((field) => <ReviewFlag key={field} field={field} />)}</div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  <Input aria-label={`Line ${index + 1} description`} placeholder="Description" value={line.description} onChange={(e) => edit(index, { description: e.target.value })} />
                  <Input aria-label={`Line ${index + 1} part number`} placeholder="Part number" value={line.partNumber} onChange={(e) => edit(index, { partNumber: e.target.value, previewPrice: null })} />
                  <Input aria-label={`Line ${index + 1} material`} placeholder="Material" value={line.material} onChange={(e) => edit(index, { material: e.target.value })} />
                  <Input aria-label={`Line ${index + 1} finish`} placeholder="Finish" value={line.finish} onChange={(e) => edit(index, { finish: e.target.value })} />
                  <Input aria-label={`Line ${index + 1} due date`} type="date" value={line.dueDate} onChange={(e) => edit(index, { dueDate: e.target.value })} />
                  <Input aria-label={`Line ${index + 1} quantity`} inputMode="numeric" placeholder="Quantity" value={line.quantity} onChange={(e) => edit(index, { quantity: e.target.value, previewPrice: null })} />
                  <span className="self-center text-xs text-slate-500" data-testid={`ai-rfq-line-${index + 1}-price`}>{line.previewPrice !== null
                    ? `Price from your costing calculation: ${gbp(line.previewPrice)} (worked out again when you approve)`
                    : "No price yet: priced from your costing calculation when you approve, or saved at £0.00 for you to price in the draft"}</span>
                  <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => setLines((rows) => rows.filter((_, i) => i !== index))}><Trash2 className="size-4" /> Remove line</Button>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void approve()} disabled={busy}>Approve and create draft quote</Button>
              <Button type="button" variant="outline" onClick={() => void reject()} disabled={busy}>Reject</Button>
            </div>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
