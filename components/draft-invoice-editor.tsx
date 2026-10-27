"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { VatRateSelect } from "@/components/vat-controls";
import { VatTotals } from "@/components/vat-totals";
import { auditEvent } from "@/lib/audit";
import { type DraftForm, type DraftLine, type DraftVatSettings, type LineBalance, type StoredLine, balanceText, buildDraftReplace, draftFormFrom, draftTotals, overBalanceProblem } from "@/lib/draft-invoice-edit";
import { missingDbObject } from "@/lib/db-features";
import { friendlyError } from "@/lib/friendly-error";
import { DELIVERY_ADDRESS_MAX, INVOICE_NOTE_MAX } from "@/lib/invoice-fields";
import { supabase } from "@/lib/supabase";
import { toVatChoice, type VatChoice } from "@/lib/vat";

/** Shown if the draft is saved before 067 is applied (the Edit Draft button is normally hidden until then). */
export const DRAFT_EDIT_NEEDS_UPDATE = "Editing drafts isn't available yet: the database update that adds it hasn't been applied. Nothing was changed.";

export type DraftInvoice = {
  id: string;
  reference: string;
  customer: string;
  /** invoices.updated_at as loaded: the database refuses the save if someone changed the draft since (PT409). */
  updatedAt?: string;
  date?: string;
  dueDate?: string;
  terms?: string;
  customerPo?: string;
  carriage: number;
  /** Migration 073: undefined when the database has no such column (then the field isn't shown or sent); null when none is set. */
  invoiceNote?: string | null;
  deliveryAddress?: string | null;
};

/** 099: each line's order-line link and balance, from draft_invoice_balances (position order, as the lines are loaded). */
/** An order line of the draft's orders, despatched and not invoiced, that the draft can add (freed from a draft, or never drafted). */
type Addable = { orderLine: string; description: string; unitPrice: number; vat: VatChoice; balance: LineBalance };
type Links = { state: "loading" } | { state: "none" } | { state: "ready"; byIndex: Array<string | null>; balances: Map<string, LineBalance>; addable: Addable[] } | { state: "stale" };

async function loadLinks(invoiceId: string, lineCount: number): Promise<Links> {
  if (!supabase) return { state: "none" };
  const { data, error } = await supabase.rpc("draft_invoice_balances", { p_invoice: invoiceId });
  if (error) {
    if (missingDbObject(error)) return { state: "none" }; // before 099: no links, the editor works as before
    throw error;
  }
  type Row = { line_position: number | null; sales_order_line_id: string | null; description: string | null; unit_price: number | string | null; vat_pct: number | string | null; vat_exempt: boolean | null;
    ordered: number | string | null; despatched: number | string | null; on_other_invoices: number | string | null; available: number | string | null };
  const all = (data ?? []) as Row[];
  // The draft's own lines come first, in position order; rows with no position are other lines of its orders that can be added.
  const rows = all.filter((row) => row.line_position !== null);
  if (rows.length !== lineCount) return { state: "stale" };
  const balanceOf = (row: Row): LineBalance => ({ ordered: Number(row.ordered), despatched: Number(row.despatched), onOtherInvoices: Number(row.on_other_invoices), available: Number(row.available) });
  const balances = new Map<string, LineBalance>();
  for (const row of all) if (row.sales_order_line_id) balances.set(row.sales_order_line_id, balanceOf(row));
  const addable = all.filter((row) => row.line_position === null && row.sales_order_line_id && Number(row.available) > 0).map((row) => ({
    orderLine: row.sales_order_line_id!, description: row.description ?? "", unitPrice: Number(row.unit_price ?? 0), vat: toVatChoice(Number(row.vat_pct ?? 20), Boolean(row.vat_exempt)), balance: balanceOf(row),
  }));
  return { state: "ready", byIndex: rows.map((row) => row.sales_order_line_id), balances, addable };
}

/**
 * Edit a draft invoice before it is issued (migration 067, replace_draft_invoice): remove or change lines, quantities, prices and
 * descriptions, the dates, terms, customer PO and carriage. Totals and VAT follow the invoice's own VAT settings, as when it was made.
 */
export function DraftInvoiceEditor({ invoice, lines, vat, defaultVat, textLines = false, open, onClose, onSaved }: {
  invoice: DraftInvoice;
  lines: StoredLine[];
  vat: DraftVatSettings;
  /** The VAT rate a new line starts with. */
  defaultVat: VatChoice;
  /** The database has migration 073: £0 text-only lines can be added. */
  textLines?: boolean;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<DraftForm>(() => draftFormFrom(invoice, lines));
  const [saving, setSaving] = useState(false);
  const [links, setLinks] = useState<Links>({ state: "loading" });
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setForm(draftFormFrom(invoice, lines));
    setLinks({ state: "loading" });
    loadLinks(invoice.id, lines.length).then((loaded) => {
      if (cancelled) return;
      setLinks(loaded);
      if (loaded.state === "ready") {
        setForm((current) => ({ ...current, lines: current.lines.map((line, i) => (loaded.byIndex[i] ? { ...line, orderLine: loaded.byIndex[i] ?? undefined } : line)) }));
      }
    }, (error) => {
      if (cancelled) return;
      setLinks({ state: "stale" });
      toast.error(friendlyError(error, "Couldn't read what has been despatched for this draft."));
    });
    return () => { cancelled = true; };
  }, [open, invoice, lines]);
  const balances = links.state === "ready" ? links.balances : undefined;
  const overProblem = overBalanceProblem(form.lines, balances);
  /** 099: lines of the draft's orders despatched and not invoiced, not already on the form: "Add" puts the rest on this draft. */
  const addable = links.state === "ready" ? links.addable.filter((a) => !form.lines.some((line) => line.orderLine === a.orderLine)) : [];
  const addOrderLine = (a: Addable) => setForm((current) => ({ ...current, lines: [...current.lines, { description: a.description, qty: String(a.balance.available), unit: a.unitPrice.toFixed(2), vat: a.vat, orderLine: a.orderLine }] }));

  const totals = draftTotals(form, vat);
  const setLine = (index: number, patch: Partial<DraftLine>) => setForm((current) => ({ ...current, lines: current.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) }));
  const removeLine = (index: number) => setForm((current) => ({ ...current, lines: current.lines.filter((_, i) => i !== index) }));
  const addLine = () => setForm((current) => ({ ...current, lines: [...current.lines, { description: "", qty: "1", unit: "", vat: defaultVat }] }));
  const addTextLine = () => setForm((current) => ({ ...current, lines: [...current.lines, { description: "", qty: "0", unit: "0.00", vat: defaultVat, text: true }] }));

  async function save() {
    if (links.state === "loading") { toast.error("Still reading what has been despatched for this draft. Try again in a moment."); return; }
    if (links.state === "stale") { toast.error("This draft changed since the page loaded: reload it and make your changes again. Nothing was changed."); return; }
    const built = buildDraftReplace(form, vat, { textLines, links: links.state === "ready", balances });
    if (!built.ok) { toast.error(built.error); return; }
    setSaving(true);
    try {
      if (!supabase) throw new Error("Supabase is not configured.");
      if (!invoice.updatedAt) throw new Error("Reload the page and open the draft again before editing it.");
      const { error } = await supabase.rpc("replace_draft_invoice", { p_invoice: invoice.id, p_expected_updated_at: invoice.updatedAt, p_header: built.value.header, p_lines: built.value.lines });
      if (error) {
        if (missingDbObject(error)) {
          toast.error(DRAFT_EDIT_NEEDS_UPDATE);
          return;
        }
        throw error;
      }
      void auditEvent({ action: "UPDATE", entityTable: "invoices", entityId: invoice.id, metadata: { draft_corrected: true, lines: built.value.lines.length, total: built.value.totals.total } });
      toast.success("Draft invoice updated");
      onSaved();
    } catch (error) {
      toast.error(friendlyError(error, "Couldn't save the draft. Nothing was changed."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit draft invoice for {invoice.customer}</DialogTitle>
          <DialogDescription>Remove or change what is billed before the invoice is issued. Totals and VAT are worked out again; once issued, an invoice can only be corrected with a credit note.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1"><span className="font-medium">Invoice date</span><Input type="date" value={form.invoiceDate} onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })} /></label>
            <label className="space-y-1"><span className="font-medium">Due date</span><Input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></label>
            <label className="space-y-1"><span className="font-medium">Terms</span><Input value={form.terms} maxLength={200} onChange={(e) => setForm({ ...form, terms: e.target.value })} /></label>
            <label className="space-y-1"><span className="font-medium">Customer PO</span><Input value={form.customerPo} maxLength={100} onChange={(e) => setForm({ ...form, customerPo: e.target.value })} /></label>
          </div>
          <div className="space-y-2" role="group" aria-label="Invoice lines">
            {form.lines.map((line, index) => line.text ? (
              <div key={index} className="grid grid-cols-1 gap-2 rounded-lg border border-dashed p-2 sm:grid-cols-[1fr_auto] sm:items-end">
                <label className="space-y-1"><span className="text-xs text-slate-600">Text only (£0, not counted in the totals)</span><Input aria-label={`Line ${index + 1} text`} value={line.description} onChange={(e) => setLine(index, { description: e.target.value })} /></label>
                <Button type="button" variant="ghost" size="sm" aria-label={`Remove line ${index + 1}`} disabled={form.lines.length === 1} onClick={() => removeLine(index)}><Trash2 className="size-4" /></Button>
              </div>
            ) : (
              <div key={index} className="grid grid-cols-1 gap-2 rounded-lg border p-2 sm:grid-cols-[1fr_5rem_6rem_6rem_auto] sm:items-end">
                <label className="space-y-1"><span className="text-xs text-slate-600">Description</span><Input aria-label={`Line ${index + 1} description`} value={line.description} onChange={(e) => setLine(index, { description: e.target.value })} /></label>
                <label className="space-y-1"><span className="text-xs text-slate-600">Qty</span><Input aria-label={`Line ${index + 1} quantity`} inputMode="decimal" value={line.qty} onChange={(e) => setLine(index, { qty: e.target.value })} /></label>
                <label className="space-y-1"><span className="text-xs text-slate-600">Unit price</span><Input aria-label={`Line ${index + 1} unit price`} inputMode="decimal" value={line.unit} onChange={(e) => setLine(index, { unit: e.target.value })} /></label>
                {vat.registered && vat.vatEnabled ? <VatRateSelect value={line.vat} onChange={(choice) => setLine(index, { vat: choice })} label={`Line ${index + 1} VAT rate`} /> : <span />}
                <Button type="button" variant="ghost" size="sm" aria-label={`Remove line ${index + 1}`} disabled={form.lines.length === 1} onClick={() => removeLine(index)}><Trash2 className="size-4" /></Button>
                {line.orderLine && balances?.get(line.orderLine) ? (
                  <p className="text-xs text-slate-600 sm:col-span-5" data-testid={`line-balance-${index}`}>{balanceText(balances.get(line.orderLine)!)}</p>
                ) : null}
              </div>
            ))}
            {addable.length ? (
              <div className="space-y-1 rounded-lg border border-dashed p-2" data-testid="despatched-not-invoiced">
                <p className="text-xs font-medium text-slate-700">Despatched, not yet invoiced on this order</p>
                {addable.map((a) => (
                  <div key={a.orderLine} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span>{a.description}: {a.balance.available} ({balanceText(a.balance)})</span>
                    <Button type="button" variant="outline" size="sm" aria-label={`Add ${a.description}`} onClick={() => addOrderLine(a)}><Plus className="size-4" /> Add</Button>
                  </div>
                ))}
              </div>
            ) : null}
            {overProblem ? <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-2 text-sm text-red-800" data-testid="over-balance">{overProblem}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={addLine}><Plus className="size-4" /> Add line</Button>
              {textLines ? <Button type="button" variant="outline" size="sm" onClick={addTextLine}><Plus className="size-4" /> Add text line</Button> : null}
            </div>
          </div>
          {form.invoiceNote !== undefined ? (
            <label className="block space-y-1"><span className="font-medium">Invoice note</span><span className="block text-xs text-slate-600">One line, printed on the invoice.</span>
              <Input value={form.invoiceNote} maxLength={INVOICE_NOTE_MAX} onChange={(e) => setForm({ ...form, invoiceNote: e.target.value.replace(/[\r\n]+/g, " ") })} /></label>
          ) : null}
          {form.deliveryAddress !== undefined ? (
            <label className="block space-y-1"><span className="font-medium">Delivery address</span><span className="block text-xs text-slate-600">Printed under Deliver To. Leave blank to print the invoice address.</span>
              <Textarea value={form.deliveryAddress} maxLength={DELIVERY_ADDRESS_MAX} rows={3} onChange={(e) => setForm({ ...form, deliveryAddress: e.target.value })} /></label>
          ) : null}
          <label className="block max-w-40 space-y-1"><span className="font-medium">Carriage</span><Input inputMode="decimal" value={form.carriage} onChange={(e) => setForm({ ...form, carriage: e.target.value })} /></label>
          <VatTotals totals={totals} vatEnabled={vat.vatEnabled && vat.registered} showCarriage className="ml-auto w-full max-w-xs space-y-1 rounded-lg bg-slate-50 p-4 text-sm" />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button>
            <Button type="button" className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save draft"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
