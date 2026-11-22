import { PortalFrame } from "@/components/portal/portal-frame";
import { portalSession } from "@/components/portal/portal-data";
import { RefusalView } from "@/components/portal/refusal-view";

/** BOUNDARY: /portal. Flag first, then the cookie session. Any refusal shows the generic refusal and the sign-in form. No other data. */
export const dynamic = "force-dynamic";

export default async function PortalHomePage() {
  const got = await portalSession();
  if (!got) return <RefusalView />;
  const { session } = got;
  return (
    <PortalFrame title={`Welcome, ${session.displayName}`} signedIn={session}>
      <p data-testid="portal-home">{session.customerName} at {session.companyName}. Use the tabs above to see your documents.</p>
    </PortalFrame>
  );
}
