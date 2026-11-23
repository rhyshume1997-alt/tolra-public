/**
 * The owner issues inbox routes (app/api/platform/issues/route.ts). Proves: the platform guard runs first (a refused caller gets its refusal and
 * nothing is read); with OWNER_ISSUES_ENABLED anything but exactly "true" the owner gets 404 and no function is called; GET passes the checked
 * filters to platform_list_issues with the owner's own client and returns whitelisted rows plus the company list; PATCH passes a checked update to
 * platform_update_issue; bad input is 400 before any call; a database refusal gives fixed wording and never its message; the service-role client,
 * e-mail and AI are never touched; the server flag and the page are wired.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const guard = vi.hoisted(() => ({ result: null as unknown }));
vi.mock("@/lib/server/platform", () => ({ requirePlatformOwner: async () => guard.result }));

import { GET, PATCH } from "@/app/api/platform/issues/route";

const ID = "11111111-1111-4111-8111-111111111111";
const rpc = vi.fn();
const admin = vi.fn();
const owner = () => ({ supabase: { rpc }, user: { id: "owner-1" }, companies: [{ organization_id: ID, name: "Alpha", slug: "alpha", status: "active" }], admin: { from: admin } });
const dbRow = { issue_id: ID, organization_id: ID, organization_name: "Alpha", raised_by_name: "Pat", raised_by_email: null, page: "/jobs", body: "It broke", urgent: false, status: "new", created_at: "2026-11-22T10:00:00Z", updated_at: "2026-11-22T10:00:00Z", closed_at: null, owner_notes: "private", pr_url: null };
const get = (query = "") => GET(new Request(`https://app.example/api/platform/issues${query}`));
const patch = (body: unknown) => PATCH(new Request("https://app.example/api/platform/issues", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const source = readFileSync(path.resolve(__dirname, "../../app/api/platform/issues/route.ts"), "utf8");

beforeEach(() => {
  rpc.mockReset(); admin.mockReset();
  guard.result = owner();
  vi.stubEnv("OWNER_ISSUES_ENABLED", "true");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("the guard and the flag", () => {
  it("a refused caller gets the guard's refusal and nothing is read or changed", async () => {
    guard.result = NextResponse.json({ error: "Forbidden" }, { status: 403 });
    expect((await get()).status).toBe(403);
    expect((await patch({ id: ID, status: "closed" })).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("off unless the flag is exactly 'true': the owner gets 404 and no function is called", async () => {
    for (const value of [undefined, "", "TRUE", "1", "yes"]) {
      vi.stubEnv("OWNER_ISSUES_ENABLED", value as string);
      expect((await get()).status, String(value)).toBe(404);
      expect((await patch({ id: ID, status: "closed" })).status, String(value)).toBe(404);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("GET lists every company's issues for the owner", () => {
  it("passes the filters, returns whitelisted rows and the company list, uncached", async () => {
    rpc.mockResolvedValue({ data: [dbRow, { nonsense: true }], error: null });
    const response = await get(`?org=${ID}&status=fixing&urgent=false`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(rpc).toHaveBeenCalledWith("platform_list_issues", { p_org: ID, p_status: "fixing", p_urgent: false, p_limit: 200 });
    const body = await response.json();
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toMatchObject({ id: ID, organizationName: "Alpha", ownerNotes: "private", status: "new" });
    expect(body.companies).toEqual([{ organizationId: ID, name: "Alpha" }]);
  });
  it("no filters means all companies; bad filters are 400 before any call", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect((await get()).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("platform_list_issues", { p_org: null, p_status: null, p_urgent: null, p_limit: 200 });
    rpc.mockClear();
    for (const q of ["?org=x", "?status=bogus", "?urgent=1"]) expect((await get(q)).status, q).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a database refusal gives fixed wording, never its message; mfa_required keeps its code", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", hint: "mfa_required", message: "Confirm your authenticator code first (second step of sign-in)." } });
    const a = await get();
    expect(a.status).toBe(403);
    expect(await a.json()).toEqual({ error: "Confirm your authenticator code first.", code: "mfa_required" });
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "relation public.issues does not exist" } });
    const b = await get();
    expect(b.status).toBe(500);
    expect(JSON.stringify(await b.json())).not.toMatch(/relation|public\.issues/);
  });
});

describe("PATCH sets status, private notes, the PR link, and closes", () => {
  const result = (status: string) => ({ data: { issue_id: ID, status, updated_at: "2026-11-22T11:00:00Z", closed_at: status === "closed" ? "2026-11-22T11:00:00Z" : null }, error: null });
  it("passes a checked update to platform_update_issue and reports the new state", async () => {
    rpc.mockResolvedValue(result("fixing"));
    const response = await patch({ id: ID, status: "fixing", notes: "private note", prUrl: "https://github.com/o/r/pull/9" });
    expect(rpc).toHaveBeenCalledWith("platform_update_issue", { p_id: ID, p_status: "fixing", p_notes: "private note", p_pr_url: "https://github.com/o/r/pull/9" });
    expect(await response.json()).toEqual({ ok: true, status: "fixing", closedAt: null, updatedAt: "2026-11-22T11:00:00Z" });
  });
  it("close is the status 'closed' and returns the close time", async () => {
    rpc.mockResolvedValue(result("closed"));
    const body = await (await patch({ id: ID, status: "closed", notes: "", prUrl: "" })).json();
    expect(rpc).toHaveBeenCalledWith("platform_update_issue", { p_id: ID, p_status: "closed", p_notes: "", p_pr_url: null });
    expect(body).toMatchObject({ ok: true, status: "closed", closedAt: "2026-11-22T11:00:00Z" });
  });
  it("bad input is 400 before any call (including a PR link that is not https)", async () => {
    for (const body of [{ id: "x", status: "closed" }, { id: ID, status: "weird" }, { id: ID, status: "new", prUrl: "http://x.example" }, { id: ID, status: "new", organizationId: ID }]) {
      expect((await patch(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a missing issue is 404 with fixed wording; a reply that does not confirm the issue is 500", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "P0002", hint: "issue_not_found", message: "Issue not found" } });
    expect((await patch({ id: ID, status: "closed" })).status).toBe(404);
    rpc.mockResolvedValue({ data: { issue_id: "someone-else" }, error: null });
    expect((await patch({ id: ID, status: "closed" })).status).toBe(500);
  });
});

describe("what the route never does", () => {
  it("never uses the service role, e-mail, AI or a direct table write, and never deletes an issue", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await get();
    expect(admin).not.toHaveBeenCalled();
    expect(source).not.toMatch(/\.admin\b|createSupabaseAdminClient|\.from\(|\.insert\(|\.delete\(|sendMail|resend|@\/lib\/ai|openai|anthropic/i);
  });
  it("the owner page and inbox are wired to the same flag and routes", () => {
    const page = readFileSync(path.resolve(__dirname, "../../app/platform/issues/page.tsx"), "utf8");
    expect(page).toContain("ownerIssuesEnabled()");
    expect(page).toContain("<IssuesInbox />");
    const inbox = readFileSync(path.resolve(__dirname, "../../components/platform/issues-inbox.tsx"), "utf8");
    expect(inbox).toContain("/api/platform/issues");
    expect(inbox).toContain("Private notes");
    expect(inbox).toContain("Link to the PR");
    expect(inbox).toContain("Close issue");
  });
});
