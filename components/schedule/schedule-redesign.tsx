/** Machine Schedule presentation. Receives the real screen actions and panels from the route. */
import type { ReactNode } from "react";
import { PageHeader, premiumTokens } from "@/components/ui/premium";

export interface ScheduleViewProps {
  actions: ReactNode;
  legacyHeader: ReactNode;
  children: ReactNode;
}

export function ScheduleRedesign({ actions, children }: ScheduleViewProps) {
  return (
    <div className={`${premiumTokens} min-w-0 space-y-4 [&_[data-slot=card]]:rounded-[14px]`} data-testid="schedule-v2">
      <PageHeader title="Machine Schedule" description="Book jobs onto machines and see when each machine is free." actions={actions} />
      {children}
    </div>
  );
}
