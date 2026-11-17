import type { PortalJob } from "@/lib/portal/types";
import { portalDate } from "./format";

/** BOUNDARY: components/portal/jobs-table.tsx (server component). Input: the contact's jobs. Output: a read-only table of the 3 stages. */
const STAGE: Record<PortalJob["stage"], string> = { not_started: "Not started", in_progress: "In progress", complete: "Complete" };

export function JobsTable({ jobs }: { jobs: PortalJob[] }) {
  if (jobs.length === 0) return <p data-testid="portal-jobs-empty">No jobs to show.</p>;
  return (
    <table className="w-full text-left text-sm" data-testid="portal-jobs">
      <thead><tr><th>Job</th><th>Your PO</th><th>Due</th><th>Stage</th></tr></thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.jobNo}><td>{j.jobNo}</td><td>{j.customerPo ?? "-"}</td><td>{portalDate(j.dueDate)}</td><td>{STAGE[j.stage]}</td></tr>
        ))}
      </tbody>
    </table>
  );
}
