/**
 * /api/my-company-logos (the company picker's logos): signed out gets 401 and no data; only the ids my_organizations() returns for the
 * caller are looked up; a logo path outside the company's own folder, or a file that is not PNG/JPEG, answers null; nothing but the
 * data URL leaves the route; a deactivated login (user_profiles.active not true, or unreadable) gets 403 before anything else is read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let signedIn = true;
let profileActive: boolean | null = true;
let profileError = false;
let mine: Array<{ organization_id: string }> = [];
let settings: Array<{ organization_id: string; company_profile: Record<string, unknown> | null }> = [];
let files: Record<string, Uint8Array>;
let askedIds: string[][] = [];
let downloaded: string[] = [];
let rpcCalls: string[] = [];
let fromCalls: string[] = [];

vi.mock("@/lib/server/auth", async () => {
  const { NextResponse } = await import("next/server");
  return {
    jsonError: (message: string, status: number, init?: { headers?: Record<string, string> }) => NextResponse.json({ error: message }, { status, headers: init?.headers }),
    createSupabaseServerClient: async () => ({
      auth: { getUser: async () => (signedIn ? { data: { user: { id: "user-1" } }, error: null } : { data: { user: null }, error: { message: "no session" } }) },
      from: (table: string) => { fromCalls.push(table); return { select: () => ({ eq: () => ({ maybeSingle: async () => (profileError ? { data: null, error: { code: "XX000" } } : { data: profileActive === null ? null : { active: profileActive }, error: null }) }) }) }; },
      rpc: async (name: string) => { rpcCalls.push(name); return { data: mine, error: null }; },
    }),
  };
});
vi.mock("@/lib/server/supabase-admin", () => ({
  createSupabaseAdminClient: () => ({
    from: () => ({ select: () => ({ in: async (_col: string, ids: string[]) => { askedIds.push(ids); return { data: settings, error: null }; } }) }),
    storage: {
      from: () => ({
        download: async (path: string) => {
          downloaded.push(path);
          const bytes = files[path];
          return bytes ? { data: new Blob([bytes as BlobPart]), error: null } : { data: null, error: { message: "not found" } };
        },
      }),
    },
  }),
}));

import { GET } from "@/app/api/my-company-logos/route";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const TEXT = new TextEncoder().encode("<svg></svg>");

beforeEach(() => {
  signedIn = true;
  mine = [{ organization_id: "org-a" }, { organization_id: "org-b" }];
  settings = [];
  files = {};
  askedIds = [];
  downloaded = [];
  rpcCalls = [];
  fromCalls = [];
  profileActive = true;
  profileError = false;
});

describe("GET /api/my-company-logos", () => {
  it("answers 401 with no data to someone who is not signed in", async () => {
    signedIn = false;
    const response = await GET();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(rpcCalls).toEqual([]);
    expect(askedIds).toEqual([]);
  });

  it.each([
    ["a deactivated login", () => { profileActive = false; }],
    ["no profile row", () => { profileActive = null; }],
    ["a profile that can't be read", () => { profileError = true; }],
  ])("answers 403 with no data for %s: no company list, no service-role read", async (_name, arrange) => {
    arrange();
    const response = await GET();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fromCalls).toEqual(["user_profiles"]);
    expect(rpcCalls).toEqual([]);
    expect(askedIds).toEqual([]);
    expect(downloaded).toEqual([]);
  });

  it("loads only the companies my_organizations() returned for the caller, as private no-store JSON", async () => {
    // A settings row for a company the caller is not in must never be read, even if the query returned it.
    settings = [
      { organization_id: "org-a", company_profile: { logoPath: "org-a/logo.png", name: "A Ltd", vat: "GB123" } },
      { organization_id: "org-x", company_profile: { logoPath: "org-x/logo.png" } },
    ];
    files = { "org-a/logo.png": PNG, "org-x/logo.png": PNG };
    const response = await GET();
    expect(rpcCalls).toEqual(["my_organizations"]);
    expect(askedIds).toEqual([["org-a", "org-b"]]);
    expect(downloaded).toEqual(["org-a/logo.png"]);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["org-a", "org-b"]);
    expect(body["org-a"]).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    expect(body["org-b"]).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/A Ltd|GB123/);
  });

  it("answers JPEG logos and null for a company with no logo", async () => {
    settings = [{ organization_id: "org-a", company_profile: { logoPath: "org-a/logo.jpg" } }, { organization_id: "org-b", company_profile: {} }];
    files = { "org-a/logo.jpg": JPEG };
    const body = await (await GET()).json();
    expect(body["org-a"]).toBe(`data:image/jpeg;base64,${Buffer.from(JPEG).toString("base64")}`);
    expect(body["org-b"]).toBeNull();
  });

  it("answers null for a logo path outside the company's own folder", async () => {
    settings = [
      { organization_id: "org-a", company_profile: { logoPath: "org-b/logo.png" } },
      { organization_id: "org-b", company_profile: { logoPath: "org-b/../org-x/logo.png" } },
    ];
    files = { "org-b/logo.png": PNG, "org-b/../org-x/logo.png": PNG };
    const body = await (await GET()).json();
    expect(body).toEqual({ "org-a": null, "org-b": null });
    expect(downloaded).toEqual([]);
  });

  it("answers null for a file that is not a PNG or JPEG, whatever its name", async () => {
    settings = [{ organization_id: "org-a", company_profile: { logoPath: "org-a/logo.png" } }, { organization_id: "org-b", company_profile: { logoPath: "org-b/logo.svg" } }];
    files = { "org-a/logo.png": TEXT, "org-b/logo.svg": TEXT };
    expect(await (await GET()).json()).toEqual({ "org-a": null, "org-b": null });
  });
});
