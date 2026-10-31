"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { WRITE_OFF_REASON_MAX, type WriteOffMode, reverseWriteOff, writeOffInvoice, writeOffReasonProblem } from "@/lib/invoice-write-off";
import { supabase } from "@/lib/supabase";

/**
 * Write off what is still owed on an issued invoice, or reverse a write-off (migration 105, write_off_invoice / reverse_write_off):
 * asks for the reason, then the database checks the invoice and changes its status with an audit row, in one step. Amounts and lines
 * are not changed. A refusal (or "Available after database update 105") is shown in plain English and nothing changes.
 */
export function WriteOffInvoiceDialog({ invoice, mode, open, onClose, onDone }: {
  invoice: { id: string; reference: string; customer: string };
  mode: WriteOffMode;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => { if (open) { setReason(""); setRefusal(null); } }, [open, invoice.id, mode]);
  const reverse = mode === "reverse";

  async function submit() {
    const problem = writeOffReasonProblem(reason, mode);
    if (problem) { setRefusal(problem); return; }
    if (!supabase) { setRefusal("Supabase is not configured."); return; }
    setBusy(true);
    setRefusal(null);
    try {
      const client = supabase;
      const rpcClient = { rpc: (fn: "write_off_invoice" | "reverse_write_off", args: { p_invoice_id: string; p_reason: string }) => client.rpc(fn, args) };
      const result = reverse ? await reverseWriteOff(rpcClient, invoice.id, reason) : await writeOffInvoice(rpcClient, invoice.id, reason);
      if (!result.ok) { setRefusal(result.error); return; }
      toast.success(reverse ? `Write-off of invoice ${invoice.reference} reversed` : `Invoice ${invoice.reference} written off`);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{reverse ? `Reverse the write-off of invoice ${invoice.reference}?` : `Write off invoice ${invoice.reference}?`}</DialogTitle>
          <DialogDescription>
            {reverse
              ? <>For {invoice.customer}. The invoice is owed again for what was left to pay; its amounts and lines are unchanged.</>
              : <>For {invoice.customer}. What is still owed is no longer counted as owed and no more payments can be recorded against it. Its amounts and lines are unchanged, and it can be brought back with Reverse write-off.</>}
          </DialogDescription>
        </DialogHeader>
        <label className="grid gap-1 text-xs text-slate-500">Reason (required, at least 10 characters, kept in the history)
          <Textarea name="write_off_reason" rows={3} maxLength={WRITE_OFF_REASON_MAX} value={reason} onChange={(event) => setReason(event.target.value)}
            placeholder={reverse ? "For example: the customer paid after all" : "For example: the customer has gone into liquidation"} />
        </label>
        {refusal ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{refusal}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button className={reverse ? "bg-brand text-brand-ink hover:bg-brand-hover" : "bg-red-600 text-white hover:bg-red-700"} disabled={busy || !reason.trim()} onClick={() => void submit()}>
            {busy ? "Saving…" : reverse ? "Reverse write-off" : "Write off"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
