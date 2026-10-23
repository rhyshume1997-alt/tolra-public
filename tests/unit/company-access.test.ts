/**
 * Admin > Users, per-company access (migration 066): what the page shows and sends. Only companies the database listed are shown,
 * the current company and support memberships are never sent, and every refusal reads as a sentence naming the company.
 */
import { describe, expect, it } from "vitest";

import { companyAccessErrorMessage, draftCompanies, mayAddExistingLogin, OTHER_COMPANY_LOGIN, parseCompanyAccess, PROTECTED_LOGIN, parseCompanyResults, planCompanyChanges, summariseCompanyResults } from "@/lib/company-access";

const JNR = "11111111-1111-4111-8111-111111111111";
const MARPET = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const rows = parseCompanyAccess([
  { organization_id: JNR, name: "JNR Engineering", is_current: true, require_admin_mfa: false, member: true, role: "office", secondary_role: null, active: true, support: false },
  { organization_id: MARPET, name: "Marpet", is_current: false, require_admin_mfa: true, member: true, role: "workshop", secondary_role: "viewer", active: true, support: false },
  { organization_id: OTHER, name: "Other Ltd", is_current: false, require_admin_mfa: false, member: false, role: null, secondary_role: null, active: false, support: false },
  { name: "no id" },
  null,
]);

describe("reading the database's lists", () => {
  it("keeps well-formed rows only, with typed fields", () => {
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({ organizationId: MARPET, name: "Marpet", isCurrent: false, requireAdminMfa: true, member: true, role: "workshop", secondary: "viewer", active: true, support: false });
    expect(rows[2]).toMatchObject({ member: false, role: null, secondary: "", active: false });
    expect(parseCompanyAccess(null)).toEqual([]);
    expect(parseCompanyAccess([{ organization_id: OTHER, role: "owner" }])[0]).toMatchObject({ role: null, name: "Company" });
  });

  it("the editable rows leave out the current company; a company they are not in starts off with the default role", () => {
    const drafts = draftCompanies(rows, "viewer");
    expect(drafts.map((d) => d.organizationId)).toEqual([MARPET, OTHER]);
    expect(drafts[0]).toEqual({ organizationId: MARPET, name: "Marpet", on: true, role: "workshop", secondary: "viewer", locked: false });
    expect(drafts[1]).toEqual({ organizationId: OTHER, name: "Other Ltd", on: false, role: "viewer", secondary: "", locked: false });
  });

  it("a support membership is shown locked and off", () => {
    const [support] = draftCompanies(parseCompanyAccess([{ organization_id: OTHER, name: "Other Ltd", is_current: false, member: true, role: "admin", active: true, support: true }]));
    expect(support).toMatchObject({ on: false, locked: true });
  });
});

describe("what is sent", () => {
  const drafts = draftCompanies(rows);

  it("nothing when nothing changed", () => {
    expect(planCompanyChanges(rows, drafts)).toEqual([]);
  });

  it("switching a company on is a grant with the role (and second role, never the same as the role)", () => {
    const next = drafts.map((d) => (d.organizationId === OTHER ? { ...d, on: true, role: "office" as const, secondary: "office" as const } : d));
    expect(planCompanyChanges(rows, next)).toEqual([{ organization_id: OTHER, active: true, role: "office", secondary_role: null }]);
  });

  it("switching a company off is a removal only", () => {
    const next = drafts.map((d) => (d.organizationId === MARPET ? { ...d, on: false } : d));
    expect(planCompanyChanges(rows, next)).toEqual([{ organization_id: MARPET, active: false }]);
  });

  it("a different role or second role while on is a change that sends both", () => {
    expect(planCompanyChanges(rows, drafts.map((d) => (d.organizationId === MARPET ? { ...d, role: "admin" as const } : d))))
      .toEqual([{ organization_id: MARPET, active: true, role: "admin", secondary_role: "viewer" }]);
    expect(planCompanyChanges(rows, drafts.map((d) => (d.organizationId === MARPET ? { ...d, secondary: "" as const } : d))))
      .toEqual([{ organization_id: MARPET, active: true, role: "workshop", secondary_role: null }]);
  });

  it("a brand-new login: every ticked company is a grant; unticked ones send nothing", () => {
    const fresh = draftCompanies(rows).map((d) => (d.organizationId === MARPET ? { ...d, on: true, role: "viewer" as const, secondary: "" as const } : { ...d, on: false }));
    expect(planCompanyChanges([], fresh)).toEqual([{ organization_id: MARPET, active: true, role: "viewer", secondary_role: null }]);
  });

  it("the current company and support memberships are never sent, whatever the draft says", () => {
    const supportRows = parseCompanyAccess([
      { organization_id: JNR, name: "JNR", is_current: true, member: true, role: "office", active: true },
      { organization_id: OTHER, name: "Other", is_current: false, member: true, role: "admin", active: true, support: true },
    ]);
    const forged = [
      { organizationId: JNR, name: "JNR", on: false, role: "office" as const, secondary: "" as const, locked: false },
      { organizationId: OTHER, name: "Other", on: false, role: "admin" as const, secondary: "" as const, locked: false },
    ];
    expect(planCompanyChanges(supportRows, forged)).toEqual([]);
  });
});

describe("the database's refusals, as sentences", () => {
  it.each([
    [{ code: "42501", hint: "not_company_admin" }, "You're not an admin of Marpet"],
    [{ code: "42501", hint: "mfa_required" }, "Marpet requires two-step sign-in"],
    [{ code: "23514", hint: "last_admin" }, "Marpet must keep at least one active admin"],
    [{ code: "23514", hint: "self_removal" }, "You can't remove your own access to Marpet"],
    [{ code: "23514", hint: "self_demotion" }, "You can't remove your own admin rights in Marpet"],
    [{ code: "23514", hint: "last_company" }, "must keep access to at least one company"],
    [{ code: "42501", hint: "support_membership" }, "Tolra support access to Marpet"],
    [{ code: "42501", hint: "support_session" }, "Support access can't change"],
    [{ code: "40001", hint: "concurrent_change" }, "at the same time"],
    [{ code: "22023" }, "Choose a role for Marpet"],
    [{ code: "P0002" }, "User not found"],
    [{ code: "42501" }, "You can't change who has access to Marpet"],
    [{ code: "XX000" }, "Couldn't update access to Marpet"],
    [null, "Couldn't update access to Marpet"],
  ])("%j", (error, text) => {
    expect(companyAccessErrorMessage(error, "Marpet")).toContain(text);
  });
});

describe("the result after saving", () => {
  it("reads the route's results and summarises saved and refused companies", () => {
    const results = parseCompanyResults({ results: [
      { organization_id: MARPET, name: "Marpet", ok: true, changed: true, action: "GRANT_COMPANY_ACCESS", admin_mfa_onboarding: true },
      { organization_id: OTHER, name: "Other Ltd", ok: false, error: "Other Ltd must keep at least one active admin." },
      { name: "no id" },
    ] });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true, admin_mfa_onboarding: true, action: "GRANT_COMPANY_ACCESS" });
    expect(summariseCompanyResults(results)).toEqual({ tone: "partial", text: "Company access saved: Marpet. Other Ltd: Other Ltd must keep at least one active admin." });
    expect(summariseCompanyResults([results[0]]).tone).toBe("ok");
    expect(summariseCompanyResults([results[1]]).tone).toBe("error");
    expect(summariseCompanyResults([{ ...results[0], changed: false }]).tone).toBe("none");
    expect(parseCompanyResults(null)).toEqual([]);
  });
});

describe("mayAddExistingLogin: who an admin may add or switch on", () => {
  const CALLER = "caller";
  it("refuses a login in a company the caller doesn't administer (a Marpet-only admin and a JNR-only login)", () => {
    expect(mayAddExistingLogin(CALLER, "charlie", [JNR], [MARPET], false)).toBe(false);
    // Also when the login is in the caller's company as well (enabling a shared login).
    expect(mayAddExistingLogin(CALLER, "charlie", [JNR, MARPET], [MARPET], false)).toBe(false);
  });
  it("allows an admin of every company the login is in (The JNR controller, admin of both)", () => {
    expect(mayAddExistingLogin(CALLER, "charlie", [JNR], [JNR, MARPET], false)).toBe(true);
    expect(mayAddExistingLogin(CALLER, "charlie", [JNR, MARPET], [JNR, MARPET], false)).toBe(true);
  });
  it("allows the caller themself, whatever their companies", () => {
    expect(mayAddExistingLogin(CALLER, CALLER, [JNR, OTHER], [MARPET], false)).toBe(true);
    // A platform owner adding their own login is not a takeover (093 never stops self).
    expect(mayAddExistingLogin(CALLER, CALLER, [JNR], [MARPET], true)).toBe(true);
  });
  it("093: never passes on an empty membership set (it used to: every() of nothing is true)", () => {
    expect(mayAddExistingLogin(CALLER, "nobody", [], [MARPET], false)).toBe(false);
    expect(mayAddExistingLogin(CALLER, "nobody", [], [], false)).toBe(false);
  });
  it("093: the reported path, a platform owner whose only row is a leftover support row in the caller's company, is refused", () => {
    expect(mayAddExistingLogin(CALLER, "owner", [MARPET], [MARPET], true)).toBe(false);
  });
  it("093: a platform owner (or any support login) is refused even when every company is the caller's", () => {
    expect(mayAddExistingLogin(CALLER, "owner", [JNR], [JNR, MARPET], true)).toBe(false);
    expect(mayAddExistingLogin(CALLER, "owner", [JNR, MARPET], [JNR, MARPET], true)).toBe(false);
  });
  it("093: a genuine member of the caller's companies is still added", () => {
    expect(mayAddExistingLogin(CALLER, "charlie", [MARPET], [MARPET], false)).toBe(true);
  });
  it("093: the database's protected_login reads as the support-login sentence", () => {
    expect(companyAccessErrorMessage({ code: "42501", hint: "protected_login" }, "Marpet")).toBe(PROTECTED_LOGIN);
    expect(PROTECTED_LOGIN).toBe("This is a Tolra support login, so it can't be changed here.");
  });
  it("the database's other_company_login reads as the plain sentence", () => {
    expect(companyAccessErrorMessage({ code: "42501", hint: "other_company_login" }, "Marpet")).toBe(OTHER_COMPANY_LOGIN);
    expect(OTHER_COMPANY_LOGIN).toBe("This login belongs to another company. An admin of that company must add it.");
  });
});
