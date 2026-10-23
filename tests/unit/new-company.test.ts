/**
 * The platform owner's "New company" form and route (app/api/platform/organizations): the slug and field rules, and the order of
 * the route: nothing reaches platform_create_organization (migration 039, called with the owner's own session; the service role is
 * used only for the rate limiter) unless the platform-owner guard passed; duplicates and a lost race are told
 * apart clearly; the answer names only the new company.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

import { checkNewCompany, COMPANY_SLUG_PATTERN, sameCompanyName, slugFromName } from "@/lib/new-company";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => undefined }), headers: async () => new Headers() }));

type Existing = { organization_id: string; name: string; slug: string; status: string };
let guardResult: "ok" | "forbidden" | "mfa";
let existing: Existing[];
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
let createResult: { data: unknown; error: { code?: string; message?: string; hint?: string } | null };
let adminRpcCalls: string[];
let limitOk: boolean;
let limitCalls: Array<{ bucket: string; key: string; windowSeconds: number; max: number }>;

vi.mock("@/lib/server/platform", () => ({
  requirePlatformOwner: async () => {
    if (guardResult === "forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (guardResult === "mfa") return NextResponse.json({ error: "Confirm", code: "mfa_required" }, { status: 403 });
    return {
      supabase: { rpc: async (fn: string, args: Record<string, unknown>) => { rpcCalls.push({ fn, args }); return createResult; } },
      user: { id: "owner-1" }, companies: existing,
      admin: { rpc: async (fn: string) => { adminRpcCalls.push(fn); return { data: null, error: { code: "XX000", message: "service role used" } }; } },
    };
  },
}));
vi.mock("@/lib/server/login", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/login")>("@/lib/server/login");
  return { ...actual, withinLimit: async (_admin: unknown, bucket: string, key: string, windowSeconds: number, max: number) => { limitCalls.push({ bucket, key, windowSeconds, max }); return limitOk; } };
});

import { POST } from "@/app/api/platform/organizations/route";

const post = (body: unknown) => POST(new Request("http://localhost/api/platform/organizations", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
const good = { name: "Acme Fabrication Ltd", slug: "acme-fabrication", adminEmail: "Owner@Acme.example", confirmEmail: "owner@acme.example" };

beforeEach(() => {
  guardResult = "ok";
  existing = [{ organization_id: "o1", name: "JNR Engineering", slug: "jnr-engineering", status: "active" }];
  rpcCalls = [];
  adminRpcCalls = [];
  createResult = { data: "11111111-1111-4111-8111-111111111111", error: null };
  limitOk = true;
  limitCalls = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("slug from a company name", () => {
  it("lower-cases, drops accents, turns anything else into single hyphens and never ends on one", () => {
    expect(slugFromName("Acme Fabrication Ltd")).toBe("acme-fabrication-ltd");
    expect(slugFromName("  J & R  Métal (UK) Ltd. ")).toBe("j-and-r-metal-uk-ltd");
    expect(slugFromName("---Hello---")).toBe("hello");
    expect(slugFromName("!!!")).toBe("");
    const long = slugFromName("a".repeat(47) + " bcd efg");
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith("-")).toBe(false);
  });
  it("produces a slug the database accepts whenever it produces one of two characters or more", () => {
    for (const name of ["Acme", "O'Brien & Sons", "Ünïcode Works 2", "123", "x y z"]) {
      const slug = slugFromName(name);
      if (slug.length >= 2) expect(COMPANY_SLUG_PATTERN.test(slug)).toBe(true);
    }
  });
});

describe("field rules", () => {
  it("accepts a good company and normalises it", () => {
    expect(checkNewCompany({ ...good, name: "  Acme   Fabrication Ltd " })).toEqual({ ok: true, value: { name: "Acme Fabrication Ltd", slug: "acme-fabrication", adminEmail: "owner@acme.example" } });
  });
  it.each([
    [{ ...good, name: " " }, "name"],
    [{ ...good, name: "A" }, "name"],
    [{ ...good, name: "x".repeat(121) }, "name"],
    [{ ...good, name: "bad\u0000name" }, "name"],
    [{ ...good, name: "bad\u0085name" }, "name"],
    [{ ...good, name: "JNR\u200B Engineering" }, "name"],
    [{ ...good, name: "Acme \u202Ed\u202C Ltd" }, "name"],
    [{ ...good, name: 42 }, "name"],
    [{ ...good, slug: "" }, "slug"],
    [{ ...good, slug: "a" }, "slug"],
    [{ ...good, slug: "Has Caps" }, "slug"],
    [{ ...good, slug: "under_score" }, "slug"],
    [{ ...good, slug: "a".repeat(49) }, "slug"],
    [{ ...good, slug: "x'; drop table organizations;--" }, "slug"],
    [{ ...good, adminEmail: "" }, "adminEmail"],
    [{ ...good, adminEmail: "not-an-email" }, "adminEmail"],
    [{ ...good, adminEmail: "a b@c.example" }, "adminEmail"],
    [{ ...good, adminEmail: `${"a".repeat(250)}@x.example` }, "adminEmail"],
  ])("refuses %j on %s", (input, field) => {
    const result = checkNewCompany(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe(field);
  });
  it("accepts the 2 and 48 character slug limits", () => {
    expect(checkNewCompany({ ...good, slug: "ab" }).ok).toBe(true);
    expect(checkNewCompany({ ...good, slug: "a".repeat(48) }).ok).toBe(true);
  });
  it("accepts a confirmation that matches after trimming and lower-casing, and refuses one that doesn't (field adminEmail)", () => {
    expect(checkNewCompany({ ...good, confirmEmail: "  OWNER@acme.EXAMPLE " })).toMatchObject({ ok: true, value: { adminEmail: "owner@acme.example" } });
    for (const confirmEmail of ["", "owner@acme.exampl", "0wner@acme.example", 42, null, undefined]) {
      expect(checkNewCompany({ ...good, confirmEmail })).toMatchObject({ ok: false, field: "adminEmail", error: expect.stringMatching(/don't match/) });
    }
  });
  it("requires the confirmation: missing is refused like a mismatch (field adminEmail)", () => {
    const withoutConfirm = { name: good.name, slug: good.slug, adminEmail: good.adminEmail };
    expect(checkNewCompany(withoutConfirm)).toMatchObject({ ok: false, field: "adminEmail", error: expect.stringMatching(/don't match/) });
  });
  it("compares names without regard to case or spacing", () => {
    expect(sameCompanyName("Acme  Ltd", " acme ltd")).toBe(true);
    expect(sameCompanyName("Acme Ltd", "Acme Limited")).toBe(false);
  });
});

describe("POST /api/platform/organizations", () => {
  it("creates the company with the validated, normalised values and answers with the new company only", async () => {
    const response = await post(good);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, company: { organization_id: "11111111-1111-4111-8111-111111111111", name: "Acme Fabrication Ltd", slug: "acme-fabrication", status: "active" } });
    expect(rpcCalls).toEqual([{ fn: "platform_create_organization", args: { p_name: "Acme Fabrication Ltd", p_slug: "acme-fabrication", p_admin_email: "owner@acme.example" } }]);
    // The company is created with the owner's own session; the service role is never asked to create it.
    expect(adminRpcCalls).toEqual([]);
  });

  it("counts attempts per platform owner in a bucket the database's limiter accepts (auth_rate_hit: ^[a-z_:]{1,40}$)", async () => {
    await post(good);
    expect(limitCalls).toHaveLength(1);
    expect(limitCalls[0].bucket).toMatch(/^[a-z_:]{1,40}$/);
    expect(limitCalls[0]).toMatchObject({ key: "owner-1", windowSeconds: 3600, max: 20 });
  });

  it("never reaches platform_create_organization when the platform-owner guard refuses", async () => {
    guardResult = "forbidden";
    expect((await post(good)).status).toBe(403);
    guardResult = "mfa";
    const response = await post(good);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mfa_required" });
    expect(rpcCalls).toEqual([]);
  });

  it("refuses a confirmation e-mail that is missing or differs from the first admin's e-mail (400, field adminEmail), creating nothing", async () => {
    const mismatch = await post({ ...good, confirmEmail: "owner@acme.exmaple" });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ field: "adminEmail", error: expect.stringMatching(/don't match/) });
    expect(rpcCalls).toEqual([]);
    const withoutConfirm = { name: good.name, slug: good.slug, adminEmail: good.adminEmail };
    const missing = await post(withoutConfirm);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ field: "adminEmail", error: expect.stringMatching(/don't match/) });
    expect(rpcCalls).toEqual([]);
    const matching = await post({ ...good, confirmEmail: " OWNER@ACME.EXAMPLE" });
    expect(matching.status).toBe(201);
    expect(rpcCalls).toEqual([{ fn: "platform_create_organization", args: { p_name: "Acme Fabrication Ltd", p_slug: "acme-fabrication", p_admin_email: "owner@acme.example" } }]);
  });

  it("refuses invalid input and a body that is not JSON, creating nothing", async () => {
    const bad = await post({ ...good, slug: "No Good" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: "slug" });
    expect((await post("not json")).status).toBe(400);
    expect((await post("[1,2]")).status).toBe(400);
    expect((await post("null")).status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it("tells a duplicate slug and a duplicate name apart, creating nothing", async () => {
    const slug = await post({ ...good, slug: "jnr-engineering" });
    expect(slug.status).toBe(409);
    expect(await slug.json()).toMatchObject({ field: "slug", error: expect.stringMatching(/web address.*already used/) });
    const name = await post({ ...good, name: "jnr  ENGINEERING" });
    expect(name.status).toBe(409);
    expect(await name.json()).toMatchObject({ field: "name", error: expect.stringMatching(/already exists/) });
    expect(rpcCalls).toEqual([]);
  });

  it("reports a slug taken a moment earlier by someone else as a duplicate, not a failure", async () => {
    createResult = { data: null, error: { code: "P0001", message: "create_organization: slug acme-fabrication is already used" } };
    const response = await post(good);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ field: "slug" });
    createResult = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
    expect((await post(good)).status).toBe(409);
  });

  it("maps the database's own refusals: the second step, and not a platform owner", async () => {
    createResult = { data: null, error: { code: "42501", message: "Confirm your authenticator code first (second step of sign-in).", hint: "mfa_required" } };
    const mfa = await post(good);
    expect(mfa.status).toBe(403);
    expect(await mfa.json()).toMatchObject({ code: "mfa_required" });
    createResult = { data: null, error: { code: "42501", message: "Platform access only" } };
    const forbidden = await post(good);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).not.toHaveProperty("code");
  });

  it("answers an unexpected database failure with a generic message that quotes nothing from the database", async () => {
    createResult = { data: null, error: { code: "XX000", message: "relation organizations column secret" } };
    const response = await post(good);
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toMatch(/relation|secret/);
  });

  it("stops after too many attempts", async () => {
    limitOk = false;
    const response = await post(good);
    expect(response.status).toBe(429);
    expect(rpcCalls).toEqual([]);
  });
});
