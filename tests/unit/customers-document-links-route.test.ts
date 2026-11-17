/**
 * tests/unit/customers-document-links-route.test.ts. app/api/customers/document-links/route.ts with the caller's session stood in.
 * Unauthenticated refused; wrong role, support session, stale or missing authenticator code and another company's rows refused AND logged
 * with five safe fields; validation refusals not logged; success logs nothing; the log never holds a code, key, document field or name.
 */
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const auth = vi.hoisted(() => ({ requireProfile: vi.fn() }));
vi.mock("@/lib/server/auth", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/server/auth")>()), requireProfile: auth.requireProfile }));

import { POST } from "@/app/api/customers/document-links/route";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const ACTOR = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const CUST = "33333333-3333-4333-8333-333333333333";
const FOREIGN = "44444444-4444-4444-8444-444444444444";
const REASON = "Checked with Acme Engineering Ltd, code 987654";

const db = vi.hoisted(() => ({
  rows: {} as Record<string, string[]>, // table -> ids that exist in ORG
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcError: null as null | { message: string; hint: string },
  mfa: { currentLevel: "aal2", currentAuthenticationMethods: [] as unknown[] },
}));

function supabase() {
  return {
    from: (table: string) => {
      const f: Record<string, string> = {};
      const q = {
        select: () => q,
        eq: (c: string, v: string) => { f[c] = v; return q; },
        maybeSingle: async () => ({ data: f.organization_id === ORG && (db.rows[table] ?? []).includes(f.id) ? { id: f.id } : null, error: null }),
      };
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpcs.push({ fn, args });
      return db.rpcError ? { data: null, error: db.rpcError } : { data: { link_id: "L", doc_kind: "job", document_id: JOB, customer_id: CUST, source: "manual" }, error: null };
    },
    auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: db.mfa, error: null }) } },
  };
}
function signIn(role = "office", extra: Record<string, unknown> = {}) {
  auth.requireProfile.mockResolvedValue({ supabase: supabase(), user: { id: ACTOR }, profile: { organization_id: ORG, role, secondary_role: null }, session: { support: false, ...extra } });
}
const fresh = () => [{ method: "totp", timestamp: Date.now() / 1000 - 60 }];
const post = (body: unknown) => POST(new Request("http://localhost/api/customers/document-links", { method: "POST", body: JSON.stringify(body) }));
const link = (over: Record<string, unknown> = {}) => ({ action: "link", kind: "job", documentId: JOB, customerId: CUST, reason: REASON, ...over });

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const logged = () => [...warn.mock.calls, ...error.mock.calls];
const securityLines = () => warn.mock.calls.filter(c => c[0] === "[customers] link refused:");

beforeEach(() => {
  db.rows = { jobs: [JOB], quotes: [], customers: [CUST] };
  db.rpcs = []; db.rpcError = null; db.mfa = { currentLevel: "aal2", currentAuthenticationMethods: fresh() };
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  signIn();
});
afterEach(() => { vi.restoreAllMocks(); auth.requireProfile.mockReset(); });

function expectFiveFields(action: string, category: string) {
  expect(securityLines()).toHaveLength(1);
  const fields = JSON.parse(securityLines()[0][1] as string);
  expect(Object.keys(fields).sort()).toEqual(["action", "actor_id", "at", "category", "organization_id"]);
  expect(fields).toMatchObject({ organization_id: ORG, actor_id: ACTOR, action, category });
  expect(Number.isNaN(Date.parse(fields.at))).toBe(false);
  const serialized = JSON.stringify(logged());
  for (const secret of [REASON, "Acme", "987654", JOB, CUST, FOREIGN]) expect(serialized).not.toContain(secret);
}

describe("customer document-link route", () => {
  it("unauthenticated: refused (401), nothing called", async () => {
    auth.requireProfile.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    expect((await post(link())).status).toBe(401);
    expect(db.rpcs).toEqual([]);
  });
  it("wrong role: refused and logged with the five fields only", async () => {
    signIn("sales");
    expect((await post(link())).status).toBe(403);
    expect(db.rpcs).toEqual([]);
    expectFiveFields("link", "role");
  });
  it("office cannot do an admin-only action (override); admin can link", async () => {
    expect((await post({ ...link({ action: "override" }), identityConfirmed: true })).status).toBe(403);
    expectFiveFields("override", "role");
    expect(db.rpcs).toEqual([]);
    signIn("admin");
    expect((await post(link())).status).toBe(200);
  });
  it("a support session is refused and logged", async () => {
    signIn("admin", { support: true });
    expect((await post(link())).status).toBe(403);
    expect(db.rpcs).toEqual([]);
    expectFiveFields("link", "support_session");
  });
  it("no second step: refused with mfa_required and logged", async () => {
    db.mfa = { currentLevel: "aal1", currentAuthenticationMethods: [] };
    const res = await post(link());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("mfa_required");
    expect(db.rpcs).toEqual([]);
    expectFiveFields("link", "mfa");
  });
  it("stale authenticator code: refused with mfa_recent_required and logged", async () => {
    db.mfa = { currentLevel: "aal2", currentAuthenticationMethods: [{ method: "totp", timestamp: Date.now() / 1000 - 3600 }] };
    const res = await post(link());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("mfa_recent_required");
    expect(db.rpcs).toEqual([]);
    expectFiveFields("link", "mfa_recent");
  });
  it("another company's document or customer: refused before the database and logged", async () => {
    expect((await post(link({ documentId: FOREIGN }))).status).toBe(403);
    expectFiveFields("link", "other_company");
    warn.mockClear();
    expect((await post(link({ customerId: FOREIGN }))).status).toBe(403);
    expectFiveFields("link", "other_company");
    expect(db.rpcs).toEqual([]);
  });
  it("database refusals keep their meaning: link_other_company and a stale code from the database are logged too", async () => {
    db.rpcError = { message: "Acme Engineering Ltd 987654", hint: "link_other_company" };
    expect((await post(link())).status).toBe(403);
    expectFiveFields("link", "other_company");
    warn.mockClear();
    db.rpcError = { message: "x", hint: "mfa_recent_required" };
    expect((await (await post(link())).json()).code).toBe("mfa_recent_required");
    expectFiveFields("link", "mfa_recent");
  });
  it("validation errors are 400 and not logged as security events (bad body, empty reason, unconfirmed identity)", async () => {
    signIn("admin");
    expect((await post({ action: "link", kind: "invoice" })).status).toBe(400);
    const empty = await post(link({ reason: "   " }));
    expect(empty.status).toBe(400);
    expect((await empty.json()).code).toBe("reason_required");
    expect((await post({ ...link({ action: "override" }), identityConfirmed: false })).status).toBe(400);
    expect(securityLines()).toEqual([]);
    expect(logged()).toEqual([]);
  });
  it("a business refusal (already linked) is 409 and not logged", async () => {
    db.rpcError = { message: "m", hint: "already_linked" };
    expect((await post(link())).status).toBe(409);
    expect(logged()).toEqual([]);
  });
  it("success: result returned, the database called once with the company-less arguments, nothing logged", async () => {
    const res = await post(link());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ linkId: "L", source: "manual" });
    expect(db.rpcs).toEqual([{ fn: "link_document_customer", args: { p_kind: "job", p_document: JOB, p_customer: CUST, p_reason: REASON } }]);
    expect(logged()).toEqual([]);
  });
  it("verify: ids must be 1..200 UUIDs; malformed input is 400, unlogged, and never reaches the database", async () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const verify = (linkIds: unknown) => ({ action: "verify", linkIds, reason: "checked" });
    expect((await post(verify(["not-a-uuid"]))).status).toBe(400);
    expect((await post(verify([]))).status).toBe(400);
    expect((await post(verify(Array.from({ length: 201 }, (_, i) => uuid(i))))).status).toBe(400);
    expect(db.rpcs).toEqual([]);
    expect(logged()).toEqual([]);
    const ok = Array.from({ length: 200 }, (_, i) => uuid(i));
    expect((await post(verify(ok))).status).toBe(200);
    expect(db.rpcs).toHaveLength(1);
    expect(db.rpcs[0].fn).toBe("verify_document_customer_links");
  });
  it("portal OFF needs no fresh code (admin); portal ON does", async () => {
    signIn("admin");
    db.mfa = { currentLevel: "aal2", currentAuthenticationMethods: [] };
    expect((await post({ action: "portal_set", enabled: false, reason: "pause" })).status).toBe(200);
    expect((await post({ action: "portal_set", enabled: true, reason: "go" })).status).toBe(403);
    expectFiveFields("portal_set", "mfa_recent");
  });
});
