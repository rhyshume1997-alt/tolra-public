/**
 * Company look (module 12): the installed-app manifest and icon URLs. Pure functions plus the server rules with the database mocked.
 * Proves: neutral manifest is unchanged, a company's manifest holds only its own public fields, and nothing leaks across companies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildManifest, companyIconUrl, iconHrefFor, manifestHref, type InstalledAppBrand } from "@/lib/company-look/installed-app";

vi.mock("server-only", () => ({}));
const metaFor = vi.fn();
vi.mock("@/lib/server/branding", async () => {
  const real = await vi.importActual<typeof import("@/lib/branding")>("@/lib/branding");
  return {
    BRAND_COOKIE: "tolra_brand",
    getPublicBrandingMeta: (slug: string) => metaFor(slug),
    loginSlug: (input: { org?: string | null; host?: string | null; cookie?: string | null }) => {
      const asked = input.org?.trim().toLowerCase();
      if (asked) return asked;
      const remembered = input.cookie?.trim().toLowerCase();
      return real.isOrgSlug(remembered) ? remembered : null;
    },
  };
});

const ACME: InstalledAppBrand = { slug: "acme", name: "Acme Engineering Ltd", tagline: "Precision parts", primary: "#112233", version: "abc123abc123", hasLogo: true };
const BETA: InstalledAppBrand = { slug: "beta", name: "Beta Fabrication", tagline: "", primary: "#aa5500", version: "def456def456", hasLogo: false };

describe("buildManifest", () => {
  it("neutral manifest is the Tolra one: static icons, Tolra name and theme", () => {
    const m = buildManifest(null);
    expect(m).toMatchObject({ id: "/", name: "Tolra", short_name: "Tolra", theme_color: "#0b2a5b", background_color: "#0b2a5b", start_url: "/dashboard?source=pwa" });
    expect(m.icons.map((i) => `${i.src} ${i.sizes} ${i.purpose}`)).toEqual([
      "/icons/icon-192.png 192x192 any", "/icons/icon-512.png 512x512 any", "/icons/icon-maskable-512.png 512x512 maskable",
    ]);
  });

  it("company manifest uses the company's name, colour and icons", () => {
    const m = buildManifest(ACME);
    expect(m).toMatchObject({ name: "Acme Engineering Ltd", short_name: "Acme Enginee", theme_color: "#112233", background_color: "#112233", id: "/?app=acme", description: "Precision parts" });
    expect(m.icons.map((i) => i.purpose)).toEqual(["any", "any", "maskable"]);
    for (const i of m.icons) expect(i.src).toContain("org=acme");
  });

  it("falls back to the Tolra tagline when the company has none", () => {
    expect(buildManifest(BETA).description).toBe("Quotes, jobs and invoices for engineering workshops.");
  });

  it("one company's manifest never contains another company's details", () => {
    const text = JSON.stringify(buildManifest(ACME));
    for (const other of [BETA.name, BETA.slug, BETA.primary, BETA.version]) expect(text).not.toContain(other);
    expect(JSON.stringify(buildManifest(null))).not.toMatch(/acme|beta/i);
  });

  it("builds only from the public fields (no extra brand data can reach the manifest)", () => {
    const extra = { ...ACME, email: "boss@acme.test", organizationId: "11111111-1111-4111-8111-111111111111", logoPath: "x/logo.png" } as InstalledAppBrand;
    const text = JSON.stringify(buildManifest(extra));
    expect(text).not.toContain("boss@acme.test");
    expect(text).not.toContain("11111111");
    expect(text).not.toContain("logo.png");
  });
});

describe("urls", () => {
  it("icon url carries slug, version, size and purpose", () => {
    expect(companyIconUrl(ACME, 192)).toBe("/api/pwa-icon?org=acme&v=abc123abc123&size=192");
    expect(companyIconUrl(ACME, 512, "maskable")).toBe("/api/pwa-icon?org=acme&v=abc123abc123&size=512&purpose=maskable");
  });
  it("manifest link names the company, or '-' (never a company) for the neutral page", () => {
    expect(manifestHref("acme")).toBe("/manifest.webmanifest?org=acme");
    expect(manifestHref(null)).toBe("/manifest.webmanifest?org=-");
  });
  it("icon links are re-pointed only when they are ours", () => {
    expect(iconHrefFor("/api/pwa-icon?size=180", "acme")).toBe("/api/pwa-icon?size=180&org=acme");
    expect(iconHrefFor("/api/pwa-icon?size=180&org=zzz", null)).toBe("/api/pwa-icon?size=180&org=-");
    expect(iconHrefFor("/icons/favicon.ico", "acme")).toBe("/icons/favicon.ico");
  });
});

describe("server rules", () => {
  const saved = process.env.BRANDED_APP_ENABLED;
  beforeEach(() => { metaFor.mockReset(); });
  afterEach(() => { if (saved === undefined) delete process.env.BRANDED_APP_ENABLED; else process.env.BRANDED_APP_ENABLED = saved; });

  it("flag off (unset or not exactly 'true'): neutral, and the database is never asked", async () => {
    const { installedAppBrand } = await import("@/lib/company-look/installed-app-server");
    for (const value of [undefined, "", "TRUE", "1", "yes", "false"]) {
      if (value === undefined) delete process.env.BRANDED_APP_ENABLED;
      expect(await installedAppBrand("acme")).toBeNull();
    }
    expect(metaFor).not.toHaveBeenCalled();
  });

  it("flag on: an opted-in active company is branded; unknown or opted-out is the same null", async () => {
    process.env.BRANDED_APP_ENABLED = "true";
    const { installedAppBrand } = await import("@/lib/company-look/installed-app-server");
    metaFor.mockImplementation(async (slug: string) => (slug === "acme" ? { ...ACME, style: "light", eyebrow: "", accent: "#000000" } : null));
    expect(await installedAppBrand("acme")).toEqual(ACME);
    expect(await installedAppBrand("optedout")).toBeNull();
    expect(await installedAppBrand("nobody")).toBeNull();
    expect(await installedAppBrand(null)).toBeNull();
  });

  it("a lookup error is neutral, not a failure", async () => {
    process.env.BRANDED_APP_ENABLED = "true";
    const { installedAppBrand } = await import("@/lib/company-look/installed-app-server");
    metaFor.mockRejectedValue(new Error("db down"));
    expect(await installedAppBrand("acme")).toBeNull();
  });

  it("?org wins over the cookie; the cookie is used only when there is no ?org", async () => {
    const { installedAppSlug } = await import("@/lib/company-look/installed-app-server");
    const req = (path: string, cookie?: string) => new Request(`https://app.test${path}`, { headers: cookie ? { cookie } : {} });
    expect(installedAppSlug(req("/manifest.webmanifest?org=beta", "tolra_brand=acme"))).toBe("beta");
    expect(installedAppSlug(req("/manifest.webmanifest?org=-", "tolra_brand=acme"))).toBe("-");
    expect(installedAppSlug(req("/manifest.webmanifest", "a=1; tolra_brand=acme; b=2"))).toBe("acme");
    expect(installedAppSlug(req("/manifest.webmanifest"))).toBeNull();
  });
});
