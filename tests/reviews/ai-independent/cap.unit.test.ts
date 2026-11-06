import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ cap: false, off: false, support: false, source: "own", calls: [] as string[], org: "10000000-0000-4000-8000-000000000001" }));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => ({
  from: (table: string) => {
    state.calls.push(`read:${table}`); let org = "";
    const q = { select: () => q, eq: (_field: string, value: string) => { org = value; return q; }, maybeSingle: async () => {
      state.calls.push(`key-org:${org}`);
      return { data: { api_key_enc: encryptSecret("synthetic-own-key", { organizationId: org, provider: "anthropic", purpose: "api_key" }) }, error: null };
    } }; return q;
  },
  rpc: async (fn: string, args: Record<string, unknown>) => {
    state.calls.push(fn);
    if (fn === "ai_helper_tolra_key") {
      expect(args.p_org).toBe(state.org);
      return { data: encryptSecret("synthetic-tolra-key", { organizationId: "tolra-provided-ai", provider: "anthropic", purpose: "api_key" }), error: null };
    }
    return { data: null, error: null };
  },
}) }));
vi.mock("@/lib/server/auth", async () => {
  const { NextResponse } = await import("next/server");
  return { sameOrigin: () => true, forbiddenOrigin: () => NextResponse.json({}, { status: 403 }),
    requireProfile: async () => ({ profile: { organization_id: state.org, role: "admin" }, session: { support: state.support },
      supabase: { rpc: () => { throw Error("Support must be refused before any RPC"); }, from: () => { throw Error("Support must be refused before reading"); } } }),
    isErrorResponse: (x: unknown) => x instanceof Response,
    jsonError: (error: string, status: number) => NextResponse.json({ error }, { status }),
    readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
  };
});

import { runAiHelper } from "@/lib/ai-helper/server";
import { encryptSecret } from "@/lib/integrations/crypto";
import { runFinanceCheck } from "@/lib/ai/finance-check/check";
import { POST as rfq } from "@/app/api/ai-helper/rfq/route";
import { POST as roundup } from "@/app/api/ai-helper/roundup/route";
import { POST as assistant } from "@/app/api/ai-helper/assistant/route";
import { POST as keyPost, DELETE as keyDelete } from "@/app/api/ai-helper/key/route";
import { POST as settings } from "@/app/api/ai-helper/settings/route";

const features = ["rfq", "roundup", "assistant"] as const;
const client = { rpc: async (fn: string) => {
  state.calls.push(fn);
  return state.off ? { data: null, error: { hint: "ai_helper_off" } } : {
    data: { ok: !state.cap, reason: state.cap ? "cap" : undefined, request_id: "20000000-0000-4000-8000-000000000002", key_source: state.source }, error: null };
} };
const complete = vi.fn(async (r: { model: string; apiKey: string }) => {
  state.calls.push("provider"); return { json: { answer: "Synthetic" }, usage: { inputTokens: 10, outputTokens: 10 }, model: r.model };
});
const run = (feature: typeof features[number]) => runAiHelper({ supabase: client as never, organizationId: state.org, feature,
  data: "synthetic only", system: "test", schema: {}, provider: { id: "mock", complete },
  validate: (json) => ({ value: json, store: { kind: feature } }) });

beforeEach(() => { state.calls = []; state.cap = false; state.off = false; state.support = false; state.source = "own"; complete.mockClear();
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", Buffer.alloc(32, 8).toString("base64"));
  vi.stubEnv("AI_HELPER_ENABLED", "true"); vi.stubEnv("AI_ASSISTANT_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("every paid feature, either key source: cap refusal before key/provider", () => {
  for (const source of ["own", "tolra"]) it.each(features)(`${source}: %s refuses before key access`, async feature => {
    state.source = source; state.cap = true;
    expect(await run(feature)).toMatchObject({ kind: "cap" });
    expect(state.calls).toEqual([feature === "assistant" ? "ai_helper_reserve_assistant" : "ai_helper_reserve"]);
    expect(complete).not.toHaveBeenCalled();
  });
  it.each(features)("%s OFF refuses before key/provider", async feature => {
    state.off = true; expect(await run(feature)).toMatchObject({ kind: "off" }); expect(complete).not.toHaveBeenCalled();
    expect(state.calls).toHaveLength(1);
  });
});

describe("successful reservations select the recorded key source, never a fallback", () => {
  for (const source of ["own", "tolra"]) it.each(features)(`${source}: %s uses that key only`, async feature => {
    state.source = source;
    expect(await run(feature)).toMatchObject({ kind: "ok" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].apiKey).toBe(source === "own" ? "synthetic-own-key" : "synthetic-tolra-key");
    expect(state.calls[0]).toBe(feature === "assistant" ? "ai_helper_reserve_assistant" : "ai_helper_reserve");
    expect(state.calls.at(-1)).toBe("ai_helper_settle");
    if (source === "tolra") expect(state.calls).not.toContain("read:ai_helper_secrets");
    else expect(state.calls).toContain(`key-org:${state.org}`);
  });
});

describe("session and free finance boundaries", () => {
  it.each([["rfq", rfq], ["roundup", roundup], ["assistant", assistant]] as const)("server OFF blocks %s before provider work", async (_name, handler) => {
    vi.stubEnv("AI_HELPER_ENABLED", "false");
    expect((await handler(new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))).status).toBe(404);
    expect(state.calls).toEqual([]); expect(complete).not.toHaveBeenCalled();
  });
  it.each([["rfq", rfq], ["roundup", roundup], ["assistant", assistant], ["replace key", keyPost], ["remove key", keyDelete], ["settings", settings]] as const)("support cannot use %s", async (_name, handler) => {
    state.support = true;
    expect((await handler(new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))).status).toBe(403);
    expect(state.calls).toEqual([]); expect(complete).not.toHaveBeenCalled();
  });
  it("finance check is deterministic, costs no tokens and cannot mutate its input", () => {
    const input = { kind: "invoice" as const, document: { id: "synthetic", customerPo: "PO-1", subtotal: 0, vat: 0, total: 0, carriage: 0,
      carriageVat: false, vatEnabled: false, date: null, lines: [] }, recent: [] };
    const before = JSON.stringify(input); runFinanceCheck(input); expect(JSON.stringify(input)).toBe(before);
    expect(state.calls).toEqual([]); expect(complete).not.toHaveBeenCalled();
  });
});
