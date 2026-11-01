/**
 * E2/E7 (migration 107): app-level credentials (stored row, else the environment, else nothing; a missing 107 table falls back to the
 * environment), the accountant's one-use connect link (token hash, invalid links refused before any database call, the invite state
 * bound to its own state hash and completed for the invite's company only), Microsoft 365's delegated Connect (the state bound to this
 * admin and company, PKCE, the mailbox stored as the connection) and its token refresh under 084's lease. The database, Xero and
 * Microsoft are faked: nothing reaches the network.
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  appSecretContext, databaseHas107, defaultRedirectUri, envCredentials, getAppCredentials, inviteRedirectUri, last4, missingDbObject, validRedirectUri,
} from "@/lib/integrations/app-credentials";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { INVITE_TOKEN, finishInviteConnect, hashInviteToken, inviteConfirmPage, inviteVerifierContext, invitePage, newInviteToken, peekInvite, redeemInvite } from "@/lib/integrations/invite";
import { disconnectAndRevoke } from "@/lib/integrations/server";
import { microsoftTokenSource } from "@/lib/integrations/microsoft/client";
import { beginMicrosoftConnect, finishMicrosoftConnect } from "@/lib/integrations/microsoft/connect";
import { MicrosoftAuthError, authorizeUrl as msAuthorizeUrl, microsoftTenant, refreshTokens as msRefresh } from "@/lib/integrations/microsoft/oauth";
import { cardStatusLabel, connectOutcomeMessage, microsoftOutcomeMessage, notSetUpMessage } from "@/lib/integrations/overview";
import { readOrganisationName } from "@/lib/integrations/xero/client";
import { hashState } from "@/lib/integrations/xero/oauth";

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const ADMIN = "33333333-3333-3333-3333-333333333333";
const key = randomBytes(32);
const SITE = "https://app.example.test";
const env = { NEXT_PUBLIC_SITE_URL: SITE, INTEGRATIONS_ENCRYPTION_KEY: key.toString("base64") };

type Rpc = { fn: string; args: Record<string, unknown> };
/** A fake Supabase client: one answer per table read, rpc answers by name, every rpc recorded. */
function fakeClient(opts: { table?: Record<string, { data: unknown; error: unknown }>; rpc?: Record<string, { data?: unknown; error?: unknown } | ((args: Record<string, unknown>) => { data?: unknown; error?: unknown })> }) {
  const calls: Rpc[] = [];
  const reads: string[] = [];
  const chain = (table: string) => {
    const answer = opts.table?.[table] ?? { data: null, error: null };
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "limit"]) c[m] = () => c;
    c.maybeSingle = async () => answer;
    c.then = (resolve: (v: unknown) => unknown) => resolve(answer);
    return c;
  };
  return {
    calls, reads,
    client: {
      from: (table: string) => { reads.push(table); return chain(table); },
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const a = opts.rpc?.[fn];
        const r = typeof a === "function" ? a(args) : a;
        return { data: r?.data ?? null, error: r?.error ?? null };
      },
    } as never,
  };
}

describe("app credentials: stored row, else environment, else nothing", () => {
  const stored = (provider: "xero" | "microsoft", secret = "stored-secret", k = key) => ({
    data: { provider, client_id: `stored-${provider}`, client_secret_enc: encryptSecret(secret, appSecretContext(provider), k), redirect_uri: `${SITE}/api/integrations/${provider}/callback` },
    error: null,
  });
  const xeroEnv = { ...env, XERO_CLIENT_ID: "env-id", XERO_CLIENT_SECRET: "env-secret", XERO_REDIRECT_URI: `${SITE}/api/integrations/xero/callback` };

  it("the stored row wins over the environment (decrypted on the server)", async () => {
    const svc = fakeClient({ table: { integration_app_credentials: stored("xero") } });
    expect(await getAppCredentials("xero", { service: svc.client, env: xeroEnv, key })).toEqual({
      provider: "xero", clientId: "stored-xero", clientSecret: "stored-secret", redirectUri: `${SITE}/api/integrations/xero/callback`, source: "stored" });
  });

  it("no stored row: the environment; neither: null", async () => {
    const none = fakeClient({ table: { integration_app_credentials: { data: null, error: null } } });
    expect(await getAppCredentials("xero", { service: none.client, env: xeroEnv, key })).toMatchObject({ clientId: "env-id", source: "env" });
    expect(await getAppCredentials("xero", { service: none.client, env, key })).toBeNull();
  });

  it("107 not applied (table missing): the environment, exactly as before", async () => {
    const missing = fakeClient({ table: { integration_app_credentials: { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.integration_app_credentials' in the schema cache" } } } });
    expect(await getAppCredentials("xero", { service: missing.client, env: xeroEnv, key })).toMatchObject({ clientId: "env-id", source: "env" });
    expect(await getAppCredentials("microsoft", { service: missing.client, env, key })).toBeNull();
    expect(missingDbObject({ code: "42P01" })).toBe(true);
    expect(missingDbObject({ code: "42501" })).toBe(false);
  });

  it("a stored secret this server's key can't read falls back to the environment (never a half-read value)", async () => {
    const svc = fakeClient({ table: { integration_app_credentials: stored("xero", "s", randomBytes(32)) } });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await getAppCredentials("xero", { service: svc.client, env: xeroEnv, key })).toMatchObject({ source: "env" });
    expect(await getAppCredentials("xero", { service: svc.client, env, key })).toBeNull();
    expect(err.mock.calls.flat().join(" ")).not.toContain("stored-secret");
    err.mockRestore();
  });

  it("a secret encrypted for one provider does not decrypt as the other's", async () => {
    const svc = fakeClient({ table: { integration_app_credentials: { data: { ...stored("xero").data, provider: "microsoft", redirect_uri: null }, error: null } } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await getAppCredentials("microsoft", { service: svc.client, env, key })).toBeNull();
  });

  it("Microsoft from MS_CLIENT_ID / MS_CLIENT_SECRET with the redirect derived from NEXT_PUBLIC_SITE_URL; redirects are checked", () => {
    expect(envCredentials("microsoft", { ...env, MS_CLIENT_ID: "m", MS_CLIENT_SECRET: "s" })).toEqual({
      provider: "microsoft", clientId: "m", clientSecret: "s", redirectUri: `${SITE}/api/integrations/microsoft/callback`, source: "env" });
    expect(envCredentials("microsoft", { MS_CLIENT_ID: "m", MS_CLIENT_SECRET: "s" })).toBeNull();
    expect(defaultRedirectUri("xero", { NEXT_PUBLIC_SITE_URL: "http://evil.example.test" })).toBeNull();
    expect(validRedirectUri("xero", `${SITE}/api/integrations/microsoft/callback`)).toBeNull();
    expect(validRedirectUri("xero", "http://localhost:3000/api/integrations/xero/callback")).not.toBeNull();
    expect(inviteRedirectUri(`${SITE}/api/integrations/xero/callback`)).toBe(`${SITE}/api/integrations/invite/callback`);
    expect(last4("abcd efgh")).toBe("efgh");
    expect(last4("ab")).toBe("**ab");
  });

  it("databaseHas107: true, false for a missing table, null when it can't tell", async () => {
    expect(await databaseHas107(fakeClient({}).client)).toBe(true);
    expect(await databaseHas107(fakeClient({ table: { integration_connect_invites: { data: null, error: { code: "PGRST205" } } } }).client)).toBe(false);
    expect(await databaseHas107(fakeClient({ table: { integration_connect_invites: { data: null, error: { code: "57014" } } } }).client)).toBeNull();
    expect(await databaseHas107(null)).toBeNull();
  });
});

const xeroReady = { config: { clientId: "xid", clientSecret: "xsecret", redirectUri: `${SITE}/api/integrations/xero/callback` }, key };

describe("the accountant's connect link", () => {
  it("a random 43-character token; only its SHA-256 is sent to the database", () => {
    const a = newInviteToken();
    const b = newInviteToken();
    expect(a.token).toMatch(INVITE_TOKEN);
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).toBe(createHash("sha256").update(a.token).digest("hex"));
    expect(hashInviteToken(a.token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a malformed link is refused before any database call", async () => {
    const svc = fakeClient({});
    for (const bad of ["", "short", `${"a".repeat(42)}!`, "a".repeat(44)]) expect(await redeemInvite(svc.client, bad, xeroReady)).toEqual({ ok: false, reason: "invalid" });
    expect(svc.calls).toEqual([]);
  });

  it("used, expired or unknown (the database refuses): the same 'invalid' answer", async () => {
    const svc = fakeClient({ rpc: { integration_invite_redeem: { error: { code: "42501", message: "expired or used", hint: "invite_invalid" } } } });
    expect(await redeemInvite(svc.client, newInviteToken().token, xeroReady)).toEqual({ ok: false, reason: "invalid" });
  });

  it("a good link: used up with its hash, a state and a verifier bound to that state; Xero's URL comes back to the invite callback", async () => {
    const { token, tokenHash } = newInviteToken();
    const svc = fakeClient({ rpc: { integration_invite_redeem: { data: { organization_id: ORG, provider: "xero" } } } });
    const out = await redeemInvite(svc.client, token, xeroReady);
    expect(out.ok).toBe(true);
    const call = svc.calls[0];
    expect(call.fn).toBe("integration_invite_redeem");
    expect(call.args.p_token_hash).toBe(tokenHash);
    expect(JSON.stringify(call.args)).not.toContain(token);
    const url = new URL((out as { url: string }).url);
    expect(url.searchParams.get("redirect_uri")).toBe(`${SITE}/api/integrations/invite/callback`);
    const state = url.searchParams.get("state")!;
    expect(call.args.p_state_hash).toBe(hashState(state));
    // The verifier decrypts under ITS state's context only.
    const verifier = decryptSecret(String(call.args.p_verifier_enc), inviteVerifierContext(hashState(state)), key);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect(() => decryptSecret(String(call.args.p_verifier_enc), inviteVerifierContext(hashState("another")), key)).toThrow();
  });

  it("the callback: a state that isn't an invite's (or was used) completes nothing", async () => {
    const svc = fakeClient({ rpc: { integration_oauth_consume_invite: { data: null } } });
    const fetchImpl = vi.fn();
    expect(await finishInviteConnect(svc.client, "state", "code", xeroReady, { fetchImpl: fetchImpl as never })).toEqual({ ok: false, reason: "expired" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(svc.calls.map((c) => c.fn)).toEqual(["integration_oauth_consume_invite"]);
  });

  it("the callback: the invite's company and admin, the code exchanged at the invite callback, stored for that company", async () => {
    const state = "the-state";
    const verifierEnc = encryptSecret("the-verifier", inviteVerifierContext(hashState(state)), key);
    const svc = fakeClient({ rpc: { integration_oauth_consume_invite: { data: { organization_id: ORG, user_id: ADMIN, verifier_enc: verifierEnc } } } });
    const at = `h.${Buffer.from(JSON.stringify({ authentication_event_id: "evt" })).toString("base64url")}.s`;
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/connect/token")) { bodies.push(String(init?.body)); return new Response(JSON.stringify({ access_token: at, refresh_token: "r", expires_in: 1800 }), { status: 200 }); }
      return new Response(JSON.stringify([{ id: "c1", tenantId: "t1", tenantName: "Alpha Ltd", tenantType: "ORGANISATION", authEventId: "evt" }]), { status: 200 });
    });
    expect(await finishInviteConnect(svc.client, state, "code", xeroReady, { fetchImpl: fetchImpl as never })).toEqual({ ok: true, tenantName: "Alpha Ltd" });
    expect(new URLSearchParams(bodies[0]).get("redirect_uri")).toBe(`${SITE}/api/integrations/invite/callback`);
    expect(new URLSearchParams(bodies[0]).get("code_verifier")).toBe("the-verifier");
    const store = svc.calls.find((c) => c.fn === "integration_store_connection")!;
    expect(store.args).toMatchObject({ p_org: ORG, p_user: ADMIN, p_provider: "xero", p_tenant_id: "t1" });
    expect(svc.calls[0]).toEqual({ fn: "integration_oauth_consume_invite", args: { p_provider: "xero", p_state_hash: hashState(state) } });
  });

  it("the link's page (peek) asks the database for the company only: nothing is used up; a malformed link asks nothing", async () => {
    const { token, tokenHash } = newInviteToken();
    const svc = fakeClient({ rpc: { integration_invite_peek: { data: { company_name: "Alpha Ltd" } } } });
    expect(await peekInvite(svc.client, token)).toEqual({ companyName: "Alpha Ltd" });
    expect(svc.calls).toEqual([{ fn: "integration_invite_peek", args: { p_token_hash: tokenHash } }]);
    expect(await peekInvite(svc.client, "bad")).toBeNull();
    expect(svc.calls).toHaveLength(1);
    const html = await inviteConfirmPage("A&B <x>").text();
    expect(html).toContain("Connect A&amp;B &lt;x&gt; to Xero");
    expect(html).not.toContain("<x>");
  });

  it("the accountant's page is fixed text (nothing from the request), not cached, framed by nobody", async () => {
    const res = invitePage("<script>");
    const html = await res.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("That didn&apos;t work".replace("&apos;", "'"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await invitePage("connected").text()).toContain("All connected");
  });
});

const msReady = { config: { clientId: "mid", clientSecret: "msecret", redirectUri: `${SITE}/api/integrations/microsoft/callback`, tenant: "organizations" }, key };

describe("Microsoft 365 delegated Connect", () => {
  it("step 1: the state's hash and the verifier (encrypted for THIS company) kept via integration_oauth_start; Microsoft's URL with PKCE and the scopes", async () => {
    const user = fakeClient({});
    const url = new URL(await beginMicrosoftConnect(user.client, ORG, msReady));
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
    // C1 (127): read-only Mail.Read joins the sending scopes (never Mail.ReadWrite).
    expect(url.searchParams.get("scope")).toBe("offline_access Mail.Send Mail.Read User.Read");
    expect(url.searchParams.get("redirect_uri")).toBe(`${SITE}/api/integrations/microsoft/callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("client_secret")).toBe(false);
    const call = user.calls[0];
    expect(call.fn).toBe("integration_oauth_start");
    expect(call.args.p_provider).toBe("microsoft");
    expect(call.args.p_state_hash).toBe(hashState(url.searchParams.get("state")!));
    const verifier = decryptSecret(String(call.args.p_verifier_enc), { organizationId: ORG, provider: "microsoft", purpose: "pkce" }, key);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect(() => decryptSecret(String(call.args.p_verifier_enc), { organizationId: OTHER, provider: "microsoft", purpose: "pkce" }, key)).toThrow();
  });

  it("the callback: the state used up for this admin and company; the mailbox stored as the connection; tokens encrypted", async () => {
    const svc = fakeClient({ rpc: { integration_oauth_consume: { data: { verifier_enc: encryptSecret("v", { organizationId: ORG, provider: "microsoft", purpose: "pkce" }, key) } } } });
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/oauth2/v2.0/token")) { bodies.push(String(init?.body)); return new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }), { status: 200 }); }
      return new Response(JSON.stringify({ id: "oid-1", mail: "office@alpha.example.test", displayName: "Office" }), { status: 200 });
    });
    expect(await finishMicrosoftConnect(svc.client, ORG, ADMIN, "st", "code", msReady, { fetchImpl: fetchImpl as never })).toEqual({ ok: true, mailbox: "office@alpha.example.test", mailRead: false });
    expect(svc.calls[0]).toEqual({ fn: "integration_oauth_consume", args: { p_org: ORG, p_user: ADMIN, p_provider: "microsoft", p_state_hash: hashState("st") } });
    const p = new URLSearchParams(bodies[0]);
    expect([p.get("grant_type"), p.get("code_verifier"), p.get("client_secret"), p.get("redirect_uri")]).toEqual(["authorization_code", "v", "msecret", `${SITE}/api/integrations/microsoft/callback`]);
    const store = svc.calls.find((c) => c.fn === "integration_store_connection")!.args;
    expect(store).toMatchObject({ p_org: ORG, p_user: ADMIN, p_provider: "microsoft", p_tenant_id: "oid-1", p_tenant_name: "office@alpha.example.test" });
    expect(JSON.stringify(store)).not.toContain("\"AT\"");
    expect(decryptSecret(String(store.p_refresh_enc), { organizationId: ORG, provider: "microsoft", purpose: "refresh" }, key)).toBe("RT");
  });

  it("a mailbox linked to another company is refused with its own reason", async () => {
    const svc = fakeClient({ rpc: {
      integration_oauth_consume: { data: { verifier_enc: encryptSecret("v", { organizationId: ORG, provider: "microsoft", purpose: "pkce" }, key) } },
      integration_store_connection: { error: { code: "23505", message: "in use", hint: "tenant_in_use" } },
    } });
    const fetchImpl = vi.fn(async (url: string) => (url.includes("/token")
      ? new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify({ id: "oid-1", userPrincipalName: "a@b.test" }), { status: 200 })));
    expect(await finishMicrosoftConnect(svc.client, ORG, ADMIN, "st", "code", msReady, { fetchImpl: fetchImpl as never })).toEqual({ ok: false, reason: "mailbox_in_use" });
    expect(microsoftOutcomeMessage("mailbox_in_use")).toContain("another company");
  });

  it("tenant: organizations unless MS_TENANT_ID names a directory", () => {
    expect(microsoftTenant({})).toBe("organizations");
    expect(microsoftTenant({ MS_TENANT_ID: "contoso.onmicrosoft.com" })).toBe("contoso.onmicrosoft.com");
    expect(microsoftTenant({ MS_TENANT_ID: "../evil" })).toBe("organizations");
    expect(new URL(msAuthorizeUrl({ ...msReady.config, tenant: "contoso.onmicrosoft.com" }, "s", "c")).pathname).toBe("/contoso.onmicrosoft.com/oauth2/v2.0/authorize");
  });
});

describe("Microsoft 365 token refresh (under 084's lease)", () => {
  const ctx = (purpose: "refresh" | "access") => ({ organizationId: ORG, provider: "microsoft", purpose });
  function leaseDb(lease: Record<string, unknown> | null) {
    return fakeClient({ rpc: { integration_token_lease: { data: lease }, integration_token_store: { data: true } } });
  }

  it("a token still valid is used as it is (no call to Microsoft)", async () => {
    const svc = leaseDb({ refresh_token_enc: encryptSecret("RT", ctx("refresh"), key), access_token_enc: encryptSecret("AT", ctx("access"), key), access_expires_at: new Date(Date.now() + 3_600_000).toISOString(), key_version: 1 });
    const fetchImpl = vi.fn();
    expect(await microsoftTokenSource(svc.client, msReady, fetchImpl as never)(ORG)).toBe("AT");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an expired one is refreshed; the new pair is stored (encrypted) before it is returned", async () => {
    const svc = leaseDb({ refresh_token_enc: encryptSecret("RT", ctx("refresh"), key), access_token_enc: null, access_expires_at: null, key_version: 1 });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }), { status: 200 }));
    expect(await microsoftTokenSource(svc.client, msReady, fetchImpl as never)(ORG)).toBe("AT2");
    const store = svc.calls.find((c) => c.fn === "integration_token_store")!.args;
    expect(store.p_provider).toBe("microsoft");
    expect(decryptSecret(String(store.p_refresh_enc), ctx("refresh"), key)).toBe("RT2");
    // C1 (127): under the lease, the company's own reading state picks the refresh scopes (no 127 here: sending only).
    expect(svc.calls.map((c) => c.fn)).toEqual(["integration_token_lease", "mailbox_sync_due", "integration_token_store", "integration_token_release"]);
    expect(svc.calls[1].args).toEqual({ p_org: ORG });
  });

  it("Microsoft answers without a new refresh token: the old one is kept", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "AT3", expires_in: 3600 }), { status: 200 }));
    expect(await msRefresh(msReady.config, "RT-old", fetchImpl as never)).toMatchObject({ accessToken: "AT3", refreshToken: "RT-old" });
  });

  it("invalid_grant: needs connecting again (Microsoft 365's words), null", async () => {
    const svc = leaseDb({ refresh_token_enc: encryptSecret("RT", ctx("refresh"), key), access_token_enc: null, access_expires_at: null, key_version: 1 });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "AADSTS70000 secret detail" }), { status: 400 }));
    expect(await microsoftTokenSource(svc.client, msReady, fetchImpl as never)(ORG)).toBeNull();
    const mark = svc.calls.find((c) => c.fn === "integration_mark_needs_reconnect")!.args;
    expect(mark).toMatchObject({ p_org: ORG, p_provider: "microsoft" });
    expect(String(mark.p_reason)).toContain("Microsoft 365 refused the stored sign-in");
    await expect(msRefresh(msReady.config, "r", fetchImpl as never)).rejects.toBeInstanceOf(MicrosoftAuthError);
    await expect(msRefresh(msReady.config, "r", fetchImpl as never)).rejects.not.toHaveProperty("message", expect.stringContaining("AADSTS"));
  });
});

describe("disconnect cancels the open links (107), and falls back to 084's disconnect before 107", () => {
  it("107: integration_disconnect_revoke only", async () => {
    const user = fakeClient({});
    await disconnectAndRevoke(user.client, "xero");
    expect(user.calls.map((c) => c.fn)).toEqual(["integration_disconnect_revoke"]);
  });
  it("before 107 (function missing): 084's integration_disconnect, as before", async () => {
    const user = fakeClient({ rpc: { integration_disconnect_revoke: { error: { code: "PGRST202", message: "Could not find the function" } } } });
    await disconnectAndRevoke(user.client, "microsoft");
    expect(user.calls).toEqual([{ fn: "integration_disconnect_revoke", args: { p_provider: "microsoft" } }, { fn: "integration_disconnect", args: { p_provider: "microsoft" } }]);
  });
  it("any other refusal is the answer (no second try)", async () => {
    const user = fakeClient({ rpc: { integration_disconnect_revoke: { error: { code: "P0002", message: "not connected", hint: "not_connected" } } } });
    await expect(disconnectAndRevoke(user.client, "xero")).rejects.toMatchObject({ hint: "not_connected" });
    expect(user.calls).toHaveLength(1);
  });
});

describe("Xero Test: the connected organisation's name", () => {
  it("reads GET /Organisation with the tenant header; Xero's own reason when refused", async () => {
    const seen: Array<Record<string, string>> = [];
    const ok = vi.fn(async (_u: string, init?: RequestInit) => { seen.push(init?.headers as Record<string, string>); return new Response(JSON.stringify({ Organisations: [{ Name: "Alpha Ltd" }] }), { status: 200 }); });
    expect(await readOrganisationName("AT", "tenant-1", ok as never)).toBe("Alpha Ltd");
    expect(seen[0]).toMatchObject({ authorization: "Bearer AT", "xero-tenant-id": "tenant-1" });
    const refused = vi.fn(async () => new Response(JSON.stringify({ Detail: "AuthenticationUnsuccessful" }), { status: 403 }));
    await expect(readOrganisationName("AT", "t", refused as never)).rejects.toMatchObject({ outcome: "forbidden" });
  });
});

describe("what Admin > Integrations says", () => {
  it("All connected; Not set up yet; the Microsoft card never says 'Not connected' (the Xero card's words)", () => {
    expect(cardStatusLabel({ status: "connected" })).toBe("All connected");
    expect(cardStatusLabel({ status: "not_connected" })).toBe("Not connected");
    expect(cardStatusLabel({ status: "not_connected" }, "microsoft")).not.toContain("Not connected");
    expect(notSetUpMessage("xero")).toBe("Not set up yet: the owner must enter the Xero app details.");
    expect(notSetUpMessage("microsoft")).toBe("Not set up yet: the owner must enter the Microsoft 365 app details.");
    expect(connectOutcomeMessage("connected")).toBe("All connected: Xero.");
    expect(microsoftOutcomeMessage("connected")).toBe("All connected: Microsoft 365.");
  });
});
