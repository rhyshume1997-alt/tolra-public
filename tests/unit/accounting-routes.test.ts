import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const fixture = vi.hoisted(() => ({ support: false, sameOrigin: true, forbidden: false, invoice: "INV-FAKE", configured: true, roles: [] as string[][], filters: [] as Array<[string, string]> }));
const disconnectAccounting = vi.hoisted(() => vi.fn(async (_id: string, _context: unknown) => undefined));
const checkInvoice = vi.hoisted(() => vi.fn(async () => ({ totalPence: 12050, outstandingPence: 0, currency: "GBP", reviewOnly: true })));
const chain = () => ({ select: () => chain(), eq: (key: string, value: string) => { fixture.filters.push([key, value]); return chain(); }, maybeSingle: async () => ({ data: fixture.invoice ? { invoice_ref: fixture.invoice, status: "connected", tenant_name: "Fake company" } : null, error: null }) });
vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => fixture.sameOrigin,
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  jsonError: (error: string, status: number) => NextResponse.json({ error }, { status }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  requireProfile: async (roles: string[]) => {
    fixture.roles.push(roles);
    if (fixture.forbidden) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return { profile: { organization_id: "company-a" }, user: { id: "admin-a" }, session: { support: fixture.support, read_only: false }, supabase: { auth: freshMfaAuth(), from: () => chain() } };
  },
}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => ({ from: () => chain() }) }));
vi.mock("@/lib/accounting/connections", () => ({ disconnectAccounting, accountingConnection: async () => fixture.configured ? { checkInvoice, begin: async () => "https://provider.example.test/authorize", finish: async () => true, disconnect: async () => undefined } : null }));
import { GET, POST } from "@/app/api/accounting/[provider]/[action]/route";
import { freshMfaAuth } from "../support/fresh-mfa";
const context = (action: string, provider = "sage") => ({ params: Promise.resolve({ action, provider }) });
const request = (body: object = {}) => new Request("https://tolra.example.test/api/accounting/sage/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { fixture.support = false; fixture.sameOrigin = true; fixture.forbidden = false; fixture.invoice = "INV-FAKE"; fixture.configured = true; fixture.filters = []; fixture.roles = []; checkInvoice.mockClear(); disconnectAccounting.mockClear(); });
describe("shared accounting route guards", () => {
  it("rejects cross-origin, non-admin and support without consulting a provider", async () => {
    fixture.sameOrigin = false;
    expect((await POST(request(), context("check"))).status).toBe(403);
    fixture.sameOrigin = true; fixture.forbidden = true;
    expect((await POST(request(), context("check"))).status).toBe(403);
    fixture.forbidden = false; fixture.support = true;
    expect((await POST(request(), context("check"))).status).toBe(403);
    expect(checkInvoice).not.toHaveBeenCalled();
    expect(fixture.roles).toEqual([["admin"], ["admin"]]);
  });
  it("uses only the signed-in company's invoice, ignores supplied company/tenant/number, and makes no invoice write", async () => {
    const response = await POST(request({ invoiceId: "11111111-1111-1111-1111-111111111111", organizationId: "company-b", tenantId: "evil", invoiceNumber: "FOREIGN" }), context("check"));
    expect(response.status).toBe(200);
    expect(fixture.filters).toContainEqual(["organization_id", "company-a"]);
    expect(checkInvoice).toHaveBeenCalledTimes(1);
    expect(checkInvoice).toHaveBeenCalledWith("INV-FAKE");
    expect(await response.json()).toMatchObject({ reviewOnly: true, evidence: { outstandingPence: 0 } });
    // Fake database deliberately has no insert/update/delete/rpc methods: a payment write would fail this test.
  });
  it("refuses a missing own-company invoice rather than passing an arbitrary external number", async () => {
    fixture.invoice = "";
    expect((await POST(request({ invoiceId: "11111111-1111-1111-1111-111111111111" }), context("check"))).status).toBe(404);
    expect(checkInvoice).not.toHaveBeenCalled();
  });
  it("can disconnect even if registration credentials were removed", async () => {
    fixture.configured = false;
    expect((await POST(request(), context("disconnect", "xero"))).status).toBe(200);
    expect(disconnectAccounting).toHaveBeenCalledTimes(1);
    expect(disconnectAccounting.mock.calls[0]?.[0]).toBe("xero");
  });
  it("stays unavailable without registration/schema and rejects unknown providers or write actions", async () => {
    fixture.configured = false;
    expect((await POST(request(), context("connect"))).status).toBe(503);
    expect((await POST(request(), context("send"))).status).toBe(404);
    expect((await GET(new Request("https://tolra.example.test"), context("status", "unknown"))).status).toBe(404);
  });
});
