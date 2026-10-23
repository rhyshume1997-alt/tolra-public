"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";

import { DespatchFromOrder } from "@/components/despatch-from-order";
import { StatusBadge } from "@/components/status-badge";
import { deliveryNoteStatusKey } from "@/lib/status-colours";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { fmtDate } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { type InvoiceNote, canCreateDeliveryNote, canOfferCreateDeliveryNote, deliveryNoteSource, fetchInvoiceNotes } from "@/lib/invoice-delivery-notes";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

/**
 * The delivery notes behind one invoice (lib/invoice-delivery-notes), each opening its print page, and a button that makes another
 * from the invoice's job (or its sales order) through the existing create_delivery_note path. Nothing here is a new permission:
 * the list is read under the signed-in person's row security, and the button is for the roles create_delivery_note already allows.
 */
export function InvoiceDeliveryNotes({ invoiceId, jobId }: { invoiceId: string; jobId?: string | null }) {
  const { activeRole } = useUser();
  const [notes, setNotes] = useState<InvoiceNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (!supabase) return;
    try {
      setNotes(await fetchInvoiceNotes(supabase, { id: invoiceId, jobId }));
      setError(null);
    } catch (err) {
      setError(friendlyError(err, "Couldn't load the delivery notes."));
    }
  }, [invoiceId, jobId]);

  useEffect(() => {
    setNotes(null);
    void load();
  }, [load]);

  const source = notes ? deliveryNoteSource({ jobId }, notes) : null;
  const canCreate = canCreateDeliveryNote(activeRole);
  // Only on an invoice that came from delivery notes: a note made here is not attached to this invoice (see canOfferCreateDeliveryNote).
  const canOffer = canCreate && !!notes && canOfferCreateDeliveryNote({ jobId }, notes);

  return (
    <section aria-label="Delivery notes" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-950">Delivery notes</h3>
        {canOffer && source ? (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button size="sm" variant="outline"><Plus className="size-4" /> Create delivery note</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New delivery note</DialogTitle>
                <DialogDescription>Made from {source.source === "job" ? "this invoice's job" : "this invoice's sales order"}, with the quantity despatched on each line. It is not added to this invoice: sending this delivery note out makes its own draft invoice for the new goods.</DialogDescription>
              </DialogHeader>
              <DespatchFromOrder source={source.source} presetId={source.id} onCreated={() => { setOpen(false); void load(); }} />
            </DialogContent>
          </Dialog>
        ) : null}
      </div>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {!error && !notes ? <p className="text-sm text-slate-500" role="status">Loading the delivery notes...</p> : null}
      {notes && !notes.length ? <p className="text-sm text-slate-500">No delivery notes are linked to this invoice yet.</p> : null}
      {notes?.length ? (
        <ul className="divide-y rounded-lg border text-sm" aria-label="Delivery notes on this invoice">
          {notes.map((note) => (
            <li key={note.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2">
              <span className="font-mono font-medium text-slate-950">{note.ref}</span>
              <span className="text-slate-600">{note.date ? fmtDate(note.date) : "-"}</span>
              <StatusBadge status={deliveryNoteStatusKey(note.status)} label={note.status} className="capitalize" />
              {note.via === "job" ? <span className="text-xs text-slate-500" title="On the same job; not on any invoice yet">same job, not invoiced yet</span> : null}
              <a className="ml-auto text-sm font-medium underline" href={`/delivery-notes/${encodeURIComponent(note.id)}/print`} target="_blank" rel="noreferrer">Open / print</a>
            </li>
          ))}
        </ul>
      ) : null}
      {notes && canCreate && !canOffer ? <p className="text-xs text-slate-500">Create delivery notes from the job or sales order.</p> : null}
    </section>
  );
}
