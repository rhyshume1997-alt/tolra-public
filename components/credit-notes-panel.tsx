"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CreditNotePDF } from "@/components/pdf/CreditNotePDF";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { WhoWhen } from "@/components/who-when";
import { auditEvent } from "@/lib/audit";
import { requireCompanyProfile } from "@/lib/company";
import { fmtDate, toDateInput } from "@/lib/dates";
import { resolveCustomerAddress } from "@/lib/customers";
import { issuedBillTo, issuedCompany } from "@/lib/document-snapshot";
import { creditPreview, startingQuantity } from "@/lib/credit-draft";
import { downloadPdf } from "@/lib/download-pdf";
import { friendlyError } from "@/lib/friendly-error";
import { nudgeIntegrationSend } from "@/lib/integrations/nudge";
import { fromPence, gbp, isTextLine, toPence } from "@/lib/money";
import { balanceDue, customerCredit, invoiceStatus } from "@/lib/receivables";
import { supabase } from "@/lib/supabase";

type InvoiceLine = { id: string; description: string; quantity: number; unitPrice: number; credited: number; vatPct: number; vatExempt: boolean };
type CreditNote = {
  id: string; credit_ref: string | null; status: string; credit_date: string; reason: string | null; subtotal: number; vat: number; total: number;
  vat_enabled: boolean; allocated_amount: number; customer: string; issuer_snapshot: unknown; customer_snapshot: unknown;
};

const money = (value: number) => gbp(value, 2);

/**
 * Credit notes for one issued invoice (migration 034): make one from the invoice's lines, issue it (it then gets a CN number, is
 * locked and, in the same database transaction, is applied to the invoice: an allocation, not a payment) and print it. The database
 * works out the totals and refuses a credit above the invoice. What the invoice still owed is settled by the credit; any more is
 * customer credit on the invoice, shown and refundable like any other (the Customer credit box above), never left unapplied.
 */
export function CreditNotesPanel({ invoice, onChanged }: {
  invoice: { id: string; reference: string; customer: string; vatEnabled: boolean; rawStatus: string };
  onChanged: () => void;
}) {
  const [notes, setNotes] = useState<CreditNote[]>([]);
  const [lines, setLines] = useState<InvoiceLine[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [making, setMaking] = useState(false);
  const [quantities, setQuantities] = useState<string[]>([]);
  const [prices, setPrices] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [applying, setApplying] = useState<{ note: CreditNote; amount: string; requestId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The draft waiting for "are you sure?" before it is deleted. */
  const [discarding, setDiscarding] = useState<CreditNote | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error: loadError } = await supabase.from("credit_notes").select("*").eq("invoice_id", invoice.id).order("created_at").order("id");
    if (!mounted.current) return;
    if (loadError) { console.error(loadError); return setState("error"); }
    setNotes((data ?? []).map((row) => ({ ...row, subtotal: Number(row.subtotal), vat: Number(row.vat), total: Number(row.total), allocated_amount: Number(row.allocated_amount) })) as CreditNote[]);
    // The invoice's own lines, and how much of each has been credited already (the credit takes its VAT from the invoice).
    const { data: rows, error: linesError } = await supabase.from("invoice_line_items").select("id, description, quantity, unit_price, vat_pct, vat_exempt").eq("invoice_id", invoice.id).order("position");
    if (linesError) { console.error(linesError); return setState("error"); }
    const { data: credited } = await supabase.from("credit_note_lines").select("invoice_line_id, quantity").in("invoice_line_id", (rows ?? []).map((row) => row.id));
    if (!mounted.current) return;
    // £0 text-only lines (migration 073) bill nothing, so there is nothing to credit on them.
    setLines((rows ?? []).filter((row) => !isTextLine({ quantity: Number(row.quantity), unitPrice: Number(row.unit_price) })).map((row) => ({
      id: String(row.id), description: String(row.description), quantity: Number(row.quantity), unitPrice: Number(row.unit_price),
      vatPct: Number(row.vat_pct ?? 20), vatExempt: Boolean(row.vat_exempt),
      credited: (credited ?? []).filter((c) => c.invoice_line_id === row.id).reduce((sum, c) => sum + Number(c.quantity), 0),
    })));
    setState("ready");
  }, [invoice.id]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);

  function startMaking() {
    // Each line starts at the most that can still be credited (invoiced less already credited); the user lowers it.
    setQuantities(lines.map(startingQuantity));
    setPrices(lines.map((line) => line.unitPrice.toFixed(2)));
    setReason("");
    setError(null);
    setMaking(true);
  }

  async function make() {
    if (!supabase || busy) return;
    const chosen = lines.map((line, index) => ({ line, quantity: Number(quantities[index] || 0), price: Number(prices[index] || 0) })).filter((item) => item.quantity > 0);
    if (!chosen.length) return setError("Enter the quantity to credit on at least one line.");
    setBusy(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc("create_credit_note", {
        p_invoice: invoice.id, p_reason: reason.trim() || null, p_credit_date: toDateInput(new Date()),
        p_lines: chosen.map(({ line, quantity, price }) => ({ invoice_line_id: line.id, quantity, unit_price: price })),
      });
      if (rpcError) throw rpcError;
      void auditEvent({ action: "CREATE", entityTable: "invoices", entityId: invoice.reference, metadata: { credit_note: String(data) } });
      toast.success("Draft credit note saved. Check it, then issue it to give it a number.");
      setMaking(false);
      await load();
    } catch (err) {
      setError(friendlyError(err, "Couldn't save the credit note. Nothing was saved."));
    } finally {
      setBusy(false);
    }
  }

  async function issue(note: CreditNote) {
    if (!supabase || busy) return;
    setBusy(true);
    try {
      const { data, error: rpcError } = await supabase.rpc("issue_credit_note", { p_credit: note.id });
      if (rpcError) throw rpcError;
      nudgeIntegrationSend("credit_note", note.id);
      // Issuing applied the credit to the invoice in the same transaction: read the invoice back to say what that did.
      const { data: after } = await supabase.from("invoices").select("status, total, amount_paid, credited_amount, refunded_amount, payment_unverified").eq("id", invoice.id).single();
      const owed = after ? balanceDue(Number(after.total), Number(after.amount_paid), Number(after.credited_amount), Number(after.refunded_amount)) : null;
      const surplus = after ? customerCredit({ status: after.status, total: Number(after.total), amount_paid: Number(after.amount_paid), credited_amount: Number(after.credited_amount), refunded_amount: Number(after.refunded_amount), payment_unverified: after.payment_unverified }) : 0;
      toast.success(`Credit note ${String(data)} issued and applied to ${invoice.reference}.${owed === null ? "" : owed > 0 ? ` Balance due ${money(owed)}.` : " Nothing is owed on it now."}${surplus > 0 ? ` ${money(surplus)} is customer credit.` : ""}`);
      await load();
      onChanged();
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't issue the credit note."));
    } finally {
      setBusy(false);
    }
  }

  async function discard(note: CreditNote) {
    if (!supabase || busy) return;
    setDiscarding(null);
    setBusy(true);
    try {
      const { error: deleteError } = await supabase.from("credit_notes").delete().eq("id", note.id).eq("status", "draft");
      if (deleteError) throw deleteError;
      toast.success("Draft credit note deleted");
      await load();
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't delete the draft."));
    } finally {
      setBusy(false);
    }
  }

  function startApplying(note: CreditNote) {
    const left = fromPence(toPence(note.total) - toPence(note.allocated_amount));
    setApplying({ note, amount: left.toFixed(2), requestId: crypto.randomUUID() });
    setError(null);
  }

  async function apply() {
    if (!supabase || !applying || busy) return;
    if (!/^\d+(\.\d{1,2})?$/.test(applying.amount.trim()) || Number(applying.amount) <= 0) return setError("Enter the amount in pounds and pence, more than zero.");
    setBusy(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc("allocate_credit_note", { p_credit: applying.note.id, p_amount: Number(applying.amount), p_request_id: applying.requestId });
      if (rpcError) throw rpcError;
      const result = data as { balance_due: number; customer_credit: number; status: string };
      toast.success(`${money(Number(applying.amount))} applied to ${invoice.reference}. Balance due ${money(Number(result.balance_due))}.${Number(result.customer_credit) > 0 ? ` ${money(Number(result.customer_credit))} is customer credit.` : ""}`);
      setApplying(null);
      await load();
      onChanged();
    } catch (err) {
      setError(friendlyError(err, "Couldn't apply the credit. Nothing was changed."));
    } finally {
      setBusy(false);
    }
  }

  async function pdf(note: CreditNote) {
    await downloadPdf(async () => {
      if (!supabase) throw new Error("Supabase is not configured.");
      const current = await requireCompanyProfile();
      const company = issuedCompany(current, note.issuer_snapshot);
      const { data, error: linesError } = await supabase.from("credit_note_lines").select("description, quantity, unit_price, vat_pct, vat_exempt, vat_amount").eq("credit_note_id", note.id).order("position");
      if (linesError) throw linesError;
      const billTo = issuedBillTo(note.customer_snapshot, note.customer) ?? await resolveCustomerAddress(note.customer);
      return (
        <CreditNotePDF
          data={{
            number: note.credit_ref ?? "",
            date: fmtDate(note.credit_date),
            invoiceRef: invoice.reference,
            billTo,
            lineItems: (data ?? []).map((row) => ({ description: String(row.description), quantity: Number(row.quantity), unitPrice: Number(row.unit_price), vatPct: Number(row.vat_pct), vatExempt: Boolean(row.vat_exempt), vatAmount: Number(row.vat_amount) })),
            vatEnabled: note.vat_enabled,
            reason: note.reason ?? undefined,
            company,
            storedTotals: { reference: note.credit_ref ?? "", issued: true, total: note.total, subtotal: note.subtotal, vat: note.vat },
          }}
        />
      );
    }, `credit-note-${note.credit_ref}.pdf`, { entityTable: "invoices", entityId: note.credit_ref ?? invoice.reference });
  }

  const canMake = !["draft", "void", "voided", "cancelled", "canceled", "credited", "written_off"].includes(invoiceStatus(invoice.rawStatus));
  return (
    <section aria-label="Credit notes" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-950">Credit notes</h3>
        {canMake && !making ? <Button size="sm" variant="outline" disabled={busy || state !== "ready"} onClick={startMaking}>New credit note</Button> : null}
      </div>
      {state === "loading" ? <p className="text-xs text-slate-500">Loading…</p> : null}
      {state === "error" ? <p role="alert" className="text-xs text-red-700">Couldn&apos;t load the credit notes. <button type="button" className="underline" onClick={() => void load()}>Retry</button></p> : null}
      {state === "ready" && !notes.length && !making ? <p className="text-sm text-slate-500">No credit notes against this invoice.</p> : null}
      {notes.length ? (
        <ul className="divide-y rounded-lg border text-sm" aria-label="Credit notes for this invoice">
          {notes.map((note) => {
            const left = fromPence(toPence(note.total) - toPence(note.allocated_amount));
            return (
              <li key={note.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3" data-testid="credit-note-row">
                <span className="w-28 font-mono font-semibold">{note.credit_ref ?? "Draft"}</span>
                <span className="w-24">{fmtDate(note.credit_date)}</span>
                <span className="w-24 font-semibold">{money(note.total)}</span>
                <span className="text-xs text-slate-600">{note.status === "draft" ? "Not issued" : `${money(note.allocated_amount)} applied to ${invoice.reference}, ${money(left)} left`}</span>
                <span className="ml-auto flex flex-wrap gap-1">
                  {note.status === "draft" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => setDiscarding(note)}>Delete draft</Button> : null}
                  {note.status === "draft" ? <Button size="sm" className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={busy} onClick={() => void issue(note)}>Issue credit note</Button> : null}
                  {note.status === "issued" && left > 0 ? <Button size="sm" variant="outline" disabled={busy} onClick={() => startApplying(note)}>Apply credit</Button> : null}
                  {note.status === "issued" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void pdf(note)}>Download PDF</Button> : null}
                </span>
                <WhoWhen table="credit_notes" row={note as unknown as Record<string, unknown>} className="basis-full" />
              </li>
            );
          })}
        </ul>
      ) : null}
      {applying ? (
        <div role="group" aria-label={`Apply ${applying.note.credit_ref}`} className="flex flex-wrap items-end gap-2 rounded-lg border p-3 text-sm">
          <label className="grid gap-1 text-xs text-slate-500">Amount to apply to {invoice.reference}
            <Input aria-label="Credit amount to apply" className="h-9 w-32" inputMode="decimal" value={applying.amount} onChange={(event) => setApplying({ ...applying, amount: event.target.value })} />
          </label>
          <Button size="sm" className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={busy} onClick={() => void apply()}>{busy ? "Saving…" : "Apply credit"}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setApplying(null)}>Cancel</Button>
        </div>
      ) : null}
      {making ? (
        <div role="group" aria-label="New credit note" className="space-y-2 rounded-lg border p-3 text-sm">
          <p className="text-xs text-slate-500">Each line starts at the most that can still be credited: lower the quantity on any line, or set it to 0 to leave it out. Credit at the price it was invoiced (or less). VAT is the invoice&apos;s own, and you can&apos;t credit more than was invoiced.</p>
          <table className="w-full text-xs" aria-label="Lines to credit">
            <thead><tr className="text-left text-slate-500"><th className="p-1">Line</th><th className="p-1 text-right">Invoiced</th><th className="p-1 text-right">Credited</th><th className="p-1 text-right">Credit qty</th><th className="p-1 text-right">Each</th></tr></thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={line.id} className="border-t">
                  <td className="p-1">{line.description}</td>
                  <td className="p-1 text-right">{line.quantity}</td><td className="p-1 text-right">{line.credited}</td>
                  <td className="p-1 text-right"><Input aria-label={`Quantity to credit: ${line.description}`} className="ml-auto h-8 w-20 text-right" type="number" inputMode="decimal" min="0" step="any" value={quantities[index] ?? ""} onChange={(event) => setQuantities((current) => current.map((value, i) => (i === index ? event.target.value : value)))} /></td>
                  <td className="p-1 text-right"><Input aria-label={`Price each: ${line.description}`} className="ml-auto h-8 w-24 text-right" type="number" inputMode="decimal" min="0" step="0.01" value={prices[index] ?? ""} onChange={(event) => setPrices((current) => current.map((value, i) => (i === index ? event.target.value : value)))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-right text-xs text-slate-700" data-testid="credit-preview">
            {(() => {
              const preview = creditPreview(lines, quantities, prices, invoice.vatEnabled);
              return `Net ${money(preview.subtotal)} + VAT ${money(preview.vat)} = ${money(preview.total)}`;
            })()}
          </p>
          <p className="text-right text-[11px] text-slate-500">The VAT shown is a preview: the database works out the final figures when you save.</p>
          <Textarea aria-label="Reason for the credit" maxLength={500} placeholder="Reason (printed on the credit note)" value={reason} onChange={(event) => setReason(event.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={busy} onClick={() => void make()}>{busy ? "Saving…" : "Save draft credit note"}</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setMaking(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      <ConfirmDialog
        open={Boolean(discarding)}
        title={`Delete draft credit note for ${invoice.reference}?`}
        description={discarding ? `The draft credit note for ${money(discarding.total)} has not been issued. Deleting it removes it for good and it cannot be brought back.` : ""}
        confirmLabel="Delete draft"
        cancelLabel="Keep draft"
        destructive
        busy={busy}
        onCancel={() => setDiscarding(null)}
        onConfirm={() => discarding && void discard(discarding)}
      />
    </section>
  );
}
