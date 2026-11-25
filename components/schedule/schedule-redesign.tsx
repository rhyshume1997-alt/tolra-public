/** Machine Schedule presentation. Receives the real screen actions and panels from the route; owns no data, handlers or permissions. */
import type { ReactNode } from "react";
import { PageHeader, premiumTokens } from "@/components/ui/premium";
import { useCompanyUiSwitch } from "@/lib/use-company-ui-switch";

export interface ScheduleViewProps {
  actions: ReactNode;
  legacyTitle: ReactNode;
  children: ReactNode;
}

function LegacyScheduleView({ actions, legacyTitle, children }: ScheduleViewProps) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        {legacyTitle}
        {actions}
      </div>
      {children}
    </div>
  );
}

function ScheduleRedesign({ actions, children }: ScheduleViewProps) {
  return (
    <div className={`${premiumTokens} min-w-0 space-y-4 [&_[data-slot=card]]:rounded-[14px]`} data-testid="schedule-v2">
      <PageHeader title="Machine Schedule" description="Book jobs onto machines and see when each machine is free." actions={actions} />
      {children}
    </div>
  );
}

/** Picks the presentation from the company switch ui-schedule-v2:on (default OFF = legacy). */
export function ScheduleView(props: ScheduleViewProps) {
  const redesign = useCompanyUiSwitch("ui-schedule-v2:on");
  return redesign ? <ScheduleRedesign {...props} /> : <LegacyScheduleView {...props} />;
}

/** Load and live-use error banners, unchanged markup; retry handlers come from the route. */
export function ScheduleBanners({ error, liveError, onRetry, onRetryLive }: { error: string | null; liveError: string | null; onRetry: () => void; onRetryLive: () => void }) {
  return (
    <>
      {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error} <button onClick={onRetry} className="font-semibold underline">Retry</button></div> : null}
      {liveError && !error ? <div role="alert" data-testid="schedule-live-error" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Live machine use may be out of date. {liveError} <button onClick={onRetryLive} className="font-semibold underline">Retry</button></div> : null}
    </>
  );
}
