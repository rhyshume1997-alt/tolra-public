/** Dashboard presentation. Existing role-specific sections supply their own data, actions and fallback states. */
import type { ReactNode } from "react";

import { PageHeader, premiumTokens } from "@/components/ui/premium";

import styles from "./dashboard-redesign.module.css";

export function DashboardRedesign({ description, actions, children }: {
  description: string;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`${premiumTokens} ${styles.dashboard}`} data-testid="dashboard-v2">
      <PageHeader title="Dashboard" description={description} actions={actions} />
      {children}
    </div>
  );
}
