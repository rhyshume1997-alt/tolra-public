"use client";

import { StatusBadge } from "@/components/status-badge";
import { fmtDate } from "@/lib/dates";
import { shownInvoiceRef } from "@/lib/invoice-ref";
import { type CompactInvoiceFigures, compactInvoiceTotals, netAndVat } from "@/lib/invoice-list-totals";
import { gbp } from "@/lib/money";
import { invoiceStatusKey } from "@/lib/status-colours";

/** The fields of an Invoices list row this table reads; the page's rows satisfy it as they are. */
export type CompactInvoice = CompactInvoiceFigures & {
  id?: string;
  reference: string;
  unnumbered?: boolean;
  customer: string;
  date?: string;
  dueDate?: string;
  rawStatus: string;
  status: "overdue" | "outstanding" | "paid" | "closed" | "unverified";
  daysOverdue: number;
  partPaid: boolean;
};

function statusLabel(invoice: CompactInvoice): string {
  if (invoice.status === "paid") return "PAID";
  if (invoice.status === "unverified") return "PAYMENT TO CONFIRM";
  if (invoice.status === "closed") return invoice.rawStatus.toUpperCase();
  if (invoice.partPaid) return "PART PAID";
  if (!invoice.dueDate) return "No due date";
  if (invoice.daysOverdue > 0) return `${invoice.daysOverdue} days overdue`;
  return invoice.daysOverdue === 0 ? "Due today" : `Due in ${Math.abs(invoice.daysOverdue)} days`;
}

const money = (value: number) => gbp(value, 2);
const NUM = "block whitespace-nowrap px-2 py-1.5 text-left tabular-nums desk:table-cell desk:text-right";
const HEAD = "whitespace-nowrap px-2 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-600 dark:text-slate-300";

/**
 * The dense, accounting-package style list of invoices: number, date, customer, net, VAT, gross, paid, outstanding, status, due date,
 * with the totals of the rows given at the foot. `rows` is the list's own filtered set. A click on a row opens that invoice. The
 * table is a table from 1025px; below that (phone and tablet) each invoice is a stacked card with its columns as labelled lines
 * (data-tablet-cards in app/globals.css), so neither it nor the page scrolls sideways.
 */
export function CompactInvoiceList<T extends CompactInvoice>({ rows, onOpen }: { rows: T[]; onOpen: (invoice: T) => void }) {
  const totals = compactInvoiceTotals(rows);
  return (
    <div data-testid="compact-invoice-list" className="w-full max-w-full overflow-x-auto rounded-lg border border-slate-200 dark:border-white/10">
      <table role="table" className="w-full border-collapse text-sm desk:min-w-[56rem]" data-tablet-cards>
        <thead role="rowgroup" className="hidden border-b border-slate-200 bg-slate-50 desk:table-header-group dark:border-white/10 dark:bg-white/5">
          <tr role="row">
            <th role="columnheader" scope="col" className={HEAD}>Invoice</th>
            <th role="columnheader" scope="col" className={HEAD}>Date</th>
            <th role="columnheader" scope="col" className={HEAD}>Customer</th>
            <th role="columnheader" scope="col" className={`${HEAD} text-right`}>Net</th>
            <th role="columnheader" scope="col" className={`${HEAD} text-right`}>VAT</th>
            <th role="columnheader" scope="col" className={`${HEAD} text-right`}>Gross</th>
            <th role="columnheader" scope="col" className={`${HEAD} text-right`}>Paid</th>
            <th role="columnheader" scope="col" className={`${HEAD} text-right`}>Outstanding</th>
            <th role="columnheader" scope="col" className={HEAD}>Status</th>
            <th role="columnheader" scope="col" className={HEAD}>Due</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((invoice) => {
            const { net, vat } = netAndVat(invoice);
            return (
              <tr
                role="row"
                key={invoice.id ?? invoice.reference}
                data-testid="compact-invoice-row"
                onClick={() => onOpen(invoice)}
                className={`block cursor-pointer border-b border-slate-100 desk:table-row hover:bg-slate-50 dark:border-white/5 dark:hover:bg-white/5 ${invoice.status === "paid" ? "opacity-60" : ""}`}
              >
                <td role="cell" className="block whitespace-nowrap px-2 py-1.5 font-mono font-semibold desk:table-cell">
                  <button type="button" className="text-left underline-offset-2 hover:underline focus-visible:underline" aria-label={`Open ${shownInvoiceRef(invoice)}`}>{shownInvoiceRef(invoice)}</button>
                </td>
                <td role="cell" data-label="Date" className="block whitespace-nowrap px-2 py-1.5 desk:table-cell">{fmtDate(invoice.date)}</td>
                <td role="cell" data-label="Customer" className="block max-w-[16rem] truncate px-2 py-1.5 desk:table-cell">{invoice.customer}</td>
                <td role="cell" data-label="Net" className={NUM}>{money(net)}</td>
                <td role="cell" data-label="VAT" className={NUM}>{money(vat)}</td>
                <td role="cell" data-label="Gross" className={`${NUM} font-semibold`}>{money(invoice.amount)}</td>
                <td role="cell" data-label="Paid" className={NUM}>{money(invoice.amountPaid)}</td>
                <td role="cell" data-label="Outstanding" className={`${NUM} font-semibold`}>{money(invoice.balance)}</td>
                <td role="cell" data-label="Status" className="block whitespace-nowrap px-2 py-1.5 desk:table-cell"><StatusBadge status={invoiceStatusKey(invoice)} unmapped={{ variant: "outline" }} label={statusLabel(invoice)} /></td>
                <td role="cell" data-label="Due" className="block whitespace-nowrap px-2 py-1.5 desk:table-cell">{fmtDate(invoice.dueDate)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot role="rowgroup" className="block border-t-2 border-slate-300 bg-slate-50 font-semibold desk:table-footer-group dark:border-white/20 dark:bg-white/5" data-testid="compact-invoice-totals">
          <tr role="row" className="block desk:table-row">
            <td role="cell" className="block whitespace-nowrap px-2 py-2 desk:table-cell" colSpan={3}>Totals ({totals.count} invoice{totals.count === 1 ? "" : "s"})</td>
            <td role="cell" data-label="Net" className={NUM} data-total="net">{money(totals.net)}</td>
            <td role="cell" data-label="VAT" className={NUM} data-total="vat">{money(totals.vat)}</td>
            <td role="cell" data-label="Gross" className={NUM} data-total="gross">{money(totals.gross)}</td>
            <td role="cell" data-label="Paid" className={NUM} data-total="paid">{money(totals.paid)}</td>
            <td role="cell" data-label="Outstanding" className={NUM} data-total="outstanding">{money(totals.outstanding)}</td>
            <td role="cell" colSpan={2} className="hidden desk:table-cell" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
