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
 *
 * With migration 099 a line made from a delivery note bills an order line (its link, `orderLine`), and a draft may bill no more of an
 * order line than was despatched and is not on another invoice. The editor reads each linked line's balance (draft_invoice_balances),
 * sends every line's link back (null for a line typed by hand), and refuses more than the balance here; the database refuses it again.
 */
import { deliveryAddressProblem, invoiceNoteProblem } from "@/lib/invoice-fields";
import { documentTotals, isTextLine, type DocumentTotals } from "@/lib/money";
import { fromVatChoice, toVatChoice, type VatChoice } from "@/lib/vat";

/** `text`: a £0 text-only line (073); its quantity and price are 0 whatever the fields say. */
export type DraftLine = { description: string; qty: string; unit: string; vat: VatChoice; text?: boolean; /** 099: the order line it bills. */ orderLine?: string };
export type DraftForm = {
  invoiceDate: string; dueDate: string; terms: string; customerPo: string; carriage: string; lines: DraftLine[];
  /** undefined: not offered (the database has no such column yet). */
  invoiceNote?: string;
  deliveryAddress?: string;
};
/** The invoice's own VAT settings and the company's, as the totals are worked out with them. */
export type DraftVatSettings = { vatEnabled: boolean; carriageVat: boolean; registered: boolean; standardRate: number };
export type StoredLine = { description: string; quantity: number; unitPrice: number; vatPct: number; vatExempt?: boolean; salesOrderLineId?: string | null };
/** 099: an order line's balance as this draft sees it. `available` is the most this draft may bill of it (despatched less other invoices). */
export type LineBalance = { ordered: number; despatched: number; onOtherInvoices: number; available: number };
/**
 * What the database supports: £0 text-only lines (073); order-line links (099: every line is sent with its link, and `balances`, by
 * order line, holds the quantities to the balance).
 */
export type DraftOptions = { textLines?: boolean; links?: boolean; balances?: ReadonlyMap<string, LineBalance> };

export type DraftReplace = {
  header: {
    description: string; quantity: number; unit_price: number; subtotal: number; vat: number; total: number; carriage: number; invoice_date: string; due_date: string; terms: string; customer_po: string;
    invoice_note?: string; delivery_address?: string;
  };
  lines: Array<{ description: string; quantity: number; unit_price: number; vat_pct: number; vat_exempt: boolean; sales_order_line_id?: string | null }>;
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
    lines: lines.map((line) => ({
      ...(isTextLine(line)
        ? { description: line.description, qty: "0", unit: "0.00", vat: toVatChoice(line.vatPct, line.vatExempt), text: true }
        : { description: line.description, qty: String(line.quantity), unit: line.unitPrice.toFixed(2), vat: toVatChoice(line.vatPct, line.vatExempt) }),
      ...(line.salesOrderLineId ? { orderLine: line.salesOrderLineId } : {}),
    })),
    ...(invoice.invoiceNote === undefined ? {} : { invoiceNote: invoice.invoiceNote ?? "" }),
    ...(invoice.deliveryAddress === undefined ? {} : { deliveryAddress: invoice.deliveryAddress ?? "" }),
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const QTY = /^\d+(\.\d{1,3})?$/;
const MONEY = /^\d+(\.\d{1,2})?$/;

const lineQty = (line: DraftLine) => (line.text ? 0 : Number(line.qty) || 0);
const thousandths = (n: number) => Math.round(n * 1000);

/** 099: "despatched 8, 5 on other invoices: up to 3 on this draft" for a linked line. */
export function balanceText(balance: LineBalance): string {
  return `Despatched ${balance.despatched} of ${balance.ordered}, ${balance.onOtherInvoices} on other invoices: up to ${balance.available} on this draft.`;
}

/**
 * 099: while draft_invoice_balances is being read, lines can't be added or removed. Its answer is put on the lines by position (the
 * draft's stored order), so a line removed or added before it lands would shift every line after it onto another line's order link,
 * and replace_draft_invoice accepts any link of the draft's orders (the double-billing path ChatGPT and Grok found, 28 Oct).
 */
export function lineRowsLocked(linksState: string): boolean {
  return linksState === "loading";
}

/** The draft's lines without the one at `index`; unchanged while the order links are loading (lineRowsLocked). */
export function removeDraftLine(lines: DraftLine[], index: number, linksState: string): DraftLine[] {
  return lineRowsLocked(linksState) ? lines : lines.filter((_, i) => i !== index);
}

/** 099: the order links read by position (draft_invoice_balances) put on the form's lines, which are still in the stored order. */
export function linesWithLoadedLinks(lines: DraftLine[], byIndex: ReadonlyArray<string | null>): DraftLine[] {
  return lines.map((line, i) => (byIndex[i] ? { ...line, orderLine: byIndex[i] ?? undefined } : line));
}

/**
 * 099: the first line that takes more of its order line than the balance allows (the quantities of every line billing that order line
 * added together), as the message to show; null when every linked line is within its balance.
 */
export function overBalanceProblem(lines: DraftLine[], balances: ReadonlyMap<string, LineBalance> | undefined): string | null {
  if (!balances) return null;
  const used = new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    if (!line.orderLine) continue;
    const balance = balances.get(line.orderLine);
    if (!balance) continue;
    const total = (used.get(line.orderLine) ?? 0) + thousandths(lineQty(line));
    used.set(line.orderLine, total);
    if (total > thousandths(balance.available)) {
      return `Line ${index + 1}: only ${balance.available} of "${line.description.trim()}" can be billed on this draft (${balance.despatched} despatched, ${balance.onOtherInvoices} on other invoices). The rest is billed when it is despatched.`;
    }
  }
  return null;
}
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
  const over = overBalanceProblem(form.lines, options.balances);
  if (over) return { ok: false, error: over };
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
    return {
      description: line.description.trim(), quantity: lineQty(line), unit_price: lineUnit(line), vat_pct: rate.vatPct, vat_exempt: rate.vatExempt,
      ...(options.links ? { sales_order_line_id: line.orderLine ?? null } : {}),
    };
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
