/**
 * F1: the AI key, switch and Tolra-mode routes ask for a recent authenticator code (G1) before they write anything, the same way the other
 * sensitive admin actions do (requireRecentAal2), and the key never comes back or leaks.
 *   - REQUIRE_ADMIN_MFA on: key save/replace, switching a feature ON (settings) and Tolra ON need an authenticator code under 15 minutes old.
 *     Old code -> 403 mfa_recent_required and NOTHING is written (no rpc). No second step at all -> 403 mfa_required. Fresh code -> goes on.
 *   - Switching OFF never asks (the way out stays open).
 *   - Key save/replace always requires a recent code. Feature switches retain their existing global policy.
 *   - The key: only ciphertext reaches the database, the answer is the status (never the key), nothing is logged with it.
 */
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => null }));

const state = vi.hoisted(() => ({
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  amr: [] as unknown[],
  level: "aal2" as string,
  assuranceReads: 0,
}));

const supabase = {
  rpc: async (fn: string, args: Record<string, unknown>) => {
    state.rpcs.push({ fn, args });
    return { data: { key_set: true, key_last4: String(args.p_last4 ?? "") || null, roundup_enabled: true }, error: null };
  },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  auth: { mfa: { getAuthenticatorAssuranceLevel: async () => { state.assuranceReads += 1; return { data: { currentLevel: state.level, currentAuthenticationMethods: state.amr }, error: null }; } } },
};

vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => true,
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  jsonError: (m: string, s: number) => NextResponse.json({ error: m }, { status: s }),
  mfaRequired: () => NextResponse.json({ error: "Confirm your authenticator code first.", code: "mfa_required" }, { status: 403 }),
  mfaRecentRequired: (action = "change your password") => NextResponse.json({ error: `For your security, enter a fresh code from your authenticator app to ${action}.`, code: "mfa_recent_required" }, { status: 403 }),
  readJson: async (r: Request) => { try { return { ok: true, data: JSON.parse(await r.text()) }; } catch { return { ok: false, response: NextResponse.json({ error: "Invalid request" }, { status: 400 }) }; } },
  requireProfile: vi.fn(async () => ({ supabase, user: { id: "u-1" }, profile: { id: "u-1", organization_id: "00000000-0000-4000-8000-0000000000a1", role: "admin", secondary_role: null }, session: { support: false } })),
}));
vi.mock("@/lib/ai/finance-check/flag", () => ({ readCompanyFinanceCheck: async () => ({ available: false, enabled: false }) }));
vi.mock("@/lib/ai-helper/assistant", () => ({ readCompanyAssistant: async () => ({ available: false, enabled: false }) }));

import { POST as keyPost, DELETE as keyDelete } from "@/app/api/ai-helper/key/route";
import { POST as settingsPost } from "@/app/api/ai-helper/settings/route";
import { POST as tolraPost } from "@/app/api/ai-helper/tolra-mode/route";
import { decryptSecret } from "@/lib/integrations/crypto";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ-1234";
const KEY2 = "sk-ant-api03-ZYXWVUTSRQPONMLKJIHGFEDCBA-9876";
const post = (body: unknown) => new Request("http://localhost/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const now = () => Math.floor(Date.now() / 1000);
const fresh = () => [{ method: "password", timestamp: now() - 7200 }, { method: "totp", timestamp: now() - 60 }];
const old = () => [{ method: "password", timestamp: now() - 7200 }, { method: "totp", timestamp: now() - 3600 }];
const settingsBody = (on: boolean) => ({ roundupEnabled: on, rfqEnabled: on, monthlyCapPence: 500 });
const wrote = () => state.rpcs.filter((r) => r.fn !== "ai_helper_status");

beforeEach(() => {
  process.env.AI_HELPER_ENABLED = "true";
  process.env.REQUIRE_ADMIN_MFA = "true";
  process.env.INTEGRATIONS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  state.rpcs = []; state.amr = fresh(); state.level = "aal2"; state.assuranceReads = 0;
});
afterEach(() => { delete process.env.REQUIRE_ADMIN_MFA; vi.restoreAllMocks(); });

describe("recent authenticator code (REQUIRE_ADMIN_MFA on)", () => {
  it("key save: an old code is refused with mfa_recent_required and nothing is written", async () => {
    state.amr = old();
    const res = await keyPost(post({ key: KEY }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("mfa_recent_required");
    expect(wrote()).toEqual([]);
  });
  it("key save: no second step at all is mfa_required and nothing is written", async () => {
    state.level = "aal1"; state.amr = [{ method: "password", timestamp: now() }];
    const res = await keyPost(post({ key: KEY }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("mfa_required");
    expect(wrote()).toEqual([]);
  });
  it("key save: a fresh code goes through and the key reaches the database as ciphertext only", async () => {
    const res = await keyPost(post({ key: KEY }));
    expect(res.status).toBe(200);
    const [write] = wrote();
    expect(write.fn).toBe("ai_helper_set_key");
    expect(String(write.args.p_key_enc)).not.toContain(KEY);
    expect(String(write.args.p_key_enc)).not.toContain(KEY.slice(10));
    expect(write.args.p_last4).toBe("1234");
    expect(decryptSecret(String(write.args.p_key_enc), { organizationId: ORG, provider: "anthropic", purpose: "api_key" })).toBe(KEY);
  });
  it("key replacement: the second key is stored as its own ciphertext and the first is not in the second request", async () => {
    await keyPost(post({ key: KEY }));
    await keyPost(post({ key: KEY2 }));
    const [first, second] = wrote();
    expect(first.args.p_key_enc).not.toBe(second.args.p_key_enc);
    expect(String(second.args.p_key_enc)).not.toContain(KEY2);
    expect(second.args.p_last4).toBe("9876");
    expect(decryptSecret(String(second.args.p_key_enc), { organizationId: ORG, provider: "anthropic", purpose: "api_key" })).toBe(KEY2);
    expect(JSON.stringify(second.args)).not.toContain(KEY);
  });
  it("the answer never contains the key, and nothing is logged with it", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const okRes = await keyPost(post({ key: KEY }));
    expect(JSON.stringify(await okRes.json())).not.toContain("sk-ant");
    state.amr = old();
    const refused = await keyPost(post({ key: KEY }));
    expect(JSON.stringify(await refused.json())).not.toContain("sk-ant");
    state.amr = fresh();
    const bad = await keyPost(post({ key: `${KEY}!` }));
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).not.toContain(KEY);
    for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain("sk-ant");
  });
  it("switching a feature ON needs a recent code; switching OFF and removing the key never do", async () => {
    state.amr = old();
    const refused = await settingsPost(post(settingsBody(true)));
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("mfa_recent_required");
    expect(wrote()).toEqual([]);
    expect((await settingsPost(post(settingsBody(false)))).status).toBe(200);
    expect(wrote().map((r) => r.fn)).toEqual(["ai_helper_save_settings"]);
    expect((await keyDelete(post({}))).status).toBe(200);
    state.amr = fresh(); state.rpcs = [];
    expect((await settingsPost(post(settingsBody(true)))).status).toBe(200);
    expect(wrote()[0].args).toMatchObject({ p_roundup: true, p_rfq: true });
  });
  it("the assistant or the finance check alone counts as switching on", async () => {
    state.amr = old();
    for (const body of [{ ...settingsBody(false), assistantEnabled: true }, { ...settingsBody(false), financeCheckEnabled: true }]) {
      const res = await settingsPost(post(body));
      expect(res.status).toBe(403);
    }
    expect(wrote()).toEqual([]);
  });
  it("Tolra-provided AI: ON needs a recent code, OFF does not", async () => {
    state.amr = old();
    const refused = await tolraPost(post({ enabled: true }));
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("mfa_recent_required");
    expect(wrote()).toEqual([]);
    expect((await tolraPost(post({ enabled: false }))).status).toBe(200);
    state.amr = fresh(); state.rpcs = [];
    expect((await tolraPost(post({ enabled: true }))).status).toBe(200);
    expect(wrote().map((r) => r.fn)).toEqual(["ai_helper_set_tolra_mode"]);
  });
});

describe("REQUIRE_ADMIN_MFA off", () => {
  it("key save still needs a fresh code; feature switches retain their existing policy", async () => {
    delete process.env.REQUIRE_ADMIN_MFA;
    state.amr = old();
    expect((await keyPost(post({ key: KEY }))).status).toBe(403);
    expect(wrote()).toEqual([]);
    expect((await settingsPost(post(settingsBody(true)))).status).toBe(200);
    expect((await tolraPost(post({ enabled: true }))).status).toBe(200);
    expect(state.assuranceReads).toBe(1);
  });
});
