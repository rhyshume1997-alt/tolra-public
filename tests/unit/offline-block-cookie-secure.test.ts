/**
 * S8-4 (Low): the lock mark this browser writes with document.cookie (tolra_offline_blocked_<id>) carries Secure on https, as the
 * copy the middleware sets does, and still works on http (development: a Secure cookie cannot be set from http://localhost).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { blockOfflineAccess, confirmOfflineAccess, offlineBlockCookieString } from "@/lib/offline/access";

const written: string[] = [];
function page(protocol: string) {
  written.length = 0;
  vi.stubGlobal("document", { get cookie() { return ""; }, set cookie(text: string) { written.push(text); } });
  vi.stubGlobal("window", { location: { protocol }, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, dispatchEvent: () => true });
}
afterEach(() => vi.unstubAllGlobals());

describe("offlineBlockCookieString", () => {
  it("sets Secure on https and keeps Path, SameSite=Strict and the one-year age", () => {
    expect(offlineBlockCookieString("u 1", "https:")).toBe("tolra_offline_blocked_u%201=1; Path=/; Max-Age=31536000; SameSite=Strict; Secure");
  });
  it("leaves Secure off on http, where the browser would drop the cookie", () => {
    expect(offlineBlockCookieString("u1", "http:")).toBe("tolra_offline_blocked_u1=1; Path=/; Max-Age=31536000; SameSite=Strict");
    expect(offlineBlockCookieString("u1", undefined)).not.toMatch(/Secure/);
  });
  it("clears with Max-Age=0 and the same attributes", () => {
    expect(offlineBlockCookieString("u1", "https:", true)).toBe("tolra_offline_blocked_u1=; Path=/; Max-Age=0; SameSite=Strict; Secure");
    expect(offlineBlockCookieString("u1", "http:", true)).toBe("tolra_offline_blocked_u1=; Path=/; Max-Age=0; SameSite=Strict");
  });
});

describe("the lock mark as written by the page", () => {
  it("blockOfflineAccess and confirmOfflineAccess write Secure cookies on https", () => {
    page("https:");
    blockOfflineAccess("https-user");
    confirmOfflineAccess("https-user");
    expect(written).toEqual([
      "tolra_offline_blocked_https-user=1; Path=/; Max-Age=31536000; SameSite=Strict; Secure",
      "tolra_offline_blocked_https-user=; Path=/; Max-Age=0; SameSite=Strict; Secure",
    ]);
  });
  it("and plain cookies on http (development)", () => {
    page("http:");
    blockOfflineAccess("http-user");
    confirmOfflineAccess("http-user");
    expect(written).toEqual([
      "tolra_offline_blocked_http-user=1; Path=/; Max-Age=31536000; SameSite=Strict",
      "tolra_offline_blocked_http-user=; Path=/; Max-Age=0; SameSite=Strict",
    ]);
  });
});
