/**
 * Xero PR 2 (G22; Rhys, Wed 21 Oct: admin only for connect, mapping and manual send/retry). The Integrations page is admin only (office,
 * workshop and viewers get Access Denied and none of it); the mappings route asks for an admin (two-step comes with every admin route),
 * reads Xero's tax rates on the server (faked here: nothing reaches the network) and refuses a tax rate whose percentage is not the Tolra
 * rate's before the database is asked; a matching one is saved by the database as the signed-in admin. No token reaches the browser.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const user = vi.hoisted(() => ({ activeRole: "admin" as string }));
vi.mock("@/lib/use-user", () => ({
  useUser: () => ({
    profile: { id: "u-1", role: user.activeRole }, loading: false, activeRole: user.activeRole,
    organizations: [{ organization_id: "o-1", name: "JNR Engineering", slug: "jnr", role: user.activeRole, is_current: true }],
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/supabase", () => ({ supabase: null }));

const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => ({ data: { fn, args } as unknown, error: null as null | { code: string; message: string; hint?: string } }));
const auth = vi.hoisted(() => ({ roles: [] as string[][], allow: true, support: false }));
vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => true,
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  jsonError: (m: string, s: number) => NextResponse.json({ error: m }, { status: s }),
  readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
  requireProfile: vi.fn(async (r: string[]) => {
    auth.roles.push(r);
    if (!auth.allow) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return { supabase: { rpc }, profile: { organization_id: "o-1" }, session: { support: auth.support } };
  }),
}));

const provider = {
  listAccounts: vi.fn(async () => [
    { code: "200", name: "Sales", type: "REVENUE", revenue: true }, { code: "260", name: "Other Revenue", type: "OTHERINCOME", revenue: true },
    { code: "090", name: "Business Bank", type: "BANK", revenue: false },
  ]),
  listTaxRates: vi.fn(async () => [
    { code: "OUTPUT2", name: "20% (VAT on Income)", rate: 20, revenue: true, active: true },
    { code: "ZERORATEDOUTPUT", name: "Zero Rated Income", rate: 0, revenue: true, active: true },
    { code: "INPUT2", name: "20% (VAT on Expenses)", rate: 20, revenue: false, active: true },
    { code: "OLDOUTPUT", name: "Old 20%", rate: 20, revenue: true, active: false },
  ]),
};
const server = vi.hoisted(() => ({ sendQueued: vi.fn(async () => ({ sent: 0 })) }));
vi.mock("@/lib/integrations/server", () => ({
  xeroReady: () => ({ config: {}, key: Buffer.alloc(32) }),
  companyProvider: vi.fn(async () => provider),
  sendQueued: server.sendQueued,
}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => ({}) }));

import AdminIntegrationsPage from "@/app/(dashboard)/admin/integrations/page";

const post = (body: unknown) => new Request("http://localhost/api/integrations/xero/mappings", { method: "POST", body: JSON.stringify(body) });

describe("the Integrations page is admin only", () => {
  it.each(["office", "workshop", "viewer"])("%s gets Access Denied and nothing of the page", (role) => {
    user.activeRole = role;
    const html = renderToStaticMarkup(createElement(AdminIntegrationsPage));
    expect(html).toContain("Access Denied");
    expect(html).not.toContain("Xero");
    expect(html).not.toContain("Send log");
  });

  it("an admin gets the page", () => {
    user.activeRole = "admin";
    const html = renderToStaticMarkup(createElement(AdminIntegrationsPage));
    expect(html).not.toContain("Access Denied");
    expect(html).toContain("Integrations");
  });

  it("the sidebar link is admin only and hidden until the database has 084", () => {
    const sidebar = readFileSync("components/sidebar.tsx", "utf8");
    expect(sidebar).toContain('{ href: "/admin/integrations", label: "Integrations", icon: Plug, roles: ["admin"] }');
    expect(sidebar).toContain('(item.href !== "/admin/integrations" || has084)');
    const panel = readFileSync("components/integrations-panel.tsx", "utf8");
    expect(panel).toContain("if (missing084 || !has084) return");
  });
});

describe("the mappings route", () => {
  beforeEach(() => {
    auth.roles.length = 0;
    auth.allow = true;
    auth.support = false;
    rpc.mockClear();
    rpc.mockImplementation(async () => ({ data: {}, error: null }));
  });

  it("asks for an admin on both the read and the save; a refused caller gets nothing", async () => {
    const route = await import("@/app/api/integrations/xero/mappings/route");
    auth.allow = false;
    expect((await route.GET()).status).toBe(403);
    expect((await route.POST(post({ kind: "sales_account", code: "200" }))).status).toBe(403);
    expect(auth.roles).toEqual([["admin"], ["admin"]]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("offers only what can be used on sales: revenue accounts, active sales tax rates (nothing else is sent)", async () => {
    const route = await import("@/app/api/integrations/xero/mappings/route");
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accounts.map((a: { code: string }) => a.code)).toEqual(["200", "260"]);
    expect(body.taxRates.map((t: { code: string }) => t.code)).toEqual(["OUTPUT2", "ZERORATEDOUTPUT"]);
    expect(Object.keys(body)).toEqual(["accounts", "taxRates"]);
  });

  it("refuses a purchases-only tax rate and a non-revenue account before the database is asked", async () => {
    const route = await import("@/app/api/integrations/xero/mappings/route");
    expect((await route.POST(post({ kind: "tax_rate", tolraKey: "20", code: "INPUT2" }))).status).toBe(422);
    expect((await route.POST(post({ kind: "tax_rate", tolraKey: "20", code: "OLDOUTPUT" }))).status).toBe(422);
    expect((await route.POST(post({ kind: "sales_account", code: "090" }))).status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a tax rate whose percentage is not the Tolra rate's, with the reason, and never asks the database", async () => {
    const route = await import("@/app/api/integrations/xero/mappings/route");
    const res = await route.POST(post({ kind: "tax_rate", tolraKey: "20", code: "ZERORATEDOUTPUT" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('Not saved: Xero\'s "Zero Rated Income" is 0%, but Tolra\'s VAT 20% is 20%. Pick a Xero tax rate of 20%.');
    expect(rpc).not.toHaveBeenCalled();
  });

  it("saves a matching tax rate through the database as the signed-in admin, with Xero's name", async () => {
    const route = await import("@/app/api/integrations/xero/mappings/route");
    const res = await route.POST(post({ kind: "tax_rate", tolraKey: "20", code: "OUTPUT2" }));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("integration_set_mapping", {
      p_provider: "xero", p_kind: "tax_rate", p_tolra_key: "20", p_external_code: "OUTPUT2", p_external_name: "20% (VAT on Income)",
    });
  });

  it("an account code must be in Xero's list; a blank code removes the mapping without asking Xero", async () => {
    const route = await import("@/app/api/integrations/xero/mappings/route");
    expect((await route.POST(post({ kind: "sales_account", code: "999" }))).status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
    provider.listAccounts.mockClear();
    expect((await route.POST(post({ kind: "credit_account", code: "" }))).status).toBe(200);
    expect(provider.listAccounts).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("integration_set_mapping", { p_provider: "xero", p_kind: "credit_account", p_tolra_key: null, p_external_code: null, p_external_name: null });
  });

  it("the database's refusal (no second step) is passed on in plain words", async () => {
    const route = await import("@/app/api/integrations/xero/mappings/route");
    rpc.mockImplementation(async () => ({ data: null, error: { code: "42501", message: "x", hint: "mfa_required" } }));
    const res = await route.POST(post({ kind: "sales_account", code: "200" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Confirm your authenticator code first.");
  });
});

describe("support access (an admin membership held by the platform owner) never reads or changes Xero settings", () => {
  beforeEach(() => {
    auth.support = true;
    auth.allow = true;
    rpc.mockClear();
    provider.listAccounts.mockClear();
    provider.listTaxRates.mockClear();
    server.sendQueued.mockClear();
  });

  it("GET is refused with 403 and neither Xero nor the database is touched", async () => {
    const route = await import("@/app/api/integrations/xero/mappings/route");
    const res = await route.GET();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Support access can't change Xero settings.");
    expect(provider.listAccounts).not.toHaveBeenCalled();
    expect(provider.listTaxRates).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("POST is refused with 403 and neither Xero nor the database is touched", async () => {
    const route = await import("@/app/api/integrations/xero/mappings/route");
    for (const body of [{ kind: "tax_rate", tolraKey: "20", code: "OUTPUT2" }, { kind: "sales_account", code: "200" }, { kind: "credit_account", code: "" }]) {
      const res = await route.POST(post(body));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("Support access can't change Xero settings.");
    }
    expect(provider.listAccounts).not.toHaveBeenCalled();
    expect(provider.listTaxRates).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Send now is refused with 403 and nothing is sent", async () => {
    const route = await import("@/app/api/integrations/xero/send/route");
    const res = await route.POST(new Request("http://localhost/api/integrations/xero/send", { method: "POST" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Support access can't change Xero settings.");
    expect(server.sendQueued).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an ordinary admin still sends", async () => {
    auth.support = false;
    const route = await import("@/app/api/integrations/xero/send/route");
    const res = await route.POST(new Request("http://localhost/api/integrations/xero/send", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(server.sendQueued).toHaveBeenCalledTimes(1);
  });

  it("the database's own support_read_only refusal has its own message", async () => {
    auth.support = false;
    rpc.mockImplementation(async () => ({ data: null, error: { code: "42501", message: "x", hint: "support_read_only" } }));
    const route = await import("@/app/api/integrations/xero/mappings/route");
    const res = await route.POST(post({ kind: "sales_account", code: "200" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Support access is read only here, so the mappings can't be changed.");
  });
});

describe("the Xero client's lists for the mapping page (Xero faked: nothing reaches the network)", () => {
  const fake = (json: unknown) => vi.fn(async () => new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } }));

  it("tax rates carry whether they apply to sales and are active; deleted ones are left out", async () => {
    const { createXeroClient } = await import("@/lib/integrations/xero/client");
    const fetchImpl = fake({ TaxRates: [
      { TaxType: "OUTPUT2", Name: "20% (VAT on Income)", EffectiveRate: 20, Status: "ACTIVE", CanApplyToRevenue: true },
      { TaxType: "INPUT2", Name: "20% (VAT on Expenses)", EffectiveRate: 20, Status: "ACTIVE", CanApplyToRevenue: false },
      { TaxType: "OLD", Name: "Old", EffectiveRate: 20, Status: "ARCHIVED", CanApplyToRevenue: true },
      { TaxType: "GONE", Name: "Gone", EffectiveRate: 20, Status: "DELETED", CanApplyToRevenue: true },
    ] });
    const rates = await createXeroClient({ accessToken: "t", tenantId: "x", fetchImpl }).listTaxRates();
    expect(rates).toEqual([
      { code: "OUTPUT2", name: "20% (VAT on Income)", rate: 20, revenue: true, active: true },
      { code: "INPUT2", name: "20% (VAT on Expenses)", rate: 20, revenue: false, active: true },
      { code: "OLD", name: "Old", rate: 20, revenue: true, active: false },
    ]);
  });

  it("accounts: active only, and revenue for Xero's REVENUE class (REVENUE, SALES, OTHERINCOME)", async () => {
    const { createXeroClient } = await import("@/lib/integrations/xero/client");
    const fetchImpl = fake({ Accounts: [
      { Code: "200", Name: "Sales", Type: "REVENUE", Class: "REVENUE", Status: "ACTIVE" },
      { Code: "201", Name: "Shop sales", Type: "SALES", Class: "REVENUE", Status: "ACTIVE" },
      { Code: "260", Name: "Other Revenue", Type: "OTHERINCOME", Class: "REVENUE", Status: "ACTIVE" },
      { Code: "090", Name: "Business Bank", Type: "BANK", Class: "ASSET", Status: "ACTIVE" },
      { Code: "299", Name: "Old sales", Type: "REVENUE", Class: "REVENUE", Status: "ARCHIVED" },
    ] });
    const accounts = await createXeroClient({ accessToken: "t", tenantId: "x", fetchImpl }).listAccounts();
    expect(accounts.map((a) => [a.code, a.revenue])).toEqual([["200", true], ["201", true], ["260", true], ["090", false]]);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain(encodeURIComponent('Status=="ACTIVE"'));
  });
});
