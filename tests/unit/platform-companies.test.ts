/**
 * Owner Console, Companies panel, pure parts (lib/platform/companies.ts) and the two routes' shape. Proves: the panel is off unless the env flag is
 * exactly "true"; the database's bigint strings become numbers and a bad row is dropped; the status input is checked (id, close or reopen, a reason
 * of 5 to 500 characters, the typed name to close, no extra keys); each database refusal has fixed wording and no database message leaks; the routes
 * answer 404 before anything when the panel is off, use the owner's own session (never the service role), ask for a recent code before a close, never
 * delete, and never log the reason. Must not change: this file proves; it never edits a route or lib file to make itself pass.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PLATFORM_COMPANIES_ENV_FLAG, checkStatusInput, parseOverview, parseStatusResult, platformCompaniesEnabled, statusRefusal } from "@/lib/platform/companies";

const ROOT = path.resolve(__dirname, "../..");
const src = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const ID = "3f2c8a10-6b1e-4c1a-9d57-0a1b2c3d4e5f";

describe("the switch", () => {
  it("is on only for exactly \"true\"", () => {
    expect(PLATFORM_COMPANIES_ENV_FLAG).toBe("PLATFORM_COMPANIES_ENABLED");
    expect(platformCompaniesEnabled({ PLATFORM_COMPANIES_ENABLED: "true" })).toBe(true);
    for (const v of [undefined, "", "TRUE", "1", "yes", "false", " true"]) expect(platformCompaniesEnabled({ PLATFORM_COMPANIES_ENABLED: v })).toBe(false);
    expect(platformCompaniesEnabled({})).toBe(false);
  });
});

describe("parseOverview", () => {
  it("turns the database's bigint strings into numbers and keeps the order", () => {
    const rows = parseOverview([
      { organization_id: ID, name: "Alpha", slug: "alpha", status: "active", user_count: "4", job_count: "12", invoice_count: "9", issued_invoice_count: "7" },
      { organization_id: "b", name: "Beta", slug: "beta", status: "closed", user_count: 0, job_count: 0, invoice_count: 0, issued_invoice_count: 0 },
    ]);
    expect(rows).toEqual([
      { organizationId: ID, name: "Alpha", slug: "alpha", status: "active", people: 4, jobs: 12, invoices: 9, issuedInvoices: 7 },
      { organizationId: "b", name: "Beta", slug: "beta", status: "closed", people: 0, jobs: 0, invoices: 0, issuedInvoices: 0 },
    ]);
  });
  it("drops a row that is not the expected shape, and anything that is not a list", () => {
    expect(parseOverview([{ name: "No id" }, null, "x", 3])).toEqual([]);
    for (const v of [null, undefined, {}, "rows", 5]) expect(parseOverview(v)).toEqual([]);
  });
  it("never returns a negative or non-numeric count", () => {
    const [row] = parseOverview([{ organization_id: "a", name: "A", slug: "a", status: "active", user_count: "-3", job_count: "many", invoice_count: null, issued_invoice_count: 2.9 }]);
    expect(row).toMatchObject({ people: 0, jobs: 0, invoices: 0, issuedInvoices: 2 });
  });
});

describe("checkStatusInput", () => {
  const ok = { organizationId: ID, status: "closed", confirmName: "Alpha Ltd", reason: "Test company no longer needed" };
  it("accepts a close with the typed name and a reason, and a reopen with a reason only", () => {
    expect(checkStatusInput(ok)).toEqual({ ok: true, value: { organizationId: ID, status: "closed", confirmName: "Alpha Ltd", reason: "Test company no longer needed" } });
    expect(checkStatusInput({ organizationId: ID.toUpperCase(), status: "active", reason: "  Closed by mistake  " })).toEqual({ ok: true, value: { organizationId: ID, status: "active", confirmName: "", reason: "Closed by mistake" } });
  });
  it("refuses a missing or wrong id, status, reason, name, or an extra key", () => {
    const cases: unknown[] = [
      null, [], "x", {}, { ...ok, organizationId: "nope" }, { ...ok, organizationId: undefined }, { ...ok, status: "deleted" }, { ...ok, status: "paused" },
      { ...ok, reason: "abc" }, { ...ok, reason: "x".repeat(501) }, { ...ok, reason: 5 }, { ...ok, confirmName: "   " }, { ...ok, confirmName: undefined }, { ...ok, extra: 1 },
    ];
    for (const body of cases) expect(checkStatusInput(body), JSON.stringify(body)).toMatchObject({ ok: false });
  });
});

describe("statusRefusal", () => {
  it("keeps the fresh-code code so the browser can ask for a code, and gives every other refusal fixed words", () => {
    expect(statusRefusal({ code: "42501", hint: "mfa_recent_required" })).toMatchObject({ status: 403, code: "mfa_recent_required" });
    expect(statusRefusal({ code: "42501", hint: "mfa_required" })).toMatchObject({ status: 403, code: "mfa_required" });
    expect(statusRefusal({ code: "42501", hint: "platform_required" })).toEqual({ status: 403, error: "Forbidden" });
    expect(statusRefusal({ code: "22023", hint: "name_mismatch" })).toMatchObject({ status: 400 });
    expect(statusRefusal({ code: "22023", hint: "reason_required" })).toMatchObject({ status: 400 });
    expect(statusRefusal({ code: "22023", hint: "inside_company" })).toMatchObject({ status: 409 });
    expect(statusRefusal({ code: "22023", hint: "status_transition" })).toMatchObject({ status: 409 });
    expect(statusRefusal({ code: "P0002", hint: "company_not_found" })).toMatchObject({ status: 404 });
    expect(statusRefusal({ code: "XX000" })).toMatchObject({ status: 500 });
    expect(statusRefusal(null)).toMatchObject({ status: 500 });
  });
  it("never repeats a database message", () => {
    const refusal = statusRefusal({ code: "22023", hint: "name_mismatch", message: "The name typed does not match this company." } as never);
    expect(JSON.stringify(refusal)).not.toMatch(/does not match this company\.$/);
    expect(refusal.error).toBe("The name you typed does not match this company. Nothing was changed.");
  });
});

describe("parseStatusResult", () => {
  it("accepts the database's answer and nothing else", () => {
    expect(parseStatusResult({ organization_id: ID, status: "closed", changed: true })).toEqual({ organizationId: ID, status: "closed", changed: true });
    for (const v of [null, {}, { organization_id: ID }, { organization_id: ID, status: "closed", changed: "yes" }, "x"]) expect(parseStatusResult(v)).toBeNull();
  });
});

describe("the routes", () => {
  const overview = src("app/api/platform/companies/route.ts");
  const status = src("app/api/platform/companies/status/route.ts");
  it("run the owner guard first, then answer 404 when the panel is off, before any database call", () => {
    for (const code of [overview, status]) {
      const guard = code.indexOf("requirePlatformOwner(request)");
      const flag = code.indexOf("platformCompaniesEnabled()");
      expect(guard).toBeGreaterThan(-1);
      expect(flag).toBeGreaterThan(guard);
      expect(flag).toBeLessThan(code.indexOf(".rpc("));
      expect(code).toMatch(/Not found", 404/);
    }
  });
  it("use the owner's own session for one release 164 call, never the service role, and never delete", () => {
    expect(overview).toMatch(/ctx\.supabase\.rpc\("platform_company_overview"\)/);
    expect(status).toMatch(/supabase\.rpc\("platform_set_organization_status"/);
    for (const code of [overview, status]) {
      expect(code).not.toMatch(/\badmin\b/);
      expect(code).not.toMatch(/\.delete\(|delete_|DELETE/);
      expect(code).not.toMatch(/createSupabaseAdminClient/);
    }
  });
  it("ask for a code under 15 minutes old before a close is sent, and log neither the reason nor a database message", () => {
    expect(status.indexOf("recentSecondStep")).toBeGreaterThan(-1);
    expect(status.indexOf("recentSecondStep")).toBeLessThan(status.indexOf("rpc(\"platform_set_organization_status\""));
    expect(status).toMatch(/status === "closed"/);
    const logs = status.split("\n").filter((line) => line.includes("console."));
    for (const line of logs) expect(line).not.toMatch(/reason|message/);
  });
});

describe("the page", () => {
  it("mounts the panel, which renders nothing unless the switch is on, and keeps the existing list, create and enter", () => {
    const page = src("app/platform/page.tsx");
    expect(page).toMatch(/<CompaniesPanel \/>/);
    for (const kept of ["platform_list_organizations", "platform_enter_organization", "data-testid=\"platform-list\"", "New company"]) expect(page).toContain(kept);
  });
});
