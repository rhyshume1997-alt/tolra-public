/**
 * Reports > Revenue (stage 1): read-only, off by default (lib/reports/revenue/revenue-switch), admin and office only.
 * Inputs: none (no address parameters; the filters live in React state in the view). Output: the Revenue report.
 * Must not change: the RoleGate roles, or logic here; it stays a thin shell around components/reports/revenue/revenue-view.
 */
import { RevenueView } from "@/components/reports/revenue/revenue-view";
import { RoleGate } from "@/components/role-gate";

export default function RevenueReportPage() {
  return (
    <RoleGate allowed={["admin", "office"]}>
      <RevenueView />
    </RoleGate>
  );
}
