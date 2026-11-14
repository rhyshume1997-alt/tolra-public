/**
 * BOUNDARY: server gate for /reports (operations reports). Input: the company switch and role (lib/reports/server-switch). Output: the off
 * notice, or the page. When off, {children} is never rendered, so no report loader mounts and no report data is read.
 * Must not change: this is outside the revenue route (it has its own switch); no data reads here; topbar and titles live in the parent layout.
 */
import { REPORTS_OFF_NOTICE } from "@/lib/reports/reports-switch";
import { reportsEnabledForCompany } from "@/lib/reports/server-switch";

export default async function ReportsOperationsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  if (!(await reportsEnabledForCompany())) return <p className="text-sm text-slate-500" data-testid="reports-off">{REPORTS_OFF_NOTICE}</p>;
  return <>{children}</>;
}
