import { describe, expect, it } from "vitest";
import { headerText } from "@/lib/mail-header";
import { sameOrigin } from "@/lib/server/auth";

// Actual helpers, no mocked backend or mail provider.
describe("S3: one-line cutover mail subjects", () => {
  it.each(["\r\n", "\n", "\u0085", "\u2028", "\u2029", "\u0000\t"])("flattens separator %j", separator => {
    expect(headerText(`Invoice${separator}Bcc: other@example.test`)).toBe("Invoice Bcc: other@example.test");
  });
  it("preserves the real reference, amount and punctuation", () => {
    expect(headerText("  JNR invoice INV-123 — £120.50  ")).toBe("JNR invoice INV-123 — £120.50");
  });
});
describe("S4: tolra.co.uk browser request origin", () => {
  const request = (origin: string | null, site = "same-origin") => new Request("https://tolra.co.uk/api/audit", {
    method: "POST", headers: { host: "tolra.co.uk", "sec-fetch-site": site, ...(origin === null ? {} : { origin }) },
  });
  it("allows the canonical site's own browser request", () => {
    expect(sameOrigin(request("https://tolra.co.uk"))).toBe(true);
  });
  it.each(["https://tolra.co.uk.attacker.test", "https://tolra.co.uk@attacker.test", "https://attacker.test/?next=https://tolra.co.uk", "https://www.tolra.co.uk", "https://tolra.co.uk:8443", "null"])("refuses foreign or opaque origin %s", origin => {
    expect(sameOrigin(request(origin))).toBe(false);
  });
  it("refuses cross-site fetch without Origin or with a matching Origin", () => {
    expect(sameOrigin(request(null, "cross-site"))).toBe(false);
    expect(sameOrigin(request("https://tolra.co.uk", "cross-site"))).toBe(false);
  });
});
