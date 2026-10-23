"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fmtDate } from "@/lib/dates";
import { type LinkOptions, ITEMS_NOT_ADDED, linkNoteToInvoice, loadLinkOptions } from "@/lib/delivery-note-invoice-link";
import { NEEDS_DATABASE_UPDATE, missingDbObject } from "@/lib/db-features";
import { friendlyError } from "@/lib/friendly-error";
import { invoiceHref } from "@/lib/invoice-link";
import { gbp } from "@/lib/money";
import { useDatabaseHas067 } from "@/lib/use-database-has-067";

/**
 * "Attach to invoice" on a delivery note (migration 067, link_delivery_note_to_invoice): put the note on a draft invoice of the same
 * company, customer and job, so no second draft is made when it goes out. Admin and office only (the caller passes canLink; the
 * database decides). Only links: the note's items are not added to the invoice (see lib/delivery-note-invoice-link.ts).
 */
export function DeliveryNoteInvoiceLink({ noteId, canLink, onLinked }: { noteId: string; canLink: boolean; onLinked?: () => void }) {
  const [options, setOptions] = useState<LinkOptions | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  // link_delivery_note_to_invoice is 067's: until the database has it, the control isn't shown (the app can go out first).
  const available = useDatabaseHas067(canLink) === true;

  const load = useCallback(async () => {
    setState("loading");
    try {
      const next = await loadLinkOptions(noteId);
      setOptions(next);
      setChoice(next.candidates[0]?.id ?? "");
      setState("ready");
    } catch (error) {
      console.error(error);
      setState("error");
    }
  }, [noteId]);
  useEffect(() => { if (canLink && available) void load(); }, [canLink, available, load]);

  if (!canLink || !available) return null;

  async function attach() {
    if (!choice || !options) return;
    setBusy(true);
    try {
      await linkNoteToInvoice(noteId, choice);
      toast.success(`Delivery note ${options.note.dnNumber} is on the draft invoice. Its items were not added: check the draft's lines.`);
      await load();
      onLinked?.();
    } catch (error) {
      toast.error(missingDbObject(error as { code?: string; message?: string }) ? NEEDS_DATABASE_UPDATE : friendlyError(error, "Couldn't put the delivery note on the invoice."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Invoice" className="space-y-2 rounded-lg border p-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><FileText className="size-4" aria-hidden /> Invoice</h3>
      {state === "loading" ? <p className="text-sm text-slate-600 dark:text-slate-300">Looking for draft invoices…</p> : null}
      {state === "error" ? <p className="text-sm text-slate-600 dark:text-slate-300">Couldn&apos;t look up the invoices for this note.</p> : null}
      {state === "ready" && options ? (
        options.current ? (
          <p className="text-sm">
            On <Link href={invoiceHref(options.current.id)} className="font-medium underline">{options.current.draft ? "a draft invoice" : `invoice ${options.current.ref ?? ""}`.trim()}</Link>.
            {options.current.draft ? " Its items are on the invoice only if the draft's lines bill them: check them with Edit Draft on the invoice." : null}
          </p>
        ) : options.blocked ? (
          <p role="status" className="text-sm text-amber-900 dark:text-amber-200">{options.blocked}</p>
        ) : options.candidates.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">No draft invoice for this job and customer to attach it to.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-slate-600 dark:text-slate-300">{ITEMS_NOT_ADDED}</p>
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Draft invoice to attach the delivery note to" value={choice} onChange={(event) => setChoice(event.target.value)} className="h-9 rounded-lg border px-2 text-sm">
                {options.candidates.map((invoice) => (
                  <option key={invoice.id} value={invoice.id}>{`Draft ${invoice.invoiceDate ? fmtDate(invoice.invoiceDate) : ""} · ${invoice.customer} · ${gbp(invoice.total)}`}</option>
                ))}
              </select>
              <Button type="button" size="sm" variant="outline" disabled={busy || !choice} onClick={() => void attach()}>Attach to invoice</Button>
            </div>
          </div>
        )
      ) : null}
    </section>
  );
}
