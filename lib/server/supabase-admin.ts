import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { withGatewayRetry } from "@/lib/server/resilient-fetch";

/**
 * Service-role client. Bypasses RLS: only import from server route handlers, and always scope queries by the
 * caller's organization_id yourself. Returns null when SUPABASE_SERVICE_ROLE_KEY is not configured.
 */
export function createSupabaseAdminClient(): SupabaseClient | null {
  if (typeof window !== "undefined") throw new Error("supabase-admin must not be used in the browser");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: withGatewayRetry() } });
}
