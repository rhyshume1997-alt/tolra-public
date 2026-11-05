/**
 * W-M: Microsoft 365 per-company isolation on the integrated candidate. Rhys's requirement: two companies (JNR, Marpet) have different
 * mailboxes; each connects its own, stores its own token, sends only from its own mailbox; company A can never use company B's connection.
 *
 * REAL code under test (nothing of the isolation path is replaced): lib/email/send-company-email.ts selectProvider / sendCompanyEmail,
 * lib/integrations/microsoft/token-source.ts getDelegatedAccessToken, microsoft/client.ts microsoftReady + microsoftTokenSource,
 * lib/integrations/tokens.ts createTokenSource, lib/integrations/crypto.ts, lib/email/providers/microsoft.ts, lib/m365/route.ts mailGuard
 * and the routes app/api/email/send and app/api/email/approve. FAKED: the service-role database (a fake that applies the filters it is
 * given to a table holding BOTH companies, so a query that forgets the company filter really sees both companies' rows) and Microsoft's
 * Graph (global fetch records the bearer token of every request). The database half is tests/db/wm-ms-isolation.test.ts.
 */
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const A = "aaaaaaaa-0000-4000-8000-00000000000a"; // JNR
const B = "bbbbbbbb-0000-4000-8000-00000000000b"; // Marpet
const USER = "33333333-3333-4333-8333-333333333333";
const DOC = "11111111-1111-4111-8111-111111111111";
const DRAFT = "22222222-2222-4222-8222-222222222222";
const key = randomBytes(32);
const ctx = (org: string, purpose: "refresh" | "access") => ({ organizationId: org, provider: "microsoft", purpose });

type Conn = { organization_id: string; provider: string; status: "connected" | "needs_reconnect" | "disconnected"; tenant_id: string };
type Secret = { refresh_enc: string; access_enc: string | null; expires: string | null };
type Logged = { kind: "from" | "rpc"; name: string; filters?: Record<string, unknown>; args?: Record<string, unknown> };

const h = vi.hoisted(() => ({
  service: null as unknown,
  profileOrg: "",
  support: false,
  approveCalls: [] as Array<{ org: string; providerSeen: string | null; sent: boolean }>,
  userRpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => h.service }));

// Auth: the company comes ONLY from requireProfile's profile (in the app: the database's answer for the sign-in session, lib/server/auth.ts:94-104).
vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => true,
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  jsonError: (m: string, s: number) => NextResponse.json({ error: m }, { status: s }),
  readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
  requireProfile: vi.fn(async () => ({
    supabase: userSession(),
    user: { id: USER },
    profile: { id: USER, organization_id: h.profileOrg, role: "admin" },
    session: { support: h.support },
  })),
}));

// The user's own client (RLS in production): the document of the caller's company, and the send ledger.
function userSession() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    invoices: [{ id: DOC, organization_id: h.profileOrg, customer: "Customer Ltd", invoice_ref: "INV-0042" }],
    customers: [{ organization_id: h.profileOrg, name: "Customer Ltd", email: "acc@customer.test" }],
    user_profiles: [],
  };
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
      limit: (n: number) => { rows = rows.slice(0, n); return q; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      insert: () => q,
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return q;
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    h.userRpc.push({ fn, args });
    if (fn === "reserve_company_email") return { data: { send_id: "s-1", history_id: "h-1", status: "sending", replay: false }, error: null };
    return { data: null, error: null };
  };
  return { from, rpc };
}

// approve-draft is covered by its own tests; here only WHICH company the route hands it, and which provider that company gets.
vi.mock("@/lib/email/approve-draft", () => ({
  approveDraft: vi.fn(async (input: { org: string }, deps: { provider: (org: string) => Promise<{ name: string; send: (e: unknown) => Promise<{ outcome: string }> } | null | "refused"> }) => {
    const provider = await deps.provider(input.org);
    let sent = false;
    if (provider && provider !== "refused") {
      const r = await provider.send({ to: ["acc@customer.test"], cc: [], subject: "s", text: "t", attachments: [] });
      sent = r.outcome === "accepted";
    }
    h.approveCalls.push({ org: input.org, providerSeen: provider && provider !== "refused" ? provider.name : String(provider), sent });
    return { status: 200, body: { ok: true } };
  }),
}));

import { POST as approvePOST } from "@/app/api/email/approve/route";
import { POST as sendPOST } from "@/app/api/email/send/route";
import { selectProvider, sendCompanyEmail } from "@/lib/email/send-company-email";
import { encryptSecret } from "@/lib/integrations/crypto";
import { getDelegatedAccessToken } from "@/lib/integrations/microsoft/token-source";
import { mailGuard } from "@/lib/m365/route";

const tokenOf = (tag: string) => `EWM-ACCESS-${tag}-${randomBytes(6).toString("hex")}`;

/** A fake service-role database holding both companies; it applies exactly the filters the code gives it. */
function makeService(conns: Conn[], secrets: Record<string, Secret>) {
  const log: Logged[] = [];
  const connections = conns;
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters[c] = v; return q; },
      maybeSingle: async () => {
        log.push({ kind: "from", name: table, filters: { ...filters } });
        if (table !== "integration_connections") return { data: null, error: null };
        const rows = connections.filter((r) => Object.entries(filters).every(([c, v]) => (r as Record<string, unknown>)[c] === v));
        // PostgREST: .maybeSingle() over more than one row is an error, not "the first one".
        if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
        return { data: rows[0] ? { status: rows[0].status } : null, error: null };
      },
    };
    return q;
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    log.push({ kind: "rpc", name: fn, args: { ...args } });
    if (fn === "integration_token_lease") {
      const org = args.p_org as string;
      const c = connections.find((r) => r.organization_id === org && r.provider === args.p_provider && r.status !== "disconnected");
      const s = secrets[org];
      if (!c || !s) return { data: null, error: null };
      return { data: { refresh_token_enc: s.refresh_enc, access_token_enc: s.access_enc, access_expires_at: s.expires, key_version: 1 }, error: null };
    }
    if (fn === "integration_mark_needs_reconnect") {
      const c = connections.find((r) => r.organization_id === args.p_org);
      if (c && c.status === "connected") c.status = "needs_reconnect";
      return { data: null, error: null };
    }
    if (fn === "mailbox_sync_due") return { data: [], error: null };
    return { data: null, error: null };
  };
  return { client: { from, rpc }, log, connections, secrets };
}

const future = () => new Date(Date.now() + 3600_000).toISOString();
function company(org: string, tag: string, status: Conn["status"] = "connected") {
  const access = tokenOf(tag);
  return {
    conn: { organization_id: org, provider: "microsoft", status, tenant_id: `mailbox-oid-${tag}` } as Conn,
    secret: { refresh_enc: encryptSecret(`RT-${tag}`, ctx(org, "refresh"), key), access_enc: encryptSecret(access, ctx(org, "access"), key), expires: future() } as Secret,
    access,
  };
}
function world(a: ReturnType<typeof company> | null, b: ReturnType<typeof company> | null) {
  const conns = [a?.conn, b?.conn].filter(Boolean) as Conn[];
  const secrets: Record<string, Secret> = {};
  if (a) secrets[A] = a.secret;
  if (b) secrets[B] = b.secret;
  const svc = makeService(conns, secrets);
  h.service = svc.client;
  return svc;
}

const graphCalls: Array<{ url: string; authorization: string | null }> = [];
const touchesB = (log: Logged[]) => JSON.stringify(log).includes(B);

beforeEach(() => {
  graphCalls.length = 0;
  h.approveCalls = [];
  h.userRpc = [];
  h.support = false;
  h.profileOrg = A;
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", key.toString("base64"));
  vi.stubEnv("MS_CLIENT_ID", "client-id");
  vi.stubEnv("MS_CLIENT_SECRET", "client-secret");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.test");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("EMAIL_FROM", "");
  vi.stubEnv("EMAIL_PROVIDER", "");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    graphCalls.push({ url: String(url), authorization: init?.headers?.Authorization ?? null });
    return new Response(null, { status: 202, headers: { "request-id": "rid" } });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const email = { to: ["acc@customer.test"], cc: [], subject: "Invoice", text: "Hello", attachments: [] };

describe("(1) a send for company A uses only A's connection and token", () => {
  it("with A and B both connected: the connection is read filtered to A, the lease is A's, the Graph call carries A's token, B is never touched", async () => {
    const a = company(A, "A"), b = company(B, "B");
    const svc = world(a, b);
    const provider = await selectProvider(A);
    expect(provider).not.toBeNull();
    expect(provider).not.toBe("refused");
    if (!provider || provider === "refused") return;
    expect(provider.name).toBe("microsoft");
    expect((await provider.send(email)).outcome).toBe("accepted");

    const reads = svc.log.filter((l) => l.kind === "from" && l.name === "integration_connections");
    expect(reads).toHaveLength(1);
    expect(reads[0].filters).toEqual({ organization_id: A, provider: "microsoft" });
    const leases = svc.log.filter((l) => l.kind === "rpc" && l.name === "integration_token_lease");
    expect(leases.map((l) => l.args?.p_org)).toEqual([A]);
    expect(graphCalls).toEqual([{ url: "https://graph.microsoft.com/v1.0/me/sendMail", authorization: `Bearer ${a.access}` }]);
    expect(JSON.stringify(graphCalls)).not.toContain(b.access);
    expect(touchesB(svc.log)).toBe(false);
  });

  it("the same for B: B's send uses B's token and never A's (the two mailboxes are different)", async () => {
    const a = company(A, "A"), b = company(B, "B");
    const svc = world(a, b);
    const provider = await selectProvider(B);
    if (!provider || provider === "refused") throw new Error("expected a provider");
    await provider.send(email);
    expect(graphCalls.map((c) => c.authorization)).toEqual([`Bearer ${b.access}`]);
    expect(JSON.stringify(svc.log)).not.toContain(A);
    expect(b.access).not.toBe(a.access);
  });

  it("the whole mailer (sendCompanyEmail) reserves the ledger row for A and sends with A's token", async () => {
    const a = company(A, "A"), b = company(B, "B");
    const svc = world(a, b);
    const ledger: Array<Record<string, unknown>> = [];
    const db = { rpc: async (fn: string, args: Record<string, unknown>) => { ledger.push({ fn, ...args }); return fn === "reserve_company_email" ? { data: { send_id: "s", history_id: "h", status: "sending", replay: false }, error: null } : { data: null, error: null }; } };
    const r = await sendCompanyEmail({ organizationId: A, userId: USER, kind: "invoice", to: ["acc@customer.test"], subject: "Invoice", text: "Hello", idempotencyKey: "wm-key-0001" }, { db: db as never });
    expect(r).toMatchObject({ ok: true, mode: "sent", provider: "microsoft" });
    expect(ledger.every((l) => l.p_org === A)).toBe(true);
    expect(graphCalls.map((c) => c.authorization)).toEqual([`Bearer ${a.access}`]);
    expect(touchesB(svc.log)).toBe(false);
  });
});

describe("(2) company A without a usable connection never gets B's", () => {
  it("A has no connection, B is connected: null token, no Microsoft provider, Resend per policy when configured, B's rows never read", async () => {
    const b = company(B, "B");
    const svc = world(null, b);
    expect(await getDelegatedAccessToken(A)).toBeNull();
    expect(svc.log.filter((l) => l.kind === "rpc" && l.name === "integration_token_lease")).toHaveLength(0); // not connected: no lease at all
    expect(await selectProvider(A)).toBeNull(); // no Resend configured: the e-mail becomes a draft
    const env = { RESEND_API_KEY: "re_test", EMAIL_FROM: "JNR <office@jnr.example>" };
    const p = await selectProvider(A, { env });
    expect(p && p !== "refused" ? p.name : p).toBe("resend");
    expect(touchesB(svc.log)).toBe(false);
    expect(graphCalls).toHaveLength(0);
  });

  it.each(["needs_reconnect", "disconnected"] as const)("A is %s, B is connected: A gets null (no token, no lease), never B's token", async (status) => {
    const a = company(A, "A", status), b = company(B, "B");
    const svc = world(a, b);
    expect(await getDelegatedAccessToken(A)).toBeNull();
    expect(await selectProvider(A)).toBeNull();
    expect(svc.log.filter((l) => l.kind === "rpc" && l.name === "integration_token_lease")).toHaveLength(0);
    expect(touchesB(svc.log)).toBe(false);
    expect(graphCalls).toHaveLength(0);
    // B is unaffected.
    expect(await getDelegatedAccessToken(B)).toBe(b.access);
  });

  it("the whole mailer: A with no connection sends nothing through Microsoft (a draft), B's mailbox is not used", async () => {
    const b = company(B, "B");
    world(null, b);
    const db = { rpc: async (fn: string) => (fn === "reserve_company_email" ? { data: { send_id: "s", history_id: "h", status: "drafted", replay: false }, error: null } : { data: null, error: null }) };
    const r = await sendCompanyEmail({ organizationId: A, userId: USER, kind: "invoice", to: ["acc@customer.test"], subject: "Invoice", text: "Hello", idempotencyKey: "wm-key-0002" }, { db: db as never });
    expect(r).toMatchObject({ ok: true, mode: "drafted", provider: "none" });
    expect(graphCalls).toHaveLength(0);
  });

  it("the legacy mailbox guard (lib/m365/route.ts mailGuard): A falls back to the legacy mailbox only if A is MS_ORGANIZATION_ID; with B as the legacy company A gets 403 and no Graph call", async () => {
    const b = company(B, "B");
    world(null, b);
    vi.stubEnv("MS_TENANT_ID", "11111111-1111-4111-8111-111111111111");
    vi.stubEnv("MS_MAILBOX", "legacy@marpet.example");
    vi.stubEnv("MS_ORGANIZATION_ID", B);
    const denied = await mailGuard(new Request("http://localhost/api/mail/poll", { method: "POST" }));
    expect(denied).toBeInstanceOf(NextResponse);
    expect((denied as NextResponse).status).toBe(403);
    expect(graphCalls).toHaveLength(0);
    // B itself (profile company B) passes the legacy guard.
    h.profileOrg = B;
    // B is connected, so B takes the delegated path with its own token.
    const ok = await mailGuard(new Request("http://localhost/api/mail/poll", { method: "POST" }));
    expect(ok).not.toBeInstanceOf(NextResponse);
    expect((ok as { config: { delegatedAccessToken: string; organizationId: string } }).config).toMatchObject({ delegatedAccessToken: b.access, organizationId: B });
  });

  it("mailGuard for A with A connected: the delegated token is A's and the guard's company is A (from the profile)", async () => {
    const a = company(A, "A"), b = company(B, "B");
    const svc = world(a, b);
    const ctxOk = await mailGuard(new Request("http://localhost/api/mail/poll", { method: "POST" }));
    expect((ctxOk as { config: { delegatedAccessToken: string; organizationId: string } }).config).toMatchObject({ delegatedAccessToken: a.access, organizationId: A });
    expect(touchesB(svc.log)).toBe(false);
  });
});

describe("(3) a send for A cannot be redirected to B by a request field", () => {
  const sendBody = (extra: Record<string, unknown>) => ({ kind: "invoice", record_id: DOC, to: ["acc@customer.test"], subject: "Invoice I-1", text: "Hello", idempotency_key: "wm-route-key-1", ...extra });
  const post = (body: Record<string, unknown>, url = "http://localhost/api/email/send") =>
    sendPOST(new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-organization-id": B }, body: JSON.stringify(body) }));

  it("POST /api/email/send: organization_id / organizationId in the body, the query string and a header are all ignored: ledger, provider and token are A's", async () => {
    const a = company(A, "A"), b = company(B, "B");
    const svc = world(a, b);
    const res = await post(sendBody({ organization_id: B, organizationId: B, org: B, company_id: B }), `http://localhost/api/email/send?organization_id=${B}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "sent", provider: "microsoft" });
    const reserve = h.userRpc.filter((c) => c.fn === "reserve_company_email");
    expect(reserve).toHaveLength(1);
    expect(reserve[0].args.p_org).toBe(A);
    expect(graphCalls.map((c) => c.authorization)).toEqual([`Bearer ${a.access}`]);
    expect(JSON.stringify(graphCalls)).not.toContain(b.access);
    expect(touchesB(svc.log)).toBe(false);
  });

  it("POST /api/email/send: A asking to send B's document id gets 404 and nothing is sent", async () => {
    const a = company(A, "A"), b = company(B, "B");
    world(a, b);
    h.profileOrg = A;
    // B's invoice is not visible to A's session (RLS in production; here the fake session only holds the caller's company documents).
    const res = await post(sendBody({ record_id: "99999999-9999-4999-8999-999999999999" }));
    expect(res.status).toBe(404);
    expect(graphCalls).toHaveLength(0);
  });

  it("POST /api/email/approve: the schema is strict, so an organization_id field is a 400 and nothing is approved or sent", async () => {
    const a = company(A, "A"), b = company(B, "B");
    world(a, b);
    const res = await approvePOST(new Request("http://localhost/api/email/approve", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft_id: DRAFT, subject: "s", body: "b", to: "acc@customer.test", organization_id: B }) }));
    expect(res.status).toBe(400);
    expect(h.approveCalls).toHaveLength(0);
    expect(graphCalls).toHaveLength(0);
  });

  it("POST /api/email/approve: the company handed to approveDraft is the session's (A), and the provider it gets is A's mailbox", async () => {
    const a = company(A, "A"), b = company(B, "B");
    const svc = world(a, b);
    const res = await approvePOST(new Request(`http://localhost/api/email/approve?organization_id=${B}`, { method: "POST", headers: { "content-type": "application/json", "x-organization-id": B },
      body: JSON.stringify({ draft_id: DRAFT, subject: "s", body: "b", to: "acc@customer.test" }) }));
    expect(res.status).toBe(200);
    expect(h.approveCalls).toEqual([{ org: A, providerSeen: "microsoft", sent: true }]);
    expect(graphCalls.map((c) => c.authorization)).toEqual([`Bearer ${a.access}`]);
    expect(touchesB(svc.log)).toBe(false);
  });

  it("a support session is refused before any provider is chosen", async () => {
    const a = company(A, "A"), b = company(B, "B");
    const svc = world(a, b);
    h.support = true;
    expect((await post(sendBody({}))).status).toBe(403);
    expect(svc.log).toHaveLength(0);
    expect(graphCalls).toHaveLength(0);
  });
});

describe("(4) a token copied from A's row into B's row does not work for B", () => {
  it("A's access ciphertext in B's row: B gets null, is marked needs_reconnect, nothing is sent, and A's token is never returned for B", async () => {
    const a = company(A, "A"), b = company(B, "B");
    const svc = world(a, b);
    svc.secrets[B] = { ...a.secret }; // the attack: B's row now holds A's ciphertext (and A's expiry, so it would be used without a refresh)
    expect(await getDelegatedAccessToken(B)).toBeNull();
    expect(svc.log.some((l) => l.kind === "rpc" && l.name === "integration_mark_needs_reconnect" && l.args?.p_org === B)).toBe(true);
    expect(svc.log.some((l) => l.kind === "rpc" && l.name === "integration_mark_needs_reconnect" && l.args?.p_org === A)).toBe(false);
    expect(svc.connections.find((c) => c.organization_id === B)?.status).toBe("needs_reconnect");
    expect(svc.connections.find((c) => c.organization_id === A)?.status).toBe("connected");
    const p = await selectProvider(B);
    expect(p).toBeNull(); // not even a provider: B's send becomes a draft
    expect(graphCalls).toHaveLength(0);
    // A is untouched and still sends as itself.
    expect(await getDelegatedAccessToken(A)).toBe(a.access);
  });

  it("A's REFRESH ciphertext in B's refresh slot (B's access token expired): B cannot decrypt it, so Microsoft is never asked and A's refresh token is never presented", async () => {
    const a = company(A, "A"), b = company(B, "B");
    const svc = world(a, b);
    svc.secrets[B] = { refresh_enc: a.secret.refresh_enc, access_enc: null, expires: null };
    expect(await getDelegatedAccessToken(B)).toBeNull();
    expect(graphCalls).toHaveLength(0);
    expect(svc.connections.find((c) => c.organization_id === B)?.status).toBe("needs_reconnect");
  });

  it("the same ciphertext moved between slots of one company (refresh into access) is refused too", async () => {
    const a = company(A, "A");
    const svc = world(a, null);
    svc.secrets[A] = { ...a.secret, access_enc: a.secret.refresh_enc };
    expect(await getDelegatedAccessToken(A)).toBeNull();
  });
});
