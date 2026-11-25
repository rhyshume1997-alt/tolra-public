/** User Management layout. Children are the live, permission-checked admin controls. */
import type { ReactNode } from "react";
import { PageHeader, premiumTokens } from "@/components/ui/premium";

export function UsersRedesign({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return (
    <div className={`${premiumTokens} min-w-0 space-y-4 [&_[data-slot=card]]:rounded-[14px]`} data-testid="admin-users-v2">
      <PageHeader title="User Management" description="Add people, choose what they can open and manage their passwords." actions={actions} />
      {children}
    </div>
  );
}
