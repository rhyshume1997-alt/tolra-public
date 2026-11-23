/**
 * Raise an issue / owner issues inbox: the pure rules (lib/issues). Proves: the company switch is OFF unless the exact marker is present;
 * the urgent wording and number; the form's checks mirror release 165's limits; refusals use fixed wording and never the database's message;
 * the owner's row, filter and update checks whitelist and refuse; the owner flag is exactly "true".
 */
import { describe, expect, it } from "vitest";

import {
  checkIssueFilters, checkOwnerUpdate, checkRaiseIssue, ISSUE_BODY_MAX, ISSUE_PAGE_MAX, ISSUE_STATUSES, ISSUES_ON_MARKER, issuePageFrom, issuesEnabled,
  issuesSwitchChange, OWNER_NOTES_MAX, OWNER_PHONE_DISPLAY, ownerIssueRefusal, parseOwnerIssue, PR_URL_MAX, raiseIssueRefusal, URGENT_CALL_MESSAGE,
} from "@/lib/issues/issues";
import { ownerIssuesEnabled } from "@/lib/issues/owner-flag";

const ID = "11111111-1111-4111-8111-111111111111";

describe("the company switch", () => {
  it("is off by default and on only with the exact marker", () => {
    expect(ISSUES_ON_MARKER).toBe("issues:on");
    expect(issuesEnabled(undefined)).toBe(false);
    expect(issuesEnabled(null)).toBe(false);
    expect(issuesEnabled([])).toBe(false);
    expect(issuesEnabled(["issues", "reports:on", "ISSUES:ON"])).toBe(false);
    expect(issuesEnabled(["reports:on", "issues:on"])).toBe(true);
  });
  it("describes the hidden_nav change to turn it on or off", () => {
    expect(issuesSwitchChange(true)).toEqual({ add: ["issues:on"], remove: [] });
    expect(issuesSwitchChange(false)).toEqual({ add: [], remove: ["issues:on"] });
  });
});

describe("the urgent wording", () => {
  it("is exactly 'Call Rhys on 07908041480'", () => {
    expect(OWNER_PHONE_DISPLAY).toBe("07908041480");
    expect(URGENT_CALL_MESSAGE).toBe("Call Rhys on 07908041480");
  });
});

describe("issuePageFrom", () => {
  it("keeps the path only, never a query string or fragment, and falls back to /", () => {
    expect(issuePageFrom("/jobs/ncr?token=secret#top")).toBe("/jobs/ncr");
    expect(issuePageFrom("")).toBe("/");
    expect(issuePageFrom(null)).toBe("/");
    expect(issuePageFrom(undefined)).toBe("/");
    expect(issuePageFrom("/" + "a".repeat(400))).toHaveLength(ISSUE_PAGE_MAX);
  });
});

describe("checkRaiseIssue (mirrors release 165: page 1 to 300, text 1 to 2000)", () => {
  it("trims, keeps urgent, and accepts the limits", () => {
    expect(checkRaiseIssue({ page: " /jobs ", body: "  It broke  ", urgent: true })).toEqual({ ok: true, value: { page: "/jobs", body: "It broke", urgent: true } });
    expect(checkRaiseIssue({ page: "/", body: "x".repeat(ISSUE_BODY_MAX), urgent: false }).ok).toBe(true);
    expect(checkRaiseIssue({ page: "p".repeat(ISSUE_PAGE_MAX), body: "x", urgent: false }).ok).toBe(true);
  });
  it("refuses empty or too long text and page, saying which field", () => {
    expect(checkRaiseIssue({ page: "/jobs", body: "   ", urgent: false })).toMatchObject({ ok: false, field: "body" });
    expect(checkRaiseIssue({ page: "/jobs", body: "x".repeat(ISSUE_BODY_MAX + 1), urgent: false })).toMatchObject({ ok: false, field: "body" });
    expect(checkRaiseIssue({ page: "  ", body: "x", urgent: false })).toMatchObject({ ok: false, field: "page" });
    expect(checkRaiseIssue({ page: "p".repeat(ISSUE_PAGE_MAX + 1), body: "x", urgent: false })).toMatchObject({ ok: false, field: "page" });
  });
});

describe("refusal wording never carries the database's message", () => {
  const leaks = (text: string) => /Raising an issue is switched off for this company|Too many issues raised|42501|22023|function|row-level/i.test(text);
  it("raise_issue", () => {
    expect(raiseIssueRefusal({ code: "42501", hint: "issues_off" })).toBe("Raising an issue isn't switched on for your company.");
    expect(raiseIssueRefusal({ code: "22023", hint: "too_many" })).toMatch(/try again later/);
    expect(raiseIssueRefusal({ code: "42501", hint: "not_permitted" })).toMatch(/support session is read-only/);
    expect(raiseIssueRefusal({ code: "22023" })).toMatch(/Check what you wrote/);
    expect(raiseIssueRefusal({ code: "XX000" })).toMatch(/Nothing was saved/);
    expect(raiseIssueRefusal(null)).toMatch(/Nothing was saved/);
    for (const e of [{ code: "42501", hint: "issues_off" }, { code: "22023", hint: "too_many" }, { code: "XX000" }]) expect(leaks(raiseIssueRefusal(e))).toBe(false);
  });
  it("platform_* functions", () => {
    expect(ownerIssueRefusal({ code: "42501", hint: "mfa_required" })).toEqual({ status: 403, code: "mfa_required", error: "Confirm your authenticator code first." });
    expect(ownerIssueRefusal({ code: "42501" })).toEqual({ status: 403, error: "Forbidden" });
    expect(ownerIssueRefusal({ code: "P0002", hint: "issue_not_found" })).toMatchObject({ status: 404 });
    expect(ownerIssueRefusal({ code: "22023" })).toMatchObject({ status: 400 });
    expect(ownerIssueRefusal({ code: "XX000" })).toMatchObject({ status: 500 });
    expect(ownerIssueRefusal(undefined)).toMatchObject({ status: 500 });
  });
});

describe("parseOwnerIssue", () => {
  const row = { issue_id: ID, organization_id: ID, organization_name: "Alpha", raised_by_name: "Pat", raised_by_email: "pat@example.test", page: "/jobs", body: "It broke", urgent: true, status: "new", created_at: "2026-11-22T10:00:00Z", updated_at: "2026-11-22T10:00:00Z", closed_at: null, owner_notes: "", pr_url: null };
  it("whitelists a good row", () => {
    expect(parseOwnerIssue({ ...row, extra: "dropped" })).toEqual({
      id: ID, organizationId: ID, organizationName: "Alpha", raisedByName: "Pat", raisedByEmail: "pat@example.test", page: "/jobs", body: "It broke", urgent: true, status: "new",
      createdAt: "2026-11-22T10:00:00Z", updatedAt: "2026-11-22T10:00:00Z", closedAt: null, ownerNotes: "", prUrl: null,
    });
  });
  it("drops a row of the wrong shape or an unknown status", () => {
    expect(parseOwnerIssue(null)).toBeNull();
    expect(parseOwnerIssue("x")).toBeNull();
    expect(parseOwnerIssue({ ...row, status: "weird" })).toBeNull();
    expect(parseOwnerIssue({ ...row, urgent: "yes" })).toBeNull();
    expect(parseOwnerIssue({ ...row, issue_id: undefined })).toBeNull();
  });
});

describe("checkIssueFilters", () => {
  const params = (q: string) => new URLSearchParams(q);
  it("accepts none, or a company, status and urgent", () => {
    expect(checkIssueFilters(params(""))).toEqual({ ok: true, value: { organizationId: null, status: null, urgent: null } });
    expect(checkIssueFilters(params(`org=${ID.toUpperCase()}&status=fixing&urgent=true`))).toEqual({ ok: true, value: { organizationId: ID, status: "fixing", urgent: true } });
    expect(checkIssueFilters(params("urgent=false"))).toMatchObject({ ok: true, value: { urgent: false } });
  });
  it("refuses anything else instead of ignoring it", () => {
    expect(checkIssueFilters(params("org=not-a-uuid")).ok).toBe(false);
    expect(checkIssueFilters(params("status=bogus")).ok).toBe(false);
    expect(checkIssueFilters(params("urgent=1")).ok).toBe(false);
  });
});

describe("checkOwnerUpdate", () => {
  it("accepts every status, notes and an https link; an empty link means none", () => {
    for (const status of ISSUE_STATUSES) expect(checkOwnerUpdate({ id: ID, status, notes: "n", prUrl: "https://github.com/o/r/pull/1" }).ok).toBe(true);
    expect(checkOwnerUpdate({ id: ID.toUpperCase(), status: "closed", notes: "done", prUrl: "  " })).toEqual({ ok: true, value: { id: ID, status: "closed", notes: "done", prUrl: null } });
    expect(checkOwnerUpdate({ id: ID, status: "new" })).toEqual({ ok: true, value: { id: ID, status: "new", notes: "", prUrl: null } });
  });
  it("refuses bad ids, statuses, unknown keys, long notes and links that are not https", () => {
    expect(checkOwnerUpdate(null).ok).toBe(false);
    expect(checkOwnerUpdate([]).ok).toBe(false);
    expect(checkOwnerUpdate({ id: "x", status: "new" }).ok).toBe(false);
    expect(checkOwnerUpdate({ id: ID, status: "weird" }).ok).toBe(false);
    expect(checkOwnerUpdate({ id: ID, status: "new", organizationId: ID }).ok).toBe(false);
    expect(checkOwnerUpdate({ id: ID, status: "new", notes: 5 }).ok).toBe(false);
    expect(checkOwnerUpdate({ id: ID, status: "new", notes: "x".repeat(OWNER_NOTES_MAX + 1) }).ok).toBe(false);
    expect(checkOwnerUpdate({ id: ID, status: "new", prUrl: 7 }).ok).toBe(false);
    for (const link of ["http://example.com/pull/1", "javascript:alert(1)", "https://has space.example", "github.com/o/r/pull/1", `https://x.example/${"a".repeat(PR_URL_MAX)}`]) {
      expect(checkOwnerUpdate({ id: ID, status: "new", prUrl: link }).ok, link).toBe(false);
    }
  });
});

describe("the owner flag", () => {
  it("is on only when OWNER_ISSUES_ENABLED is exactly 'true'", () => {
    expect(ownerIssuesEnabled({})).toBe(false);
    expect(ownerIssuesEnabled({ OWNER_ISSUES_ENABLED: "TRUE" })).toBe(false);
    expect(ownerIssuesEnabled({ OWNER_ISSUES_ENABLED: "1" })).toBe(false);
    expect(ownerIssuesEnabled({ OWNER_ISSUES_ENABLED: "true " })).toBe(false);
    expect(ownerIssuesEnabled({ OWNER_ISSUES_ENABLED: "true" })).toBe(true);
  });
});
