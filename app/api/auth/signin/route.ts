import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { z } from "zod";

import { forbiddenOrigin, readJson, sameOrigin } from "@/lib/server/auth";
import { LimiterUnavailableError, LoginLookupError, clientIp, hashKey, limiterUnavailableResponse, recentHits, resolveLoginEmail, withinLimit } from "@/lib/server/login";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { isUnreachableError } from "@/lib/auth-errors";
import { withGatewayRetry } from "@/lib/server/resilient-fetch";

// Sign-in with a username OR an e-mail. Usernames are resolved to the e-mail here, on the server, with the service
// role; the browser never learns whether a username or e-mail exists: every failure gets the same answer.
const signInSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(256),
});

const INVALID = "Invalid username or password";
const LIMIT_WINDOW = 15 * 60;
const TOO_MANY = "Too many sign-in attempts. Wait a few minutes and try again.";

// Limits (audit SEC6). Every attempt counts against the caller's IP. Only FAILED attempts count against an
// account, and a blocked attempt records nothing, so nobody can keep an account locked just by trying:
//   per IP (all attempts) ......................... 40 / 15 min  - one abusive address is stopped;
//   per account + IP (failures) ................... 10 / 15 min  - guessing from one place is stopped, without
//                                                                  affecting the real person signing in elsewhere;
//   per account, all IPs together (failures) ...... 50 / 15 min  - caps guessing spread over many addresses; it
//                                                                  needs 50 failures from several IPs and lapses
//                                                                  15 minutes after they stop.
// Correct passwords never use up an account's budget.
const IP_MAX = 40;
const ACCOUNT_IP_FAILURES = 10;
const ACCOUNT_FAILURES = 50;

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return NextResponse.json({ error: "Service unavailable" }, { status: 503 });

  const json = await readJson(request, 4096);
  if (!json.ok) return json.response;
  const raw = (json.data ?? {}) as Record<string, unknown>;
  // Older clients send { email }.
  const parsed = signInSchema.safeParse({ identifier: raw.identifier ?? raw.email, password: raw.password });
  if (!parsed.success) return NextResponse.json({ error: INVALID }, { status: 400 });
  const { identifier, password } = parsed.data;

  const admin = createSupabaseAdminClient();
  const ip = clientIp(request);
  const account = identifier.toLowerCase();
  const pairKey = `${account}\u0000${ip}`;
  // Fails safe: if the limiter can't be used, nobody signs in (a clear "try again shortly") rather than the limits
  // silently not applying.
  try {
    if (!(await withinLimit(admin, "signin_ip", ip, LIMIT_WINDOW, IP_MAX))) return NextResponse.json({ error: TOO_MANY }, { status: 429 });
    const [pairFailures, accountFailures] = await Promise.all([
      recentHits(admin, "signin_fail_pair", pairKey, LIMIT_WINDOW),
      recentHits(admin, "signin_fail_id", account, LIMIT_WINDOW),
    ]);
    if (pairFailures >= ACCOUNT_IP_FAILURES || accountFailures >= ACCOUNT_FAILURES) {
      return NextResponse.json({ error: TOO_MANY }, { status: 429 });
    }
  } catch (err) {
    if (err instanceof LimiterUnavailableError) return limiterUnavailableResponse();
    throw err;
  }

  // Unknown usernames still make a sign-in call (with an address that can't exist), so the answer and its timing
  // don't reveal whether the username exists.
  // A lookup that FAILED (database or network) is not "no such username": answer 503 and record nothing, so an outage
  // is neither reported as wrong credentials nor counted as a failed guess.
  let resolved: string | null;
  try {
    resolved = await resolveLoginEmail(admin, identifier);
  } catch (err) {
    if (err instanceof LoginLookupError) return limiterUnavailableResponse();
    throw err;
  }
  const email = resolved ?? `unknown-${hashKey(identifier).slice(0, 24)}@invalid.invalid`;

  const cookieStore = await cookies();
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    global: { fetch: withGatewayRetry() },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) =>
        cookiesToSet.forEach(({ name, value, options }) =>
          cookieStore.set(name, value, { ...options, secure: process.env.NODE_ENV === "production" }),
        ),
    },
  });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // The auth service itself failed or could not be reached: that says nothing about the credentials, so it is not
    // counted as a failed guess and not answered as "invalid". Wrong password and unknown account still get the same 401.
    if (isUnreachableError(error)) return limiterUnavailableResponse();
    // Recording the failure is all that is left to do; the answer is the same either way.
    await Promise.all([
      withinLimit(admin, "signin_fail_pair", pairKey, LIMIT_WINDOW, ACCOUNT_IP_FAILURES),
      withinLimit(admin, "signin_fail_id", account, LIMIT_WINDOW, ACCOUNT_FAILURES),
    ]).catch(() => undefined);
    return NextResponse.json({ error: INVALID }, { status: 401 });
  }

  // Admin > Users "Last login". Best effort: a failure here never blocks the sign-in.
  if (admin && data.user) {
    await admin.from("user_profiles").update({ last_login_at: new Date().toISOString() }).eq("id", data.user.id).then(() => undefined, () => undefined);
  }

  return NextResponse.json({ ok: true });
}
