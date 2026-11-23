/**
 * Owner Home (module 12): the switch, the counts adapter and GET /api/platform/owner-home. Proves: off unless exactly "true"; the route
 * runs the platform-owner guard first and reads nothing when it refuses; switch off returns no data; today's source gives users only and
 * everything else stays unknown (null, never a made-up zero); open issues are 0 when the table is absent and null on any other failure;
 * a later counts source (release 164) joins through the adapter without changing the shape; no write is ever made.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

import { loadOwnerHome, parseListRows, readOpenIssues, type CountsSource } from "@/lib/platform/owner-home/counts";
import { OWNER_HOME_FLAG, ownerHomeEnabled } from "@/lib/platform/owner-home/flag";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => undefined }), headers: async () => new Headers() }));

let guard: "ok" | "forbidden" = "ok";
let fromCalls: string[] = [];
vi.mock("@/lib/server/platform", () => ({
  requirePlatformOwner: async () => {
    if (guard === "forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return {
      supabase: { from: (t: string) => { fromCalls.push(t); return { select: () => ({ eq: () => ({ limit: async () => ({ data: [{ organization_id: A }], error: null }) }) }) }; } },
      user: { id: "owner" },
      companies: [{ organization_id: A, name: "Alpha", slug: "alpha", status: "active", active_members: 3, own_membership: false, support_expires_at: null }],
    };
  },
}));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const rows = parseListRows([
  { organization_id: A, name: "Alpha", slug: "alpha", status: "active", active_members: 4, own_membership: false, support_expires_at: null },
  { organization_id: B, name: "Beta", slug: "beta", status: "suspended", active_members: "2", own_membership: true, support_expires_at: null },
  { organization_id: 5, name: "bad" },
]);

type Result = { data: unknown; error: { code?: string } | null };
const clientFor = (result: Result | "throw", writes: string[] = []) =>
  ({
    from: (table: string) => ({
      select: () => ({ eq: () => ({ limit: async () => { if (result === "throw") throw new Error("boom"); return result; } }) }),
      insert: () => writes.push(`insert ${table}`),
      update: () => writes.push(`update ${table}`),
      delete: () => writes.push(`delete ${table}`),
    }),
    rpc: () => writes.push("rpc"),
  }) as never;

describe("switch", () => {
  it("is on only for exactly 'true'", () => {
    expect(ownerHomeEnabled({})).toBe(false);
    for (const v of ["1", "TRUE", " true", "yes", ""]) expect(ownerHomeEnabled({ [OWNER_HOME_FLAG]: v })).toBe(false);
    expect(ownerHomeEnabled({ [OWNER_HOME_FLAG]: "true" })).toBe(true);
  });
});

describe("parseListRows", () => {
  it("keeps well-formed rows, coerces counts and drops the rest", () => {
    expect(rows.map((r) => [r.slug, r.active_members])).toEqual([["alpha", 4], ["beta", 2]]);
    expect(parseListRows(null)).toEqual([]);
  });
});

describe("loadOwnerHome", () => {
  it("today: users from the list; jobs, invoices and activity unknown; issues 0 when the table is absent", async () => {
    const data = await loadOwnerHome(clientFor({ data: null, error: { code: "42P01" } }), rows);
    expect(data.companies[0]).toMatchObject({ users: 4, jobs: null, invoices: null, lastActivity: null, openIssues: 0 });
    expect(data.totals).toEqual({ companies: 2, activeCompanies: 1, users: 6, openIssues: 0 });
    expect(data.fullCounts).toBe(false);
    expect(data.errorsRecorded).toBe(false);
  });

  it("counts open issues per company when the table is there", async () => {
    const data = await loadOwnerHome(clientFor({ data: [{ organization_id: A }, { organization_id: A }, { organization_id: B }, { organization_id: "other" }], error: null }), rows);
    expect(data.companies.map((c) => c.openIssues)).toEqual([2, 1]);
    expect(data.totals.openIssues).toBe(3);
  });

  it("an unreadable issues table is unknown, not zero; a thrown read is too", async () => {
    expect((await readOpenIssues(clientFor({ data: null, error: { code: "42501" } }), rows)).get(A)).toBeNull();
    expect((await readOpenIssues(clientFor("throw"), rows)).get(A)).toBeNull();
    expect((await readOpenIssues(clientFor({ data: null, error: { code: "PGRST205" } }), rows)).get(B)).toBe(0);
  });

  it("joins a later counts source (release 164) through the adapter", async () => {
    const source: CountsSource = async () => new Map([[A, { users: 5, jobs: 12, invoices: 7, lastActivity: "2026-11-20T10:00:00Z" }], [B, { jobs: 1, lastActivity: "2026-11-21T09:00:00Z" }]]);
    const data = await loadOwnerHome(clientFor({ data: [], error: null }), rows, { counts: source });
    expect(data.companies[0]).toMatchObject({ users: 5, jobs: 12, invoices: 7 });
    expect(data.companies[1]).toMatchObject({ users: null, jobs: 1, invoices: null });
    expect(data.latestActivity).toBe("2026-11-21T09:00:00Z");
    expect(data.fullCounts).toBe(true);
  });

  it("a failing source leaves the screen up with unknowns, and writes nothing", async () => {
    const writes: string[] = [];
    const bad: CountsSource = async () => { throw new Error("x"); };
    const data = await loadOwnerHome(clientFor({ data: [], error: null }, writes), rows, { counts: bad });
    expect(data.companies[0].users).toBeNull();
    expect(writes).toEqual([]);
  });
});

describe("GET /api/platform/owner-home", () => {
  beforeEach(() => { guard = "ok"; fromCalls = []; delete process.env[OWNER_HOME_FLAG]; });

  it("refuses a non-owner before reading anything", async () => {
    guard = "forbidden";
    process.env[OWNER_HOME_FLAG] = "true";
    const { GET } = await import("@/app/api/platform/owner-home/route");
    const response = await GET(new Request("http://localhost/api/platform/owner-home"));
    expect(response.status).toBe(403);
    expect(fromCalls).toEqual([]);
  });

  it("switch off: enabled false and no data read", async () => {
    const { GET } = await import("@/app/api/platform/owner-home/route");
    const response = await GET(new Request("http://localhost/api/platform/owner-home"));
    expect(await response.json()).toEqual({ enabled: false });
    expect(fromCalls).toEqual([]);
  });

  it("switch on: the owner's companies with counts, read only", async () => {
    process.env[OWNER_HOME_FLAG] = "true";
    const { GET } = await import("@/app/api/platform/owner-home/route");
    const body = await (await GET(new Request("http://localhost/api/platform/owner-home"))).json();
    expect(body.enabled).toBe(true);
    expect(body.companies[0]).toMatchObject({ slug: "alpha", users: 3, jobs: null, openIssues: 1 });
    expect(fromCalls).toEqual(["issues"]);
  });
});
