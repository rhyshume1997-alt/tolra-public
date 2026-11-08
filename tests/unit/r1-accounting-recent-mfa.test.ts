/** R1: the shared accounting route (/api/accounting/[provider]/[action]) needs a recent authenticator code for connect and disconnect (not check/status/callback). */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ amr: [] as unknown[], level: "aal2", disconnect: 0, begin: 0, check: 0 }));
vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()),
  sameOrigin: () => true,
  requireProfile: async () => ({ profile: { organization_id: "company-a" }, user: { id: "admin-a" }, session: { support: false, read_only: false },
    supabase: { auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: h.level, currentAuthenticationMethods: h.amr }, error: null }) } } } }),
}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock("@/lib/accounting/connections", () => ({
  disconnectAccounting: async () => { h.disconnect++; },
  accountingConnection: async () => ({ begin: async () => { h.begin++; return "https://p.test/a"; }, checkInvoice: async () => { h.check++; return {}; } }),
}));
import { POST } from "@/app/api/accounting/[provider]/[action]/route";

const ctx = (action: string) => ({ params: Promise.resolve({ provider: "sage", action }) });
const req = (body: object = {}) => new Request("https://t.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const now = () => Math.floor(Date.now() / 1000);
beforeEach(() => { delete process.env.REQUIRE_ADMIN_MFA; h.level = "aal2"; h.amr = [{ method: "totp", timestamp: now() }]; h.disconnect = h.begin = h.check = 0; });

describe.each([["connect", () => h.begin], ["disconnect", () => h.disconnect]] as const)("accounting %s", (action, reached) => {
  it("fresh code: goes through", async () => { expect((await POST(req(), ctx(action))).status).toBe(200); expect(reached()).toBe(1); });
  it("stale code: mfa_recent_required, nothing done, even with REQUIRE_ADMIN_MFA unset", async () => {
    h.amr = [{ method: "totp", timestamp: now() - 16 * 60 }];
    const res = await POST(req(), ctx(action));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("mfa_recent_required");
    expect(reached()).toBe(0);
  });
  it("aal1: mfa_required", async () => {
    h.level = "aal1";
    expect((await (await POST(req(), ctx(action))).json()).code).toBe("mfa_required");
    expect(reached()).toBe(0);
  });
});
describe("accounting check is read only: unchanged with a stale code", () => {
  it("answers", async () => {
    h.amr = [{ method: "totp", timestamp: now() - 3600 }];
    const res = await POST(req({ invoiceId: "11111111-1111-1111-1111-111111111111" }), ctx("check"));
    expect(res.status).not.toBe(403);
  });
});
