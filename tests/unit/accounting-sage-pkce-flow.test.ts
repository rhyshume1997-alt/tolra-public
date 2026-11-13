/**
 * BOUNDARY (module 6): real connection begin/finish, crypto and provider transport -> Sage S256 proof.
 * RPC fixture models the existing single-use/ten-minute bound-state contract; it is not independent database evidence.
 * Preserve shared connection logic and Xero/QuickBooks behaviour. No SQL, real credentials or external calls.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { accountingConnection } from "@/lib/accounting/connections";
import { cloudAuthorize, cloudTokens } from "@/lib/accounting/cloud-adapters";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { hashState, newAuthorisation } from "@/lib/integrations/xero/oauth";

type State = { org: string; admin: string; provider: string; hash: string; encrypted: string; expires: number; consumed: boolean };
const key = Buffer.alloc(32, 43);
const org = "00000000-0000-4000-8000-000000000001";
const admin = "00000000-0000-4000-8000-000000000002";
const config = { clientId: "synthetic-id", clientSecret: "synthetic-secret", redirectUri: "https://app.test/api/accounting/sage/callback" };
let stored: State | null;
let saved: Record<string, unknown> | null;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

function clients(company = org, user = admin) {
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "accounting_cloud_connections_ready") return { data: true, error: null };
    if (name === "integration_oauth_start") {
      stored = { org: company, admin: user, provider: String(args.p_provider), hash: String(args.p_state_hash), encrypted: String(args.p_verifier_enc), expires: Date.now() + 600_000, consumed: false };
      return { data: null, error: null };
    }
    if (name === "integration_oauth_consume") {
      const s = stored;
      if (!s || s.consumed || s.expires <= Date.now() || args.p_org !== s.org || args.p_user !== s.admin || args.p_provider !== s.provider || args.p_state_hash !== s.hash) {
        return { data: null, error: { message: "Connect refused", code: "42501", hint: "oauth_state_invalid" } };
      }
      s.consumed = true;
      return { data: { verifier_enc: s.encrypted }, error: null };
    }
    if (name === "integration_store_connection") { saved = args; return { data: null, error: null }; }
    throw new Error(`Unexpected RPC ${name}`);
  };
  const client = { rpc } as unknown as SupabaseClient;
  return { userClient: client, service: client, org: company, userId: user };
}
const adapter = async (company = org, user = admin) => {
  const a = await accountingConnection("sage", clients(company, user));
  if (!a) throw new Error("Synthetic Sage adapter missing");
  return a;
};

beforeEach(() => {
  stored = saved = null;
  vi.stubEnv("SAGE_CLIENT_ID", config.clientId);
  vi.stubEnv("SAGE_CLIENT_SECRET", config.clientSecret);
  vi.stubEnv("SAGE_REDIRECT_URI", config.redirectUri);
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", key.toString("base64"));
  fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).endsWith("/token")
    ? Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600 })
    : Response.json({ $items: [{ id: "business-a", displayed_as: "Synthetic business" }] }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Sage uses existing S256 generation and encrypted connection state", () => {
  it("begin hashes the real encrypted verifier into the browser challenge, never exposing secrets", async () => {
    const url = new URL(await (await adapter()).begin());
    expect(stored).not.toBeNull();
    const verifier = decryptSecret(stored!.encrypted, { organizationId: org, provider: "sage", purpose: "pkce" }, key);
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_verifier")).toBeNull();
    expect(url.searchParams.get("scope")).toBe("readonly");
    expect(stored!.hash).toBe(hashState(url.searchParams.get("state")!));
    expect(stored!.encrypted).toMatch(/^v1\./);
    expect(stored!.expires - Date.now()).toBeGreaterThan(590_000);
    for (const secret of [verifier, config.clientSecret]) expect(url.toString()).not.toContain(secret);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("finish decrypts the matching verifier into the code POST and stores only encrypted bound tokens", async () => {
    const a = await adapter();
    const url = new URL(await a.begin());
    const verifier = decryptSecret(stored!.encrypted, { organizationId: org, provider: "sage", purpose: "pkce" }, key);
    expect(await a.finish(url.searchParams.get("state")!, "synthetic-code", null)).toBe(true);
    const [tokenUrl, init] = fetcher.mock.calls[0];
    expect(tokenUrl).toBe("https://oauth.accounting.sage.com/token");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("code_verifier")).toBe(verifier);
    expect(body.get("code")).toBe("synthetic-code");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(saved).toMatchObject({ p_org: org, p_user: admin, p_provider: "sage", p_tenant_id: "business-a" });
    expect(decryptSecret(String(saved!.p_refresh_enc), { organizationId: org, provider: "sage", purpose: "refresh" }, key)).toBe("synthetic-refresh");
    expect(JSON.stringify(saved)).not.toContain("synthetic-refresh");
    expect(JSON.stringify(saved)).not.toContain("synthetic-access");
  });

  it("refresh never sends a verifier or code", async () => {
    await cloudTokens("sage", config, { refreshToken: "synthetic-refresh" }, fetcher);
    const body = new URLSearchParams(String(fetcher.mock.calls[0][1]?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("synthetic-refresh");
    expect(body.has("code_verifier")).toBe(false);
    expect(body.has("code")).toBe(false);
  });

  it("replay refuses before another provider call", async () => {
    const a = await adapter(); const state = new URL(await a.begin()).searchParams.get("state")!;
    await a.finish(state, "synthetic-code", null);
    fetcher.mockClear();
    await expect(a.finish(state, "synthetic-code", null)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("ten-minute expiry refuses before a provider call", async () => {
    vi.useFakeTimers();
    const a = await adapter(); const state = new URL(await a.begin()).searchParams.get("state")!;
    vi.advanceTimersByTime(600_000);
    await expect(a.finish(state, "synthetic-code", null)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["company", "admin", "provider", "state"] as const)("wrong %s refuses before network", async (boundary) => {
    const a = await adapter(); const state = new URL(await a.begin()).searchParams.get("state")!;
    const callback = boundary === "company" ? await adapter("other-company") : boundary === "admin" ? await adapter(org, "other-admin") : a;
    if (boundary === "provider") stored!.provider = "quickbooks";
    await expect(callback.finish(boundary === "state" ? `${state}x` : state, "synthetic-code", null)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["company", "provider", "purpose"] as const)("a transplanted encrypted verifier with wrong %s fails before network", async (boundary) => {
    const a = await adapter(); const state = new URL(await a.begin()).searchParams.get("state")!;
    stored!.encrypted = encryptSecret("transplanted-verifier", { organizationId: boundary === "company" ? "foreign" : org, provider: boundary === "provider" ? "quickbooks" : "sage", purpose: boundary === "purpose" ? "access" : "pkce" }, key);
    await expect(a.finish(state, "synthetic-code", null)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps QuickBooks without invented PKCE and preserves Xero S256", () => {
    const auth = newAuthorisation();
    expect(new URL(cloudAuthorize("quickbooks", config, auth.state, auth.challenge)).searchParams.has("code_challenge")).toBe(false);
    expect(new URL(cloudAuthorize("xero", config, auth.state, auth.challenge)).searchParams.get("code_challenge")).toBe(auth.challenge);
  });
});
