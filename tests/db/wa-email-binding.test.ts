/**
 * W-A: approved e-mail binding and failure handling, proved on a disposable loopback PostgreSQL 16 with all migrations and the 138 release.
 * Real: chase_create_draft, the 106 send ledger (reserve/complete_company_email), write_audit and the audit trail, row level security
 * (queries run as the person with their JWT claims), and the app code (lib/email/chase/*, lib/email/approve-draft.ts, the approve,
 * statement and resolve routes). Stood in: the supabase-js client (tests/support/wa-pg-client.ts runs the same queries as SQL), the
 * session lookup, and the provider transport (a recorder, so no provider is ever called). All addresses are .invalid.
 */
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: { admin: null as unknown, user: null as unknown, organizationId: "", userId: "", role: "office" },
  transport: { calls: [] as Array<{ to: string[]; subject: string; text: string }>, outcomes: [] as Array<"accepted" | "failed" | "unknown"> },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => h.state.admin }));
vi.mock("@/lib/server/error-alert", () => ({ reportServerError: async () => ({ sent: false, reason: "disabled" }) }));
vi.mock("@/lib/server/auth", () => {
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return {
    sameOrigin: () => true, forbiddenOrigin: () => json({ error: "Forbidden" }, 403), jsonError: (error: string, status: number) => json({ error }, status),
    isErrorResponse: (value: unknown) => value instanceof Response, clientIp: () => "127.0.0.1",
    readJson: async (request: Request) => ({ ok: true as const, data: await request.json() }),
    requireProfile: async (roles: string[]) => (roles.includes(h.state.role)
      ? { supabase: h.state.user, user: { id: h.state.userId }, profile: { organization_id: h.state.organizationId, role: h.state.role }, session: null }
      : json({ error: "Forbidden" }, 403)),
  };
});
vi.mock("@/lib/email/send-company-email", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/email/send-company-email")>();
  const inject = (deps: object = {}) => ({
    getToken: async () => null,
    providers: {
      resend: () => ({
        name: "resend" as const,
        send: async (email: { to: string[]; subject: string; text: string }) => {
          h.transport.calls.push({ to: email.to, subject: email.subject, text: email.text });
          const outcome = h.transport.outcomes.shift() ?? "accepted";
          return outcome === "accepted" ? { outcome, providerMessageId: "msg-stub", detail: "stub" } : { outcome, detail: "stub" };
        },
      }),
    },
    ...deps,
  });
  return {
    ...real,
    selectProvider: (org: string, deps?: object) => real.selectProvider(org, inject(deps)),
    resendFromEnv: (env: Record<string, string | undefined>, deps?: object) => real.resendFromEnv(env, inject(deps) as never),
    sendCompanyEmail: (input: Parameters<typeof real.sendCompanyEmail>[0], deps?: object) => real.sendCompanyEmail(input, inject(deps)),
  };
});

import { runInvoiceReminders } from "@/lib/email/schedules/reminders";
import { closeWaPool, pgClient, waPool } from "../support/wa-pg-client";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";
import { verifyBackendIdentity } from "../support/fixtures";

const run = randomUUID().slice(0, 8);
let counter = 0;
const evidence = (label: string, value: unknown) => console.log(`WA-EVIDENCE ${label} ${JSON.stringify(value)}`);
const sql = async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) => (await waPool().query(text, params)).rows as T[];
const dbToday = async () => (await sql<{ d: string }>("select ((now() at time zone 'Europe/London')::date)::text as d"))[0].d;
const plusDays = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

type Person = { id: string; email: string; session: string };
const orgs: string[] = [];
const people: string[] = [];
async function makeOrg(label: string) {
  const id = randomUUID(); counter += 1;
  await sql("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [id, `WA ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-wa-${label}-${counter}`]);
  orgs.push(id); return id;
}
async function makePerson(org: string, name: string, role: string): Promise<Person> {
  counter += 1;
  const p = { id: randomUUID(), email: `${name}-${counter}.${run}@wa.invalid`, session: randomUUID() };
  people.push(p.id);
  await sql("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await sql("insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, $3, $4, $5, true, false)", [p.id, p.email, `Person ${counter}`, role, org]);
  await sql("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, $3, true)", [p.id, org, role]);
  await sql("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await sql("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
  return p;
}
const claimsOf = (p: Person) => ({ sub: p.id, role: "authenticated", aud: "authenticated", aal: "aal2", email: p.email, session_id: p.session });

type World = { org: string; office: Person; admin: Person; today: string; custId: string; custEmail: string; invoiceId: string };
async function world(label: string): Promise<World> {
  const org = await makeOrg(label);
  const office = await makePerson(org, "office", "office");
  const admin = await makePerson(org, "admin", "admin");
  await sql("insert into public.chase_steps (organization_id, offset_days, tone) values ($1, 7, 'friendly')", [org]);
  const today = await dbToday();
  const custEmail = `buyer-${counter}@${run}.invalid`;
  const custId = (await sql<{ id: string }>("insert into public.customers (organization_id, name, email) values ($1, $2, $3) returning id", [org, `Customer ${label} ${run}`, custEmail]))[0].id;
  counter += 1;
  const invoiceId = (await sql<{ id: string }>("insert into public.invoices (organization_id, invoice_ref, customer, total, amount_paid, credited_amount, refunded_amount, status, due_date, payment_unverified) values ($1, $2, $3, 120, 0, 0, 0, 'sent', $4, false) returning id",
    [org, `INV-${run}-${counter}`, `Customer ${label} ${run}`, plusDays(today, -20)]))[0].id;
  return { org, office, admin, today, custId, custEmail, invoiceId };
}
function actAs(w: World, who: "office" | "admin" = "office") {
  const p = who === "admin" ? w.admin : w.office;
  h.state.admin = pgClient({ role: "service_role" });
  h.state.user = pgClient({ role: "authenticated", claims: claimsOf(p) });
  h.state.organizationId = w.org; h.state.userId = p.id; h.state.role = who;
}
const pass = async (w: World) => {
  actAs(w);
  const schedule = { id: randomUUID(), organization_id: w.org, kind: "invoice_reminder", enabled: true, frequency: "daily", weekday: null, time_of_day: "08:00", run_at: null, timezone: "Europe/London", recipients: null, last_run_at: null, updated_at: null } as never;
  return runInvoiceReminders(h.state.admin as never, schedule, { at: new Date(), periodKey: "x" }, new Date());
};
const draftOf = async (w: World) => (await sql<{ id: string; subject: string; body: string; to_email: string; status: string }>("select id, subject, body, to_email, status from public.email_history where organization_id = $1 and related_to_id = $2 and drafted_by is null and status in ('drafted','sending','unknown') order by drafted_at desc limit 1", [w.org, w.invoiceId]))[0];
const sentRows = async (w: World) => (await sql<{ n: number }>("select count(*)::int as n from public.email_history where organization_id = $1 and status = 'sent_via_system'", [w.org]))[0].n;
const ledger = async (w: World) => (await sql<{ status: string }>("select status from security_audit.company_email_sends where organization_id = $1 order by created_at", [w.org])).map((r) => r.status);
const auditOf = async (w: World) => sql<{ action: string; new_data: Record<string, unknown> | null; metadata: Record<string, unknown> | null; actor_user_id: string | null }>("select action, new_data, metadata, actor_user_id from security_audit.audit_log where organization_id = $1 and action = 'UPDATE' and metadata->>'channel' is not null order by created_at", [w.org]);
const approve = async (w: World, id: string, extra: Record<string, unknown> = {}, who: "office" | "admin" = "office", stale?: { subject?: string; body?: string }) => {
  actAs(w, who);
  const row = (await sql<{ subject: string; body: string; to_email: string }>("select subject, body, to_email from public.email_history where id = $1", [id]))[0] ?? { subject: "gone", body: "gone", to_email: "gone@example.test" };
  const { POST } = await import("@/app/api/chase/approve/route");
  const res = await POST(new Request("http://localhost/api/chase/approve", { method: "POST", body: JSON.stringify({ history_id: id, expected_to: row.to_email, expected_subject: stale?.subject ?? row.subject, expected_body: stale?.body ?? row.body, ...extra }) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const resolve = async (w: World, id: string, outcome: "sent" | "not_sent", who: "office" | "admin" = "admin") => {
  actAs(w, who);
  const { POST } = await import("@/app/api/email/resolve/route");
  const res = await POST(new Request("http://localhost/api/email/resolve", { method: "POST", body: JSON.stringify({ history_id: id, outcome }) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  const identity = await verifyBackendIdentity();
  const loopback = await sql<{ a: string; p: number; n: string }>("select host(inet_server_addr()) as a, inet_server_port() as p, current_database() as n");
  evidence("database", { host: identity.database.host, port: identity.database.port, name: identity.database.name, version: identity.database.serverVersion, server: loopback[0] });
  expect(loopback[0].a).toBe("127.0.0.1");
});
beforeEach(() => {
  h.transport.calls.length = 0; h.transport.outcomes.length = 0;
  vi.stubEnv("RESEND_API_KEY", "re_wa_invalid_key"); vi.stubEnv("EMAIL_FROM", "Tolra <noreply@sender.invalid>"); vi.stubEnv("EMAIL_PROVIDER", ""); vi.stubEnv("VERCEL_ENV", "");
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => {
  const db = await waPool().connect();
  try {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    for (const t of ["public.chase_sends", "public.chase_steps", "security_audit.company_email_sends", "public.email_history", "public.invoices", "public.customers", "security_audit.audit_log", "public.organization_members", "public.user_profiles"]) {
      await db.query(`delete from ${t} where organization_id = any($1)`, [orgs]);
    }
    await db.query("delete from security_audit.session_company where user_id = any($1)", [people]);
    await db.query("delete from public.organizations where id = any($1)", [orgs]);
    await db.query("commit");
  } catch { await db.query("rollback").catch(() => undefined); } finally { db.release(); }
  await closeWaPool();
});

describe("scheduler: drafts only, no provider needed", () => {
  it("makes the draft through the real chase_create_draft with NO provider configured and sends nothing", async () => {
    vi.stubEnv("RESEND_API_KEY", ""); vi.stubEnv("EMAIL_FROM", "");
    const w = await world("sched");
    const out = await pass(w);
    expect(out).toMatchObject({ sent: 0, drafted: 1, failed: 0, error: null });
    const d = await draftOf(w);
    expect(d).toMatchObject({ status: "drafted", to_email: w.custEmail });
    expect(h.transport.calls).toEqual([]);
    expect(await ledger(w)).toEqual([]);
    evidence("scheduler", { out, draftStatus: d.status });
  });
});

describe("a change after review voids the approval (nothing is sent)", () => {
  it("body edited, subject edited, recipient changed, or customer address changed", async () => {
    const w = await world("void");
    await pass(w);
    const d = await draftOf(w);
    // 1. the reviewer approves the text they read, but the body was edited since
    await sql("update public.email_history set body = body || ' (edited)' where id = $1", [d.id]);
    const a = await approve(w, d.id, {}, "office", { body: d.body });
    expect(a.status).toBe(409);
    await sql("update public.email_history set body = $2 where id = $1", [d.id, d.body]);
    // 2. subject edited since
    await sql("update public.email_history set subject = subject || ' X' where id = $1", [d.id]);
    const b = await approve(w, d.id, {}, "office", { subject: d.subject });
    expect(b.status).toBe(409);
    await sql("update public.email_history set subject = $2 where id = $1", [d.id, d.subject]);
    // 3. recipient replaced by an address that is not on file
    await sql("update public.email_history set to_email = $2 where id = $1", [d.id, `elsewhere@${run}.invalid`]);
    const c = await approve(w, d.id);
    expect(c.status).toBe(403);
    await sql("update public.email_history set to_email = $2 where id = $1", [d.id, d.to_email]);
    // 4. the customer's address changed after the draft: the draft is not redirected, it is refused
    await sql("update public.customers set email = $2 where id = $1", [w.custId, `moved@${run}.invalid`]);
    const e = await approve(w, d.id);
    expect(e.status).toBe(403);
    expect(h.transport.calls).toEqual([]);
    expect(await ledger(w)).toEqual([]);
    expect((await draftOf(w)).status).toBe("drafted");
    evidence("void", { body: a.status, subject: b.status, recipient: c.status, customerEmailChanged: e.status, sends: h.transport.calls.length });
  });

  it("an edit that lands between the claim and the send (statement) is caught by the re-read: nothing sent, back to drafted, audited", async () => {
    const w = await world("claimrace");
    actAs(w);
    const { POST: draftStatement } = await import("@/app/api/email/statement/route");
    const made = await draftStatement(new Request("http://localhost/api/email/statement", { method: "POST", body: JSON.stringify({ customer_id: w.custId, idempotency_key: randomUUID() }) }));
    expect(made.status).toBe(200);
    const d = (await sql<{ id: string; subject: string; body: string; to_email: string }>("select id, subject, body, to_email from public.email_history where organization_id = $1 and related_to_id like 'customer_statement:%'", [w.org]))[0];
    await sql(`create or replace function public.wa_edit_after_claim() returns trigger language plpgsql as $f$ begin if new.status = 'sending' and new.related_to_id like 'customer_statement:%' and new.body not like '%(late edit)' then update public.email_history set body = body || ' (late edit)' where id = new.id; end if; return null; end $f$`);
    await sql("create trigger wa_edit_after_claim after update of status on public.email_history for each row when (new.status = 'sending') execute function public.wa_edit_after_claim()");
    try {
      const { POST } = await import("@/app/api/email/approve/route");
      actAs(w);
      const res = await POST(new Request("http://localhost/api/email/approve", { method: "POST", body: JSON.stringify({ draft_id: d.id, subject: d.subject, body: d.body, to: d.to_email }) }));
      expect(res.status).toBe(409);
      expect(h.transport.calls).toEqual([]);
      const row = (await sql<{ status: string }>("select status from public.email_history where id = $1", [d.id]))[0];
      expect(row.status).toBe("drafted");
      const trail = await auditOf(w);
      expect(trail.map((r) => r.new_data?.outcome)).toContain("changed");
      evidence("claimrace", { http: res.status, sends: h.transport.calls.length, status: row.status, audit: trail.map((r) => r.new_data?.outcome) });
    } finally {
      await sql("drop trigger if exists wa_edit_after_claim on public.email_history");
      await sql("drop function if exists public.wa_edit_after_claim()");
    }
  });
});

describe("the customer address changing between the claim and the send", () => {
  it("is caught by the second check: nothing is sent to the old address, the draft returns to the queue, audited", async () => {
    const w = await world("addrrace");
    actAs(w);
    const { POST: draftStatement } = await import("@/app/api/email/statement/route");
    expect((await draftStatement(new Request("http://localhost/api/email/statement", { method: "POST", body: JSON.stringify({ customer_id: w.custId, idempotency_key: randomUUID() }) }))).status).toBe(200);
    const d = (await sql<{ id: string; subject: string; body: string; to_email: string }>("select id, subject, body, to_email from public.email_history where organization_id = $1 and related_to_id like 'customer_statement:%'", [w.org]))[0];
    await sql(`create or replace function public.wa_move_customer() returns trigger language plpgsql as $f$ begin update public.customers set email = 'moved@wa.invalid' where organization_id = new.organization_id; return null; end $f$`);
    await sql("create trigger wa_move_customer after update of status on public.email_history for each row when (new.status = 'sending' and new.related_to_id like 'customer_statement:%') execute function public.wa_move_customer()");
    try {
      const { POST } = await import("@/app/api/email/approve/route");
      actAs(w);
      const res = await POST(new Request("http://localhost/api/email/approve", { method: "POST", body: JSON.stringify({ draft_id: d.id, subject: d.subject, body: d.body, to: d.to_email }) }));
      expect(res.status).toBe(409);
      expect(h.transport.calls).toEqual([]);
      expect((await sql<{ status: string }>("select status from public.email_history where id = $1", [d.id]))[0].status).toBe("drafted");
      expect((await auditOf(w)).map((r) => r.new_data?.outcome)).toContain("changed");
      evidence("addrrace", { http: res.status, sends: h.transport.calls.length });
    } finally {
      await sql("drop trigger if exists wa_move_customer on public.email_history");
      await sql("drop function if exists public.wa_move_customer()");
    }
  });
});

describe("unknown outcome: held, never auto-retried, no provider switch until a person resolves it", () => {
  it("is held; Approve and the admin's Resend are refused; resolving as not sent allows ONE new approval attempt", async () => {
    const w = await world("unknown");
    await pass(w);
    const d = await draftOf(w);
    h.transport.outcomes.push("unknown");
    const first = await approve(w, d.id);
    expect(first.status).toBe(502);
    expect((await draftOf(w)).status).toBe("unknown");
    expect(await ledger(w)).toEqual(["unknown"]);
    // no retry and no switch
    const again = await approve(w, d.id);
    const viaResend = await approve(w, d.id, { provider: "resend" }, "admin");
    expect([again.status, viaResend.status]).toEqual([409, 409]);
    expect(h.transport.calls).toHaveLength(1);
    // failure audit row: ids and codes only
    const trail = await auditOf(w);
    expect(trail.find((r) => r.new_data?.outcome === "unknown")).toMatchObject({ metadata: { channel: "chase-approve" }, actor_user_id: w.office.id });
    expect(JSON.stringify(trail)).not.toMatch(/invalid|Reminder|Dear|Hello/);
    // an office user cannot resolve it; an admin can, and it only records
    expect((await resolve(w, d.id, "not_sent", "office")).status).toBe(403);
    const resolved = await resolve(w, d.id, "not_sent");
    expect(resolved.json).toEqual({ status: "drafted", audited: true });
    expect(h.transport.calls).toHaveLength(1);
    const resolveAudit = (await auditOf(w)).find((r) => r.new_data?.outcome === "resolved_not_sent");
    expect(resolveAudit).toMatchObject({ actor_user_id: w.admin.id, metadata: { channel: "email-resolve" } });
    // now ONE new approval attempt goes through under a new attempt key and sends exactly once
    const retry = await approve(w, d.id);
    expect(retry.status).toBe(200);
    expect(h.transport.calls).toHaveLength(2);
    expect(await sentRows(w)).toBe(1);
    // and a second approval of the same draft cannot send again
    const third = await approve(w, d.id);
    expect(third.status).toBeGreaterThanOrEqual(400);
    expect(h.transport.calls).toHaveLength(2);
    evidence("unknown", { first: first.status, again: again.status, viaResend: viaResend.status, resolved: resolved.json, retry: retry.status, third: third.status, sends: h.transport.calls.length, sentRows: await sentRows(w), ledger: await ledger(w) });
  });
});

describe("confirmed failure: retried once through an explicitly selected provider", () => {
  it("failure keeps the draft queued and audited; office cannot pick Resend; the admin's choice sends exactly once; the same key never sends twice", async () => {
    const w = await world("failed");
    await pass(w);
    const d = await draftOf(w);
    h.transport.outcomes.push("failed");
    const first = await approve(w, d.id);
    expect(first.status).toBe(502);
    expect((await draftOf(w)).status).toBe("drafted");
    expect(await ledger(w)).toEqual(["failed"]);
    expect((await auditOf(w)).map((r) => r.new_data?.outcome)).toContain("failed");
    const office = await approve(w, d.id, { provider: "resend" }, "office");
    expect(office.status).toBe(403);
    expect(h.transport.calls).toHaveLength(1);
    const admin = await approve(w, d.id, { provider: "resend" }, "admin");
    expect(admin.status).toBe(200);
    expect(h.transport.calls).toHaveLength(2);
    expect(await sentRows(w)).toBe(1);
    expect((await auditOf(w)).map((r) => r.new_data?.outcome)).toContain("provider_override");
    // duplicate prevention: the sent draft is gone, and re-using the sent attempt's ledger key replays instead of sending
    const after = await approve(w, d.id, { provider: "resend" }, "admin");
    expect(after.status).toBeGreaterThanOrEqual(400);
    const { sendCompanyEmail } = await import("@/lib/email/send-company-email");
    actAs(w);
    const replay = await sendCompanyEmail({ organizationId: w.org, userId: w.office.id, kind: "invoice_reminder", to: [d.to_email], subject: d.subject, text: d.body, recordType: "invoice", recordId: w.invoiceId, idempotencyKey: `chase-approve:${d.id}:r1` }, { db: h.state.user as never });
    expect(replay).toMatchObject({ ok: true, mode: "sent" });
    expect(h.transport.calls).toHaveLength(2);
    expect(await ledger(w)).toEqual(["failed", "accepted"]);
    evidence("failed", { replay: replay.ok, first: first.status, office: office.status, admin: admin.status, after: after.status, sends: h.transport.calls.length, sentRows: await sentRows(w), ledger: await ledger(w) });
  });
});
