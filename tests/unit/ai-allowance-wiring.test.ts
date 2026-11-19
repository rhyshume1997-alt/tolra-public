// Session 13: runAiHelper reserves a request count when the company has a tier, and keeps the pence reserve when it has none.
// Inputs: a stubbed caller client (rpc + from) and stubbed service client. Outputs: which reserve RPC ran and the outcome. No keys, no network.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const serviceRpc = vi.fn();
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => ({ rpc: serviceRpc, from: vi.fn() }) }));

const provider = { complete: vi.fn() };
const run = async (tier: unknown, reserveAnswer: unknown, opts: { tierError?: boolean; noFrom?: boolean } = {}) => {
  const { runAiHelper } = await import("@/lib/ai-helper/server");
  const rpc = vi.fn(async (fn: string) => (fn === "ai_helper_status" ? { data: { tolra_enabled: false }, error: null } : { data: reserveAnswer, error: null }));
  const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => (opts.tierError ? { data: null, error: { code: "42703" } } : { data: { ai_allowance_tier: tier }, error: null }) }) }) }));
  const supabase = opts.noFrom ? { rpc } : { rpc, from };
  const out = await runAiHelper({ feature: "roundup", organizationId: "org", system: "s", data: "d", schema: {}, supabase, provider, validate: (j: unknown) => ({ value: j, store: {} }) } as never);
  return { out, rpc };
};
const reserveCalls = (rpc: ReturnType<typeof vi.fn>) => rpc.mock.calls.map((c) => c[0]).filter((n) => String(n).startsWith("ai_helper_reserve"));

describe("runAiHelper allowance wiring", () => {
  beforeEach(() => { serviceRpc.mockReset(); provider.complete.mockReset(); });

  it("with a tier, reserves through ai_helper_reserve_allowance only", async () => {
    const { rpc } = await run("small", { ok: false, reason: "no_key", request_id: "r1" });
    expect(reserveCalls(rpc)).toEqual(["ai_helper_reserve_allowance"]);
  });
  it("with a tier at its limit, returns cap with no request id and calls no provider", async () => {
    const { out } = await run("small", { ok: false, reason: "allowance", period: "2026-11", limit: 100, used: 100 });
    expect(out).toEqual({ kind: "cap" });
    expect(provider.complete).not.toHaveBeenCalled();
  });
  it("with no tier, keeps the pence reserve", async () => {
    const { rpc } = await run(null, { ok: false, reason: "no_key", request_id: "r1" });
    expect(reserveCalls(rpc)).toEqual(["ai_helper_reserve"]);
  });
  it("an unknown tier, a tier read error and a client with no from() all keep the pence reserve", async () => {
    expect(reserveCalls((await run("huge", { ok: false, reason: "no_key", request_id: "r" })).rpc)).toEqual(["ai_helper_reserve"]);
    expect(reserveCalls((await run(null, { ok: false, reason: "no_key", request_id: "r" }, { tierError: true })).rpc)).toEqual(["ai_helper_reserve"]);
    expect(reserveCalls((await run(null, { ok: false, reason: "no_key", request_id: "r" }, { noFrom: true })).rpc)).toEqual(["ai_helper_reserve"]);
  });
  it("a no_allowance answer fails closed as unavailable", async () => {
    const { out } = await run("small", { ok: false, reason: "no_allowance", period: "2026-11" });
    expect(out).toEqual({ kind: "unavailable" });
  });
});
