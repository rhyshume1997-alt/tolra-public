import Link from "next/link";

import { PortalFrame } from "@/components/portal/portal-frame";
import { portalGate } from "@/components/portal/portal-data";

/** BOUNDARY: /portal/signin/sent. Flag first; no database call. The wording is the same whether or not the address can use the portal. */
export const dynamic = "force-dynamic";

export default function PortalSigninSentPage() {
  portalGate();
  return (
    <PortalFrame title="Check your e-mail">
      <p data-testid="portal-sent">If this address can use the portal, we&apos;ve e-mailed a link and code. They work once, for 10 minutes.</p>
      <p className="mt-4 text-sm"><Link prefetch={false} href="/portal/signin" className="underline">Back to sign in</Link></p>
    </PortalFrame>
  );
}
