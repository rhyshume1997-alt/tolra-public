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
const NUM = "whitespace-nowrap px-2 py-1.5 text-right tabular-nums";
const HEAD = "whitespace-nowrap px-2 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-600 dark:text-slate-300";

/**
 * The dense, accounting-package style list of invoices: number, date, customer, net, VAT, gross, paid, outstanding, status, due date,
 * with the totals of the rows given at the foot. `rows` is the list's own filtered set. A click on a row opens that invoice. The
 * table scrolls sideways inside its own box on a phone; the page does not.
 */
export function CompactInvoiceList<T extends CompactInvoice>({ rows, onOpen }: { rows: T[]; onOpen: (invoice: T) => void }) {
  const totals = compactInvoiceTotals(rows);
  return (
    <div data-testid="compact-invoice-list" className="w-full max-w-full overflow-x-auto rounded-lg border border-slate-200 dark:border-white/10">
      <table className="w-full min-w-[56rem] border-collapse text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/5">
          <tr>
            <th scope="col" className={HEAD}>Invoice</th>
            <th scope="col" className={HEAD}>Date</th>
            <th scope="col" className={HEAD}>Customer</th>
            <th scope="col" className={`${HEAD} text-right`}>Net</th>
            <th scope="col" className={`${HEAD} text-right`}>VAT</th>
            <th scope="col" className={`${HEAD} text-right`}>Gross</th>
            <th scope="col" className={`${HEAD} text-right`}>Paid</th>
            <th scope="col" className={`${HEAD} text-right`}>Outstanding</th>
            <th scope="col" className={HEAD}>Status</th>
            <th scope="col" className={HEAD}>Due</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((invoice) => {
            const { net, vat } = netAndVat(invoice);
            return (
              <tr
                key={invoice.id ?? invoice.reference}
                data-testid="compact-invoice-row"
                onClick={() => onOpen(invoice)}
                className={`cursor-pointer border-b border-slate-100 hover:bg-slate-50 dark:border-white/5 dark:hover:bg-white/5 ${invoice.status === "paid" ? "opacity-60" : ""}`}
              >
                <td className="whitespace-nowrap px-2 py-1.5 font-mono font-semibold">
                  <button type="button" className="text-left underline-offset-2 hover:underline focus-visible:underline" aria-label={`Open ${shownInvoiceRef(invoice)}`}>{shownInvoiceRef(invoice)}</button>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5">{fmtDate(invoice.date)}</td>
                <td className="max-w-[16rem] truncate px-2 py-1.5">{invoice.customer}</td>
                <td className={NUM}>{money(net)}</td>
                <td className={NUM}>{money(vat)}</td>
                <td className={`${NUM} font-semibold`}>{money(invoice.amount)}</td>
                <td className={NUM}>{money(invoice.amountPaid)}</td>
                <td className={`${NUM} font-semibold`}>{money(invoice.balance)}</td>
                <td className="whitespace-nowrap px-2 py-1.5"><StatusBadge status={invoiceStatusKey(invoice)} unmapped={{ variant: "outline" }} label={statusLabel(invoice)} /></td>
                <td className="whitespace-nowrap px-2 py-1.5">{fmtDate(invoice.dueDate)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-semibold dark:border-white/20 dark:bg-white/5" data-testid="compact-invoice-totals">
          <tr>
            <td className="whitespace-nowrap px-2 py-2" colSpan={3}>Totals ({totals.count} invoice{totals.count === 1 ? "" : "s"})</td>
            <td className={NUM} data-total="net">{money(totals.net)}</td>
            <td className={NUM} data-total="vat">{money(totals.vat)}</td>
            <td className={NUM} data-total="gross">{money(totals.gross)}</td>
            <td className={NUM} data-total="paid">{money(totals.paid)}</td>
            <td className={NUM} data-total="outstanding">{money(totals.outstanding)}</td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
