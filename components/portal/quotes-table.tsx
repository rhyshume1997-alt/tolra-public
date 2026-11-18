import { gbp } from "@/lib/money";
import type { PortalQuote } from "@/lib/portal/types";
import { portalDate } from "./format";

/** BOUNDARY: components/portal/quotes-table.tsx (server component). Input: the contact's quotes. Output: a read-only table. Money via lib/money.ts. */
const STATUS: Record<PortalQuote["status"], string> = { sent: "Awaiting your answer", accepted: "Accepted", rejected: "Declined" };

export function QuotesTable({ quotes }: { quotes: PortalQuote[] }) {
  if (quotes.length === 0) return <p data-testid="portal-quotes-empty">No quotes to show.</p>;
  return (
    <table className="w-full text-left text-sm" data-testid="portal-quotes">
      <thead><tr><th>Quote</th><th>Status</th><th>Sent</th><th>Valid until</th><th>Your PO</th><th className="text-right">Total</th></tr></thead>
      <tbody>
        {quotes.map((q) => (
          <tr key={q.quoteRef}>
            <td>{q.quoteRef}</td><td>{STATUS[q.status]}</td><td>{portalDate(q.sentAt)}</td><td>{portalDate(q.validUntil)}</td><td>{q.customerPo ?? "-"}</td>
            <td className="text-right">{q.totalValue === null ? "-" : gbp(q.totalValue)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
