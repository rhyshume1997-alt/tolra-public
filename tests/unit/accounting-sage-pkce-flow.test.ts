// Real accountingConnection("sage") begin()/finish() with a fake RPC recorder and fake fetch. Synthetic values only; no network.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
import { accountingConnection } from "@/lib/accounting/connections";
import { decryptSecret } from "@/lib/integrations/crypto";

const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b2";
type Pending = { state_hash: string; verifier_enc: string; org: string; user: string; provider: string; expires_at: number; consumed: boolean };
const store: { pending: Pending[]; tokenCalls: URLSearchParams[]; stored: number } = { pending: [], tokenCalls: [], stored: 0 };

function makeClient(org: string, user: string): SupabaseClient {
  return { rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === "accounting_cloud_connections_ready") return { data: true, error: null };
    if (name === "integration_oauth_start") {
      store.pending.push({ state_hash: String(args.p_state_hash), verifier_enc: String(args.p_verifier_enc), org, user, provider: String(args.p_provider), expires_at: Date.now() + 10 * 60_000, consumed: false });
      return { data: null, error: null };
    }
    if (name === "integration_oauth_consume") {
      const row = store.pending.find((p) => p.state_hash === args.p_state_hash && p.provider === args.p_provider && p.org === args.p_org && p.user === args.p_user && !p.consumed && p.expires_at > Date.now());
      if (!row) return { data: null, error: { message: "oauth state invalid", code: "P0001", hint: "oauth_state_invalid" } };
      row.consumed = true;
      return { data: { verifier_enc: row.verifier_enc }, error: null };
    }
    if (name === "integration_store_connection") { store.stored++; return { data: null, error: null }; }
    throw new Error(`Unexpected RPC: ${name}`);
  } } as unknown as SupabaseClient;
}
const ctx = (org = ORG_A, user = "admin-a") => { const c = makeClient(org, user); return { userClient: c, service: c, org, userId: user }; };
const sage = async (org?: string, user?: string) => (await accountingConnection("sage", ctx(org, user)))!;
const qbo = async () => (await accountingConnection("quickbooks", ctx()))!;
const b64url = (v: string) => createHash("sha256").update(v).digest("base64url");
const verifierOf = (row: Pending) => decryptSecret(row.verifier_enc, { organizationId: row.org, provider: row.provider as "sage", purpose: "pkce" });
const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
let logs: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  store.pending = []; store.tokenCalls = []; store.stored = 0;
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  for (const [p, x] of [["sage", "SAGE"], ["quickbooks", "QUICKBOOKS"]]) {
    vi.stubEnv(`${x}_CLIENT_ID`, "synthetic-app-id"); vi.stubEnv(`${x}_CLIENT_SECRET`, "synthetic-app-secret");
    vi.stubEnv(`${x}_REDIRECT_URI`, `https://tolra.example.test/api/accounting/${p}/callback`);
  }
  vi.stubEnv("QUICKBOOKS_ENVIRONMENT", "sandbox");
  logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth.accounting.sage.com") { store.tokenCalls.push(new URLSearchParams(String(init?.body))); return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600 }); }
    if (url.hostname === "api.accounting.sage.com") return Response.json({ $items: [{ id: "biz-1", displayed_as: "Synthetic Co" }] });
    throw new Error(`Unexpected fetch ${url}`);
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("(a) begin() sends sha256(verifier) as challenge and stores only ciphertext", async () => {
  const url = await (await sage()).begin();
  const row = store.pending[0];
  const verifier = verifierOf(row);
  expect(new URL(url).searchParams.get("code_challenge")).toBe(b64url(verifier));
  expect(new URL(url).searchParams.get("code_challenge_method")).toBe("S256");
  expect(row.verifier_enc).toMatch(/^v1\./);
  expect(row.verifier_enc).not.toContain(verifier);
  expect(url).not.toContain(verifier);
});

it("(b) finish() sends the matching code_verifier to Sage exactly once", async () => {
  const url = await (await sage()).begin();
  const verifier = verifierOf(store.pending[0]);
  expect(await (await sage()).finish(stateOf(url), "synthetic-code", null)).toBe(true);
  expect(store.tokenCalls).toHaveLength(1);
  const body = store.tokenCalls[0];
  expect(body.get("code_verifier")).toBe(verifier);
  expect(body.get("code")).toBe("synthetic-code");
  expect(body.get("grant_type")).toBe("authorization_code");
  expect(store.stored).toBe(1);
});

it("(c) replay of the same state is refused with no second token call", async () => {
  const state = stateOf(await (await sage()).begin());
  await (await sage()).finish(state, "synthetic-code", null);
  await expect((await sage()).finish(state, "synthetic-code", null)).rejects.toThrow();
  expect(store.tokenCalls).toHaveLength(1);
});

it("(d) expired state is refused before any token call", async () => {
  const state = stateOf(await (await sage()).begin());
  store.pending[0].expires_at = Date.now() - 1;
  await expect((await sage()).finish(state, "synthetic-code", null)).rejects.toThrow();
  expect(store.tokenCalls).toHaveLength(0);
});

it("(e) another company, another admin, or another provider's state is refused before any token call", async () => {
  const state = stateOf(await (await sage()).begin());
  await expect((await sage(ORG_B)).finish(state, "c", null)).rejects.toThrow();
  await expect((await sage(ORG_A, "admin-b")).finish(state, "c", null)).rejects.toThrow();
  expect(store.tokenCalls).toHaveLength(0);
  const qState = stateOf(await (await qbo()).begin());
  await expect((await sage()).finish(qState, "c", null)).rejects.toThrow();
  expect(store.tokenCalls).toHaveLength(0);
  // the legitimate owner can still finish once
  await expect((await sage()).finish(state, "c", null)).resolves.toBe(true);
  expect(store.tokenCalls).toHaveLength(1);
});

it("(f) the verifier never appears in returned values or console output", async () => {
  const url = await (await sage()).begin();
  const verifier = verifierOf(store.pending[0]);
  const result = await (await sage()).finish(stateOf(url), "synthetic-code", null);
  const failing = await (await sage()).finish(stateOf(url), "synthetic-code", null).catch((e) => String(e?.message ?? e));
  const seen = JSON.stringify([url, result, failing, logs.map((l) => l.mock.calls)]);
  expect(seen).not.toContain(verifier);
});
