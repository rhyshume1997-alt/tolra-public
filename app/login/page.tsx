import { Suspense } from "react";
import { cookies, headers } from "next/headers";

import { LoginForm } from "@/app/login/login-form";
import { BRAND_COOKIE, loginBranding, loginSlug } from "@/lib/server/branding";

/**
 * The sign-in page. The company's branding is chosen here, on the server, so the first paint already shows it (no switch from the
 * product page a moment later): ?org, else the company subdomain, else this device's brand cookie (lib/server/branding.ts). The
 * cookie is only a hint: the slug is looked up again like any ?org, and only an active company with branded sign-in on is shown.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const org = typeof params.org === "string" ? params.org : Array.isArray(params.org) ? params.org[0] : null;
  const host = (await headers()).get("host");
  const cookie = (await cookies()).get(BRAND_COOKIE)?.value ?? null;
  const branding = await loginBranding(loginSlug({ org, host, cookie }));
  return (
    <Suspense fallback={null}>
      <LoginForm initialBranding={branding} />
    </Suspense>
  );
}
