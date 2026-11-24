/** Invoicing presentation. Receives the real screen actions and panels from the route. */
import type { ReactNode } from "react";
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
