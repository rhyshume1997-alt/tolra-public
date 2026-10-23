"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { nudgeIntegrationSend } from "@/lib/integrations/nudge";
import { VOID_REASON_MAX, voidInvoice, voidReasonProblem } from "@/lib/invoice-void";
import { supabase } from "@/lib/supabase";

/**
 * Void an issued invoice (migration 073, void_invoice): asks for the reason, then the database checks the invoice has no payments or
 * credits against it and voids it with an audit row, in one step. A refusal is shown in plain English and nothing changes.
 */
export function VoidInvoiceDialog({ invoice, open, onClose, onVoided }: {
  invoice: { id: string; reference: string; customer: string };
  open: boolean;
  onClose: () => void;
  onVoided: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => { if (open) { setReason(""); setRefusal(null); } }, [open, invoice.id]);

  async function submit() {
    const problem = voidReasonProblem(reason);
    if (problem) { setRefusal(problem); return; }
    if (!supabase) { setRefusal("Supabase is not configured."); return; }
    setBusy(true);
    setRefusal(null);
    try {
      const client = supabase;
      const result = await voidInvoice({ rpc: (fn, args) => client.rpc(fn, args) }, invoice.id, reason);
      if (!result.ok) { setRefusal(result.error); return; }
      nudgeIntegrationSend("invoice", invoice.id);
      toast.success(`Invoice ${invoice.reference} voided`);
      onVoided();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void invoice {invoice.reference}?</DialogTitle>
          <DialogDescription>
            For {invoice.customer}. A void invoice is no longer owed and can&apos;t be brought back; its number stays used. An invoice with
            payments or credits against it can&apos;t be voided: correct it with a credit note instead.
          </DialogDescription>
        </DialogHeader>
        <label className="grid gap-1 text-xs text-slate-500">Reason (required, kept in the history)
          <Textarea name="void_reason" rows={3} maxLength={VOID_REASON_MAX} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="For example: raised to the wrong customer" />
        </label>
        {refusal ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{refusal}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>Keep invoice</Button>
          <Button className="bg-red-600 text-white hover:bg-red-700" disabled={busy || !reason.trim()} onClick={() => void submit()}>{busy ? "Voiding…" : "Void invoice"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
