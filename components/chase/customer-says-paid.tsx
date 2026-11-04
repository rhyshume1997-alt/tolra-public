"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export type CustomerSaysPaidProps = {
  /** Use the invoice ID as the React key when switching invoice. */
  invoiceId: string;
  invoiceNumber: string;
  paymentToConfirm: boolean;
  onCustomerSaysPaid: (invoiceId: string) => void | Promise<void>;
  onConfirmPaymentReceived: (invoiceId: string) => void | Promise<void>;
  onNotReceivedResumeChasing: (invoiceId: string) => void | Promise<void>;
  disabled?: boolean;
};

/** The parent owns payment/chasing state. A customer's claim never records a payment here. */
export function CustomerSaysPaid({ invoiceId, invoiceNumber, paymentToConfirm, onCustomerSaysPaid, onConfirmPaymentReceived, onNotReceivedResumeChasing, disabled = false }: CustomerSaysPaidProps) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [completedFor, setCompletedFor] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { setError(""); setMessage(""); }, [paymentToConfirm]);
  const completed = completedFor === paymentToConfirm;
  const locked = disabled || pending || completed;

  async function run(action: (id: string) => void | Promise<void>, success: string) {
    if (disabled || busy.current || completed) return;
    busy.current = true; setPending(true); setError(""); setMessage("");
    try { await action(invoiceId); setCompletedFor(paymentToConfirm); setMessage(success); }
    catch { setError("Could not save that change. Please try again."); }
    finally { busy.current = false; setPending(false); }
  }

  return (
    <section aria-label={`Payment check for invoice ${invoiceNumber}`} className="space-y-3">
      {paymentToConfirm ? <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-slate-900" role="status">
        <p className="font-semibold">Payment to confirm</p>
        <p className="text-sm">The customer says they have paid invoice {invoiceNumber}. Chasing is paused while you check your bank account. This does not mean the payment has been received.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={locked} onClick={() => void run(onConfirmPaymentReceived, "Payment confirmed as received.")}>Confirm payment received</Button>
          <Button type="button" variant="outline" disabled={locked} onClick={() => void run(onNotReceivedResumeChasing, "Payment not received. Chasing resumed.")}>Not received, resume chasing</Button>
        </div>
      </div> : <Button type="button" variant="outline" disabled={locked} onClick={() => void run(onCustomerSaysPaid, "Customer's payment claim saved for checking.")}>Customer says paid</Button>}
      {pending && <p role="status" className="text-sm">Saving…</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </section>
  );
}
