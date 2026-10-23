import { NextResponse } from "next/server";

import { checkNewCompany, sameCompanyName } from "@/lib/new-company";
import { clientIp, isErrorResponse, jsonError, mfaRequired, readJson } from "@/lib/server/auth";
import { LimiterUnavailableError, limiterUnavailableResponse, withinLimit } from "@/lib/server/login";
import { requirePlatformOwner } from "@/lib/server/platform";

// The platform owner creates a company: POST { name, slug, adminEmail }.
//
// Order matters: the platform-owner checks (lib/server/platform.ts: same origin, signed in, is_platform_admin(), aal2, and the
// database's own platform_list_organizations() check) come first. The company is then created with the platform owner's OWN session
// by public.platform_create_organization() (migration 039), which checks the owner list and the second step again in the database,
// calls create_organization() (007) and writes a PLATFORM_CREATE_ORGANIZATION row to the new company's audit log in the same
// transaction. The service role is used only for the rate limiter. Nothing is created for anyone else.
// The answer carries the new company only: never another company's data, and never whether the admin's e-mail already has a login.

const PER_HOUR = 20;

export async function POST(request: Request) {
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  const { supabase, user, companies, admin } = ctx;

  try {
    if (!(await withinLimit(admin, "platform_new_company", user.id, 3600, PER_HOUR))) {
      return NextResponse.json({ error: "Too many attempts. Wait a while and try again." }, { status: 429, headers: { "Retry-After": "3600" } });
    }
  } catch (error) {
    if (error instanceof LimiterUnavailableError) return limiterUnavailableResponse("Company creation is temporarily unavailable. Try again shortly.");
    throw error;
  }

  const json = await readJson(request, 4 * 1024);
  if (!json.ok) return json.response;
  const body = json.data && typeof json.data === "object" ? (json.data as Record<string, unknown>) : {};
  const checked = checkNewCompany(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error, field: checked.field }, { status: 400 });
  const { name, slug, adminEmail } = checked.value;

  // The list is the platform owner's own (they may see every company), read by the database after its checks above.
  if (companies.some((company) => company.slug === slug)) {
    return NextResponse.json({ error: "That web address (slug) is already used by another company. Choose a different one.", field: "slug" }, { status: 409 });
  }
  if (companies.some((company) => sameCompanyName(company.name, name))) {
    return NextResponse.json({ error: "A company with that name already exists. Use a different name.", field: "name" }, { status: 409 });
  }

  const { data: organizationId, error } = await supabase.rpc("platform_create_organization", { p_name: name, p_slug: slug, p_admin_email: adminEmail });
  if (error || typeof organizationId !== "string") {
    console.error("[platform] platform_create_organization failed", error?.code ?? "no-id", String(error?.message ?? "").slice(0, 120));
    if (error?.code === "42501") {
      if (error.hint === "mfa_required") return mfaRequired();
      return jsonError("Forbidden", 403);
    }
    // Lost a race with another creation of the same slug (the database's unique key, or its own check).
    if (error?.code === "23505" || /slug .* is already used/i.test(error?.message ?? "")) {
      return NextResponse.json({ error: "That web address (slug) is already used by another company. Choose a different one.", field: "slug" }, { status: 409 });
    }
    return jsonError("Couldn't create the company. Nothing was created; try again.", 500);
  }

  // The durable record is the audit row written by the database; this line is a convenience for the server log.
  console.info(JSON.stringify({ event: "platform.company_created", actor: user.id, organization_id: organizationId, slug, ip: clientIp(request) }));
  return NextResponse.json({ ok: true, company: { organization_id: organizationId, name, slug, status: "active" } }, { status: 201 });
}
