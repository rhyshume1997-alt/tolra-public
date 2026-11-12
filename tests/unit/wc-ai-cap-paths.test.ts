/**
 * W-C: every AI path uses its OWN company's cap and runs only while switched on (decision, Rhys 5 Nov: the Tolra-provided monthly cap
 * is per company, default 1000p, AI off until enabled; the company's own-key cap stays 500p and is deliberately not touched here).
 *
 * Pure logic and source checks, no database and no network. The matching database proof is tests/db/wc-ai-cap-paths.test.ts.
 * `WC_SQL_146` (a path) points the SQL checks at a mutated copy of release 146: that is how the fail-first proof was made, the real
 * release file is never edited.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const root = path.resolve(__dirname, "../..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const walk = (dir: string): string[] =>
  (readdirSync(path.join(root, dir), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(dir, f));

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* 1. The inventory: no way to reach a provider, or to reserve spend, except the three capped entry points.                          */
/* ------------------------------------------------------------------------------------------------------------------------------ */
describe("every AI call site is one of the capped paths (source inventory)", () => {
  const all = ["app", "lib", "components"].flatMap(walk);

  it("only lib/ai-helper/anthropic.ts imports a model SDK or names a provider endpoint", () => {
    const sdk = all.filter((f) => /from ["']@anthropic-ai\/sdk["']|from ["']openai["']|@ai-sdk\/|from ["']@google\/generative-ai["']/.test(read(f)));
    expect(sdk).toEqual([path.join("lib", "ai-helper", "anthropic.ts")]);
    const endpoint = all.filter((f) => /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis|api\.mistral|api\.cohere/.test(read(f)));
    expect(endpoint).toEqual([]);
  });

  it("only lib/ai-helper/server.ts calls provider.complete(), and only through runAiHelper", () => {
    const callers = all.filter((f) => /\bprovider\.complete\(|\.complete\(\{/.test(read(f)) && !f.endsWith("mock.ts") && !f.endsWith("anthropic.ts"));
    expect(callers).toEqual([path.join("lib", "ai-helper", "server.ts")]);
    const users = all.filter((f) => /\brunAiHelper\s*[<(]/.test(read(f)) && f !== path.join("lib", "ai-helper", "server.ts"));
    expect(users.sort()).toEqual([
      path.join("app", "api", "ai-helper", "assistant", "route.ts"),
      path.join("app", "api", "ai-helper", "rfq", "route.ts"),
      path.join("app", "api", "ai-helper", "roundup", "route.ts"),
    ]);
  });

  it("the only reserve calls in the app are in runAiHelper, and every AI feature name is one the provided-mode reserve accepts", async () => {
    const reservers = all.filter((f) => /rpc\(\s*"ai_helper_reserve/.test(read(f)));
    expect(reservers).toEqual([path.join("lib", "ai-helper", "server.ts")]);
    const { AI_HELPER_MODELS, MAX_OUTPUT_TOKENS } = await import("@/lib/ai-helper/limits");
    const features = Object.keys(AI_HELPER_MODELS).sort();
    expect(Object.keys(MAX_OUTPUT_TOKENS).sort()).toEqual(features);
    // A new feature added in TypeScript without being added to the SQL's list would be refused by the provided-mode reserve (safe) or
    // would have to bypass it (unsafe): either way this test makes the author look at the cap.
    const list = /p_feature NOT IN \(([^)]*)\)/.exec(fnBody("_ai_helper_reserve_tolra"))?.[1] ?? "";
    expect([...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()).toEqual(features);
  });

  it("the finance check, the chase run and the purge never import the helper, a provider or a reserve", () => {
    for (const f of ["app/api/ai/finance-check/route.ts", "app/api/ai/finance-check/decision/route.ts", "app/api/cron/ai-helper-purge/route.ts", "app/api/chase/run/route.ts", ...walk("lib/ai/finance-check")]) {
      expect(read(f), f).not.toMatch(/runAiHelper|ai-helper\/server|ai-helper\/anthropic|ai-helper\/provider|ai_helper_reserve|ai_helper_tolra/);
    }
  });
});

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* 2. Off by default and off means off: each model route checks the server switch before anything else.                              */
/* ------------------------------------------------------------------------------------------------------------------------------ */
describe("the three model routes are off unless switched on, and refuse before any reserve", () => {
  const routes = [
    { file: "app/api/ai-helper/roundup/route.ts", feature: "roundup", flags: ['process.env.AI_HELPER_ENABLED !== "true"'], companySwitch: /rpc\("ai_helper_status"\)[\s\S]*roundup_enabled/ },
    { file: "app/api/ai-helper/rfq/route.ts", feature: "rfq", flags: ['process.env.AI_HELPER_ENABLED !== "true"'], companySwitch: /rpc\("ai_helper_status"\)[\s\S]*rfq_enabled/ },
    { file: "app/api/ai-helper/assistant/route.ts", feature: "assistant", flags: ['process.env.AI_HELPER_ENABLED !== "true"', 'process.env.AI_ASSISTANT_ENABLED !== "true"'], companySwitch: /readCompanyAssistant\(/ },
  ];
  for (const r of routes) {
    it(`${r.feature}: flag(s) first, then sign-in, support refused, company switch read, then runAiHelper with feature "${r.feature}"`, () => {
      const text = read(r.file);
      const post = text.slice(text.indexOf("export async function POST"));
      for (const flag of r.flags) expect(post.indexOf(flag), flag).toBeGreaterThan(-1);
      const lastFlag = Math.max(...r.flags.map((f) => post.indexOf(f)));
      const auth = post.indexOf("requireProfile(");
      const support = post.indexOf("auth.session?.support");
      const company = post.search(r.companySwitch);
      const run = post.search(/runAiHelper\s*[<(]/);
      expect(lastFlag).toBeLessThan(auth);
      expect(auth).toBeLessThan(support);
      expect(support).toBeLessThan(company);
      expect(company).toBeLessThan(run);
      expect(post.slice(run)).toMatch(new RegExp(`feature: "${r.feature}"`));
      // No second way to a provider inside the route.
      expect(text).not.toMatch(/anthropic|provider\.complete|createSupabaseAdminClient/);
    });
  }

  it("the server switches are off for anything but exactly the string true", async () => {
    const { aiHelperEnabled, aiAssistantEnabled } = await import("@/lib/ai-helper/flag");
    for (const v of [undefined, "", "TRUE", "True", "1", "yes", "on", " true", "true "]) {
      expect(aiHelperEnabled({ AI_HELPER_ENABLED: v }), String(v)).toBe(false);
      expect(aiAssistantEnabled({ AI_HELPER_ENABLED: "true", AI_ASSISTANT_ENABLED: v }), String(v)).toBe(false);
    }
    expect(aiHelperEnabled({})).toBe(false);
    expect(aiAssistantEnabled({ AI_ASSISTANT_ENABLED: "true" })).toBe(false); // the assistant never runs on its own flag
    expect(aiHelperEnabled({ AI_HELPER_ENABLED: "true" })).toBe(true);
    expect(aiAssistantEnabled({ AI_HELPER_ENABLED: "true", AI_ASSISTANT_ENABLED: "true" })).toBe(true);
  });

  it("the mock provider is refused on any Vercel deployment, so a stray setting cannot fake or bypass a real reserve", async () => {
    const { aiHelperProvider } = await import("@/lib/ai-helper/server");
    expect(aiHelperProvider({ AI_HELPER_PROVIDER: "mock", VERCEL_ENV: "production" })).toBeNull();
    expect(aiHelperProvider({ AI_HELPER_PROVIDER: "mock", VERCEL_ENV: "preview" })).toBeNull();
    expect(aiHelperProvider({ AI_HELPER_PROVIDER: "mock" })?.id).toBe("mock");
  });
});

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* 3. Release 146: the cap is per company, default 1000, read from the provided-mode table, never from the own-key row.              */
/* ------------------------------------------------------------------------------------------------------------------------------ */
const sql146 = () => readFileSync(process.env.WC_SQL_146 ?? path.join(root, "supabase/release/146_tolra_provided_ai.release.sql"), "utf8");
/** The text between the `$$` that opens a function body and the one that closes it. */
function fnBody(name: string): string {
  const sql = sql146();
  const at = sql.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(`));
  if (at < 0) throw new Error(`function ${name} not found in release 146`);
  const open = sql.indexOf("$$", at);
  return sql.slice(open + 2, sql.indexOf("$$", open + 2));
}
const stripComments = (s: string) => s.replace(/--[^\n]*/g, "");

describe("release 146: per-company provided-mode cap", () => {
  it("each company's own row holds the cap: default 1000 pence, 0 to 100000, switched off by default", () => {
    const sql = stripComments(sql146());
    expect(sql).toMatch(/CREATE TABLE public\.ai_helper_tolra_companies \(\s*organization_id UUID PRIMARY KEY REFERENCES public\.organizations\(id\) ON DELETE CASCADE,\s*enabled BOOLEAN NOT NULL DEFAULT FALSE,\s*monthly_cap_pence INTEGER NOT NULL DEFAULT 1000 CHECK \(monthly_cap_pence BETWEEN 0 AND 100000\)\s*\);/);
    expect(sql).toMatch(/CREATE TABLE public\.ai_helper_tolra_control \([\s\S]*?enabled BOOLEAN NOT NULL DEFAULT FALSE,[\s\S]*?CHECK \(NOT enabled OR api_key_enc IS NOT NULL\)/);
    expect(sql).toMatch(/INSERT INTO public\.ai_helper_tolra_control\(singleton\) VALUES \(TRUE\);/);
  });

  it("every fallback figure for a company without a row is 1000, never 500", () => {
    const sql = stripComments(sql146());
    const fallbacks = [...sql.matchAll(/coalesce\([^()]*monthly_cap_pence\s*,\s*(\d+)\)/g)].map((m) => Number(m[1]));
    expect(fallbacks.length).toBeGreaterThanOrEqual(2); // status() and caps()
    expect(fallbacks.every((n) => n === 1000)).toBe(true);
    expect(sql).not.toMatch(/\b500\b/);
  });

  it("provided-mode reserve reads THIS company's provided cap (caller's org), not the own-key row, and refuses before touching the ledger when off", () => {
    const body = stripComments(fnBody("_ai_helper_reserve_tolra"));
    expect(body).toMatch(/v_org\s+UUID := public\._ai_helper_caller\(ARRAY\['admin', 'office'\]\)/);
    expect(body).toMatch(/SELECT s\.monthly_cap_pence INTO v_cap FROM public\.ai_helper_tolra_companies s WHERE s\.organization_id = v_org AND s\.enabled FOR SHARE/);
    expect(body).toMatch(/SELECT c\.api_key_enc INTO v_key FROM public\.ai_helper_tolra_control c WHERE c\.singleton AND c\.enabled FOR SHARE/);
    // The own-key cap is a different column on a different table: it must not appear here.
    expect(body).not.toMatch(/ai_helper_settings[^;]*monthly_cap_pence|monthly_cap_pence[^;]*ai_helper_settings/);
    expect(body).not.toMatch(/\b500\b/);
    // The cap test is the guarded one-statement UPDATE on the caller's month row.
    expect(body).toMatch(/UPDATE public\.ai_helper_usage u SET reserved_pence = u\.reserved_pence \+ p_estimate_pence[\s\S]*?WHERE u\.organization_id = v_org AND u\.month = v_month\s+AND u\.reserved_pence \+ u\.spent_pence \+ p_estimate_pence\s+<= v_cap/);
    // Off (platform off, no key, or this company not enabled) refuses, with the off hint, before any ledger or request row is written.
    const off = body.indexOf("v_key IS NULL OR v_cap IS NULL");
    expect(off).toBeGreaterThan(-1);
    expect(body.indexOf("ai_helper_off", off)).toBeGreaterThan(off);
    expect(off).toBeLessThan(body.indexOf("INSERT INTO public.ai_helper_usage"));
    expect(off).toBeLessThan(body.indexOf("INSERT INTO public.ai_helper_requests"));
    // The company's own feature switch is checked before the cap as well.
    expect(body.indexOf("The AI helper is off for this company.")).toBeLessThan(off);
  });

  it("all three entry points use the provided reserve when the company is on it, so none has a cap of its own", () => {
    const reserve = stripComments(fnBody("ai_helper_reserve"));
    const assistant = stripComments(fnBody("ai_helper_reserve_assistant"));
    for (const body of [reserve, assistant]) {
      expect(body).toMatch(/EXISTS \(SELECT 1 FROM public\.ai_helper_tolra_companies WHERE organization_id = v_org AND enabled\)/);
      expect(body).not.toMatch(/monthly_cap_pence|\b500\b|\b1000\b/);
    }
    expect(reserve).toMatch(/_ai_helper_reserve_tolra\(p_feature,p_estimate_pence,p_input_digest,p_input_bytes\)/);
    expect(assistant).toMatch(/_ai_helper_reserve_tolra\('assistant',p_estimate_pence,p_input_digest,p_input_bytes\)/);
    // The rest is the renamed original own-key function: nothing else can be reached from the public names.
    expect(reserve).toMatch(/RETURN public\._ai_helper_reserve_own_key\(/);
    expect(assistant).toMatch(/RETURN public\._ai_helper_reserve_assistant_own_key\(/);
  });

  it("the cap is changed one company at a time, by the service role only, and never switches a company on", () => {
    const sql = stripComments(sql146());
    const setter = stripComments(fnBody("ai_helper_tolra_set_cap"));
    expect(setter).toMatch(/UPDATE public\.ai_helper_tolra_companies SET monthly_cap_pence = p_cap_pence WHERE organization_id = p_org;/);
    expect(setter).toMatch(/INSERT INTO public\.ai_helper_tolra_companies\(organization_id\) VALUES\(p_org\) ON CONFLICT\(organization_id\) DO NOTHING/);
    expect(setter).toMatch(/PERFORM c\.organization_id FROM public\.ai_helper_tolra_companies c WHERE c\.organization_id = p_org FOR UPDATE/);
    expect(setter).toMatch(/p_cap_pence NOT BETWEEN 0 AND 100000/);
    expect(setter).toMatch(/p_cap_pence < v_used[\s\S]*cap_below_usage/);
    expect(setter).toMatch(/platform_admins a WHERE a\.user_id = p_owner/);
    // No statement in the whole release changes a cap for every company at once.
    for (const m of sql.matchAll(/UPDATE public\.ai_helper_tolra_companies[^;]*;/g)) expect(m[0]).toMatch(/WHERE organization_id = p_org/);
    expect(sql).not.toMatch(/DELETE FROM public\.ai_helper_tolra_companies/);
    // The company-side switch changes `enabled` only, never the cap.
    expect(stripComments(fnBody("ai_helper_set_tolra_mode"))).not.toMatch(/monthly_cap_pence/);
    // Grants: the cap functions are service-role only.
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.ai_helper_tolra_caps\(\), public\.ai_helper_tolra_set_cap\(UUID,INTEGER,UUID\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.ai_helper_tolra_caps\(\), public\.ai_helper_tolra_set_cap\(UUID,INTEGER,UUID\) TO service_role;/);
    expect(sql).toMatch(/REVOKE ALL ON public\.ai_helper_tolra_companies FROM PUBLIC, anon, authenticated;/);
    // And nothing in the release grants a Tolra owner/cap/key function (or the tables) to a signed-in or anonymous caller.
    for (const g of sql.matchAll(/GRANT [^;]*;/g)) {
      if (/ai_helper_tolra_(set_cap|caps|configure|key|owner_status)|ai_helper_tolra_(control|companies)|_ai_helper_reserve_tolra/.test(g[0])) expect(g[0], g[0]).not.toMatch(/\bTO\b[^;]*\b(authenticated|anon|PUBLIC)\b/);
    }
  });

  it("Tolra's key is released only for a still-reserved provided-mode request of the named company, while the platform switch is on", () => {
    const body = stripComments(fnBody("ai_helper_tolra_key"));
    expect(body).toMatch(/c\.singleton AND c\.enabled/);
    expect(body).toMatch(/r\.id = p_request AND r\.organization_id = p_org\s+AND r\.status = 'reserved' AND r\.key_source = 'tolra'/);
  });

  it("the own-key helper keeps its separate 500p default (122): a pin, not a decision", () => {
    expect(read("supabase/migrations/122_ai_helper_cap_default.sql")).toMatch(/ALTER COLUMN monthly_cap_pence SET DEFAULT 500/);
  });

  it("the TypeScript default and ceiling match the SQL", async () => {
    const { DEFAULT_TOLRA_CAP_PENCE, MAX_TOLRA_CAP_PENCE } = await import("@/lib/ai-helper/tolra-caps");
    expect(DEFAULT_TOLRA_CAP_PENCE).toBe(1000);
    expect(MAX_TOLRA_CAP_PENCE).toBe(100_000);
  });
});

describe("the screens that name the provided allowance say 1,000p / £10, never 500p / £5", () => {
  for (const f of ["components/platform/tolra-ai-caps.tsx", "components/platform/tolra-ai-control.tsx", "components/integrations/tolra-ai-card.tsx"]) {
    it(f, () => {
      const text = read(f);
      expect(text).not.toMatch(/\b500p\b|£5\b|5 GBP|GBP 5\b|£5\.00/);
      expect(text).not.toMatch(/tolra_cap_pence \?\? (?!1000\b)\d+/);
    });
  }
  it("the caps screen and the platform control state the 1,000p / £10 default", () => {
    expect(read("components/platform/tolra-ai-caps.tsx")).toMatch(/1,000p \(£10\)/);
    expect(read("components/platform/tolra-ai-control.tsx")).toMatch(/£10 monthly allowance/);
  });
  it("these three files exist where this test expects them", () => {
    for (const f of ["components/platform/tolra-ai-caps.tsx", "components/platform/tolra-ai-control.tsx", "components/integrations/tolra-ai-card.tsx"]) expect(existsSync(path.join(root, f))).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* 4. runAiHelper: a refusal, no key and no provider all stop before any model call; each company is reserved separately.            */
/* ------------------------------------------------------------------------------------------------------------------------------ */
const mocks = vi.hoisted(() => ({
  admin: null as unknown,
  calls: [] as Array<{ who: string; fn: string; args: Record<string, unknown> }>,
  tables: [] as string[],
}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => mocks.admin }));

import { AiProviderError } from "@/lib/ai-helper/provider";
import { runAiHelper } from "@/lib/ai-helper/server";
import { encryptSecret } from "@/lib/integrations/crypto";
import { TOLRA_AI_KEY_CONTEXT } from "@/lib/ai-helper/tolra-key-context";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const KEY = "sk-ant-SYNTHETIC-wc-provider-key";

/** The database's cap arithmetic for the provided mode, per caller's company (a model of release 146 for the app-level checks only). */
function makeWorld(caps: Record<string, number>, enabled: Record<string, boolean>, platformOn = true, keyReadable = true) {
  const used: Record<string, number> = {};
  let n = 0;
  const encrypted = encryptSecret(KEY, TOLRA_AI_KEY_CONTEXT);
  const caller = (org: string) => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      mocks.calls.push({ who: org, fn, args });
      if (fn !== "ai_helper_reserve" && fn !== "ai_helper_reserve_assistant") throw new Error(`unexpected caller rpc ${fn}`);
      if (!platformOn || !enabled[org]) return { data: null, error: { code: "42501", hint: "ai_helper_off" } };
      const est = Number(args.p_estimate_pence);
      const id = `req-${org.slice(-2)}-${++n}`;
      if ((used[org] ?? 0) + est > (caps[org] ?? 1000)) return { data: { ok: false, reason: "cap", request_id: id }, error: null };
      used[org] = (used[org] ?? 0) + est;
      return { data: { ok: true, request_id: id, key_source: "tolra" }, error: null };
    },
  }) as unknown as SupabaseClient;
  mocks.admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      mocks.calls.push({ who: "service", fn, args });
      if (fn === "ai_helper_tolra_key") return { data: keyReadable ? encrypted : null, error: null };
      return { data: null, error: null };
    },
    from: (table: string) => { mocks.tables.push(table); throw new Error(`service table read ${table}`); },
  };
  return { caller, used };
}

const provider = { id: "mock" as const, complete: vi.fn(async (req: { model: string }) => ({ json: { ok: true }, usage: { inputTokens: 10, outputTokens: 10 }, model: req.model })) };
const run = (supabase: SupabaseClient, organizationId: string, feature: "roundup" | "rfq" | "assistant" = "roundup", p: typeof provider | null | undefined = provider) =>
  runAiHelper({ supabase, organizationId, feature, system: "s", data: "d", schema: { type: "object" }, validate: (j) => ({ value: j, store: {} }), provider: p as never });

beforeEach(() => {
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  mocks.calls = [];
  mocks.tables = [];
  provider.complete.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("runAiHelper with per-company caps (app-level model; the database proof is tests/db/wc-ai-cap-paths.test.ts)", () => {
  it("company A at 500p stops while company B at the 1000p default keeps going, for every feature; A's refusals never reach the provider", async () => {
    const w = makeWorld({ [A]: 40 }, { [A]: true, [B]: true });
    const features = ["roundup", "rfq", "assistant"] as const;
    const aOutcomes = [] as string[];
    for (let i = 0; i < 30 && !aOutcomes.includes("cap"); i++) aOutcomes.push((await run(w.caller(A), A, features[i % 3])).kind);
    const calledForA = provider.complete.mock.calls.length;
    // A stops at ITS cap (40p here, B's default is 1000p): the ledger never took more than that, and the next request was refused.
    expect(w.used[A]).toBeLessThanOrEqual(40);
    expect(aOutcomes.at(-1)).toBe("cap");
    expect(calledForA).toBe(aOutcomes.filter((k) => k === "ok").length);
    // B untouched by A's use, and still at its own (larger) cap.
    expect(w.used[B] ?? 0).toBe(0);
    const before = provider.complete.mock.calls.length;
    expect((await run(w.caller(B), B, "rfq")).kind).toBe("ok");
    expect(provider.complete.mock.calls.length).toBe(before + 1);
    // Changing A's cap does not change B's: B's request is judged against B's cap only.
    const w2 = makeWorld({ [A]: 5000, [B]: 1 }, { [A]: true, [B]: true });
    expect((await run(w2.caller(A), A, "rfq")).kind).toBe("ok");
    expect((await run(w2.caller(B), B, "rfq")).kind).toBe("cap");
  });

  it("a cap refusal reads no key, calls no provider and settles nothing", async () => {
    const w = makeWorld({ [A]: 0 }, { [A]: true });
    const out = await run(w.caller(A), A, "roundup");
    expect(out.kind).toBe("cap");
    expect(provider.complete).not.toHaveBeenCalled();
    expect(mocks.calls.filter((c) => c.who === "service")).toEqual([]);
    expect(mocks.tables).toEqual([]);
  });

  it("a company that is not on provided AI (or the platform switch off) is refused as off before any key read or provider call, for every feature", async () => {
    const off = makeWorld({}, { [A]: false, [B]: true }, true);
    for (const f of ["roundup", "rfq", "assistant"] as const) expect((await run(off.caller(A), A, f)).kind).toBe("off");
    const platformOff = makeWorld({}, { [A]: true }, false);
    for (const f of ["roundup", "rfq", "assistant"] as const) expect((await run(platformOff.caller(A), A, f)).kind).toBe("off");
    expect(provider.complete).not.toHaveBeenCalled();
    expect(mocks.calls.filter((c) => c.who === "service")).toEqual([]);
  });

  it("entry points: assistant reserves through its own function, the others through ai_helper_reserve, and nothing else is called before an ok", async () => {
    const w = makeWorld({}, { [A]: true });
    await run(w.caller(A), A, "assistant");
    await run(w.caller(A), A, "rfq");
    await run(w.caller(A), A, "roundup");
    const callerCalls = mocks.calls.filter((c) => c.who === A).map((c) => c.fn);
    expect(callerCalls).toEqual(["ai_helper_reserve_assistant", "ai_helper_reserve", "ai_helper_reserve"]);
    // Each ok then reads Tolra's key for THIS company and request only, and settles.
    const key = mocks.calls.filter((c) => c.fn === "ai_helper_tolra_key");
    expect(key.every((c) => c.args.p_org === A && typeof c.args.p_request === "string")).toBe(true);
  });

  it("no usable provider key: no provider call, the reservation is settled at zero cost, and the answer is the safe 'Tolra account unavailable'", async () => {
    const w = makeWorld({}, { [A]: true }, true, false); // ai_helper_tolra_key answers nothing (platform key missing or switched off in between)
    const out = await run(w.caller(A), A, "rfq");
    expect(out).toMatchObject({ kind: "failed", failure: "unavailable", detail: "tolra_key" });
    expect(provider.complete).not.toHaveBeenCalled();
    const settle = mocks.calls.find((c) => c.fn === "ai_helper_settle");
    expect(settle?.args).toMatchObject({ p_status: "failed", p_failure: "unavailable", p_cost_pence: 0 });
  });

  it("no provider at all (mock refused on Vercel): no model call, settled at zero cost", async () => {
    const w = makeWorld({}, { [A]: true });
    const out = await run(w.caller(A), A, "roundup", null);
    expect(out).toMatchObject({ kind: "failed", failure: "unavailable" });
    const settle = mocks.calls.find((c) => c.fn === "ai_helper_settle");
    expect(settle?.args).toMatchObject({ p_status: "failed", p_cost_pence: 0 });
  });

  it("a provider that fails after an ok keeps the full reservation unless it certainly did no work (so the cap is never under-charged)", async () => {
    const w = makeWorld({}, { [A]: true });
    const estimate = () => Number(mocks.calls.find((c) => c.fn === "ai_helper_reserve")!.args.p_estimate_pence);
    const failing = { id: "mock" as const, complete: vi.fn(async () => { throw new AiProviderError("unavailable"); }) };
    await run(w.caller(A), A, "rfq", failing as never);
    expect(mocks.calls.find((c) => c.fn === "ai_helper_settle")?.args.p_cost_pence).toBe(estimate());
    mocks.calls = [];
    const rejected = { id: "mock" as const, complete: vi.fn(async () => { throw new AiProviderError("unavailable", undefined, "rate", true); }) };
    await run(w.caller(A), A, "rfq", rejected as never);
    expect(mocks.calls.find((c) => c.fn === "ai_helper_settle")?.args.p_cost_pence).toBe(0);
  });

  it("without the service role nothing is reserved at all", async () => {
    const w = makeWorld({}, { [A]: true });
    mocks.admin = null;
    expect((await run(w.caller(A), A, "rfq")).kind).toBe("unavailable");
    expect(mocks.calls).toEqual([]);
    expect(provider.complete).not.toHaveBeenCalled();
  });
});
