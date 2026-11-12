/**
 * BOUNDARY (Integrations module, AI-1): proves the GBP pricing path (lib/ai-helper/pricing-gbp.ts, lib/ai-helper/fx.ts) is INACTIVE at the
 * server boundary. (1) Source: nothing outside those two files and the tests references them, in particular not lib/ai-helper/server.ts,
 * lib/ai-helper/limits.ts or any app/api route, so the GBP path cannot make a provider call, read a credential or reserve spend.
 * (2) Runtime: with the shipped EMPTY FX table, runAiHelper behaves exactly as before AI-1 (one reserve with the live estimate, key read,
 * one settle; no new refusal, no extra RPC). Must not be loosened; wiring the GBP path in needs a new, reviewed guard and test.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ serviceCalls: [] as string[], settle: null as null | Record<string, unknown> }));
vi.mock("@/lib/server/supabase-admin", () => ({
  createSupabaseAdminClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => { state.serviceCalls.push(`rpc:${name}`); if (name === "ai_helper_settle") state.settle = args; return Promise.resolve({ error: null }); },
    from: (table: string) => { state.serviceCalls.push(`from:${table}`); throw new Error("no key in this test"); },
  }),
}));

import { USD_GBP_RATES } from "@/lib/ai-helper/fx";
import { AI_HELPER_MODELS, MAX_OUTPUT_TOKENS, estimatePence } from "@/lib/ai-helper/limits";
import { runAiHelper } from "@/lib/ai-helper/server";

const root = process.cwd();
const walk = (dir: string): string[] => readdirSync(path.join(root, dir)).flatMap((n) => {
  const rel = `${dir}/${n}`;
  if (n === "node_modules" || n === ".next") return [];
  return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx|mjs|js)$/.test(n) ? [rel] : [];
});
const rootFiles = () => readdirSync(root).filter((n) => /\.(ts|tsx|mjs|cjs|js)$/.test(n) && statSync(path.join(root, n)).isFile());
/** Everything that can run in production or at build time: app, lib, components, scripts and the root-level files (middleware, instrumentation, next.config). */
const productionFiles = () => [...walk("app"), ...walk("lib"), ...walk("components"), ...walk("scripts"), ...rootFiles()];
const GBP = /pricing-gbp|ai-helper\/fx|estimatePenceGbp|actualPenceGbp|priceForGbp|\brateFor\b|USD_GBP_RATES/;

describe("the GBP path is not reachable from the live code (source)", () => {
  it("server.ts, limits.ts and every app/api route neither import nor call it", () => {
    const files = ["lib/ai-helper/server.ts", "lib/ai-helper/limits.ts", ...walk("app/api")];
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(readFileSync(path.join(root, f), "utf8"), f).not.toMatch(GBP);
  });

  const own = new Set(["lib/ai-helper/pricing-gbp.ts", "lib/ai-helper/fx.ts"]);

  it("no production file at all (app, lib, components, scripts, root files) references it, apart from the two files themselves", () => {
    const files = productionFiles();
    expect(files).toEqual(expect.arrayContaining(["scripts/check-test-weakening.mjs", "next.config.ts"].filter((f) => statSync(path.join(root, f), { throwIfNoEntry: false })?.isFile())));
    const hits = files.filter((f) => !own.has(f) && GBP.test(readFileSync(path.join(root, f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("no file that mentions pricing, gbp or fx builds a dynamic import() or require() from a string, so the check above cannot be evaded", () => {
    // A dynamic import/require whose argument is not a plain quoted string literal (a variable, concatenation or template).
    const dynamic = /\b(?:import|require)\s*\(\s*(?!(?:"[^"\n]*"|'[^'\n]*')\s*[,)])/;
    const hits = productionFiles().filter((f) => {
      if (own.has(f)) return false;
      const text = readFileSync(path.join(root, f), "utf8");
      return /pricing|gbp|fx/i.test(text) && dynamic.test(text);
    });
    expect(hits).toEqual([]);
  });

  it("the live price path is still the one in limits.ts (no bigint, no fx)", () => {
    const s = readFileSync(path.join(root, "lib/ai-helper/limits.ts"), "utf8");
    expect(s).toContain("PRICES_USD_PER_MTOK");
    expect(s).not.toMatch(/BigInt|fx/);
  });
});

describe("runAiHelper with the shipped EMPTY FX table is unchanged (runtime)", () => {
  it("one reserve at the live estimate, then the key read, then one settle: no new refusal, no extra RPC, no provider call", async () => {
    expect(USD_GBP_RATES).toEqual([]);
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true, request_id: "req-1", key_source: "own" }, error: null });
    const complete = vi.fn();
    const data = "{}"; const system = "s"; const schema = {};
    const outcome = await runAiHelper({ supabase: { rpc } as never, organizationId: "org-1", feature: "rfq", system, data, schema, validate: () => ({ value: 1, store: {} }), provider: { id: "anthropic", complete } });
    expect(outcome).toMatchObject({ kind: "failed", failure: "unavailable", detail: "key" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("ai_helper_reserve");
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_feature: "rfq", p_estimate_pence: estimatePence(AI_HELPER_MODELS.rfq, Buffer.byteLength(system + data + JSON.stringify(schema), "utf8"), MAX_OUTPUT_TOKENS.rfq) });
    expect(state.serviceCalls).toEqual(["from:ai_helper_secrets", "rpc:ai_helper_settle"]);
    expect(state.settle).toMatchObject({ p_status: "failed", p_cost_pence: 0 });
    expect(complete).not.toHaveBeenCalled();
  });
});
