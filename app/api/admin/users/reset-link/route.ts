import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { setPasswordUrl } from "@/lib/auth-links";
import { PROTECTED_CHECK_FAILED, PROTECTED_LOGIN } from "@/lib/company-access";
import { maskEmail } from "@/lib/mask-email";
import { PRODUCT } from "@/lib/product";
import { audit, guard, loginIsProtected } from "@/lib/server/admin-users";
import { isErrorResponse, jsonError, readJson } from "@/lib/server/auth";
import { LimiterUnavailableError, limiterUnavailableResponse, withinLimit } from "@/lib/server/login";

// An admin asks Supabase Auth to e-mail a member of their current organisation the same "reset your password" message the
// sign-in page's "Forgot password?" sends (redirect: /auth/set-password). The link goes ONLY to the person's own mailbox: this
// route never builds, logs, stores or returns it, so the admin cannot use it to take the account over (that is why it is
// resetPasswordForEmail and not admin generateLink, whose link would be in our hands).
// Same guard as "Set password": an active admin of this organisation at aal2 whatever REQUIRE_ADMIN_MFA says (guard), no support
// session, never oneself (use Forgot password), never a login shared with another company, never a platform owner's login or one
// with any support membership, active or not (093). Rate limited per admin and per person; fails closed when the limiter is down.
// Audited as PASSWORD_RESET_PREPARED (already an accepted audit action); the e-mail address is not written to the trail.
const schema = z.object({ userId: z.string().uuid() });

const WINDOW = 15 * 60;
const PER_ADMIN = 10;
const PER_PERSON = 3;

export async function POST(request: Request) {
  const ctx = await guard(request, { aal2: true });
  if (isErrorResponse(ctx)) return ctx;
  const { auth, admin } = ctx;
  const orgId = auth.profile.organization_id;

  const json = await readJson(request, 2048);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const { userId } = parsed.data;

  if (userId === auth.user.id) return jsonError("Use Forgot password on the sign-in page for your own password.", 409);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return jsonError("Password reset e-mail is not configured", 503);

  const { data: memberships, error: memberError } = await admin
    .from("organization_members")
    .select("organization_id, support, active")
    .eq("user_id", userId);
  if (memberError) return jsonError("Could not send the reset e-mail", 500);
  const mine = memberships?.find((row) => row.organization_id === orgId);
  if (!mine) return jsonError("User not found", 404);
  if (memberships!.some((row) => row.support === true)) return jsonError(PROTECTED_LOGIN, 403);
  if (memberships!.some((row) => row.organization_id !== orgId)) {
    return jsonError(`This person also uses ${PRODUCT.name} with another company, so only they can reset their password (Forgot password on the sign-in page).`, 409);
  }
  if (mine.active === false) return jsonError("This person is deactivated.", 409);
  const protectedLogin = await loginIsProtected(ctx, userId);
  if (protectedLogin === null) return jsonError(PROTECTED_CHECK_FAILED, 500);
  if (protectedLogin) return jsonError(PROTECTED_LOGIN, 403);

  const { data: found, error: userError } = await admin.auth.admin.getUserById(userId);
  if (userError || !found?.user) return jsonError("Could not send the reset e-mail", 500);
  const email = found.user.email?.trim();
  if (!email) return jsonError("This person has no e-mail address, so a reset e-mail can't be sent. Set a password instead.", 409);

  try {
    const allowed = (await withinLimit(admin, "admin_reset_link_admin", auth.user.id, WINDOW, PER_ADMIN))
      && (await withinLimit(admin, "admin_reset_link_person", userId, WINDOW, PER_PERSON));
    if (!allowed) return jsonError("Too many reset e-mails. Wait a few minutes and try again.", 429);
  } catch (err) {
    if (err instanceof LimiterUnavailableError) return limiterUnavailableResponse("Password reset is temporarily unavailable. Try again shortly.");
    throw err;
  }

  // setPasswordUrl returns string today and string | null once the site URL is required (security PR): both compile, null/empty is a
  // configuration error and nothing is sent.
  const redirectTo: string | null = setPasswordUrl(request.headers.get("origin") || new URL(request.url).origin);
  if (!redirectTo) {
    console.error("[admin/users/reset-link] no site URL configured; nothing sent");
    return jsonError("Password reset e-mail is not configured", 500);
  }

  const sender = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, flowType: "implicit" } });
  const { error } = await sender.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) {
    console.error("[admin/users/reset-link] reset email failed", error.status);
    return jsonError("The reset e-mail couldn't be sent. Try again shortly.", 502);
  }

  await audit(ctx, "PASSWORD_RESET_PREPARED", userId, { via: "email" }, request);
  return NextResponse.json({ ok: true, sentTo: maskEmail(email) });
}
