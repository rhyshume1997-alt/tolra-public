import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";

import { LoginTooly } from "@/components/marketing/login-tooly";
import { BRAND_COOKIE, loginSlug } from "@/lib/server/branding";

/**
 * Presentational wrapper for the sign-in page. Inputs: the page (children), and the host and brand cookie, read only to tell whether
 * any company brand could apply. Output: the page unchanged, plus a decorative Tooly beside it on the neutral Tolra page.
 * Must not change: it renders `children` exactly as given and adds nothing to the form, the auth flow, the middleware or any route; the
 * page itself (app/login/page.tsx, which chooses the branding on the server) is untouched.
 */
export default async function LoginLayout({ children }: { children: ReactNode }) {
  const neutral = loginSlug({ org: null, host: (await headers()).get("host"), cookie: (await cookies()).get(BRAND_COOKIE)?.value ?? null }) === null;
  return (
    <>
      {children}
      <LoginTooly neutral={neutral} />
    </>
  );
}
