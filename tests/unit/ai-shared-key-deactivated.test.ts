// AI-E (C4), option (b): with the real SHARED_TOLRA_AI_ACTIVE (false) the shared Tolra key is off. Inputs: runAiHelper, the AI setup card and
// the AI page copy, the three Tolra routes (source only). Must not mock the constant here: the other Tolra tests mock it to true to keep the
// dormant Tolra code covered.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const serviceRpc = vi.fn();
const serviceFrom = vi.fn();
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => ({ rpc: serviceRpc, from: serviceFrom }) }));

const run = async (callerRpc: ReturnType<typeof vi.fn>, provider: { complete: ReturnType<typeof vi.fn> }) => {
  const { runAiHelper } = await import("@/lib/ai-helper/server");
  return runAiHelper({ feature: "roundup", organizationId: "org", system: "s", data: "d", schema: {}, supabase: { rpc: callerRpc }, provider } as never);
};

beforeEach(() => { serviceRpc.mockReset(); serviceFrom.mockReset(); });

describe("runAiHelper refuses shared (Tolra) mode", () => {
  it("known shared mode: refused before any reservation, no key read, no provider call", async () => {
    const callerRpc = vi.fn(async (fn: string) => (fn === "ai_helper_status" ? { data: { tolra_enabled: true }, error: null } : { data: { ok: true, request_id: "req-1", key_source: "tolra" }, error: null }));
    const provider = { complete: vi.fn() };
    expect(await run(callerRpc, provider)).toEqual({ kind: "unavailable" });
    expect(callerRpc.mock.calls.map((c) => c[0])).toEqual(["ai_helper_status"]);
    expect(serviceRpc).not.toHaveBeenCalled();
    expect(serviceFrom).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });
  it("unreadable mode: refused before any reservation", async () => {
    const callerRpc = vi.fn(async (...args: string[]) => ({ data: args.length ? null : null, error: { code: "XX000" } }));
    const provider = { complete: vi.fn() };
    expect(await run(callerRpc, provider)).toEqual({ kind: "unavailable" });
    expect(callerRpc.mock.calls.map((c) => c[0])).toEqual(["ai_helper_status"]);
    expect(serviceRpc).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });
  it("race (mode turned on after the read): settled failed at 0, no key read, no provider call", async () => {
    const callerRpc = vi.fn(async (fn: string) => (fn === "ai_helper_status" ? { data: { tolra_enabled: false }, error: null } : { data: { ok: true, request_id: "req-1", key_source: "tolra" }, error: null }));
    serviceRpc.mockResolvedValue({ data: null, error: null });
    const provider = { complete: vi.fn() };
    expect(await run(callerRpc, provider)).toEqual({ kind: "unavailable" });
    expect(serviceRpc).toHaveBeenCalledTimes(1);
    expect(serviceRpc).toHaveBeenCalledWith("ai_helper_settle", expect.objectContaining({ p_request: "req-1", p_status: "failed", p_failure: "unavailable", p_cost_pence: 0 }));
    expect(serviceRpc).not.toHaveBeenCalledWith("ai_helper_tolra_key", expect.anything());
    expect(serviceFrom).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });
});

describe("the UI hides Tolra mode; the routes are unchanged", () => {
  it("card source renders the Tolra radio only when active; page copy names no Tolra AI", () => {
    const card = readFileSync("components/integrations/ai-setup-card.tsx", "utf8");
    expect(card).toMatch(/SHARED_TOLRA_AI_ACTIVE \? <label[^]*value="tolra"/);
    expect(readFileSync("app/(dashboard)/ai-helper/page.tsx", "utf8")).not.toMatch(/Tolra-provided/);
  });
  it("the three Tolra routes carry no 410 and do not import the constant", () => {
    for (const f of ["app/api/ai-helper/tolra-mode/route.ts", "app/api/platform/tolra-ai/route.ts", "app/api/platform/tolra-ai/caps/route.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/410|shared-ai-deactivation/);
    }
  });
});
