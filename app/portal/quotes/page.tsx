import { notFound } from "next/navigation";

import { QuotesTable } from "@/components/portal/quotes-table";
import { PortalFrame } from "@/components/portal/portal-frame";
import { hasPermission, portalSession } from "@/components/portal/portal-data";
import { RefusalView } from "@/components/portal/refusal-view";
import { listPortalQuotes } from "@/lib/portal/server";

/** BOUNDARY: /portal/quotes. Flag first, then the session. 404 without the "quotes" permission. Any refusal shows the generic refusal and the sign-in form. */
export const dynamic = "force-dynamic";

export default async function PortalQuotesPage() {
  const got = await portalSession();
  if (!got) return <RefusalView />;
  if (!hasPermission(got.session, "quotes")) notFound();
  const result = await listPortalQuotes(got.token);
  if (!result.ok) return <RefusalView />;
  return (
    <PortalFrame title="Quotes" signedIn={got.session}>
      <QuotesTable quotes={result.data} />
    </PortalFrame>
  );
}
