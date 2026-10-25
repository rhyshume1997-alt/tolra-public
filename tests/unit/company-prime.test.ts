/**
 * The shell's brand (lib/brand-pending shellBrandFrom, lib/company primeShellBrand): the server hands the browser only the company's
 * name, brand colours and logo URL before hydration, never the rest of the stored profile (address, VAT number, bank details...).
 * The browser holds it for the shell only, until the full profile loads. Browser only (on the server the module's state would be
 * shared by every request), once per page load, never after a reset, and never visible to the code that prints or edits company details.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORED = {
  name: "Alpha Ltd",
  documentName: "Alpha Ltd",
  addressLines: ["1 Test Street"],
  vatRegistered: true,
  vatNumber: "GB 000 0000 00",
  bankDetails: { accountName: "Alpha Ltd", sortCode: "11-22-33", accountNumber: "12345678" },
  defaultCustomerMessage: ["Thank you."],
  brandPrimary: "#112233",
  logoPath: "org-a/logo-1.png",
};

async function freshModule() {
  vi.resetModules();
  return import("@/lib/company");
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function brandOf(organizationId: string, raw: unknown) {
  const { shellBrandFrom } = await import("@/lib/brand-pending");
  return shellBrandFrom(organizationId, raw);
}

describe("shellBrandFrom (what the server puts in the page)", () => {
  it("is only the name, the two colours and the logo URL: nothing else from the stored profile", async () => {
    const { companyLogoUrl } = await import("@/lib/branding");
    const brand = await brandOf("org-a", STORED);
    expect(brand).toEqual({ name: "Alpha Ltd", brandPrimary: "#112233", brandAccent: "", logoUrl: companyLogoUrl("org-a", "org-a/logo-1.png") });
    expect(JSON.stringify(brand)).not.toMatch(/GB 000|11-22-33|12345678|1 Test Street|Thank you|bank/i);
  });

  it("falls back to the document name, drops a colour that is not a hex colour, and gives no URL for a logo outside the company's folder", async () => {
    const brand = await brandOf("org-a", { documentName: "Doc Name Ltd", addressLines: ["1 Test Street"], vatRegistered: false, brandPrimary: "red; }</style>", brandAccent: "#ABCDEF", logoPath: "org-b/logo-1.png" });
    expect(brand).toEqual({ name: "Doc Name Ltd", brandPrimary: "", brandAccent: "#abcdef", logoUrl: undefined });
  });

  it("is null without a name or without a stored profile (the browser then reads it as before)", async () => {
    expect(await brandOf("org-a", { addressLines: ["1 Test Street"] })).toBeNull();
    expect(await brandOf("org-a", null)).toBeNull();
    expect(await brandOf("org-a", "text")).toBeNull();
  });

  it("is null for an incomplete profile, exactly when the app's own parse is (no company brand flashing before the product's)", async () => {
    const { parseCompanyProfile } = await import("@/lib/company");
    const cases: unknown[] = [
      STORED,
      { name: "Marpet" },
      { name: "Marpet", documentName: "Marpet", addressLines: [] },
      { name: "Marpet", documentName: "Marpet", addressLines: ["1 Yard"] },
      { name: "Marpet", documentName: "Marpet", addressLines: ["1 Yard"], vatRegistered: false },
      { name: "Marpet", documentName: "Marpet", addressLines: ["1 Yard"], vatNumber: "GB 1" },
      { documentName: "Doc Only", addressLines: ["1 Yard"], vatNumber: "GB 1" },
      { name: "Name Only", addressLines: ["1 Yard"], vatNumber: "GB 1" },
      { name: "", documentName: "", addressLines: ["1 Yard"], vatNumber: "GB 1" },
    ];
    for (const raw of cases) {
      expect((await brandOf("org-a", raw)) === null, JSON.stringify(raw)).toBe(parseCompanyProfile(raw) === null);
    }
  });
});

describe("primeShellBrand", () => {
  const BRAND = { name: "Alpha Ltd", brandPrimary: "#112233", brandAccent: "", logoUrl: "/api/company-logo?org=org-a&v=abc" };

  it("does nothing on the server", async () => {
    const company = await freshModule();
    company.primeShellBrand(BRAND);
    expect(() => company.getCompanyProfile()).toThrow(company.CompanyProfileMissingError);
  });

  it("holds the brand in the browser, for the shell only", async () => {
    vi.stubGlobal("window", {});
    const company = await freshModule();
    company.primeShellBrand(BRAND);
    expect(company.getShellBrand()).toEqual(BRAND);
  });

  it("is never the company profile: documents and settings still wait for the full read", async () => {
    vi.stubGlobal("window", {});
    // No Supabase client in this test, whatever the environment: CI's unit job sets placeholder NEXT_PUBLIC_SUPABASE_* values, so
    // the real module would build a client and the full read below would go to the network and time out (CI run 40182770805).
    vi.doMock("@/lib/supabase", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/supabase")>()), supabase: null }));
    try {
      const company = await freshModule();
      company.primeShellBrand(BRAND);
      expect(() => company.getCompanyProfile()).toThrow(company.CompanyProfileMissingError);
      // The full read finds nothing, so a document is refused, never printed from the shell's brand.
      await expect(company.requireCompanyProfile()).rejects.toThrow(company.CompanyProfileMissingError);
    } finally {
      vi.doUnmock("@/lib/supabase");
    }
  });

  it("works once: a second hold (another company) is ignored", async () => {
    vi.stubGlobal("window", {});
    const company = await freshModule();
    company.primeShellBrand(BRAND);
    company.primeShellBrand({ ...BRAND, name: "Beta Ltd" });
    expect(company.getShellBrand()?.name).toBe("Alpha Ltd");
  });

  it("never holds anything after a reset (sign-out or company switch: the page is being left)", async () => {
    vi.stubGlobal("window", {});
    const company = await freshModule();
    company.resetCompanyProfile();
    company.primeShellBrand(BRAND);
    expect(company.getShellBrand()).toBeNull();
    expect(() => company.getCompanyProfile()).toThrow(company.CompanyProfileMissingError);
  });

  it("shows the held brand while the full profile loads, then the full profile (found or not)", async () => {
    const { pickShellCompany } = await freshModule();
    const held = { name: "Alpha Ltd", brandPrimary: "#112233", brandAccent: "", logoUrl: "/x" };
    const full = { ...held, name: "Alpha Ltd (full)" };
    expect(pickShellCompany(null, true, held)).toEqual({ profile: held, loading: false });
    expect(pickShellCompany(null, true, null)).toEqual({ profile: null, loading: true });
    expect(pickShellCompany(full, false, held)).toEqual({ profile: full, loading: false });
    expect(pickShellCompany(null, false, held)).toEqual({ profile: null, loading: false });
  });

  it("strips the logo URL from what is saved", async () => {
    const company = await freshModule();
    const stored = company.storedProfile({ ...company.JNR_PROFILE, logoUrl: "/api/company-logo?org=x&v=1", logoSrc: "data:x" });
    expect(stored).not.toHaveProperty("logoUrl");
    expect(stored).not.toHaveProperty("logoSrc");
  });
});
