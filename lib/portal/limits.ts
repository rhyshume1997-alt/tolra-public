import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { clientIp, hashKey, LimiterUnavailableError, withinLimit } from "@/lib/server/login";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * BOUNDARY: lib/portal/limits.ts. Inputs: a Request and which step it is. Output: "ok" | "limited" | "unavailable".
 * Per-IP limits through the existing withinLimit / auth_rate_hit (lib/server/login.ts); the IP is hashed (hashKey) before it is used as
 * the key, so the rate-limit table never holds an address. FAILS CLOSED: any limiter failure is "unavailable", which callers treat as a
 * refusal. Must not log the IP, change the numbers without PM approval, or touch the e-mail-level limits (those live in release 154).
 */
export const PORTAL_LIMITS = {
  request: { bucket: "portal_ip_request", windowSeconds: 900, max: 10 },
  verify: { bucket: "portal_ip_verify", windowSeconds: 900, max: 20 },
  read: { bucket: "portal_ip_read", windowSeconds: 900, max: 300 },
} as const;
export type PortalLimitStep = keyof typeof PORTAL_LIMITS;

export async function checkPortalIpLimit(
  step: PortalLimitStep,
  request: Request,
  admin: SupabaseClient | null = createSupabaseAdminClient(),
): Promise<"ok" | "limited" | "unavailable"> {
  const limit = PORTAL_LIMITS[step];
  try {
    const allowed = await withinLimit(admin, limit.bucket, hashKey("portal-ip", clientIp(request)), limit.windowSeconds, limit.max);
    return allowed ? "ok" : "limited";
  } catch (err) {
    if (!(err instanceof LimiterUnavailableError)) console.error("[portal] limiter failed");
    return "unavailable";
  }
}
