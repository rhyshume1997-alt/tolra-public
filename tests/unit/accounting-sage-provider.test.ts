import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { AccountingError } from "@/lib/accounting/cloud-adapters";
import { sageAuthorize, sageTenant } from "@/lib/accounting/providers/sage";

const config = { clientId: "fake-id", clientSecret: "fake-secret", redirectUri: "https://tolra.example.test/api/accounting/sage/callback", sandbox: false };
const reply = (body: unknown) => vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body));
const tenant = (body: unknown, token = "fake-token") => cloudTenantViaSage(reply(body), token);
// Minimal JSON caller equivalent to the shared one: parses JSON, throws AccountingError on non-2xx without leaking bodies.
const call = async (fetchImpl: typeof fetch, url: string, init: RequestInit) => {
  const res = await fetchImpl(url, init);
  if (!res.ok) throw new AccountingError("unavailable");
  return res.json();
};
function cloudTenantViaSage(fetchImpl: typeof fetch, token: string) { return sageTenant(call, token, fetchImpl); }

describe("sageAuthorize", () => {
  it("uses readonly scope, apiv3.1 filter and the exact redirect, with no secret", () => {
    const url = new URL(sageAuthorize(config, "fake-state"));
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
      { id: "a" }, { id: "a", displayed_as: "" }, { id: "a", displayed_as: 7 }, { id: "a", name: "" }, { id: "a", name: 7 }, { id: "a", displayed_as: null, name: "A" },
    ];
    for (const item of bad) await expect(tenant({ $items: [item] })).rejects.toMatchObject({ message: expect.stringContaining("invalid") });
  });
  it("sends only bearer and accept headers and never leaks token or secret in errors", async () => {
    const fetchImpl = reply({ $items: [{ id: "a", displayed_as: "A" }] });
    await sageTenant(call, "secret-token", fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.accounting.sage.com/v3.1/businesses");
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual({ authorization: "Bearer secret-token", accept: "application/json" });
    const failing = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-token fake-secret", { status: 500 }));
    const err = await sageTenant(call, "secret-token", failing).catch((e) => e);
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
    const [a, b] = await Promise.all([sageTenant(call, "token-a", fetchImpl), sageTenant(call, "token-b", fetchImpl)]);
    expect(a.id).toBe("biz-a");
    expect(b.id).toBe("biz-b");
    expect((await sageTenant(call, "token-a", fetchImpl)).id).toBe("biz-a");
  });
});
