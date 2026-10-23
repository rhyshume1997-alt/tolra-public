/**
 * Lets a test call the real /api/mail route handlers as a signed-in synthetic user. The route code builds its Supabase
 * client with createServerClient (@supabase/ssr) from the request cookies; a test mocks that one call to return the
 * client it signed in (see tests/db/mail-poll.test.ts), so requireProfile, the role checks and the database functions
 * all run for real.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const session: { client: SupabaseClient | null } = { client: null };

/** Fetches that go to Microsoft (sign-in or Graph), recorded by the test's fetch wrapper. */
export const microsoftUrls: string[] = [];
export const isMicrosoft = (url: string) => url.includes("login.microsoftonline.com") || url.includes("graph.microsoft.com");

/** Environment the route handlers read to find the local Supabase (the cookie client is mocked, but must be 'configured'). */
export function configureRouteEnv(supabaseUrl: string, anonKey: string) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
}

export const post = (url: string, body: unknown) => new Request(`https://app.test${url}`, { method: "POST", body: JSON.stringify(body) });
