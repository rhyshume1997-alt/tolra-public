// Portal core: crypto, cookie and flag. The key is a random value made in this test, never a real secret.
import { createHash, createHmac, randomBytes } from "crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { cleanPortalCode, cleanPortalRef, cleanPortalToken, codeHash, newPortalCode, newPortalRef, newPortalSessionToken, newSigninPairs, portalKey, refHash, tokenHash } from "@/lib/portal/crypto";
import { clearPortalSessionCookie, portalCookieName, portalSessionCookie } from "@/lib/portal/cookie";
import { portalEnabled } from "@/lib/portal/flag";

const rawKey = randomBytes(32);
const envKey = { PORTAL_SIGNIN_HMAC_KEY: rawKey.toString("base64") };

describe("portal crypto", () => {
  it("refHash is SHA-256 hex (known vector)", () => {
    expect(refHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(tokenHash("abc")).toBe(refHash("abc"));
  });
  it("codeHash is the keyed HMAC over ref:code and binds the ref", () => {
    const key = portalKey(envKey)!;
    const sub = createHmac("sha256", key).update("tolra:portal-signin-code:v1").digest();
    expect(codeHash(key, "R".repeat(22), "12345678")).toBe(createHmac("sha256", sub).update(`${"R".repeat(22)}:12345678`).digest("hex"));
    expect(codeHash(key, "A".repeat(22), "12345678")).not.toBe(codeHash(key, "B".repeat(22), "12345678"));
    expect(codeHash(key, "A".repeat(22), "12345678")).not.toBe(codeHash(portalKey({ PORTAL_SIGNIN_HMAC_KEY: randomBytes(32).toString("base64") })!, "A".repeat(22), "12345678"));
  });
  it("fails closed without a usable key", () => {
    expect(portalKey({})).toBeNull();
    expect(portalKey({ PORTAL_SIGNIN_HMAC_KEY: "" })).toBeNull();
    expect(portalKey({ PORTAL_SIGNIN_HMAC_KEY: randomBytes(16).toString("base64") })).toBeNull();
    expect(portalKey({ PORTAL_SIGNIN_HMAC_KEY: "not base64!!" })).toBeNull();
    expect(portalKey(envKey)?.equals(rawKey)).toBe(true);
  });
  it("makes 22-char refs, 8-digit codes, 43-char tokens", () => {
    for (let i = 0; i < 50; i++) {
      expect(newPortalRef()).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(newPortalCode()).toMatch(/^\d{8}$/);
    }
    const { token, tokenHash: h } = newPortalSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h).toBe(createHash("sha256").update(token).digest("hex"));
  });
  it("always makes 10 distinct pairs whose hashes match", () => {
    const key = portalKey(envKey)!;
    const pairs = newSigninPairs(key);
    expect(pairs).toHaveLength(10);
    expect(new Set(pairs.map((p) => p.refHash)).size).toBe(10);
    for (const p of pairs) { expect(p.refHash).toBe(refHash(p.ref)); expect(p.codeHash).toBe(codeHash(key, p.ref, p.code)); }
  });
  it("cleans typed input", () => {
    expect(cleanPortalCode("1234 5678")).toBe("12345678");
    expect(cleanPortalCode("1234-5678")).toBe("12345678");
    for (const bad of ["1234567", "123456789", "abcdefgh", "", null, 12345678]) expect(cleanPortalCode(bad)).toBeNull();
    expect(cleanPortalRef("a".repeat(22))).toBe("a".repeat(22));
    for (const bad of ["a".repeat(21), "a".repeat(23), "a b".padEnd(22, "a"), null]) expect(cleanPortalRef(bad)).toBeNull();
    expect(cleanPortalToken("a".repeat(43))).not.toBeNull();
    expect(cleanPortalToken("a".repeat(42))).toBeNull();
  });
});

describe("portal cookie and flag", () => {
  it("production: __Host-, Secure, HttpOnly, SameSite=Strict, path /, 8 hours, no Domain", () => {
    const c = portalSessionCookie("tok", { NODE_ENV: "production" });
    expect(c).toEqual({ name: "__Host-tolra_portal", value: "tok", httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 28800 });
    expect("domain" in c).toBe(false);
  });
  it("outside production: no __Host- prefix and not Secure, still HttpOnly and Strict", () => {
    const c = portalSessionCookie("tok", { NODE_ENV: "development" });
    expect(c.name).toBe("tolra_portal");
    expect(c.secure).toBe(false);
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe("strict");
    expect(portalCookieName({})).toBe("tolra_portal");
  });
  it("clearing keeps the same name and attributes with maxAge 0", () => {
    const c = clearPortalSessionCookie({ NODE_ENV: "production" });
    expect(c).toMatchObject({ name: "__Host-tolra_portal", value: "", maxAge: 0, secure: true, httpOnly: true, sameSite: "strict", path: "/" });
  });
  it("the platform flag is on only for exactly 'true'", () => {
    expect(portalEnabled({ CUSTOMER_PORTAL_ENABLED: "true" })).toBe(true);
    for (const v of [undefined, "", "TRUE", "1", " true", "yes", "false"]) expect(portalEnabled({ CUSTOMER_PORTAL_ENABLED: v })).toBe(false);
    expect(portalEnabled({})).toBe(false);
  });
});
