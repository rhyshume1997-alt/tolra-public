/**
 * Brand flash fix (sign-in page and app shell). The sign-in page picks the company on the server (?org, else the company subdomain,
 * else the tolra_brand cookie) and never trusts the cookie: an unknown or not-opted-in slug gets the neutral page, as ?org does.
 * The public logo URL serves only an opted-in company's CURRENT logo version; the signed-in logo URL only the session's own company;
 * the remember route only ever sets the session's own (opted-in) company.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Org = { id: string; name: string; slug: string; status: string };
let orgs: Org[] = [];
let settings: Record<string, Record<string, unknown>> = {};
let files: Record<string, Uint8Array> = {};
let adminDownloads: string[] = [];
let adminLookups: string[] = [];

vi.mock("@/lib/server/supabase-admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, value: string) => ({
          maybeSingle: async () => {
            adminLookups.push(`${table}:${value}`);
            if (table === "organizations") return { data: orgs.find((org) => org.slug === value) ?? null, error: null };
            return { data: settings[value] ? { company_profile: settings[value] } : null, error: null };
          },
        }),
      }),
    }),
    storage: {
      from: () => ({
        download: async (path: string) => {
          adminDownloads.push(path);
          const bytes = files[path];
          return bytes ? { data: new Blob([bytes as BlobPart]), error: null } : { data: null, error: { message: "not found" } };
        },
      }),
    },
  }),
}));

// The signed-in caller (lib/server/auth requireProfile), with their own client: settings under RLS and storage under RLS.
let auth: "signed-out" | "ok" = "ok";
let sessionOrg = "org-a";
let myCompanies: Array<{ organization_id: string; slug: string; is_current: boolean }> = [];
let userSettingsReads: string[] = [];
let userDownloads: string[] = [];
let crossSite = false;

vi.mock("@/lib/server/auth", async () => {
  const { NextResponse } = await import("next/server");
  const jsonError = (message: string, status: number, init?: { headers?: Record<string, string> }) => NextResponse.json({ error: message }, { status, headers: init?.headers });
  const userClient = {
    from: () => ({
      select: () => ({
        eq: (_column: string, value: string) => ({
          maybeSingle: async () => {
            userSettingsReads.push(value);
            // RLS: only the session company's row is visible.
            return { data: value === sessionOrg && settings[value] ? { company_profile: settings[value] } : null, error: null };
          },
        }),
      }),
    }),
    rpc: async () => ({ data: myCompanies, error: null }),
    storage: {
      from: () => ({
        download: async (path: string) => {
          userDownloads.push(path);
          const bytes = path.startsWith(`${sessionOrg}/`) ? files[path] : undefined;
          return bytes ? { data: new Blob([bytes as BlobPart]), error: null } : { data: null, error: { message: "not found" } };
        },
      }),
    },
  };
  return {
    jsonError,
    isErrorResponse: (value: unknown) => value instanceof NextResponse,
    sameOrigin: () => !crossSite,
    forbiddenOrigin: () => jsonError("Forbidden", 403),
    requireProfile: async () => (auth === "signed-out" ? jsonError("Unauthorized", 401) : { supabase: userClient, user: { id: "user-1" }, profile: { organization_id: sessionOrg }, session: null }),
  };
});

let cookieJar: Record<string, string> = {};
let hostHeader = "app.example.test";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: hostHeader }),
  cookies: async () => ({ get: (name: string) => (cookieJar[name] === undefined ? undefined : { name, value: cookieJar[name] }) }),
}));
vi.mock("@/app/login/login-form", () => ({ LoginForm: () => null }));

import { GET as publicLogo } from "@/app/api/branding/logo/route";
import { POST as remember } from "@/app/api/branding/remember/route";
import { GET as companyLogo } from "@/app/api/company-logo/route";
import LoginPage from "@/app/login/page";
import { companyLogoUrl, logoVersion } from "@/lib/branding";
import { BRAND_COOKIE, getPublicBrandingMeta, loginBranding, loginSlug } from "@/lib/server/branding";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

beforeEach(() => {
  orgs = [
    { id: "org-a", name: "Alpha Ltd", slug: "alpha", status: "active" },
    { id: "org-b", name: "Beta Ltd", slug: "beta", status: "active" },
    { id: "org-c", name: "Gone Ltd", slug: "gone", status: "suspended" },
  ];
  settings = {
    "org-a": { brandedLogin: true, brandPrimary: "#112233", loginTagline: "Alpha tagline.", logoPath: "org-a/logo-1.png", vatNumber: "GB123" },
    "org-b": { brandedLogin: false, logoPath: "org-b/logo-1.png" },
    "org-c": { brandedLogin: true, logoPath: "org-c/logo-1.png" },
  };
  files = { "org-a/logo-1.png": PNG, "org-b/logo-1.png": PNG, "org-c/logo-1.png": PNG };
  adminDownloads = [];
  adminLookups = [];
  auth = "ok";
  sessionOrg = "org-a";
  myCompanies = [{ organization_id: "org-a", slug: "alpha", is_current: true }, { organization_id: "org-b", slug: "beta", is_current: false }];
  userSettingsReads = [];
  userDownloads = [];
  crossSite = false;
  cookieJar = {};
  hostHeader = "app.example.test";
});

describe("sign-in page slug precedence", () => {
  it("takes ?org first, then the company subdomain, then the brand cookie", () => {
    expect(loginSlug({ org: "Alpha", host: "beta.example.test", cookie: "gone" }, "example.test")).toBe("alpha");
    expect(loginSlug({ org: null, host: "beta.example.test", cookie: "gone" }, "example.test")).toBe("beta");
    expect(loginSlug({ org: "", host: "app.example.test", cookie: "gone" }, "example.test")).toBe("gone");
    expect(loginSlug({ org: null, host: "beta.example.test", cookie: "alpha" }, undefined)).toBe("alpha"); // no TENANT_ROOT_DOMAIN: no host route
    expect(loginSlug({}, "example.test")).toBeNull();
  });

  it("lets an explicit ?org win even when it does not resolve, as /api/branding does", () => {
    expect(loginSlug({ org: "no such!", cookie: "alpha" }, undefined)).toBe("no such!");
  });

  it("ignores a cookie that is not a slug", () => {
    expect(loginSlug({ cookie: "../org-a" }, undefined)).toBeNull();
    expect(loginSlug({ cookie: "x".repeat(80) }, undefined)).toBeNull();
  });
});

describe("sign-in branding from a slug (the cookie is never trusted)", () => {
  it("answers the opted-in company with its public fields and a versioned logo URL, without downloading the logo", async () => {
    const brand = await loginBranding("alpha");
    const meta = await getPublicBrandingMeta("alpha");
    expect(brand).toEqual({
      slug: "alpha", name: "Alpha Ltd", tagline: "Alpha tagline.", primary: "#112233", accent: expect.any(String), style: "light", eyebrow: "",
      logo: `/api/branding/logo?org=alpha&v=${meta?.version}`,
    });
    expect(JSON.stringify(brand)).not.toMatch(/GB123|org-a/);
    expect(adminDownloads).toEqual([]);
  });

  it("gives the neutral page (null) for an unknown, not-opted-in or inactive company, or no slug", async () => {
    for (const slug of ["nobody", "beta", "gone", null]) expect(await loginBranding(slug)).toBeNull();
  });

  it("renders the page with the cookie's company only after looking it up again", async () => {
    cookieJar = { [BRAND_COOKIE]: "alpha" };
    const page = (await LoginPage({ searchParams: Promise.resolve({}) })) as { props: { children: { props: { initialBranding: unknown } } } };
    expect(page.props.children.props.initialBranding).toMatchObject({ slug: "alpha", name: "Alpha Ltd" });
    expect(adminLookups).toContain("organizations:alpha");
  });

  it("renders the neutral page for a cookie naming an unknown or not-opted-in company", async () => {
    for (const slug of ["nobody", "beta", "gone"]) {
      cookieJar = { [BRAND_COOKIE]: slug };
      const page = (await LoginPage({ searchParams: Promise.resolve({}) })) as { props: { children: { props: { initialBranding: unknown } } } };
      expect(page.props.children.props.initialBranding).toBeNull();
    }
  });

  it("prefers ?org over the cookie on the page", async () => {
    cookieJar = { [BRAND_COOKIE]: "alpha" };
    const page = (await LoginPage({ searchParams: Promise.resolve({ org: "beta" }) })) as { props: { children: { props: { initialBranding: unknown } } } };
    expect(page.props.children.props.initialBranding).toBeNull();
  });
});

describe("GET /api/branding/logo (public)", () => {
  const ask = (query: string) => publicLogo(new Request(`http://app.example.test/api/branding/logo?${query}`));

  it("serves the opted-in company's current logo, cacheable for a year", async () => {
    const version = (await getPublicBrandingMeta("alpha"))?.version;
    const response = await ask(`org=alpha&v=${version}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, s-maxage=600, immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(adminDownloads).toEqual(["org-a/logo-1.png"]);
  });

  it("downloads nothing from storage for a wrong or missing version (a guessed v cannot make the server fetch)", async () => {
    for (const query of ["org=alpha&v=000000000000", "org=alpha&v=", "org=alpha"]) {
      expect((await ask(query)).status).toBe(404);
      expect(adminDownloads).toEqual([]);
    }
  });

  it("answers an old or missing version with an empty 404 that is never cached", async () => {
    for (const query of ["org=alpha&v=000000000000", "org=alpha"]) {
      const response = await ask(query);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
  });

  it("gives an unknown, not-opted-in or inactive company exactly the same 404", async () => {
    for (const slug of ["nobody", "beta", "gone"]) {
      const version = (await getPublicBrandingMeta(slug))?.version ?? "x";
      const response = await ask(`org=${slug}&v=${version}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
    expect(adminDownloads).toEqual([]);
  });
});

describe("GET /api/company-logo (signed in)", () => {
  const url = (org: string, path: string) => companyLogoUrl(org, path) as string;
  const ask = (target: string) => companyLogo(new Request(`http://app.example.test${target}`));

  it("refuses another company's logo, whoever asks, without reading anything", async () => {
    const response = await ask(url("org-b", "org-b/logo-1.png"));
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(userSettingsReads).toEqual([]);
    expect(userDownloads).toEqual([]);
    expect(adminDownloads).toEqual([]);
  });

  it("refuses someone signed out, uncached", async () => {
    auth = "signed-out";
    const response = await ask(url("org-a", "org-a/logo-1.png"));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("serves the session company's current logo as the caller (never the service role), privately cacheable", async () => {
    const response = await ask(url("org-a", "org-a/logo-1.png"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(userDownloads).toEqual(["org-a/logo-1.png"]);
    expect(adminDownloads).toEqual([]);
  });

  it("answers an old version, or a path outside the company's folder, with an uncached 404", async () => {
    let response = await ask("/api/company-logo?org=org-a&v=deadbeef");
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    settings["org-a"].logoPath = "org-b/logo-1.png";
    response = await ask(`/api/company-logo?org=org-a&v=${logoVersion("org-b/logo-1.png")}`);
    expect(response.status).toBe(404);
    expect(userDownloads).toEqual([]);
  });
});

describe("POST /api/branding/remember", () => {
  const post = () => remember(new Request("http://app.example.test/api/branding/remember", { method: "POST" }));

  it("sets the cookie to the session's own opted-in company: slug only, httpOnly, Lax, host-only, a year", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^tolra_brand=alpha;/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=31536000/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("clears the cookie when the session's company has branded sign-in off, and never names another company", async () => {
    sessionOrg = "org-b";
    myCompanies = [{ organization_id: "org-a", slug: "alpha", is_current: false }, { organization_id: "org-b", slug: "beta", is_current: true }];
    const cookie = (await post()).headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^tolra_brand=;/);
    expect(cookie).toMatch(/Max-Age=0/);
  });

  it("clears the cookie when the session's company is not among the caller's own (a support session)", async () => {
    myCompanies = [{ organization_id: "org-b", slug: "beta", is_current: false }];
    expect((await post()).headers.get("set-cookie")).toMatch(/^tolra_brand=;/);
  });

  it("refuses someone signed out, and a cross-site request, without setting anything", async () => {
    auth = "signed-out";
    let response = await post();
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    auth = "ok";
    crossSite = true;
    response = await post();
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("logo URL helpers", () => {
  it("version the logo by its path and refuse paths outside the company's folder", () => {
    expect(logoVersion("org-a/logo-1.png")).toMatch(/^[0-9a-f]{8}$/);
    expect(logoVersion("org-a/logo-1.png")).not.toBe(logoVersion("org-a/logo-2.png"));
    expect(companyLogoUrl("org-a", "org-a/logo-1.png")).toBe(`/api/company-logo?org=org-a&v=${logoVersion("org-a/logo-1.png")}`);
    expect(companyLogoUrl("org-a", "org-b/logo-1.png")).toBeUndefined();
    expect(companyLogoUrl("org-a", "org-a/../org-b/logo.png")).toBeUndefined();
    expect(companyLogoUrl(null, "org-a/logo-1.png")).toBeUndefined();
    expect(companyLogoUrl("org-a", "")).toBeUndefined();
  });
});
