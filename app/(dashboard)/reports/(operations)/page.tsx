"use client";

/**
 * Reports page (admin and office, off by default). Inputs: the company's switch (organization_settings.hidden_nav marker "reports:on") and the
 * signed-in role. Output: the switch-off notice, or the reports (components/reports/reports-view). Reads nothing while the switch is off.
 * Must not change: no data is read or written here; the role list and the notice text.
 */
import { RoleGate } from "@/components/role-gate";
import { ReportsView } from "@/components/reports/reports-view";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrgSettings } from "@/lib/org-settings";
import { REPORTS_OFF_NOTICE, reportsEnabled } from "@/lib/reports/reports-switch";

function ReportsBody() {
  const { hiddenNav, loaded } = useOrgSettings();
  if (!loaded) return <Skeleton className="h-80" />;
  if (!reportsEnabled(hiddenNav)) return <p className="text-sm text-slate-500">{REPORTS_OFF_NOTICE}</p>;
  return <ReportsView />;
}

export default function ReportsPage() {
  return (
    <RoleGate allowed={["admin", "office"]}>
      <ReportsBody />
    </RoleGate>
  );
}
