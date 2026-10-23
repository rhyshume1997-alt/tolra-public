import "server-only";
import type { NextResponse } from "next/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";

import { forbiddenOrigin, createSupabaseServerClient, jsonError, mfaRequired, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * The guard for platform-owner API routes (/api/platform/...). Unlike requireProfile it needs no current company: a platform
 * owner outside a company resolves to none (migration 036), and that is exactly where this page lives.
 *
 * Every check is the database's own, run with the CALLER's token, so nothing here can be satisfied by a forged request:
 *   1. same origin (CSRF), a signed-in user, an active profile that has chosen its own password;
 *   2. is_platform_admin(): the person is on security_audit.platform_admins (anyone else gets a plain 403, which does not say
 *      that a platform exists);
 *   3. aal2: the session passed the second step. Checked here from the session AND by the database
 *      (platform_list_organizations calls assert_platform_aal() on the token's own aal claim), so a password-only token is
 *      refused with the same mfa_required answer the company routes give.
 * `companies` is what that last call returned: the platform owner's own list, used to refuse duplicates clearly. The service-role
 * client is created only after all of this has passed.
 */
export type PlatformCompanyRow = { organization_id: string; name: string; slug: string; status: string };
export type PlatformContext = { supabase: SupabaseClient; user: User; companies: PlatformCompanyRow[]; admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>> };

export async function requirePlatformOwner(request: Request): Promise<PlatformContext | NextResponse> {
  if (!sameOrigin(request)) return forbiddenOrigin();

  const supabase = await createSupabaseServerClient();
  if (!supabase) return jsonError("Service unavailable", 503);
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user;
  if (userError || !user) return jsonError("Unauthorized", 401);

  const { data: profile, error: profileError } = await supabase.from("user_profiles").select("active, must_change_password").eq("id", user.id).maybeSingle();
  if (profileError || !profile || profile.active !== true || profile.must_change_password !== false) {
    console.error("[platform] refused: profile", profileError?.code ?? (profile ? "inactive-or-password" : "no-profile"));
    return jsonError("Forbidden", 403);
  }

  const { data: isOwner, error: ownerError } = await supabase.rpc("is_platform_admin");
  if (ownerError || isOwner !== true) {
    console.error("[platform] refused: owner", ownerError?.code ?? "not-owner");
    return jsonError("Forbidden", 403);
  }

  const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assuranceError || assurance?.currentLevel !== "aal2") return mfaRequired();

  const { data: companies, error: listError } = await supabase.rpc("platform_list_organizations");
  if (listError) {
    console.error("[platform] company list refused", listError.code ?? "no-code");
    if (listError.code === "42501") return listError.hint === "mfa_required" ? mfaRequired() : jsonError("Forbidden", 403);
    return jsonError("Couldn't check the companies. Try again.", 500);
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return jsonError("Company creation is not configured", 503);
  return { supabase, user, companies: (companies ?? []) as PlatformCompanyRow[], admin };
}
