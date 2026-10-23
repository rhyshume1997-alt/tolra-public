/**
 * Correcting a DRAFT invoice before it is issued (migration 067, replace_draft_invoice): "not everything is always billed". Lines can
 * be removed or changed (description, quantity, price, VAT rate), and the dates, terms, customer PO and carriage. The totals are
 * worked out here with the same rules as creating one (lib/money documentTotals: the invoice's own "Add VAT" and carriage-VAT
 * settings, the company's VAT registration and standard rate), and the database checks them against the lines again
 * (check_document_totals) before anything is saved. An issued invoice can't be changed: it is corrected with a credit note.
 *
 * With migration 073 the draft can also carry £0 text-only lines (quantity 0, price 0: a description only, excluded from the totals),
 * a one-line invoice note and a delivery address. Before 073 none of these is offered or sent: text lines only when the caller says the
 * database has them, and the note and address only when the invoice was loaded with those columns (the form keeps them undefined
 * otherwise, so nothing is ever saved over a value that wasn't read).
 */
import { deliveryAddressProblem, invoiceNoteProblem } from "@/lib/invoice-fields";
import { documentTotals, isTextLine, type DocumentTotals } from "@/lib/money";
import { fromVatChoice, toVatChoice, type VatChoice } from "@/lib/vat";

/** `text`: a £0 text-only line (073); its quantity and price are 0 whatever the fields say. */
export type DraftLine = { description: string; qty: string; unit: string; vat: VatChoice; text?: boolean };
export type DraftForm = {
  invoiceDate: string; dueDate: string; terms: string; customerPo: string; carriage: string; lines: DraftLine[];
  /** undefined: not offered (the database has no such column yet). */
  invoiceNote?: string;
  deliveryAddress?: string;
};
/** The invoice's own VAT settings and the company's, as the totals are worked out with them. */
export type DraftVatSettings = { vatEnabled: boolean; carriageVat: boolean; registered: boolean; standardRate: number };
export type StoredLine = { description: string; quantity: number; unitPrice: number; vatPct: number; vatExempt?: boolean };
/** What the database supports (migration 073): £0 text-only lines. */
export type DraftOptions = { textLines?: boolean };

export type DraftReplace = {
  header: {
    description: string; quantity: number; unit_price: number; subtotal: number; vat: number; total: number; carriage: number; invoice_date: string; due_date: string; terms: string; customer_po: string;
    invoice_note?: string; delivery_address?: string;
  };
  lines: Array<{ description: string; quantity: number; unit_price: number; vat_pct: number; vat_exempt: boolean }>;
  totals: DocumentTotals;
};

/** Only a draft (no number yet) can be changed. */
export function draftEditable(rawStatus: string | null | undefined): boolean {
  return (rawStatus ?? "draft") === "draft";
}

/** The edit form, filled from the invoice as stored. A note or address that wasn't loaded (undefined) stays undefined. */
export function draftFormFrom(
  invoice: { date?: string; dueDate?: string; terms?: string; customerPo?: string; carriage: number; invoiceNote?: string | null; deliveryAddress?: string | null },
  lines: StoredLine[],
): DraftForm {
  return {
    invoiceDate: invoice.date ?? "",
    dueDate: invoice.dueDate ?? "",
    terms: invoice.terms ?? "",
    customerPo: invoice.customerPo ?? "",
    carriage: String(invoice.carriage || 0),
    lines: lines.map((line) => isTextLine(line)
      ? { description: line.description, qty: "0", unit: "0.00", vat: toVatChoice(line.vatPct, line.vatExempt), text: true }
      : { description: line.description, qty: String(line.quantity), unit: line.unitPrice.toFixed(2), vat: toVatChoice(line.vatPct, line.vatExempt) }),
    ...(invoice.invoiceNote === undefined ? {} : { invoiceNote: invoice.invoiceNote ?? "" }),
    ...(invoice.deliveryAddress === undefined ? {} : { deliveryAddress: invoice.deliveryAddress ?? "" }),
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const QTY = /^\d+(\.\d{1,3})?$/;
const MONEY = /^\d+(\.\d{1,2})?$/;

const lineQty = (line: DraftLine) => (line.text ? 0 : Number(line.qty) || 0);
const lineUnit = (line: DraftLine) => (line.text ? 0 : Number(line.unit) || 0);

/** Totals for the form as it stands (for the preview); lines that aren't numbers yet count as 0, text lines always do. */
export function draftTotals(form: DraftForm, vat: DraftVatSettings): DocumentTotals {
  return documentTotals(
    form.lines.map((line) => ({ quantity: lineQty(line), unitPrice: lineUnit(line), ...fromVatChoice(line.vat) })),
    Number(form.carriage) || 0,
    { vatEnabled: vat.vatEnabled && vat.registered, carriageVat: vat.carriageVat, standardRate: vat.standardRate },
  );
}

/** What replace_draft_invoice is sent, or why the form can't be saved yet. */
export function buildDraftReplace(form: DraftForm, vat: DraftVatSettings, options: DraftOptions = {}): { ok: true; value: DraftReplace } | { ok: false; error: string } {
  if (!form.lines.length) return { ok: false, error: "Keep at least one line. If nothing is to be billed, delete the draft instead." };
  for (const [index, line] of form.lines.entries()) {
    const n = index + 1;
    if (line.text) {
      if (!options.textLines) return { ok: false, error: `Line ${n}: text-only lines need a database update that hasn't been applied yet.` };
      if (!line.description.trim()) return { ok: false, error: `Line ${n} is a text line: type its text.` };
      continue;
    }
    if (!line.description.trim()) return { ok: false, error: `Line ${n} needs a description.` };
    if (!QTY.test(line.qty.trim()) || Number(line.qty) <= 0) return { ok: false, error: `Line ${n}: the quantity must be more than 0, with at most 3 decimal places.` };
    if (!MONEY.test(line.unit.trim())) return { ok: false, error: `Line ${n}: the price must be in pounds and pence and not negative.` };
  }
  if (!form.lines.some((line) => !line.text)) return { ok: false, error: "Keep at least one priced line. If nothing is to be billed, delete the draft instead." };
  if (!MONEY.test(form.carriage.trim() || "0")) return { ok: false, error: "Carriage must be in pounds and pence and not negative." };
  if (!DATE.test(form.invoiceDate) || !DATE.test(form.dueDate)) return { ok: false, error: "Give the invoice date and the due date." };
  if (form.dueDate < form.invoiceDate) return { ok: false, error: "The due date can't be before the invoice date." };
  if (form.terms.length > 200) return { ok: false, error: "Terms are at most 200 characters." };
  if (form.customerPo.length > 100) return { ok: false, error: "The customer PO is at most 100 characters." };
  if (form.invoiceNote !== undefined) {
    const problem = invoiceNoteProblem(form.invoiceNote);
    if (problem) return { ok: false, error: problem };
  }
  if (form.deliveryAddress !== undefined) {
    const problem = deliveryAddressProblem(form.deliveryAddress);
    if (problem) return { ok: false, error: problem };
  }

  const lines = form.lines.map((line) => {
    const rate = fromVatChoice(line.vat);
    return { description: line.description.trim(), quantity: lineQty(line), unit_price: lineUnit(line), vat_pct: rate.vatPct, vat_exempt: rate.vatExempt };
  });
  const totals = draftTotals(form, vat);
  // The header's one-line summary (what the database has always taken as sent): the first priced line.
  const first = lines.find((line) => line.quantity > 0) ?? lines[0];
  return {
    ok: true,
    value: {
      header: {
        description: first.description, quantity: first.quantity, unit_price: first.unit_price,
        subtotal: totals.subtotal, vat: totals.vat, total: totals.total, carriage: totals.carriage,
        invoice_date: form.invoiceDate, due_date: form.dueDate, terms: form.terms.trim(), customer_po: form.customerPo.trim(),
        ...(form.invoiceNote === undefined ? {} : { invoice_note: form.invoiceNote.trim() }),
        ...(form.deliveryAddress === undefined ? {} : { delivery_address: form.deliveryAddress.trim() }),
      },
      lines,
      totals,
    },
  };
}
