import { NextResponse } from "next/server";

import { companyLogoUrl, logoVersion } from "@/lib/branding";
import { isErrorResponse, jsonError, requireProfile } from "@/lib/server/auth";
import { loadLogo } from "@/lib/server/branding";

// The signed-in company's own logo at a cacheable URL, /api/company-logo?org=<organisation id>&v=<version> (lib/branding.ts
// companyLogoUrl): the sidebar shows it straight away on every later page load instead of downloading it each time.
//
// Signed in only, and only for the company THIS session works in: any other organisation id is refused, whoever asks. Everything
// is read as the caller (their own session, never the service role): organization_settings under RLS, and the file under storage
// RLS, which serves only the session company's folder. Only the current version is served, kept privately for a year (a new logo
// has a new path, so a new URL). Nothing else from the company profile leaves here.

const NO_STORE = { "Cache-Control": "private, no-store" };
const notFound = () => new Response(null, { status: 404, headers: NO_STORE });

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const org = params.get("org");
  const version = params.get("v");

  const auth = await requireProfile();
  if (isErrorResponse(auth)) return jsonError("Not available", auth.status, { headers: NO_STORE });
  if (!org || org !== auth.profile.organization_id) return jsonError("Forbidden", 403, { headers: NO_STORE });

  const { data, error } = await auth.supabase.from("organization_settings").select("company_profile").eq("organization_id", org).maybeSingle();
  if (error || !data) return notFound();
  const path = (data.company_profile as Record<string, unknown> | null)?.logoPath;
  // A path outside the company's own folder is never served (companyLogoUrl is undefined for it); nor is an old version.
  if (typeof path !== "string" || !companyLogoUrl(org, path) || version !== logoVersion(path)) return notFound();

  const logo = await loadLogo(auth.supabase, org, path).catch(() => null);
  if (!logo) return notFound();
  return new NextResponse(new Uint8Array(logo.bytes), {
    headers: { "Content-Type": logo.type, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
  });
}
