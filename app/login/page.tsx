import { Suspense } from "react";
import { headers } from "next/headers";

import { LoginForm } from "@/app/login/login-form";
import { loginBranding, loginSlug } from "@/lib/server/branding";

/**
 * The sign-in page. The company's branding is chosen here, on the server, so the first paint already shows it (no switch from the
 * product page a moment later): ?org, else the company subdomain (lib/server/branding.ts). Plain /login is always neutral.
 * Only an active company with branded sign-in on is shown for an explicit company URL.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const org = typeof params.org === "string" ? params.org : Array.isArray(params.org) ? params.org[0] : null;
  const host = (await headers()).get("host");
  const branding = await loginBranding(loginSlug({ org, host }));
  return (
    <Suspense fallback={null}>
      <LoginForm initialBranding={branding} />
    </Suspense>
  );
}
