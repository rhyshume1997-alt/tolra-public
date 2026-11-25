/** Integrations layout. Children are the live, permission-checked admin controls. */
import type { ReactNode } from "react";
import { PageHeader, premiumTokens } from "@/components/ui/premium";

export function AdminIntegrationsRedesign({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return (
    <div className={`${premiumTokens} min-w-0 space-y-4 [&_[data-slot=card]]:rounded-[14px]`} data-testid="admin-integrations-v2">
      <PageHeader title="Integrations" description="Connect AI, Xero and email. Each integration has its own setup and switch." actions={actions} />
      {children}
    </div>
  );
}
