"use client";

import { useColumnVisibility } from "@/lib/org-settings";
import { Card, CardContent } from "@/components/ui/card";
import { formatDayTime, type MachineStatus } from "@/lib/machine-schedule";
import { statusCardText } from "@/lib/schedule-live";
import { type InUseRow, inUseText } from "@/lib/machine-runs";
import type { UnbookedRunView } from "@/lib/run-plan";

/**
 * `inUse` (migration 044): the live run on each machine, from machines_in_use(). An open run wins over the booking-based guess: the
 * pill says "In use by Dave since 09:12" and the card never says "Free now" while a run is open (lib/schedule-live statusCardText).
 */
export function MachineStatusCards({ statuses, inUse = new Map(), now = new Date(), unbooked = new Map() }: { statuses: MachineStatus[]; inUse?: Map<string, InUseRow>; now?: Date; unbooked?: Map<string, UnbookedRunView> }) {
  const { isVisible } = useColumnVisibility("schedule");
  if (!statuses.length || !isVisible("status-cards")) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {statuses.map((s) => {
        const live = inUse.get(s.machine.id);
        const text = statusCardText(s, live, now, unbooked.get(s.machine.id));
        const red = text.inUse || s.busy;
        return (
          <Card key={s.machine.id} data-testid="machine-status" data-machine={s.machine.name} data-in-use={text.inUse ? "true" : undefined}>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-950">{s.machine.name}</p>
                  {s.machine.type && isVisible("machine-type") ? <p className="truncate text-xs text-slate-500">{s.machine.type}</p> : null}
                </div>
                <span data-testid="machine-status-pill" className={`shrink-0 rounded-none px-2.5 py-1 text-xs font-semibold ${red ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>
                  {text.pill}
                </span>
              </div>
              {live ? (
                <p data-testid="machine-in-use" className="text-sm font-medium text-red-700 dark:text-red-400">
                  IN USE: <span className="font-semibold">{live.job_no}</span>, {inUseText(live, now).replace(/^.*? by /, "by ")}
                </p>
              ) : null}
              {text.staleNote ? <p className="text-xs font-semibold text-amber-700">{text.staleNote}</p> : null}
              <p className="text-sm text-slate-700">{text.body}</p>
              {isVisible("next-free") ? <p className="text-xs text-slate-500">
                <span className="field-label">Next free:</span> <span className="font-medium text-slate-700">{text.nextFree}</span>
                {s.next ? <> · Next job {s.next.jobNo} from {formatDayTime(s.nextStart ?? s.next.start)}</> : null}
              </p> : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
