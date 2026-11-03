"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type ChaseEmailDraft = {
  id: string;
  customerId: string;
  customerName: string;
  invoiceNumber: string;
  to: string;
  subject: string;
  body: string;
};
type EditedEmail = { subject: string; body: string };
export type ChaseApprovalCardProps = {
  /** Remount with the draft ID as key when displaying another draft. */
  draft: ChaseEmailDraft;
  onEdit: (draftId: string, email: EditedEmail) => void | Promise<void>;
  onApproveAndSend: (draftId: string, reviewed: EditedEmail) => void | Promise<void>;
  onSkip: (draftId: string) => void | Promise<void>;
  onPauseCustomer: (customerId: string) => void | Promise<void>;
  disabled?: boolean;
};

/** Approvals-page presentation only; callbacks own persistence and delivery. */
export function ChaseApprovalCard({ draft, onEdit, onApproveAndSend, onSkip, onPauseCustomer, disabled = false }: ChaseApprovalCardProps) {
  const prefix = useId();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<EditedEmail>({ subject: draft.subject, body: draft.body });
  const [email, setEmail] = useState(saved);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [finished, setFinished] = useState(false);
  const locked = disabled || pending || finished;

  async function run(action: () => void | Promise<void>, success: string, finish = false) {
    if (disabled || busy.current || finished) return;
    busy.current = true; setPending(true); setError(""); setResult("");
    try { await action(); setResult(success); if (finish) setFinished(true); }
    catch { setError("Could not complete that action. Please try again."); }
    finally { busy.current = false; setPending(false); }
  }
  function save() {
    if (!email.subject.trim() || !email.body.trim()) { setError("Enter a subject and a message before saving."); return; }
    void run(async () => { await onEdit(draft.id, { ...email }); setSaved({ ...email }); setEditing(false); }, "Draft saved for approval.");
  }

  return (
    <Card>
      <CardHeader><CardTitle>Payment reminder — {draft.customerName}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">Invoice {draft.invoiceNumber} · To: {draft.to}</p>
        <p className="text-sm text-slate-600">This is a draft. Check it before you approve and send it.</p>
        {editing ? <div className="space-y-3">
          <label htmlFor={`${prefix}-subject`} className="block text-sm font-medium">Subject
            <Input id={`${prefix}-subject`} value={email.subject} disabled={locked} onChange={(e) => { setError(""); setEmail((current) => ({ ...current, subject: e.target.value })); }} />
          </label>
          <label htmlFor={`${prefix}-body`} className="block text-sm font-medium">Message
            <Textarea id={`${prefix}-body`} rows={8} value={email.body} disabled={locked} onChange={(e) => { setError(""); setEmail((current) => ({ ...current, body: e.target.value })); }} />
          </label>
          <div className="flex gap-2">
            <Button type="button" disabled={locked} onClick={save}>Save draft</Button>
            <Button type="button" variant="outline" disabled={locked} onClick={() => { setEmail(saved); setEditing(false); setError(""); }}>Cancel edit</Button>
          </div>
        </div> : <div className="space-y-2 rounded-lg border p-3">
          <p className="font-medium">{saved.subject}</p>
          <p className="whitespace-pre-wrap text-sm">{saved.body}</p>
        </div>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {result && <p role="status" className="text-sm">{result}</p>}
        {pending && <p role="status" className="text-sm">Please wait…</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={locked || editing} onClick={() => { setEmail(saved); setEditing(true); setResult(""); }}>Edit</Button>
          <Button type="button" disabled={locked || editing} onClick={() => void run(() => onApproveAndSend(draft.id, { ...saved }), "Payment reminder sent.", true)}>Approve and send</Button>
          <Button type="button" variant="outline" disabled={locked || editing} onClick={() => void run(() => onSkip(draft.id), "Payment reminder skipped.", true)}>Skip</Button>
          <Button type="button" variant="outline" disabled={locked || editing} onClick={() => void run(() => onPauseCustomer(draft.customerId), "Chasing paused for this customer.", true)}>Pause chasing for this customer</Button>
        </div>
      </CardContent>
    </Card>
  );
}
