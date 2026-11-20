// QB-1 QuickBooks hardening: refresh/invalid_grant handling, remote revocation on disconnect, stricter company identity.
// Inputs: real provider/connection/route code with injected fetch and fake RPC recorders. Everything is synthetic; no network, no database.
// MUST NOT CHANGE: assertions that no token or provider body is logged/returned, and that disconnect never stores credentials.
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ clients: null as unknown as { service: unknown; userClient: unknown } }));
vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => true, forbiddenOrigin: () => NextResponse.json({}, { status: 403 }),
  isErrorResponse: (value: unknown) => value instanceof NextResponse,
  jsonError: (error: string, status: number) => NextResponse.json({ error }, { status }),
  requireProfile: async () => ({ supabase: h.clients.userClient, profile: { organization_id: "org-a" }, user: { id: "admin-a" }, session: { support: false, read_only: false } }),
}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => h.clients.service }));

import { POST } from "@/app/api/accounting/[provider]/[action]/route";
import { accountingConnection, disconnectAccounting } from "@/lib/accounting/connections";
import { cloudConfig, cloudTenant } from "@/lib/accounting/cloud-adapters";
import { quickbooksRevoke } from "@/lib/accounting/providers/quickbooks";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { freshMfaAuth } from "../support/fresh-mfa";

const ORG = "org-a";
const OLD_REFRESH = "synthetic-old-refresh";
const OLD_ACCESS = "synthetic-old-access";
const NEW_REFRESH = "synthetic-new-refresh";
const NEW_ACCESS = "synthetic-new-access";
const BODY_SECRET = "synthetic-provider-body-secret";
const ctx = (provider: string, purpose: "refresh" | "access" | "pkce") => ({ organizationId: ORG, provider, purpose });
const config = { clientId: "synthetic-app-id", clientSecret: "synthetic-app-secret", redirectUri: "https://tolra.example.test/api/accounting/quickbooks/callback", sandbox: true };

type Opts = { status?: string; lease?: "row" | "busy" | "norefresh"; local?: { code?: string; hint?: string; message?: string } | null; expired?: boolean };
function makeClients(provider: "quickbooks" | "sage" = "quickbooks", opts: Opts = {}) {
  const events: string[] = [];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const row = () => ({
    refresh_token_enc: opts.lease === "norefresh" ? null : encryptSecret(OLD_REFRESH, ctx(provider, "refresh")),
    access_token_enc: encryptSecret(OLD_ACCESS, ctx(provider, "access")),
    access_expires_at: new Date(Date.now() + (opts.expired === false ? 3_600_000 : -1000)).toISOString(), key_version: 1,
  });
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args: structuredClone(args) }); events.push(`rpc:${name}`);
    if (name === "accounting_cloud_connections_ready") return { data: true, error: null };
    if (name === "integration_token_lease") return { data: opts.lease === "busy" ? null : row(), error: null };
    if (name === "integration_oauth_consume") return { data: { verifier_enc: encryptSecret("synthetic-verifier", ctx(provider, "pkce")) }, error: null };
    if (name === "integration_disconnect_revoke" || name === "integration_disconnect") {
      return opts.local ? { data: null, error: { message: opts.local.message ?? "synthetic", code: opts.local.code, hint: opts.local.hint } } : { data: null, error: null };
    }
    return { data: name === "integration_token_store" ? true : null, error: null };
  };
  const from = () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { tenant_id: "1234567890", status: opts.status ?? "connected" }, error: null }) }; return q; };
  const service = { rpc, from };
  const userClient = { rpc, from, auth: freshMfaAuth() };
  h.clients = { service, userClient };
  return { service: service as never, userClient: userClient as never, calls, events, count: (n: string) => calls.filter((c) => c.name === n).length };
}
const adapterFor = async (c: ReturnType<typeof makeClients>) => (await accountingConnection("quickbooks", { userClient: c.userClient, service: c.service, org: ORG, userId: "admin-a" }))!;
const tokenReply = (refresh = NEW_REFRESH) => Response.json({ access_token: NEW_ACCESS, refresh_token: refresh, expires_in: 3600 });
const invoiceReply = () => Response.json({ QueryResponse: { Invoice: [{ DocNumber: "INV-1", TotalAmt: "10.00", Balance: "5.00", CurrencyRef: { value: "GBP" } }] } });
function stubFetch(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>, events?: string[]) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const url = new URL(String(input)); events?.push(`fetch:${url.hostname}${url.pathname}`); return handler(url, init); });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const allOutput = (spies: ReturnType<typeof vi.spyOn>[]) => JSON.stringify(spies.map((s) => s.mock.calls));
const silence = () => (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));

beforeEach(() => {
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
  vi.stubEnv("QUICKBOOKS_CLIENT_ID", config.clientId); vi.stubEnv("QUICKBOOKS_CLIENT_SECRET", config.clientSecret);
  vi.stubEnv("QUICKBOOKS_REDIRECT_URI", config.redirectUri); vi.stubEnv("QUICKBOOKS_ENVIRONMENT", "sandbox");
  vi.stubEnv("SAGE_CLIENT_ID", "sage-id"); vi.stubEnv("SAGE_CLIENT_SECRET", "sage-secret"); vi.stubEnv("SAGE_REDIRECT_URI", "https://tolra.example.test/api/accounting/sage/callback");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("token refresh", () => {
  it("1 stores the rotated refresh token before the new access token is used", async () => {
    const c = makeClients(); const events = c.events;
    stubFetch((url) => (url.hostname === "oauth.platform.intuit.com" ? tokenReply() : invoiceReply()), events);
    await (await adapterFor(c)).checkInvoice("INV-1");
    expect(events.indexOf("rpc:integration_token_store")).toBeGreaterThan(-1);
    expect(events.indexOf("rpc:integration_token_store")).toBeLessThan(events.findIndex((e) => e.endsWith("/query")));
    const stored = c.calls.find((x) => x.name === "integration_token_store")!;
    expect(decryptSecret(String(stored.args.p_refresh_enc), ctx("quickbooks", "refresh"))).toBe(NEW_REFRESH);
  });
  it("2 stores an unchanged refresh token too", async () => {
    const c = makeClients(); stubFetch((url) => (url.hostname === "oauth.platform.intuit.com" ? tokenReply(OLD_REFRESH) : invoiceReply()));
    await (await adapterFor(c)).checkInvoice("INV-1");
    expect(c.count("integration_token_store")).toBe(1);
    expect(decryptSecret(String(c.calls.find((x) => x.name === "integration_token_store")!.args.p_refresh_enc), ctx("quickbooks", "refresh"))).toBe(OLD_REFRESH);
  });
  it("3 invalid_grant marks needs_reconnect once with exactly one token call", async () => {
    const c = makeClients(); const f = stubFetch(() => Response.json({ error: "invalid_grant", error_description: BODY_SECRET }, { status: 400 }));
    const err = await (await adapterFor(c)).checkInvoice("INV-1").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error); expect(String((err as Error).message) + JSON.stringify(c.calls)).not.toContain(BODY_SECRET);
    expect(c.count("integration_mark_needs_reconnect")).toBe(1); expect(f).toHaveBeenCalledTimes(1); expect(c.count("integration_token_store")).toBe(0);
  });
  it("4 invalid_client, 401, 5xx and timeouts are unavailable: no needs_reconnect, no store", async () => {
    const replies: Array<() => Response | Promise<Response>> = [
      () => Response.json({ error: "invalid_client" }, { status: 401 }), () => new Response("boom", { status: 401 }),
      () => new Response("down", { status: 503 }), () => { throw new DOMException("timeout", "TimeoutError"); },
    ];
    for (const reply of replies) {
      const c = makeClients(); stubFetch(reply);
      await expect((await adapterFor(c)).checkInvoice("INV-1")).rejects.toMatchObject({ reason: "unavailable" });
      expect(c.count("integration_mark_needs_reconnect")).toBe(0); expect(c.count("integration_token_store")).toBe(0);
    }
  });
  it("5 a busy lease makes no Intuit call", async () => {
    vi.useFakeTimers(); const c = makeClients("quickbooks", { lease: "busy" }); const f = stubFetch(() => tokenReply());
    const pending = (await adapterFor(c)).checkInvoice("INV-1").catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ reason: "refused" }); expect(f).not.toHaveBeenCalled();
  });
  it("6 a needs_reconnect connection makes no Intuit call on check", async () => {
    const c = makeClients("quickbooks", { status: "needs_reconnect" }); const f = stubFetch(() => tokenReply());
    await expect((await adapterFor(c)).checkInvoice("INV-1")).rejects.toMatchObject({ reason: "refused" });
    expect(f).not.toHaveBeenCalled(); expect(c.count("integration_token_lease")).toBe(0);
  });
});

describe("remote revocation on disconnect", () => {
  it("7 the revoke request is JSON with Basic auth and no redirects", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await quickbooksRevoke(config, OLD_REFRESH, f)).toBe(true);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://developer.api.intuit.com/v2/oauth2/tokens/revoke");
    expect(init).toMatchObject({ method: "POST", redirect: "error" }); expect(init?.signal).toBeDefined();
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json"); expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`);
    expect(JSON.parse(String(init?.body))).toEqual({ token: OLD_REFRESH });
    for (const status of [202, 400, 500]) expect(await quickbooksRevoke(config, OLD_REFRESH, vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status })))).toBe(false);
  });
  it("8 disconnects locally before revoking, then reports revoked with the newest refresh token", async () => {
    silence(); const c = makeClients(); const f = stubFetch(() => new Response("{}", { status: 200 }), c.events);
    expect(await disconnectAccounting("quickbooks", { userClient: c.userClient, service: c.service, org: ORG })).toEqual({ remoteRevocation: "revoked" });
    expect(c.events.indexOf("rpc:integration_disconnect_revoke")).toBeLessThan(c.events.indexOf("fetch:developer.api.intuit.com/v2/oauth2/tokens/revoke"));
    expect(c.events.indexOf("rpc:integration_token_lease")).toBeLessThan(c.events.indexOf("rpc:integration_disconnect_revoke"));
    expect(f).toHaveBeenCalledTimes(1); expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ token: OLD_REFRESH });
    expect(c.count("integration_token_release")).toBe(1);
  });
  it("9 a remote failure keeps the local disconnect and leaks no token or body", async () => {
    for (const failing of [() => new Response(BODY_SECRET, { status: 500 }), () => { throw new Error(`${OLD_REFRESH} ${BODY_SECRET}`); }]) {
      const spies = silence(); const c = makeClients(); stubFetch(failing);
      const result = await disconnectAccounting("quickbooks", { userClient: c.userClient, service: c.service, org: ORG });
      expect(result).toEqual({ remoteRevocation: "local_only" }); expect(c.count("integration_disconnect_revoke")).toBe(1);
      const seen = JSON.stringify([result, allOutput(spies), c.calls.filter((x) => x.name !== "integration_token_lease")]);
      for (const secret of [OLD_REFRESH, OLD_ACCESS, BODY_SECRET]) expect(seen).not.toContain(secret);
      vi.restoreAllMocks();
    }
  });
  it("10 no configuration, no key or no stored refresh token means local only", async () => {
    silence();
    vi.stubEnv("QUICKBOOKS_CLIENT_ID", "");
    let c = makeClients(); let f = stubFetch(() => new Response("{}", { status: 200 }));
    expect(await disconnectAccounting("quickbooks", { userClient: c.userClient, service: c.service, org: ORG })).toEqual({ remoteRevocation: "local_only" });
    expect(f).not.toHaveBeenCalled(); expect(c.count("integration_disconnect_revoke")).toBe(1);
    vi.stubEnv("QUICKBOOKS_CLIENT_ID", config.clientId); vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", "");
    c = makeClients(); f = stubFetch(() => new Response("{}", { status: 200 }));
    expect(await disconnectAccounting("quickbooks", { userClient: c.userClient, service: c.service, org: ORG })).toEqual({ remoteRevocation: "local_only" });
    expect(f).not.toHaveBeenCalled();
    vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
    c = makeClients("quickbooks", { lease: "norefresh" }); f = stubFetch(() => new Response("{}", { status: 200 }));
    expect(await disconnectAccounting("quickbooks", { userClient: c.userClient, service: c.service, org: ORG })).toEqual({ remoteRevocation: "local_only" });
    expect(f).not.toHaveBeenCalled(); expect(c.count("integration_disconnect_revoke")).toBe(1);
  });
  it("11 a retry after a completed disconnect makes no Intuit call and no credential write", async () => {
    silence(); const c = makeClients("quickbooks", { local: { code: "P0001", hint: "not_connected" } }); const f = stubFetch(() => new Response("{}", { status: 200 }));
    expect(await disconnectAccounting("quickbooks", { userClient: c.userClient, service: c.service, org: ORG })).toEqual({ remoteRevocation: "local_only", alreadyDisconnected: true });
    expect(f).not.toHaveBeenCalled(); expect(c.count("integration_token_store") + c.count("integration_store_connection")).toBe(0);
  });
  it("12 no disconnect path stores credentials", async () => {
    silence();
    for (const opts of [{}, { local: { hint: "not_connected" } }, { local: { code: "42501" } }, { lease: "norefresh" as const }]) {
      const c = makeClients("quickbooks", opts); stubFetch(() => new Response("", { status: 500 }));
      await disconnectAccounting("quickbooks", { userClient: c.userClient, service: c.service, org: ORG }).catch(() => undefined);
      expect(c.count("integration_token_store") + c.count("integration_store_connection")).toBe(0);
    }
    const c = makeClients(); stubFetch(() => new Response("{}", { status: 200 }));
    await (await adapterFor(c)).disconnect();
    expect(c.count("integration_token_store") + c.count("integration_store_connection")).toBe(0); expect(c.count("integration_disconnect_revoke")).toBe(1);
  });
  it("13 a refused local disconnect makes no Intuit call and still releases the lease", async () => {
    silence(); const c = makeClients("quickbooks", { local: { code: "42501", message: "not allowed" } }); const f = stubFetch(() => new Response("{}", { status: 200 }));
    await expect(disconnectAccounting("quickbooks", { userClient: c.userClient, service: c.service, org: ORG })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled(); expect(c.count("integration_token_release")).toBe(1);
  });
  it("14 a busy lease during disconnect still disconnects locally and returns local_only", async () => {
    silence(); vi.useFakeTimers(); const c = makeClients("quickbooks", { lease: "busy" }); const f = stubFetch(() => new Response("{}", { status: 200 }));
    const pending = disconnectAccounting("quickbooks", { userClient: c.userClient, service: c.service, org: ORG });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual({ remoteRevocation: "local_only" });
    expect(c.count("integration_token_lease")).toBe(4); expect(c.count("integration_disconnect_revoke")).toBe(1); expect(f).not.toHaveBeenCalled();
  });
});

describe("company identity", () => {
  it("15 CompanyInfo uses the sandbox host by default and production only when configured", async () => {
    const f = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ CompanyInfo: { CompanyName: "Synthetic Co" } }));
    const sandbox = cloudConfig("quickbooks", { QUICKBOOKS_CLIENT_ID: "a", QUICKBOOKS_CLIENT_SECRET: "b", QUICKBOOKS_REDIRECT_URI: config.redirectUri })!;
    const production = cloudConfig("quickbooks", { QUICKBOOKS_CLIENT_ID: "a", QUICKBOOKS_CLIENT_SECRET: "b", QUICKBOOKS_REDIRECT_URI: config.redirectUri, QUICKBOOKS_ENVIRONMENT: "production" })!;
    await cloudTenant("quickbooks", sandbox, "t", "123", f); await cloudTenant("quickbooks", production, "t", "123", f);
    expect(f.mock.calls[0][0]).toBe("https://sandbox-quickbooks.api.intuit.com/v3/company/123/companyinfo/123");
    expect(f.mock.calls[1][0]).toBe("https://quickbooks.api.intuit.com/v3/company/123/companyinfo/123");
  });
  it("16 a bad realm is refused before any Intuit call", async () => {
    const f = vi.fn<typeof fetch>();
    for (const realm of [null, "", "abc", "../x", "12 3", "1".repeat(31)]) await expect(cloudTenant("quickbooks", config, "t", realm, f)).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
  it("17 a CompanyInfo 401 or 403 fails the callback and stores no connection", async () => {
    for (const status of [401, 403]) {
      const c = makeClients(); stubFetch((url) => (url.hostname === "oauth.platform.intuit.com" ? tokenReply() : new Response("denied", { status })));
      await expect((await adapterFor(c)).finish("state", "code", "1234567890")).rejects.toThrow();
      expect(c.count("integration_store_connection")).toBe(0);
    }
  });
  it("18 a missing CompanyInfo, blank name or Fault body is refused", async () => {
    for (const body of [{}, { CompanyInfo: {} }, { CompanyInfo: { CompanyName: "   " } }, { CompanyInfo: { CompanyName: "" } }, { Fault: { Error: [] }, CompanyInfo: { CompanyName: "X" } }]) {
      await expect(cloudTenant("quickbooks", config, "t", "123", vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)))).rejects.toThrow();
    }
    expect(await cloudTenant("quickbooks", config, "t", "123", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ CompanyInfo: { CompanyName: " Synthetic Co " } })))).toEqual({ id: "123", name: "Synthetic Co" });
  });
});

describe("Sage and route", () => {
  it("19 Sage disconnect is unchanged: local only, no lease, no provider call", async () => {
    const c = makeClients("sage"); const f = stubFetch(() => new Response("{}", { status: 200 }));
    expect(await disconnectAccounting("sage", { userClient: c.userClient, service: c.service, org: ORG })).toBeUndefined();
    expect(c.calls.map((x) => x.name)).toEqual(["integration_disconnect_revoke"]); expect(c.calls[0].args).toEqual({ p_provider: "sage" }); expect(f).not.toHaveBeenCalled();
  });
  it("20 the route adds remoteRevocation for QuickBooks only", async () => {
    silence();
    const post = (provider: string) => POST(new Request(`https://tolra.example.test/api/accounting/${provider}/disconnect`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ provider, action: "disconnect" }) });
    makeClients("quickbooks"); stubFetch(() => new Response("{}", { status: 200 }));
    const qbo = await post("quickbooks"); expect(qbo.status).toBe(200); expect(await qbo.json()).toEqual({ disconnected: true, remoteRevocation: "revoked" });
    makeClients("sage");
    const sage = await post("sage"); expect(sage.status).toBe(200); expect(await sage.json()).toEqual({ disconnected: true });
  });
});
