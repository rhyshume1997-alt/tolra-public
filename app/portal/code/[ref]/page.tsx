import { PortalFrame } from "@/components/portal/portal-frame";
import { portalGate } from "@/components/portal/portal-data";
import { RefusalView } from "@/components/portal/refusal-view";

/**
 * BOUNDARY: /portal/code/[ref] (path = PORTAL_CODE_PATH). Flag first. This GET makes NO database call and reads no cookie, so a mail
 * scanner opening the e-mailed link uses nothing up: the code is typed into a form that POSTs to /api/portal/signin/verify.
 * The ref is only echoed into a hidden field after a shape check; the database decides whether it is any good.
 */
export const dynamic = "force-dynamic";
const REF_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

export default async function PortalCodePage({ params }: { params: Promise<{ ref: string }> }) {
  portalGate();
  const { ref } = await params;
  if (!REF_SHAPE.test(ref)) return <RefusalView />;
  return (
    <PortalFrame title="Enter your sign-in code">
      <form method="post" action="/api/portal/signin/verify" className="space-y-3" data-testid="portal-code-form">
        <input type="hidden" name="ref" value={ref} />
        <label className="block text-sm font-medium" htmlFor="portal-code">8-digit code from the e-mail</label>
        <input id="portal-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" maxLength={8} required className="w-full rounded border border-slate-300 px-3 py-2" />
        <button type="submit" className="rounded bg-slate-900 px-4 py-2 text-white">Sign in</button>
      </form>
    </PortalFrame>
  );
}
