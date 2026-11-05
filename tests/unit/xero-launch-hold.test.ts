/**
 * The Xero transfer switch in the app (release 149). Off (or unreadable, or malformed) is OFF: no token, no engine, no Xero call. Switched off
 * in the middle of a send: the next call is not made, the row goes back to pending (never left in 'sending'), the run stops with
 * launch_hold and nothing throws. A rolled-back database (no switch function) is OFF and the daily sweep reports skipped instead of throwing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ sent: vi.fn(), token: vi.fn(), enabled: false }));
vi.mock("@/lib/integrations/engine", async (importOriginal) => ({ ...(await importOriginal<object>()), runSends: state.sent }));
vi.mock("@/lib/integrations/tokens", () => ({ createTokenSource: () => state.token }));

import { sendQueued, sweepDeps } from "@/lib/integrations/server";
import { runIntegrationSweep } from "@/lib/integrations/sweep";
import { type AccountingProvider, TransfersHeldError } from "@/lib/integrations/types";
import { batchDeps } from "@/lib/integrations/xero/batch-deps";
import { heldXeroProvider, xeroTransfersEnabled } from "@/lib/integrations/xero/launch-hold";

const ready = { config: {} as never, key: Buffer.alloc(32) };
const client = () => ({ rpc: vi.fn(async () => ({ data: state.enabled, error: null })) }) as unknown as SupabaseClient;
beforeEach(() => { state.enabled = false; state.sent.mockReset(); state.token.mockReset(); state.sent.mockResolvedValue({ sent: 1 }); });

describe("OFF means no engine, token or outbound call", () => {
  it("connected company held OFF: sendQueued answers launch_hold before any token or engine work", async () => {
    expect(await sendQueued(client(), "company-A", ready)).toMatchObject({ blocked: "launch_hold", sent: 0 });
    expect(state.sent).not.toHaveBeenCalled();
    expect(state.token).not.toHaveBeenCalled();
  });
  it("switched on: the existing normal send path runs", async () => {
    state.enabled = true;
    expect(await sendQueued(client(), "company-A", ready)).toEqual({ sent: 1 });
    expect(state.sent).toHaveBeenCalledOnce();
  });
  it.each([null, false, {}, "true", 1, undefined])("a missing or malformed answer %j stays OFF", async (value) => {
    const c = { rpc: async () => ({ data: value, error: null }) } as unknown as SupabaseClient;
    expect(await xeroTransfersEnabled(c, "A")).toBe(false);
  });
  it("a read failure, a thrown error and a missing function (rolled back) stay OFF", async () => {
    expect(await xeroTransfersEnabled({ rpc: async () => { throw new Error("synthetic"); } } as unknown as SupabaseClient, "A")).toBe(false);
    expect(await xeroTransfersEnabled({ rpc: async () => ({ data: null, error: { code: "PGRST202" } }) } as unknown as SupabaseClient, "A")).toBe(false);
    expect(await xeroTransfersEnabled({ rpc: async () => ({ data: true, error: { code: "42883" } }) } as unknown as SupabaseClient, "A")).toBe(false);
  });
  it("a held batch cannot enqueue or retry even with an existing connection, and touches nothing", async () => {
    const service = { ...client(), from: vi.fn() };
    const user = { rpc: vi.fn() };
    const deps = batchDeps({ service: service as never, user: user as never, org: "company-A", ready });
    await expect(deps.enqueue({} as never)).rejects.toThrow("off");
    await expect(deps.retry("synthetic-send")).rejects.toThrow("off");
    expect(service.from).not.toHaveBeenCalled();
    expect(user.rpc).not.toHaveBeenCalled();
  });
  it("an enabled batch keeps its existing retry path", async () => {
    state.enabled = true;
    const user = { rpc: vi.fn(async () => ({ error: null })) };
    await batchDeps({ service: client(), user: user as never, org: "company-A", ready }).retry("synthetic-send");
    expect(user.rpc).toHaveBeenCalledWith("integration_retry_send", { p_send: "synthetic-send" });
  });
});

describe("the held provider rechecks before every call", () => {
  it("invoice, credit, void, contact and read-back are refused with TransfersHeldError while OFF; a switch back on lets them through", async () => {
    const call = vi.fn();
    const provider = { id: "xero", pushInvoice: call, pushCreditNote: call, voidInvoice: call, readBack: call, createContact: call, findContacts: call } as unknown as AccountingProvider;
    const held = heldXeroProvider(provider, async () => state.enabled);
    for (const op of [() => held.pushInvoice({} as never, {} as never, "c", "k"), () => held.pushCreditNote({} as never, {} as never, "c", "k"), () => held.voidInvoice("i", "k"),
      () => held.readBack("invoice", "INV-1"), () => held.createContact("name", "k"), () => held.findContacts("name")]) {
      await expect(op()).rejects.toBeInstanceOf(TransfersHeldError);
    }
    expect(call).not.toHaveBeenCalled();
    state.enabled = true;
    await held.readBack("invoice", "INV-1");
    expect(call).toHaveBeenCalledOnce();
    state.enabled = false;
    await expect(held.readBack("invoice", "INV-1")).rejects.toThrow("off");
    expect(call).toHaveBeenCalledOnce();
  });
});

describe("the daily sweep", () => {
  const service = (rpc: (fn: string, args?: unknown) => Promise<{ data: unknown; error: unknown }>) => ({ rpc: vi.fn(rpc), from: vi.fn() }) as unknown as SupabaseClient;
  it("lists only the companies the database says are switched on and connected (it never reads the connections table)", async () => {
    const c = service(async (fn) => (fn === "integration_xero_enabled_orgs" ? { data: ["org-A"], error: null } : { data: true, error: null }));
    expect(await sweepDeps(c, ready).connected()).toEqual([{ organizationId: "org-A", provider: "xero" }]);
    expect((c as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();
  });
  it("a company switched off after the list was made is neither renewed nor an error", async () => {
    const c = service(async (fn) => (fn === "integration_xero_enabled_orgs" ? { data: ["org-A"], error: null } : { data: false, error: null }));
    const summary = await runIntegrationSweep(sweepDeps(c, ready));
    expect(summary).toMatchObject({ companies: 1, renewed: 0, errors: 0, sent: 0 });
    expect(state.token).not.toHaveBeenCalled();
  });
  it("a database without the switch (release 149 rolled back) raises a DbError the cron pass turns into skipped, not an uncaught throw", async () => {
    const c = service(async () => ({ data: null, error: { code: "PGRST202", message: "no function" } }));
    await expect(sweepDeps(c, ready).connected()).rejects.toMatchObject({ code: "PGRST202" });
  });
});
