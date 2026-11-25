/** Invoicing presentation. Receives the real screen actions and panels from the route. */
import type { ReactNode } from "react";
import { DRAFT_INVOICE_DAYS } from "@/lib/attention-items";
import { gbp } from "@/lib/money";
import { PageHeader, premiumTokens } from "@/components/ui/premium";

export interface InvoicesViewProps {
  actions: ReactNode;
  legacyHeader: ReactNode;
  notices?: ReactNode;
  children: ReactNode;
}

export function InvoicesRedesign({ actions, children, notices }: InvoicesViewProps) {
  return (
    <div className={`${premiumTokens} min-w-0 space-y-4 [&_[data-slot=card]]:rounded-[14px]`} data-testid="invoices-v2">
      <PageHeader title="Invoicing" description="Invoices are what customers owe us. See what is unpaid and chase it." actions={actions} />
      {notices}
      {children}
    </div>
  );
}

/** Drafts-waiting and customer-credit notices (shown under the title in both layouts). */
export function InvoiceNotices({ draftsWaiting, oldDrafts, creditHeld }: { draftsWaiting: number; oldDrafts: number; creditHeld: { total: number; customers: number } }) {
  return (
    <>
      {draftsWaiting > 0 ? <p className="mt-1 text-sm font-medium text-ink" data-testid="drafts-waiting" title={`${oldDrafts} over ${DRAFT_INVOICE_DAYS} days old (what the dashboard counts). A draft has no number and isn't owed until a person issues it.`}>Drafts waiting to issue: {draftsWaiting}</p> : null}
      {creditHeld.total > 0 ? <p className="mt-1 text-sm font-medium text-amber-800" data-testid="customer-credit-held" title="Open an invoice with credit to refund it or apply it to another invoice.">Customer credit held: {gbp(creditHeld.total, 2)} for {creditHeld.customers} customer{creditHeld.customers === 1 ? "" : "s"}</p> : null}
    </>
  );
}

/** The existing (OFF) layout: the legacy header above the page content. */
export function LegacyInvoicesView({ legacyHeader, children }: InvoicesViewProps) {
  return <div className="space-y-6">{legacyHeader}{children}</div>;
}

/** Ageing buckets for the unpaid-invoice summary (label, colour, days-overdue test). */
export const AGING = [
  { label: "Current", color: "text-blue-700", test: (days: number) => days <= 0 },
  { label: "1-30 days late", color: "text-amber-700", test: (days: number) => days >= 1 && days <= 30 },
  { label: "31-60 days late", color: "text-orange-700", test: (days: number) => days >= 31 && days <= 60 },
  { label: "60+ days late", color: "text-red-700", test: (days: number) => days > 60 },
];
