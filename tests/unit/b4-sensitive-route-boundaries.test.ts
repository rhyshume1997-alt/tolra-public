/** Independent #415 review: real requireProfile, sameOrigin and requireRecentAal2.
 * Only Supabase transport, cookie store and provider side effects are replaced. No provider network calls.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "../support/fake-db";
vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ client: null as unknown, beginXero: vi.fn(), disconnectXero: vi.fn(), beginMs: vi.fn(), disconnectMs: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }) }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => h.client }));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock("@/lib/integrations/server", () => ({ DbError: class extends Error {}, xeroReady: async () => ({}), beginConnect: h.beginXero, disconnectCompany: h.disconnectXero }));
vi.mock("@/lib/integrations/app-credentials", () => ({ xeroEnvProblem: () => null }));
vi.mock("@/lib/integrations/microsoft/client", () => ({ microsoftReady: async () => ({}) }));
vi.mock("@/lib/integrations/microsoft/connect", () => ({ beginMicrosoftConnect: h.beginMs, disconnectMicrosoft: h.disconnectMs }));
import { POST as aiKey } from "@/app/api/ai-helper/key/route";
import { POST as xeroConnect } from "@/app/api/integrations/xero/connect/route";
import { POST as xeroDisconnect } from "@/app/api/integrations/xero/disconnect/route";
import { POST as msConnect } from "@/app/api/integrations/microsoft/connect/route";
import { POST as msDisconnect } from "@/app/api/integrations/microsoft/disconnect/route";
import { decryptSecret } from "@/lib/integrations/crypto";
const A = "aaaaaaaa-0000-4000-8000-00000000000a", B = "bbbbbbbb-0000-4000-8000-00000000000b";
const KEY = "sk-ant-api03-MOCK-ONLY-NOT-A-REAL-KEY-1234";
const NOW = new Date("2026-11-05T15:00:00Z");
let db: FakeDb, role: string, secondary: string | null, company: string, support: boolean, active: boolean, orgAllowed: boolean, mismatch: boolean;
let level: string, amr: unknown[], assuranceError: unknown;
let rpc: ReturnType<typeof vi.fn>, client: unknown;
const methods = (age: number) => [{ method: "totp", timestamp: NOW.getTime() / 1000 - age }];
const request = (body: unknown = { key: KEY }, origin = "https://app.test") => new Request(`https://app.test/api?organization_id=${B}`, { method: "POST", headers: { origin, "content-type": "application/json", "x-organization-id": B }, body: JSON.stringify(body) });
const routes = [
  { name: "AI key save", run: aiKey, reached: () => rpc.mock.calls.filter(c => c[0] === "ai_helper_set_key").length },
  { name: "Xero connect", run: xeroConnect, reached: () => h.beginXero.mock.calls.length },
  { name: "Xero disconnect", run: xeroDisconnect, reached: () => h.disconnectXero.mock.calls.length },
  { name: "Microsoft connect", run: msConnect, reached: () => h.beginMs.mock.calls.length },
  { name: "Microsoft disconnect", run: msDisconnect, reached: () => h.disconnectMs.mock.calls.length },
];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "fake-anon");
  vi.stubEnv("AI_HELPER_ENABLED", "true"); vi.stubEnv("REQUIRE_ADMIN_MFA", "true"); vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  role = "admin"; secondary = null; company = A; support = false; active = true; orgAllowed = true; mismatch = false;
  level = "aal2"; amr = methods(60); assuranceError = null;
  db = new FakeDb({ user_profiles: [{ id: "admin", organization_id: B, role: "workshop", secondary_role: null, active: true, must_change_password: false }] });
  rpc = vi.fn(async (fn: string) => ({ data: fn === "current_user_organization_id" ? company : fn === "my_session" ? { user_id: "admin", organization_id: mismatch ? B : company, role, secondary_role: secondary, support } : fn === "has_org_role" ? orgAllowed : { key_set: true }, error: null }));
  client = { from: (table: string) => { db.rows("user_profiles")[0].active = active; return db.from(table); }, rpc, auth: { getUser: async () => ({ data: { user: { id: "admin" } }, error: null }), mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: level, currentAuthenticationMethods: amr }, error: assuranceError }) } } };
  h.client = client;
  for (const fn of [h.beginXero, h.disconnectXero, h.beginMs, h.disconnectMs]) fn.mockReset().mockResolvedValue("https://provider.example.test/connect");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected outbound request in an isolated test"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe.each(routes)("$name through real authentication and MFA guards", route => {
  it.each([901, 3600, -61])("refuses a code aged %s seconds, before any side effect", async age => {
    amr = methods(age);
    const response = await route.run(request());
    expect(response.status).toBe(403); expect((await response.json()).code).toBe("mfa_recent_required"); expect(route.reached()).toBe(0);
  });
  it.each([{ label: "absent", methods: [] }, { label: "password only", methods: [{ method: "password", timestamp: NOW.getTime()/1000 }] }, { label: "no timestamp", methods: [{ method: "totp" }] }])("refuses $label code evidence", async evidence => {
    amr = evidence.methods;
    const response = await route.run(request());
    expect(response.status).toBe(403); expect((await response.json()).code).toBe("mfa_recent_required"); expect(route.reached()).toBe(0);
  });
  it.each(["aal1", "error"])("refuses missing MFA or an assurance error: %s", async kind => {
    if (kind === "aal1") level = "aal1"; else assuranceError = { message: "Auth unavailable" };
    const response = await route.run(request());
    expect(response.status).toBe(403); expect((await response.json()).code).toBe("mfa_required"); expect(route.reached()).toBe(0);
  });
  it.each(["office", "workshop", "read_only"])("refuses a fresh-code %s user", async value => {
    role = value;
    expect((await route.run(request())).status).toBe(403); expect(route.reached()).toBe(0);
  });
  it.each(["support", "inactive", "database_role_refusal", "company_mismatch", "cross_site"])("refuses %s even with fresh MFA", async reason => {
    support = reason === "support"; active = reason !== "inactive"; orgAllowed = reason !== "database_role_refusal"; mismatch = reason === "company_mismatch";
    expect((await route.run(request(undefined, reason === "cross_site" ? "https://attacker.test" : "https://app.test"))).status).toBe(403); expect(route.reached()).toBe(0);
  });
  it("accepts fresh MFA for a secondary admin in the session's company", async () => {
    role = "office"; secondary = "admin";
    expect((await route.run(request())).status).toBe(200); expect(route.reached()).toBe(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("a stale code cannot be bypassed by disabling the global MFA switch", async () => {
    vi.stubEnv("REQUIRE_ADMIN_MFA", "false"); amr = methods(901);
    const response = await route.run(request());
    expect(response.status).toBe(403); expect((await response.json()).code).toBe("mfa_recent_required"); expect(route.reached()).toBe(0);
  });
});
it("company A's saved AI key cannot decrypt under company B, even though B appears in the stale profile and request", async () => {
  expect((await aiKey(request())).status).toBe(200);
  const args = rpc.mock.calls.find(c => c[0] === "ai_helper_set_key")![1] as { p_key_enc: string };
  expect(decryptSecret(args.p_key_enc, { organizationId: A, provider: "anthropic", purpose: "api_key" })).toBe(KEY);
  expect(() => decryptSecret(args.p_key_enc, { organizationId: B, provider: "anthropic", purpose: "api_key" })).toThrow();
});
it.each([["Xero", xeroConnect, h.beginXero], ["Microsoft", msConnect, h.beginMs]] as const)("%s connection uses the chosen session company, never a stale profile or request company", async (_name, run, begin) => {
  expect((await run(request({ organization_id: B }))).status).toBe(200);
  expect(begin).toHaveBeenCalledWith(client, A, expect.anything());
});
it.each([["Xero", xeroDisconnect, h.disconnectXero], ["Microsoft", msDisconnect, h.disconnectMs]] as const)("%s disconnect uses the signed-in user's own scoped client", async (_name, run, disconnect) => {
  expect((await run(request({ organization_id: B }))).status).toBe(200);
  expect(disconnect.mock.calls[0][0]).toBe(client);
});
