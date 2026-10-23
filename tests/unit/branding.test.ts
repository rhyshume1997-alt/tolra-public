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
