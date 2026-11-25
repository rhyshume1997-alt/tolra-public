/** Security layout. Children are the live, permission-checked admin controls. */
import type { ReactNode } from "react";
import { PageHeader, premiumTokens } from "@/components/ui/premium";

export function ComplianceRedesign({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return (
    <div className={`${premiumTokens} min-w-0 space-y-4 [&_[data-slot=card]]:rounded-[14px]`} data-testid="admin-security-v2">
      <PageHeader title="Security" description="How Tolra protects your company’s records." actions={actions} />
      {children}
    </div>
  );
}
