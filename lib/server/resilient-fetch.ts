/**
 * fetch for server-side Supabase clients: one retry when the API gateway answers 502/503/504, only for requests
 * that are safe to repeat.
 *
 * Why: the gateway in front of PostgREST occasionally loses the upstream connection ("connection reset by peer",
 * "upstream prematurely closed connection") and answers 502 although nothing is wrong with the request. Observed on
 * the local test stack; it can happen on any proxied deployment. Without a retry a harmless read inside an access
 * check turned into "Forbidden".
 *
 * Safe to repeat: GET/HEAD, PATCH/PUT/DELETE (same filter and values give the same result) and the RPCs listed
 * below (read-only or idempotent). Inserts and other RPCs are never retried: a 502 doesn't say whether they ran.
 */
const RETRY_STATUSES = new Set([502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PATCH", "PUT", "DELETE"]);
const SAFE_RPCS = new Set([
  "current_user_organization_id", "has_org_role", "current_user_role", "my_organizations", "org_members",
  "section_allowed", "record_activity", "org_activity", "set_member_access",
  // Read-only (STABLE, migration 036). requireProfile (lib/server/auth.ts) reads it on every guarded API request; without a retry a
  // gateway blip on it answered 403, which is what left one of a job's photo thumbnails broken while the other loaded.
  "my_session", "company_people",
]);

export function isRetrySafe(url: string, method: string): boolean {
  const upper = method.toUpperCase();
  if (IDEMPOTENT_METHODS.has(upper)) return true;
  if (upper !== "POST") return false;
  const match = /\/rest\/v1\/rpc\/([a-z0-9_]+)/i.exec(url);
  return Boolean(match && SAFE_RPCS.has(match[1]));
}

type Fetch = typeof fetch;

export function withGatewayRetry(base: Fetch = fetch, delayMs = 150): Fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    const response = await base(input, init);
    if (!RETRY_STATUSES.has(response.status) || !isRetrySafe(url, method)) return response;
    console.error("[supabase] gateway", response.status, "retrying once:", method, new URL(url).pathname);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return base(input, init);
  };
}
