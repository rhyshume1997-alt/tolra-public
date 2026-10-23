/**
 * Tokens at rest and the Xero sign-in (G22, migration 084, Lot B §2.6): AES-256-GCM bound to company, provider and slot, in the exact form
 * the database's CHECK accepts; the key's absence or a wrong length is an error naming the variable, never a value. OAuth: PKCE S256, the
 * state hashed for the database, the client secret only on the token call, invalid_grant marks "connect again", and the organisation
 * this consent connected is taken only when it is exactly one. Xero itself is mocked: nothing here reaches the network.
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { IntegrationCryptoError, decryptSecret, encryptSecret, encryptionKey } from "@/lib/integrations/crypto";
import { ProviderError } from "@/lib/integrations/types";
import { XeroAuthError, authorizeUrl, chooseConnection, exchangeCode, hashState, listConnections, newAuthorisation, refreshTokens, xeroConfig } from "@/lib/integrations/xero/oauth";

const key = randomBytes(32);
const ctx = { organizationId: "11111111-1111-1111-1111-111111111111", provider: "xero", purpose: "refresh" as const };
/** migration 084's CHECK on integration_secrets.refresh_token_enc / access_token_enc / integration_oauth_states.verifier_enc. */
const DB_FORM = /^v[0-9]{1,3}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

describe("encryption at rest", () => {
  it("round-trips, in the database's form, never containing the plaintext; a fresh IV each time", () => {
    const token = "eyJhbGciOiJSUzI1NiJ9.refresh-token-value";
    const a = encryptSecret(token, ctx, key);
    const b = encryptSecret(token, ctx, key);
    expect(a).toMatch(DB_FORM);
    expect(a).not.toBe(b);
    expect(a).not.toContain("refresh-token-value");
    expect(decryptSecret(a, ctx, key)).toBe(token);
  });

  it("is bound to its company, provider and slot, and refuses a tampered value or another key", () => {
    const stored = encryptSecret("secret", ctx, key);
    for (const other of [{ ...ctx, organizationId: "22222222-2222-2222-2222-222222222222" }, { ...ctx, purpose: "access" as const }, { ...ctx, provider: "quickbooks" }]) {
      expect(() => decryptSecret(stored, other, key)).toThrow(IntegrationCryptoError);
    }
    const parts = stored.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), ctx, key)).toThrow(/could not be decrypted/);
    expect(() => decryptSecret(stored, ctx, randomBytes(32))).toThrow(IntegrationCryptoError);
    expect(() => decryptSecret(stored.replace(/^v1\./, "v2."), ctx, key)).toThrow(/key version 2/);
    expect(() => decryptSecret("plain", ctx, key)).toThrow(/expected form/);
  });

  it("the key comes only from INTEGRATIONS_ENCRYPTION_KEY: 32 bytes, base64; errors name the variable, never a value", () => {
    expect(() => encryptionKey({})).toThrow(/INTEGRATIONS_ENCRYPTION_KEY is not set/);
    const short = Buffer.from("short").toString("base64");
    try {
      encryptionKey({ INTEGRATIONS_ENCRYPTION_KEY: short });
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/32 random bytes/);
      expect((err as Error).message).not.toContain(short);
    }
    expect(encryptionKey({ INTEGRATIONS_ENCRYPTION_KEY: key.toString("base64") }).equals(key)).toBe(true);
  });
});

const env = { XERO_CLIENT_ID: "client-id", XERO_CLIENT_SECRET: "client-secret", XERO_REDIRECT_URI: "https://app.example.test/api/integrations/xero/callback" };

describe("configuration", () => {
  it("all three values, an https (or localhost) redirect to the callback route; otherwise Xero is off", () => {
    expect(xeroConfig(env)).toEqual({ clientId: "client-id", clientSecret: "client-secret", redirectUri: env.XERO_REDIRECT_URI });
    expect(xeroConfig({ ...env, XERO_CLIENT_SECRET: "" })).toBeNull();
    expect(xeroConfig({ ...env, XERO_REDIRECT_URI: "http://app.example.test/api/integrations/xero/callback" })).toBeNull();
    expect(xeroConfig({ ...env, XERO_REDIRECT_URI: "https://app.example.test/elsewhere" })).toBeNull();
    expect(xeroConfig({ ...env, XERO_REDIRECT_URI: "http://localhost:3000/api/integrations/xero/callback" })).not.toBeNull();
  });
});

describe("authorisation", () => {
  it("state (only its hash is kept) and PKCE S256; the URL carries no secret", () => {
    const a = newAuthorisation();
    expect(a.stateHash).toBe(createHash("sha256").update(a.state).digest("hex"));
    expect(hashState(a.state)).toMatch(/^[0-9a-f]{64}$/);
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
    const url = new URL(authorizeUrl(xeroConfig(env)!, a.state, a.challenge));
    expect(url.origin + url.pathname).toBe("https://login.xero.com/identity/connect/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: "code", client_id: "client-id", redirect_uri: env.XERO_REDIRECT_URI,
      state: a.state, code_challenge: a.challenge, code_challenge_method: "S256" });
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("scope")).not.toMatch(/payments|bank/);
    expect(url.toString()).not.toContain("client-secret");
    expect(url.toString()).not.toContain(a.verifier);
  });
});

const jwt = (payload: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const ok = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });

describe("token calls (Xero mocked)", () => {
  it("the code is exchanged with the client secret (Basic) and the PKCE verifier; the consent's event id is read from the token", async () => {
    const fetchImpl = vi.fn(async () => ok({ access_token: jwt({ authentication_event_id: "evt-1" }), refresh_token: "r-1", expires_in: 1800 }));
    const set = await exchangeCode(xeroConfig(env)!, "the-code", "the-verifier", fetchImpl as unknown as typeof fetch, () => 0);
    expect(set).toMatchObject({ refreshToken: "r-1", authEventId: "evt-1", expiresAt: new Date(1_800_000) });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://identity.xero.com/connect/token");
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ grant_type: "authorization_code", code: "the-code", redirect_uri: env.XERO_REDIRECT_URI, code_verifier: "the-verifier" });
  });

  it("a refused refresh token is invalid_grant (connect again); a 5xx or no answer is unknown; neither message carries a token", async () => {
    const refused = vi.fn(async () => ok({ error: "invalid_grant", error_description: "token r-secret is not valid" }, 400));
    const err = await refreshTokens(xeroConfig(env)!, "r-secret", refused as unknown as typeof fetch).catch((e) => e);
    expect(err).toBeInstanceOf(XeroAuthError);
    expect(err.code).toBe("invalid_grant");
    expect(err.message).not.toContain("r-secret");
    await expect(refreshTokens(xeroConfig(env)!, "r", (async () => ok({}, 503)) as unknown as typeof fetch)).rejects.toMatchObject({ outcome: "unknown" });
    await expect(refreshTokens(xeroConfig(env)!, "r", (async () => { throw new Error("socket"); }) as unknown as typeof fetch)).rejects.toBeInstanceOf(ProviderError);
  });

  it("the organisation this consent connected is taken only when it is exactly one; never guessed", async () => {
    const list = await listConnections("at", (async () => ok([
      { id: "c1", tenantId: "t1", tenantName: "JNR Ltd", tenantType: "ORGANISATION", authEventId: "evt-1" },
      { id: "c2", tenantId: "t2", tenantName: "Marpet Ltd", tenantType: "ORGANISATION", authEventId: "evt-0" },
      { id: "c3", tenantId: "p1", tenantName: "Practice", tenantType: "PRACTICEMANAGER", authEventId: "evt-1" },
    ])) as unknown as typeof fetch);
    expect(chooseConnection(list, "evt-1")).toMatchObject({ ok: true, connection: { tenantId: "t1", tenantName: "JNR Ltd" } });
    expect(chooseConnection(list, "evt-9")).toMatchObject({ ok: false, reason: "none" });
    expect(chooseConnection(list.map((c) => ({ ...c, authEventId: "evt-1" })), "evt-1")).toMatchObject({ ok: false, reason: "several" });
    // Without an event id, only a single organisation in the list is taken.
    expect(chooseConnection(list, null)).toMatchObject({ ok: false });
    expect(chooseConnection([list[0]], null)).toMatchObject({ ok: true });
  });
});
