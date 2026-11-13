import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
import { AccountingError, cloudAuthorize, cloudTenant, cloudTokens } from "@/lib/accounting/cloud-adapters";
import { newAuthorisation } from "@/lib/integrations/xero/oauth";

const config = { clientId: "fake-id", clientSecret: "fake-secret", redirectUri: "https://tolra.example.test/api/accounting/sage/callback", sandbox: false };
const reply = (body: unknown) => vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body));
const tenant = (body: unknown, token = "fake-token") => cloudTenantViaSage(reply(body), token);
const cloudTenantViaSage = (fetchImpl: typeof fetch, token: string) => cloudTenant("sage", config, token, null, fetchImpl);

describe("sageAuthorize", () => {
  it("uses readonly scope, apiv3.1 filter and the exact redirect, with no secret", () => {
    const url = new URL(cloudAuthorize("sage", config, "fake-state", "fake-challenge"));
    expect(url.host + url.pathname).toBe("www.sageone.com/oauth2/auth/central");
    expect(url.searchParams.get("filter")).toBe("apiv3.1");
    expect(url.searchParams.get("scope")).toBe("readonly");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("fake-id");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("state")).toBe("fake-state");
    expect(url.searchParams.get("client_secret")).toBeNull();
    expect(url.toString()).not.toContain("fake-secret");
    expect(url.toString()).not.toContain("full_access");
  });
});

describe("sageTenant business identity", () => {
  it("uses documented displayed_as", async () => {
    expect(await tenant({ $items: [{ id: "b1", displayed_as: "Fake Co", $path: "/businesses/b1" }] })).toEqual({ id: "b1", name: "Fake Co" });
  });
  it("still accepts legacy name", async () => {
    expect(await tenant({ $items: [{ id: "b1", name: "Legacy Co" }] })).toEqual({ id: "b1", name: "Legacy Co" });
  });
  it("prefers displayed_as over name", async () => {
    expect(await tenant({ $items: [{ id: "b1", displayed_as: "New", name: "Old" }] })).toEqual({ id: "b1", name: "New" });
  });
  it("rejects two businesses, $next and empty list as ambiguous", async () => {
    for (const body of [
      { $items: [{ id: "a", displayed_as: "A" }, { id: "b", displayed_as: "B" }] },
      { $items: [{ id: "a", displayed_as: "A" }], $next: "/businesses?page=2" },
      { $items: [] },
    ]) await expect(tenant(body)).rejects.toMatchObject({ message: expect.stringContaining("ambiguous") });
  });
  it("rejects missing, empty or non-string id and name as invalid", async () => {
    const bad = [
      { displayed_as: "A" }, { id: "", displayed_as: "A" }, { id: 5, displayed_as: "A" },
      { id: "a" }, { id: "a", displayed_as: "" }, { id: "a", displayed_as: 7 }, { id: "a", displayed_as: "   " }, { id: "  ", displayed_as: "A" }, { id: "a", name: "  " }, { id: "a", name: "" }, { id: "a", name: 7 }, { id: "a", displayed_as: null, name: "A" },
    ];
    for (const item of bad) await expect(tenant({ $items: [item] })).rejects.toMatchObject({ message: expect.stringContaining("invalid") });
  });
  it("sends only bearer and accept headers and never leaks token or secret in errors", async () => {
    const fetchImpl = reply({ $items: [{ id: "a", displayed_as: "A" }] });
    await cloudTenant("sage", config, "secret-token", null, fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.accounting.sage.com/v3.1/businesses");
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer secret-token", accept: "application/json" });
    const init = fetchImpl.mock.calls[0][1];
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const failing = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-token fake-secret", { status: 500 }));
    const err = await cloudTenant("sage", config, "secret-token", null, failing).catch((e) => e);
    expect(err).toBeInstanceOf(AccountingError);
    expect(String(err.message)).not.toContain("secret-token");
    expect(String(err.message)).not.toContain(config.clientSecret);
    const bad = await tenant({ $items: [{ id: "", displayed_as: "A" }] }, "secret-token").catch((e) => e);
    expect(String(bad.message)).not.toContain("secret-token");
  });
  it("keeps no shared state between companies", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_u, init) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      return Response.json({ $items: [auth === "Bearer token-a" ? { id: "biz-a", displayed_as: "A" } : { id: "biz-b", displayed_as: "B" }] });
    });
    const [a, b] = await Promise.all([cloudTenant("sage", config, "token-a", null, fetchImpl), cloudTenant("sage", config, "token-b", null, fetchImpl)]);
    expect(a.id).toBe("biz-a");
    expect(b.id).toBe("biz-b");
    expect((await cloudTenant("sage", config, "token-a", null, fetchImpl)).id).toBe("biz-a");
  });
});

describe("Sage PKCE S256", () => {
  const tokenReply = () => vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600 }));
  it("authorise URL carries the S256 challenge and no verifier or secret", () => {
    const url = new URL(cloudAuthorize("sage", config, "fake-state", "fake-challenge"));
    expect(url.searchParams.get("code_challenge")).toBe("fake-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.toString()).not.toContain("plain");
    expect(url.searchParams.get("code_verifier")).toBeNull();
    expect(url.searchParams.get("client_secret")).toBeNull();
    expect(() => cloudAuthorize("sage", config, "fake-state", "")).toThrow(AccountingError);
  });
  it("a real newAuthorisation challenge is base64url(sha256(verifier))", () => {
    const auth = newAuthorisation();
    expect(auth.challenge).toBe(createHash("sha256").update(auth.verifier).digest("base64url"));
    const url = new URL(cloudAuthorize("sage", config, auth.state, auth.challenge));
    expect(url.searchParams.get("code_challenge")).toBe(auth.challenge);
    expect(url.toString()).not.toContain(auth.verifier);
  });
  it("code exchange sends code_verifier with the documented form fields", async () => {
    const fetchImpl = tokenReply();
    await cloudTokens("sage", config, { code: "fake-code", verifier: "fake-verifier" }, fetchImpl);
    const body = new URLSearchParams(String(fetchImpl.mock.calls[0][1]?.body));
    expect(Object.fromEntries(body)).toEqual({ grant_type: "authorization_code", code: "fake-code", redirect_uri: config.redirectUri, client_id: "fake-id", client_secret: "fake-secret", code_verifier: "fake-verifier" });
    await expect(cloudTokens("sage", config, { code: "fake-code", verifier: "" }, tokenReply())).rejects.toBeInstanceOf(AccountingError);
  });
  it("refresh grant has no code_verifier", async () => {
    const fetchImpl = tokenReply();
    await cloudTokens("sage", config, { refreshToken: "fake-refresh" }, fetchImpl);
    const body = new URLSearchParams(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.has("code_verifier")).toBe(false);
  });
  it("verifier never appears in thrown errors, even when the token endpoint echoes it", async () => {
    const verifier = "very-secret-verifier-value";
    for (const status of [400, 401, 500]) {
      const failing = vi.fn<typeof fetch>().mockResolvedValue(new Response(`bad code_verifier=${verifier}`, { status }));
      const err = await cloudTokens("sage", config, { code: "fake-code", verifier }, failing).catch((e) => e);
      expect(err).toBeInstanceOf(AccountingError);
      expect(String(err.message)).not.toContain(verifier);
      expect(JSON.stringify(err)).not.toContain(verifier);
    }
  });
});
