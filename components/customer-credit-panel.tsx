"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { auditEvent } from "@/lib/audit";
import { toDateInput } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { gbp } from "@/lib/money";
import { supabase } from "@/lib/supabase";

type Target = { id: string; reference: string; balance: number };

/**
 * Customer credit on one invoice (migration 034): what the customer has paid or been credited beyond it. An admin can refund it (a row in
 * the append-only refund ledger, audited); admin or office can apply it to another open invoice of the same customer. Nothing is lost
 * or netted silently: the credit stays here until one of those happens.
 */
export function CustomerCreditPanel({ invoice, credit, isAdmin, onChanged }: {
  invoice: { id: string; reference: string; customer: string };
  credit: number;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"refund" | "apply" | null>(null);
  const [amount, setAmount] = useState(credit.toFixed(2));
  const [method, setMethod] = useState("BACS");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState("");
  const [requestId, setRequestId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== "apply" || !supabase) return;
    let active = true;
    supabase.from("invoices").select("id, invoice_ref, total, amount_paid, credited_amount, refunded_amount, status").eq("customer", invoice.customer).neq("id", invoice.id)
      .in("status", ["issued", "sent", "partial"]).order("invoice_date").then(({ data }) => {
        if (!active) return;
        setTargets((data ?? []).map((row) => ({ id: String(row.id), reference: String(row.invoice_ref ?? ""), balance: Math.max(0, Math.round((Number(row.total) - Number(row.amount_paid) - Number(row.credited_amount) + Number(row.refunded_amount)) * 100) / 100) })).filter((row) => row.balance > 0));
      });
    return () => { active = false; };
  }, [mode, invoice.customer, invoice.id]);

  function open(next: "refund" | "apply") {
    setMode(next);
    setAmount(credit.toFixed(2));
    setRequestId(crypto.randomUUID());
    setError(null);
  }

  async function submit() {
    if (!supabase || busy || !mode) return;
    if (!/^\d+(\.\d{1,2})?$/.test(amount.trim()) || Number(amount) <= 0) return setError("Enter the amount in pounds and pence, more than zero.");
    setBusy(true);
    setError(null);
    try {
      if (mode === "refund") {
        const { error: rpcError } = await supabase.rpc("refund_customer_credit", {
          p_invoice: invoice.id, p_amount: Number(amount), p_paid_on: toDateInput(new Date()), p_method: method, p_reference: reference.trim() || null, p_reason: reason.trim() || null, p_request_id: requestId,
        });
        if (rpcError) throw rpcError;
        void auditEvent({ action: "UPDATE", entityTable: "invoices", entityId: invoice.reference, metadata: { refund: Number(amount) } });
        toast.success(`${gbp(Number(amount), 2)} refunded from ${invoice.reference}`);
      } else {
        if (!target) return setError("Choose the invoice to apply it to.");
        const { error: rpcError } = await supabase.rpc("apply_customer_credit", { p_from: invoice.id, p_to: target, p_amount: Number(amount), p_request_id: requestId });
        if (rpcError) throw rpcError;
        toast.success(`${gbp(Number(amount), 2)} applied to ${targets.find((item) => item.id === target)?.reference ?? "the invoice"}`);
      }
      setMode(null);
      onChanged();
    } catch (err) {
      setError(friendlyError(err, "Couldn't do that. Nothing was changed."));
    } finally {
      setBusy(false);
    }
  }

  if (credit <= 0) return null;
  return (
    <section aria-label="Customer credit" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p><span className="font-semibold">Customer credit {gbp(credit, 2)}</span> on {invoice.reference}: paid or credited beyond the invoice. It stays on the account until it is refunded or applied to another invoice.</p>
        <span className="flex gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => open("apply")}>Apply to another invoice</Button>
          {isAdmin ? <Button size="sm" variant="outline" disabled={busy} onClick={() => open("refund")}>Refund</Button> : null}
        </span>
      </div>
      {mode ? (
        <div role="group" aria-label={mode === "refund" ? "Refund customer credit" : "Apply customer credit"} className="grid gap-2 rounded-lg border bg-white p-3 text-slate-900">
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs text-slate-500">Amount<Input aria-label="Customer credit amount" className="h-9 w-28" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
            {mode === "apply" ? (
              <label className="grid gap-1 text-xs text-slate-500">Apply to
                <select aria-label="Invoice to apply the credit to" value={target} onChange={(event) => setTarget(event.target.value)} className="h-9 rounded-lg border px-2 text-sm">
                  <option value="">{targets.length ? "Choose an invoice..." : "No other open invoice for this customer"}</option>
                  {targets.map((item) => <option key={item.id} value={item.id}>{item.reference} (owes {gbp(item.balance, 2)})</option>)}
                </select>
              </label>
            ) : (
              <>
                <label className="grid gap-1 text-xs text-slate-500">Method
                  <select aria-label="Refund method" value={method} onChange={(event) => setMethod(event.target.value)} className="h-9 rounded-lg border px-2 text-sm">{["BACS", "cheque", "card", "cash", "other"].map((item) => <option key={item}>{item}</option>)}</select>
                </label>
                <label className="grid gap-1 text-xs text-slate-500">Reference<Input aria-label="Refund reference" className="h-9 w-36" maxLength={100} value={reference} onChange={(event) => setReference(event.target.value)} /></label>
                <label className="grid gap-1 text-xs text-slate-500">Reason<Input aria-label="Refund reason" className="h-9 w-56" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
              </>
            )}
          </div>
          {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
          <div className="flex gap-2">
            <Button size="sm" className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={busy} onClick={() => void submit()}>{busy ? "Saving…" : mode === "refund" ? "Record refund" : "Apply credit"}</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode(null)}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
