import { PortalFrame } from "@/components/portal/portal-frame";
import { portalGate } from "@/components/portal/portal-data";
import { SigninForm } from "@/components/portal/signin-form";

/** BOUNDARY: /portal/signin. Flag first; no database call. Posts to /api/portal/signin/request. */
export const dynamic = "force-dynamic";

export default function PortalSigninPage() {
  portalGate();
  return (
    <PortalFrame title="Sign in to the customer portal">
      <p className="mb-4">Enter your e-mail address and we will send you a sign-in link and code.</p>
      <SigninForm />
    </PortalFrame>
  );
}
