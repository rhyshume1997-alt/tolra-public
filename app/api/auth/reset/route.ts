import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { setPasswordUrl } from "@/lib/auth-links";
import { forbiddenOrigin, readJson, sameOrigin } from "@/lib/server/auth";
import { LimiterUnavailableError, LoginLookupError, clientIp, limiterUnavailableResponse, resolveLoginEmail, withinLimit } from "@/lib/server/login";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

// "Forgot password" with a username OR an e-mail. Always answers the same, whether or not the account exists.
// The reset e-mail's link opens /auth/set-password (works from any device: the tokens come back in the link).
const schema = z.object({ identifier: z.string().trim().min(1).max(254) });
const LIMIT_WINDOW = 15 * 60;
const DONE = { ok: true, message: "If that account exists, we've sent a password reset email to its address." };

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  // The e-mail's link: NEXT_PUBLIC_SITE_URL, never this request's headers in production (lib/auth-links.ts). Checked before the
  // account is looked up, so the answer never depends on whether it exists.
  const redirectTo = setPasswordUrl(request.headers.get("origin") || new URL(request.url).origin);
  if (!redirectTo) {
    console.error("[auth/reset] NEXT_PUBLIC_SITE_URL is not set in production: no reset e-mail can be sent until it is");
    return NextResponse.json({ error: "Password reset is unavailable right now. Contact your administrator." }, { status: 500 });
  }

  const json = await readJson(request, 2048);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return NextResponse.json({ error: "Enter your username or email address." }, { status: 400 });
  const { identifier } = parsed.data;

  const admin = createSupabaseAdminClient();
  let allowed: boolean;
  try {
    allowed = (await withinLimit(admin, "reset_ip", clientIp(request), LIMIT_WINDOW, 10))
      && (await withinLimit(admin, "reset_id", identifier.toLowerCase(), LIMIT_WINDOW, 3));
  } catch (err) {
    // Fails safe: no reset e-mail is sent while the limiter can't be used.
    if (err instanceof LimiterUnavailableError) return limiterUnavailableResponse("Password reset is temporarily unavailable. Try again shortly.");
    throw err;
  }
  if (!allowed) return NextResponse.json({ error: "Too many reset requests. Wait a few minutes and try again." }, { status: 429 });

  // A failed lookup answers like "no such account" here (the reply never depends on the account); nothing is sent.
  const email = await resolveLoginEmail(admin, identifier).catch((err) => {
    if (err instanceof LoginLookupError) return null;
    throw err;
  });
  if (email) {
    const auth = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, flowType: "implicit" } });
    const { error } = await auth.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) console.error("[auth/reset] reset email failed", error.status);
  }
  return NextResponse.json(DONE);
}
