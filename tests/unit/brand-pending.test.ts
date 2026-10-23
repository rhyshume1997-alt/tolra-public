import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PRODUCT_BRANDING } from "@/lib/branding";
import { NEUTRAL_BRAND, isCompanyPending, shellColours } from "@/lib/brand-pending";

describe("until the company is known, the header and colours are neutral", () => {
  it("pending = no profile and still loading", () => {
    expect(isCompanyPending(null, true)).toBe(true);
    expect(isCompanyPending(undefined, true)).toBe(true);
    expect(isCompanyPending(null, false)).toBe(false); // loaded, the company has no profile: the product's own look
    expect(isCompanyPending({ name: "JNR" }, true)).toBe(false);
    expect(isCompanyPending({ name: "JNR" }, false)).toBe(false);
  });

  it("while pending the colours are the plain neutral, neither the product's navy nor a company's", () => {
    const colours = shellColours(null, true);
    expect(colours.primary).toBe(NEUTRAL_BRAND.primary);
    expect(colours.accent).toBe(NEUTRAL_BRAND.accent);
    expect(colours.primary).not.toBe(PRODUCT_BRANDING.primary.toLowerCase());
    expect(colours.primary).not.toBe(PRODUCT_BRANDING.primary);
    expect(colours.ink).toBe("#ffffff");
  });

  it("once known they are the company's; a company with none set, or no profile at all, gets the product's", () => {
    expect(shellColours({ brandPrimary: "#7a1f1f", brandAccent: "#b03030" }, false)).toEqual({ primary: "#7a1f1f", accent: "#b03030", ink: "#ffffff" });
    expect(shellColours({ brandPrimary: "", brandAccent: "" }, false)).toMatchObject({ primary: PRODUCT_BRANDING.primary, accent: PRODUCT_BRANDING.accent });
    expect(shellColours(null, false)).toMatchObject({ primary: PRODUCT_BRANDING.primary });
  });
});

describe("the shell uses it", () => {
  it("the sidebar shows a placeholder, not the product name, until the company is known; Tolra stays the small credit after", () => {
    const sidebar = readFileSync("components/sidebar.tsx", "utf8");
    expect(sidebar).toContain("const companyPending = isCompanyPending(company, companyLoading);");
    expect(sidebar).toContain('data-testid="company-pending"');
    expect(sidebar).toContain("{company ? <p className=\"label-mono mt-1 text-brand-ink/50\">{PRODUCT.name}</p> : null}");
    // The product name is only ever the fallback of a finished load, inside the not-pending branch.
    expect(sidebar.indexOf("companyPending ? (")).toBeLessThan(sidebar.indexOf("company?.name ?? PRODUCT.name"));
  });

  it("the topbar fallback is the company (or a placeholder), not the product name", () => {
    const topbar = readFileSync("components/topbar.tsx", "utf8");
    expect(topbar).toContain("pageTitles[pathname] ?? company?.name ?? PRODUCT.name");
    expect(topbar).toContain('data-testid="title-pending"');
  });

  it("the colours are set before first paint, from the shared rule", () => {
    const theme = readFileSync("components/theme-colour.tsx", "utf8");
    expect(theme).toContain("useLayoutEffect");
    expect(theme).not.toMatch(/\buseEffect\b/);
    expect(theme).toContain("shellColours(profile, loading)");
  });
});
