/**
 * The Companies routes (app/api/platform/companies/route.ts and .../status/route.ts), run for real with only the owner guard and the database client
 * faked. Proves: (1) with PLATFORM_COMPANIES_ENABLED unset or not exactly "true" both routes answer 404 and NOTHING is called: no release 164
 * function, no authenticator check, no service-role client; (2) the owner guard runs first, so a refused caller gets the guard's own refusal, with the
 * switch on or off, and nothing is called; (3) Close and Reopen act on exactly the ONE company named, through the owner's own session (never the
 * service role), a Close without a fresh authenticator code is refused before the database is asked, a request naming more than one company, an
 * extra key or a bad id is refused (400) before any call, and a database refusal (not owner, no second step, inside the company, wrong name) is
 * passed on as a fixed refusal with nothing else touched. The database side (forged claims, a company admin, the owner outside the second step,
 * rolling back) is proved by tests/db/platform-companies-164.test.ts in CI.
 * Must not change: this file proves; the routes are in app/api/platform/companies.
 */
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const guard = vi.hoisted(() => ({ result: null as unknown }));
vi.mock("@/lib/server/platform", () => ({ requirePlatformOwner: async () => guard.result }));

import { GET } from "@/app/api/platform/companies/route";
import { POST } from "@/app/api/platform/companies/status/route";

const ALPHA = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const rpc = vi.fn();
const assurance = vi.fn();
const adminFrom = vi.fn();
const freshCode = () => ({ data: { currentAuthenticationMethods: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 30 }] }, error: null });
const oldCode = () => ({ data: { currentAuthenticationMethods: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - 3600 }] }, error: null });
const owner = () => ({ supabase: { rpc, auth: { mfa: { getAuthenticatorAssuranceLevel: assurance } } }, user: { id: "owner-1" }, companies: [], admin: { from: adminFrom } });
const get = () => GET(new Request("https://app.example/api/platform/companies"));
const post = (body: unknown) => POST(new Request("https://app.example/api/platform/companies/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const close = { organizationId: ALPHA, status: "closed", confirmName: "Alpha Ltd", reason: "Customer left the platform" };
const reopen = { organizationId: ALPHA, status: "active", reason: "They came back" };
const nothingCalled = () => { expect(rpc).not.toHaveBeenCalled(); expect(assurance).not.toHaveBeenCalled(); expect(adminFrom).not.toHaveBeenCalled(); };

beforeEach(() => {
  rpc.mockReset(); assurance.mockReset(); adminFrom.mockReset();
  guard.result = owner();
  assurance.mockResolvedValue(freshCode());
  vi.stubEnv("PLATFORM_COMPANIES_ENABLED", "true");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("1. switched off: nothing that needs release 164 is called", () => {
  it("answers 404 to the owner and calls no database function, no authenticator check and no service role, for every value but exactly \"true\"", async () => {
    for (const value of [undefined, "", "TRUE", "1", "yes", "false", " true"]) {
      if (value === undefined) vi.unstubAllEnvs(); else vi.stubEnv("PLATFORM_COMPANIES_ENABLED", value);
      expect((await get()).status, `GET ${String(value)}`).toBe(404);
      expect((await post(close)).status, `close ${String(value)}`).toBe(404);
      expect((await post(reopen)).status, `reopen ${String(value)}`).toBe(404);
    }
    nothingCalled();
  });
  it("is the switch alone: turning it on makes the same request reach the database", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect((await get()).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("platform_company_overview");
  });
});

describe("2. the owner guard runs first", () => {
  it("a refused caller gets the guard's refusal, switch on or off, and nothing is called", async () => {
    for (const refusal of [{ error: "Unauthorized" }, { error: "Forbidden" }, { error: "mfa_required" }]) {
      guard.result = NextResponse.json(refusal, { status: refusal.error === "Unauthorized" ? 401 : 403 });
      for (const on of ["true", "false"]) {
        vi.stubEnv("PLATFORM_COMPANIES_ENABLED", on);
        const status = refusal.error === "Unauthorized" ? 401 : 403;
        expect((await get()).status, `GET ${refusal.error} ${on}`).toBe(status);
        expect((await post(close)).status, `close ${refusal.error} ${on}`).toBe(status);
        expect((await post(reopen)).status, `reopen ${refusal.error} ${on}`).toBe(status);
      }
    }
    nothingCalled();
  });
});

describe("3. Close and Reopen act on one company, as the owner, and nothing else", () => {
  it("Reopen sends exactly one call for the one company, through the owner's own session, and does not ask for a code", async () => {
    rpc.mockResolvedValue({ data: { organization_id: ALPHA, status: "active", changed: true }, error: null });
    const response = await post(reopen);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, organizationId: ALPHA, status: "active", changed: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("platform_set_organization_status", { p_org: ALPHA, p_status: "active", p_confirm_name: "", p_reason: "They came back" });
    expect(assurance).not.toHaveBeenCalled();
    expect(adminFrom).not.toHaveBeenCalled();
  });
  it("Close with a fresh code sends exactly one call for the one company, with the typed name, and never touches another company or the service role", async () => {
    rpc.mockResolvedValue({ data: { organization_id: ALPHA, status: "closed", changed: true }, error: null });
    expect((await post(close)).status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("platform_set_organization_status", { p_org: ALPHA, p_status: "closed", p_confirm_name: "Alpha Ltd", p_reason: "Customer left the platform" });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(BETA);
    expect(adminFrom).not.toHaveBeenCalled();
  });
  it("Close without a code under 15 minutes old is refused with the fresh-code answer before the database is asked", async () => {
    for (const answer of [oldCode(), { data: { currentAuthenticationMethods: [] }, error: null }, { data: null, error: { message: "x" } }]) {
      assurance.mockResolvedValue(answer);
      const response = await post(close);
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("mfa_recent_required");
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it("refuses more than one company, an extra key, a bad id, no reason and a non-object before any call", async () => {
    const bad: unknown[] = [
      { ...close, organizationId: [ALPHA, BETA] }, { ...close, organizationIds: [ALPHA, BETA] }, { ...close, all: true }, { ...close, organizationId: "not-a-uuid" },
      { ...close, organizationId: undefined }, { ...close, status: "deleted" }, { ...close, status: "paused" }, { ...close, reason: "no" }, { ...close, confirmName: "" },
      [close], "close", null,
    ];
    for (const body of bad) expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    nothingCalled();
  });
  it("passes a database refusal on as fixed words and changes nothing else: not owner, no second step, inside the company, wrong name, unknown company", async () => {
    const cases: Array<[{ code: string; hint?: string }, number]> = [
      [{ code: "42501", hint: "platform_required" }, 403], [{ code: "42501", hint: "mfa_required" }, 403], [{ code: "42501", hint: "mfa_recent_required" }, 403],
      [{ code: "22023", hint: "inside_company" }, 409], [{ code: "22023", hint: "name_mismatch" }, 400], [{ code: "P0002", hint: "company_not_found" }, 404],
    ];
    for (const [error, status] of cases) {
      rpc.mockReset();
      rpc.mockResolvedValue({ data: null, error: { ...error, message: "secret database text with Alpha Ltd" } });
      const response = await post(close);
      expect(response.status, JSON.stringify(error)).toBe(status);
      expect(JSON.stringify(await response.json())).not.toContain("secret database text");
      expect(rpc).toHaveBeenCalledTimes(1);
    }
    expect(adminFrom).not.toHaveBeenCalled();
  });
  it("never deletes: the only functions called are release 164's two", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await get();
    rpc.mockResolvedValue({ data: { organization_id: ALPHA, status: "closed", changed: true }, error: null });
    await post(close);
    await post(reopen);
    expect(new Set(rpc.mock.calls.map((call) => call[0]))).toEqual(new Set(["platform_company_overview", "platform_set_organization_status"]));
  });
});
