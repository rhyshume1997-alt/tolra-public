import { NextResponse } from "next/server";
import { z } from "zod";

import { audit, guard, loginIsProtected, resetMfa } from "@/lib/server/admin-users";
import { isErrorResponse, jsonError, readJson } from "@/lib/server/auth";

// Another admin resets a colleague's two-step sign-in (lost or replaced phone). Audited. The caller must be an admin who has
// passed the second step themselves (the guard, always aal2 whatever REQUIRE_ADMIN_MFA says), and can't reset their own. Never for a
// platform owner's login or one with any support membership (093: resetMfa, asking loginIsProtected once the member is found).
const schema = z.object({ userId: z.string().uuid() });

export async function POST(request: Request) {
  const ctx = await guard(request, { aal2: true });
  if (isErrorResponse(ctx)) return ctx;
  const json = await readJson(request, 2048);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);

  const result = await resetMfa(ctx.admin, ctx.auth.profile.organization_id, ctx.auth.user.id, parsed.data.userId, () => loginIsProtected(ctx, parsed.data.userId));
  if (!result.ok) return jsonError(result.error, result.status);
  await audit(ctx, "RESET_MFA", parsed.data.userId, { factors_removed: result.removed }, request);
  return NextResponse.json({ ok: true, removed: result.removed });
}
