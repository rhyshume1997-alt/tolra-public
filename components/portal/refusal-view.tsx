import { PORTAL_REFUSAL_MESSAGE, PORTAL_REFUSAL_TITLE } from "@/lib/portal/refusal";
import { PortalFrame } from "./portal-frame";
import { SigninForm } from "./signin-form";

/**
 * BOUNDARY: components/portal/refusal-view.tsx (server component). No inputs. Output: the ONE generic refusal text plus the sign-in
 * form, for every refusal (no session, expired, switched off for the contact, bad code). Must not vary by reason or show any detail.
 */
export function RefusalView() {
  return (
    <PortalFrame title={PORTAL_REFUSAL_TITLE}>
      <p className="mb-6" data-testid="portal-refusal">{PORTAL_REFUSAL_MESSAGE}</p>
      <SigninForm />
    </PortalFrame>
  );
}
