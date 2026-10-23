/**
 * Known-breach check for chosen passwords (k-anonymity range API): private, server side, and it fails open.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { breachedCheckEnabled, isBreachedPassword } from "@/lib/server/breached-password";

const ON = { BREACHED_PASSWORD_CHECK: "on" };
const sha1 = (text: string) => createHash("sha1").update(text, "utf8").digest("hex").toUpperCase();
const answer = (body: string, status = 200) => vi.fn(async () => new Response(body, { status }));

describe("switch", () => {
  it("on only when asked, or by default in Vercel Production", () => {
    expect(breachedCheckEnabled({})).toBe(false);
    expect(breachedCheckEnabled({ VERCEL_ENV: "preview" })).toBe(false);
    expect(breachedCheckEnabled({ VERCEL_ENV: "production" })).toBe(true);
    expect(breachedCheckEnabled({ VERCEL_ENV: "production", BREACHED_PASSWORD_CHECK: "off" })).toBe(false);
    expect(breachedCheckEnabled({ BREACHED_PASSWORD_CHECK: "on" })).toBe(true);
  });

  it("when off it makes no request at all", async () => {
    const fetchImpl = answer("");
    expect(await isBreachedPassword("password12345", { fetchImpl, env: {} })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("isBreachedPassword", () => {
  it("sends only the first five characters of the SHA-1, never the password or the full hash", async () => {
    const password = "correct horse 1 battery";
    const fetchImpl = answer("0000000000000000000000000000000000A:3\r\n");
    await isBreachedPassword(password, { fetchImpl, env: ON });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${sha1(password).slice(0, 5)}`);
    expect(url).not.toContain(sha1(password).slice(5));
    expect(url).not.toContain(encodeURIComponent(password));
    expect((init.headers as Record<string, string>)["Add-Padding"]).toBe("true");
    expect(JSON.stringify(init)).not.toContain(password);
  });

  it("true when the suffix is listed with a count; padding rows (count 0) and other suffixes don't match", async () => {
    const password = "Summer2024Summer2024";
    const suffix = sha1(password).slice(5);
    expect(await isBreachedPassword(password, { fetchImpl: answer(`AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:2\r\n${suffix}:48211\r\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:0`), env: ON })).toBe(true);
    expect(await isBreachedPassword(password, { fetchImpl: answer(`${suffix}:0\r\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:5`), env: ON })).toBe(false);
    expect(await isBreachedPassword(password, { fetchImpl: answer(""), env: ON })).toBe(false);
  });

  it("fails open: an error status, a network error or a timeout lets the password through", async () => {
    expect(await isBreachedPassword("anything12345", { fetchImpl: answer("busy", 503), env: ON })).toBe(false);
    expect(await isBreachedPassword("anything12345", { fetchImpl: vi.fn(async () => { throw new TypeError("fetch failed"); }), env: ON })).toBe(false);
    const hang = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    expect(await isBreachedPassword("anything12345", { fetchImpl: hang as unknown as typeof fetch, timeoutMs: 20, env: ON })).toBe(false);
  });
});
