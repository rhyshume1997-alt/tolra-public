import { NextResponse } from "next/server";

import { MAX_QUERY, allowedGroups, runSearch, type SearchClient } from "@/lib/global-search";
import { forbiddenOrigin, isErrorResponse, requireProfile, sameOrigin } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

/**
 * The global search in the top bar: GET /api/search?q=<text>. Read only, through the signed-in person's own client (row level security
 * scopes it to their company; never the service role). Any signed-in role, but a role only gets the groups whose pages it may open
 * (lib/global-search.ts allowedGroups); a support session is read only anyway. Under two characters nothing is read.
 */
export async function GET(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();

  const auth = await requireProfile();
  if (isErrorResponse(auth)) return auth;

  const q = new URL(request.url).searchParams.get("q") ?? "";
  const roles = [auth.profile.role, auth.profile.secondary_role];
  const allowed = allowedGroups(roles, auth.session?.hidden_sections ?? []);
  const answer = await runSearch(auth.supabase as unknown as SearchClient, auth.profile.organization_id, q.slice(0, MAX_QUERY * 4), allowed);
  return NextResponse.json(answer, { headers: { "Cache-Control": "no-store" } });
}
