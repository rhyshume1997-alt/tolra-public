/**
 * BOUNDARY: server gate for /reports/revenue. Input: the company switch and role (lib/reports/server-switch). Output: the off notice, or the page.
 * When off, {children} is never rendered, so no revenue loader mounts and no invoice, payment or quote data is read.
 * Must not change: no data reads here; the notice and test id match what the page already shows; topbar and titles live in the parent layout.
 */
import { REVENUE_OFF_NOTICE } from "@/lib/reports/revenue/revenue-switch";
import { revenueEnabledForCompany } from "@/lib/reports/server-switch";

export default async function RevenueLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  if (!(await revenueEnabledForCompany())) return <p className="text-sm text-slate-500" data-testid="revenue-off">{REVENUE_OFF_NOTICE}</p>;
  return <>{children}</>;
}
