/** Quote Generator presentation. Receives the real screen actions and panels from the route. */
import type { ReactNode } from "react";
import { PageHeader, premiumTokens } from "@/components/ui/premium";

export interface QuotesViewProps {
  actions: ReactNode;
  legacyHeader: ReactNode;
  children: ReactNode;
}

export function QuotesRedesign({ actions, children }: QuotesViewProps) {
  return (
    <div className={`${premiumTokens} min-w-0 space-y-4 [&_[data-slot=card]]:rounded-[14px]`} data-testid="quotes-v2">
      <PageHeader title="Quote Generator" description="A quote is the price we offer a customer. Make, send and follow up quotes here." actions={actions} />
      {children}
    </div>
  );
}
