import { getPublicLogo } from "@/lib/server/branding";

// Public (no sign-in): the sign-in page's logo at a cacheable URL, /api/branding/logo?org=<slug>&v=<version>. The same rule as
// /api/branding: only an ACTIVE organisation whose admin switched "Sign-in page branding" on, and only its logo (PNG or JPEG,
// from its own folder of the private bucket). The bucket stays private: this route is the only way out.
//
// Only the CURRENT version is served, and then it may be kept for a year (a new logo or any branding change gives a new version,
// so the URL changes). Shared caches keep it for ten minutes only, so a company that switches branded sign-in off drops out of
// them quickly. Anything else (unknown slug, not opted in, no logo, an old or missing version) is the same empty 404, never cached.

const notFound = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const version = params.get("v");
  if (!version) return notFound();
  // The version is checked against the metadata BEFORE the file is fetched: a wrong version never reaches storage.
  let found: Awaited<ReturnType<typeof getPublicLogo>>;
  try {
    found = await getPublicLogo(params.get("org")?.trim().toLowerCase(), version);
  } catch {
    return notFound();
  }
  if (!found) return notFound();
  return new Response(new Uint8Array(found.logo.bytes), {
    headers: {
      "Content-Type": found.logo.type,
      "Cache-Control": "public, max-age=31536000, s-maxage=600, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
