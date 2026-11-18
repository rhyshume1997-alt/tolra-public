import { notFound } from "next/navigation";

import { JobsTable } from "@/components/portal/jobs-table";
import { PortalFrame } from "@/components/portal/portal-frame";
import { hasPermission, portalSession } from "@/components/portal/portal-data";
import { RefusalView } from "@/components/portal/refusal-view";
import { listPortalJobs } from "@/lib/portal/server";

/** BOUNDARY: /portal/jobs. Flag first, then the session. 404 without the "jobs" permission. Any refusal shows the generic refusal and the sign-in form. */
export const dynamic = "force-dynamic";

export default async function PortalJobsPage() {
  const got = await portalSession();
  if (!got) return <RefusalView />;
  if (!hasPermission(got.session, "jobs")) notFound();
  const result = await listPortalJobs(got.token);
  if (!result.ok) return <RefusalView />;
  return (
    <PortalFrame title="Jobs" signedIn={got.session}>
      <JobsTable jobs={result.data} />
    </PortalFrame>
  );
}
