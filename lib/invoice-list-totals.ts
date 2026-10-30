import { fromPence, toPence } from "@/lib/money";

/** The fields of an Invoices list row the compact list and its totals need. */
export type CompactInvoiceFigures = {
  /** Stored total, including carriage and VAT. */
  amount: number;
  /** Stored subtotal and VAT as issued; absent on demo data. */
  subtotal?: number;
  vatAmount?: number;
  /** Everything received so far. */
  amountPaid: number;
  /** Still to collect: 0 for paid, draft, void, cancelled and unconfirmed-import invoices (the list's own derive()). */
  balance: number;
};

/** The net and VAT of one invoice, in pence-exact pounds: the stored subtotal and VAT, else the total less VAT (demo data has neither: all net). */
export function netAndVat(invoice: Pick<CompactInvoiceFigures, "amount" | "subtotal" | "vatAmount">): { net: number; vat: number } {
  const vat = invoice.vatAmount ?? 0;
  const net = invoice.subtotal ?? fromPence(toPence(invoice.amount) - toPence(vat));
  return { net, vat };
}

export type CompactInvoiceTotals = { count: number; net: number; vat: number; gross: number; paid: number; outstanding: number };

/**
 * The foot of the compact list: the sums of exactly the rows given (the filtered set the list shows), added in whole pence so a long
 * column never drifts. Outstanding is each row's own balance, so void, cancelled, draft and paid invoices add nothing to it.
 */
export function compactInvoiceTotals(rows: CompactInvoiceFigures[]): CompactInvoiceTotals {
  let net = 0, vat = 0, gross = 0, paid = 0, outstanding = 0;
  for (const row of rows) {
    const split = netAndVat(row);
    net += toPence(split.net);
    vat += toPence(split.vat);
    gross += toPence(row.amount);
    paid += toPence(row.amountPaid);
    outstanding += toPence(row.balance);
  }
  return { count: rows.length, net: fromPence(net), vat: fromPence(vat), gross: fromPence(gross), paid: fromPence(paid), outstanding: fromPence(outstanding) };
}
