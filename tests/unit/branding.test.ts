import { describe, expect, it } from "vitest";

import { hexOr, isHexColour, isOrgSlug, luminance, PRODUCT_BRANDING, slugFromHost, textOn } from "@/lib/branding";

describe("login branding helpers", () => {
  it("accepts only #rrggbb colours, so nothing else reaches CSS", () => {
    expect(isHexColour("#091949")).toBe(true);
    expect(isHexColour("#09194")).toBe(false);
    expect(isHexColour("red")).toBe(false);
    expect(isHexColour("#091949;background:url(x)")).toBe(false);
    expect(hexOr("#ABCDEF", "#000000")).toBe("#abcdef");
    expect(hexOr("javascript:alert(1)", PRODUCT_BRANDING.primary)).toBe(PRODUCT_BRANDING.primary);
  });

  it("validates organisation slugs", () => {
    expect(isOrgSlug("jnr-engineering")).toBe(true);
    expect(isOrgSlug("marpet")).toBe(true);
    for (const bad of ["", "-jnr", "jnr-", "JNR", "jnr_eng", "../x", "a".repeat(64), null]) expect(isOrgSlug(bad)).toBe(false);
  });

  it("picks readable text on brand colours", () => {
    expect(textOn("#091949")).toBe("#ffffff"); // JNR navy
    expect(textOn("#354f9b")).toBe("#ffffff"); // JNR blue
    expect(textOn("#ffd400")).toBe("#0f172a"); // yellow
    expect(luminance("#ffffff")).toBeCloseTo(1);
    expect(luminance("#000000")).toBeCloseTo(0);
  });

  it("reaches WCAG AA (4.5:1) for the shell text on any brand colour, including mid-tones", () => {
    // An independent contrast calculation (not luminance() from the code under test).
    const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = (hex: string) => 0.2126 * lin(parseInt(hex.slice(1, 3), 16)) + 0.7152 * lin(parseInt(hex.slice(3, 5), 16)) + 0.0722 * lin(parseInt(hex.slice(5, 7), 16));
    const contrast = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    // The two the owner named (they measured 4.33 and 3.99 before), and the colours that already passed keep their text colour.
    for (const brand of ["#2f7ed8", "#777777"]) expect(contrast(textOn(brand), brand)).toBeGreaterThanOrEqual(4.5);
    expect(textOn("#2f7ed8")).toBe("#000000");
    expect(textOn("#777777")).toBe("#000000");
    for (const brand of ["#1d3a6b", "#f5c518", "#ffffff", "#000000", "#475569"]) expect(contrast(textOn(brand), brand)).toBeGreaterThanOrEqual(4.5);
    expect(textOn("#1d3a6b")).toBe("#ffffff");
    expect(textOn("#f5c518")).toBe("#0f172a");
    // A sweep over the whole colour cube (every 15th step of each channel, plus greys): never below 4.5.
    const steps = Array.from({ length: 18 }, (_, i) => Math.min(255, i * 15));
    const hex2 = (n: number) => n.toString(16).padStart(2, "0");
    let worst = Infinity;
    for (const r of steps) for (const g of steps) for (const b of steps) {
      const brand = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
      worst = Math.min(worst, contrast(textOn(brand), brand));
    }
    for (let v = 0; v < 256; v += 1) { const brand = `#${hex2(v)}${hex2(v)}${hex2(v)}`; worst = Math.min(worst, contrast(textOn(brand), brand)); }
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  it("reads the organisation from a tenant subdomain only", () => {
    expect(slugFromHost("jnr-engineering.example.co.uk", "example.co.uk")).toBe("jnr-engineering");
    expect(slugFromHost("JNR-Engineering.Example.co.uk:443", "example.co.uk")).toBe("jnr-engineering");
    expect(slugFromHost("example.co.uk", "example.co.uk")).toBeNull();
    expect(slugFromHost("www.example.co.uk", "example.co.uk")).toBeNull();
    expect(slugFromHost("a.b.example.co.uk", "example.co.uk")).toBeNull();
    expect(slugFromHost("jnr.evil.com", "example.co.uk")).toBeNull();
    expect(slugFromHost("jnr-engineering.example.co.uk", undefined)).toBeNull();
  });
});

import { isValidUsername, normaliseUsername } from "@/lib/username";

describe("usernames", () => {
  it("normalises to lower case and enforces the format", () => {
    expect(normaliseUsername("  JSmith ")).toBe("jsmith");
    for (const ok of ["jsmith", "j.smith", "j_smith-2", "abc", "a".repeat(32)]) expect(isValidUsername(ok)).toBe(true);
    for (const bad of ["ab", "a".repeat(33), ".jsmith", "-js", "j smith", "j@smith", "JSmith", "jsmith!"]) expect(isValidUsername(bad)).toBe(false);
  });
});

describe("product name", () => {
  it("lives in one place and credits the product after the company", async () => {
    const { PRODUCT, withProductCredit } = await import("@/lib/product");
    const { PRODUCT_BRANDING } = await import("@/lib/branding");
    expect(PRODUCT.name).toBe("Tolra");
    expect(PRODUCT.name.startsWith(PRODUCT.monogram)).toBe(true);
    expect(JSON.stringify(PRODUCT)).not.toMatch(/\.(co\.uk|app|com)\b/); // no domain hardcoded
    expect(PRODUCT_BRANDING.name).toBe(PRODUCT.name);
    expect(PRODUCT_BRANDING.tagline).toBe(PRODUCT.tagline);
    expect(withProductCredit("JNR Engineering Ltd")).toBe("JNR Engineering Ltd · Tolra");
  });
});

describe("app icon checks", () => {
  it("reads a PNG's size from its header and rejects other files", async () => {
    const { pngSize, PNG_SIGNATURE } = await import("@/lib/png");
    const header = Buffer.alloc(24);
    PNG_SIGNATURE.copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12, "ascii");
    header.writeUInt32BE(512, 16);
    header.writeUInt32BE(512, 20);
    expect(pngSize(header)).toEqual({ width: 512, height: 512 });
    expect(pngSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
    expect(pngSize(Buffer.from("not a png at all, just text"))).toBeNull();
  });
});
