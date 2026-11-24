/** Job Board presentation. Receives the real screen actions and panels from the route. */
import type { ReactNode } from "react";
import { PageHeader, Popover, premiumTokens } from "@/components/ui/premium";

export interface JobsViewProps {
  actions: ReactNode;
  legacyHeader: ReactNode;
  children: ReactNode;
}

export function JobsRedesign({ actions, children }: JobsViewProps) {
  return (
    <div className={`${premiumTokens} min-w-0 space-y-4 [&_[data-slot=card]]:rounded-[14px]`} data-testid="jobs-v2">
      <PageHeader title="Job Board" description="Jobs are the work in the workshop. Follow each one from start to finish." actions={actions} />
      {children}
    </div>
  );
}


export function JobsSecondaryFilters({ count, children }: { count: number; children: ReactNode }) {
  return (
    <Popover label={count ? `Filters (${count})` : "Filters"} title="Job filters">
      <div className="min-w-0 space-y-3">{children}</div>
    </Popover>
  );
}
