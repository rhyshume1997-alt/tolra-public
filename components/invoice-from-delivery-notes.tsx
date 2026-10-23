"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { auditEvent } from "@/lib/audit";
import { fmtDate, toDateInput } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { supabase } from "@/lib/supabase";
import { REASON_LABEL, customerKey, isMissingFunction, toUninvoiced, type UninvoicedReason } from "@/lib/uninvoiced";

type Note = { id: string; ref: string; customer: string; date: string; status: string; reason?: UninvoicedReason; voidedInvoiceRef?: string | null };

const addDays = (day: string, days: number) => toDateInput(new Date(new Date(`${day}T12:00:00`).getTime() + days * 86_400_000));

/**
 * A draft invoice from one or more delivery notes (migration 034): the lines, quantities and prices come from the order the notes
 * were made from, so nothing is typed again. Only notes that have gone out, were made from an order and aren't on a live invoice are listed
 * (migration 059: from uninvoiced_delivery_notes(), so a note whose invoice was voided is offered again and none is cut off at a page size).
 * A note sent out by a person is drafted automatically, so this is the fallback: a failed draft, a deleted one, or several notes on one.
 */
export function InvoiceFromDeliveryNotes({ open, onClose, terms, termsDays, onCreated }: { open: boolean; onClose: () => void; terms: string; termsDays: number; onCreated: (invoiceId: string) => void }) {
  const today = toDateInput(new Date());
  const [notes, setNotes] = useState<Note[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [chosen, setChosen] = useState<string[]>([]);
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [dueDate, setDueDate] = useState(addDays(today, termsDays));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !supabase) return;
    let active = true;
    setState("loading");
    setChosen([]);
    setError(null);
    const fromTable = () => supabase!.from("delivery_notes").select("id, dn_number, customer, delivery_date, status").is("invoice_id", null).not("sales_order_id", "is", null).in("status", ["despatched", "delivered", "signed"]).order("delivery_date", { ascending: false }).limit(300)
      .then(({ data, error: loadError }) => {
        if (!active) return;
        if (loadError) { console.error(loadError); return setState("error"); }
        setNotes((data ?? []).map((row) => ({ id: String(row.id), ref: String(row.dn_number), customer: String(row.customer ?? ""), date: String(row.delivery_date ?? ""), status: String(row.status) })));
        setState("ready");
      });
    void supabase.rpc("uninvoiced_delivery_notes").then(({ data, error: loadError }) => {
      if (!active) return;
      // A database older than 059 has no such function: the table as before.
      if (loadError && isMissingFunction(loadError)) return void fromTable();
      if (loadError) { console.error(loadError); return setState("error"); }
      setNotes(((data ?? []) as Record<string, unknown>[]).map(toUninvoiced).filter((row) => row.invoiceable)
        .map((row) => ({ id: row.id, ref: row.ref, customer: row.customer, date: row.sentAt, status: row.status, reason: row.reason, voidedInvoiceRef: row.voidedInvoiceRef })));
      setState("ready");
    });
    return () => { active = false; };
  }, [open]);

  const customer = notes.find((note) => note.id === chosen[0])?.customer;

  async function create() {
    if (!supabase || saving || !chosen.length) return;
    setSaving(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc("create_invoice_from_delivery_notes", { p_notes: chosen, p_invoice_date: invoiceDate, p_due_date: dueDate, p_terms: terms });
      if (rpcError) throw rpcError;
      const made = data as { invoice_id: string };
      void auditEvent({ action: "CREATE", entityTable: "invoices", entityId: made.invoice_id });
      toast.success("Draft invoice saved from the delivery notes. Check it, then issue it to give it a number.");
      onCreated(made.invoice_id);
    } catch (err) {
      setError(friendlyError(err, "Couldn't make the invoice. Nothing was saved."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invoice from delivery notes</DialogTitle>
          <DialogDescription>Choose the delivery notes to invoice. The lines and prices come from the order, so there is nothing to type. A delivery note can be invoiced once.</DialogDescription>
        </DialogHeader>
        {state === "loading" ? <p className="text-sm text-slate-500" role="status">Loading the delivery notes…</p> : null}
        {state === "error" ? <p role="alert" className="text-sm text-red-700">Couldn&apos;t load the delivery notes. Close this and try again.</p> : null}
        {state === "ready" && !notes.length ? <p className="text-sm text-slate-500">No delivery notes are waiting to be invoiced. A note is listed once it is made from an order, marked as despatched, and not yet on an invoice.</p> : null}
        {state === "ready" && notes.length ? (
          <ul className="divide-y rounded-lg border text-sm" aria-label="Delivery notes to invoice">
            {notes.map((note) => {
              const other = customer !== undefined && customerKey(note.customer) !== customerKey(customer);
              return (
                <li key={note.id}>
                  <label className={`flex items-center gap-3 p-3 ${other ? "opacity-50" : ""}`}>
                    <input type="checkbox" disabled={other} checked={chosen.includes(note.id)} onChange={(event) => setChosen((current) => (event.target.checked ? [...current, note.id] : current.filter((id) => id !== note.id)))} />
                    <span className="font-mono font-semibold">{note.ref}</span>
                    <span className="truncate">{note.customer}</span>
                    {note.reason && note.reason !== "not-drafted" ? <span className="text-xs text-amber-800">{REASON_LABEL[note.reason]}</span> : null}
                    {note.voidedInvoiceRef ? <span className="text-xs text-slate-500">{note.voidedInvoiceRef} was voided</span> : null}
                    <span className="ml-auto text-xs text-slate-500">{fmtDate(note.date)}, {note.status}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-1 text-xs text-slate-500">Invoice date<Input type="date" value={invoiceDate} onChange={(event) => { setInvoiceDate(event.target.value); setDueDate(addDays(event.target.value, termsDays)); }} /></label>
          <label className="grid gap-1 text-xs text-slate-500">Due date<Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
        </div>
        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={saving} onClick={onClose}>Cancel</Button>
          <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={saving || !chosen.length} onClick={() => void create()}>{saving ? "Saving…" : `Make draft invoice${chosen.length > 1 ? ` from ${chosen.length} notes` : ""}`}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
