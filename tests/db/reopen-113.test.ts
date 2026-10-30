/**
 * Migration 113: the reopen sign-off (reopen_requests, reopen_preview, reopen_record, decide_reopen_request), on the local stack.
 * Rhys, 30 Oct (D30-5): a reopen needs a confirmation and counts as signed off with admin approval; with no admin available, a tick box
 * reopens now and notifies the admin for later.
 *
 *   - Tick box (no admin available): the reopen is done at once by 081's reopen_job; a pending request with notified_at; the job flow
 *     event (081) and a reopen_requested audit event in the same transaction. An admin can't use the tick box (they approve now).
 *   - An admin is here: an admin's own reopen is approved at once. A non-admin's waits (nothing reopened) until an admin approves it
 *     with their own session; workshop and office can't approve; nobody approves their own request; a decision is made once.
 *   - A rejection after the fact records the decision and does NOT undo the reopen.
 *   - 081's rules hold in every mode: someone else's finish, an invoiced job (the issued invoice unchanged) or a job gone out are refused
 *     and leave no request row. A support session can't reopen.
 *   - Two companies: neither can read, preview, reopen or decide the other's; no direct INSERT or UPDATE for anyone signed in.
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), as the 101 suite does. The same checks, as one psql script
 * that is rolled back: tests/scripts/reopen-113-proof.sql.
 */
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const run = randomUUID().slice(0, 8);
let counter = 0;
type Person = { id: string; email: string; session?: string };
const person = (name: string): Person => ({ id: randomUUID(), email: `${name}-${(counter += 1)}.${run}@example.test` });

const orgs: string[] = [];
async function makeOrg(db: Client, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')",
    [id, `113 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-113-${label}-${counter}`]);
  orgs.push(id);
  return id;
}

async function member(db: Client, org: string, p: Person, role: string) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await db.query(
    `insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`, [p.id, p.email, `Person ${counter}`, role, org]);
  await db.query("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, $3, true)", [p.id, org, role]);
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
}

/** A platform owner's live support membership of `org`, chosen for the session under its grant (036): read-only by default. */
async function supportMember(db: Client, org: string, p: Person) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await db.query(`insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
                  values ($1, $2, 'Tolra Support', 'admin', $3, true, false)`, [p.id, p.email, org]);
  await db.query("insert into security_audit.platform_admins (user_id) values ($1)", [p.id]);
  const grant = randomUUID();
  await db.query(`insert into public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant)
                  values ($1, $2, 'admin', true, true, now() + interval '2 hours', $3)`, [p.id, org, grant]);
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id, grant_id) values ($1, $2, $3, $4)", [p.session, p.id, org, grant]);
}

/** One API request: its own transaction, as role authenticated with the person's claims (as PostgREST runs it). */
async function as<T>(p: Person, fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal: "aal2", email: p.email, session_id: p.session }), p.id]);
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

type Answer = { ok: true; value: Record<string, unknown> | null } | { ok: false; code: string; hint?: string; message?: string };
async function call(p: Person, text: string, params: unknown[] = []): Promise<Answer> {
  try {
    const value = await as(p, async (db) => (await db.query<{ v: Record<string, unknown> | null }>(`select ${text} as v`, params)).rows[0]?.v ?? null);
    return { ok: true, value };
  } catch (error) {
    const e = error as { code?: string; hint?: string; message?: string };
    return { ok: false, code: e.code ?? "error", hint: e.hint, message: e.message };
  }
}

const preview = (p: Person, job: string) => call(p, "public.reopen_preview('job', $1)", [job]);
const reopen = (p: Person, job: string, mode: string, reason = "Finished by mistake, still machining") =>
  call(p, "public.reopen_record('job', $1, $2, $3)", [job, reason, mode]);
const decide = (p: Person, request: unknown, decision: string, note: string | null = null) =>
  call(p, "public.decide_reopen_request($1, $2, $3)", [request, decision, note]);

const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, params)).rows);
const job = async (id: string) => (await sql<{ finished_at: string | null }>("select finished_at from public.jobs where id = $1", [id]))[0];
const requests = (id: string) => sql<Record<string, unknown>>("select * from public.reopen_requests where record_id = $1 order by requested_at", [id]);

const A = { admin: person("a-admin"), admin2: person("a-admin2"), office: person("a-office"), w1: person("a-w1"), w2: person("a-w2"), support: person("a-support") };
const B = { admin: person("b-admin") };
let orgA = "";
let orgB = "";
const jobs: Record<string, string> = {};
let invoiceBefore = "";

async function finishedJob(db: Client, org: string, key: string, by: Person) {
  const id = randomUUID();
  await db.query("insert into public.jobs (id, organization_id, job_no, customer, finished_at, finished_by) values ($1, $2, $3, 'Customer 113', now() - interval '1 hour', $4)",
    [id, org, `J-113${key}-${run}`, by.id]);
  jobs[key] = id;
}

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    orgA = await makeOrg(db, "alpha");
    orgB = await makeOrg(db, "beta");
    await member(db, orgA, A.admin, "admin");
    await member(db, orgA, A.admin2, "admin");
    await member(db, orgA, A.office, "office");
    await member(db, orgA, A.w1, "workshop");
    await member(db, orgA, A.w2, "workshop");
    await supportMember(db, orgA, A.support);
    await member(db, orgB, B.admin, "admin");
    for (const key of ["tick", "wait", "admin", "invoiced", "other", "out", "support"]) await finishedJob(db, orgA, key, key === "other" ? A.w2 : A.w1);
    await finishedJob(db, orgB, "beta", B.admin);
    await db.query("insert into public.invoices (organization_id, customer, job_id, invoice_ref, status) values ($1, 'Customer 113', $2, $3, 'issued')",
      [orgA, jobs.invoiced, `INV-113-${run}`]);
    await db.query("insert into public.delivery_notes (organization_id, dn_number, status, job_id) values ($1, $2, 'despatched', $3)", [orgA, `DN-113-${run}`, jobs.out]);
    invoiceBefore = (await db.query<{ h: string }>("select md5(row_to_json(i)::text) as h from public.invoices i where job_id = $1", [jobs.invoiced])).rows[0].h;
  });
});

afterAll(async () => {
  const people = [...Object.values(A), ...Object.values(B)].map((p) => p.id);
  await withDb(async (db) => {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    for (const t of ["public.reopen_requests", "public.job_flow_events", "public.delivery_notes", "public.invoices", "public.jobs", "security_audit.audit_log",
      "public.organization_members", "public.user_profiles"]) await db.query(`delete from ${t} where organization_id = any($1)`, [orgs]);
    await db.query("delete from security_audit.session_company where user_id = any($1)", [people]);
    await db.query("delete from security_audit.platform_admins where user_id = any($1)", [people]);
    await db.query("delete from public.organizations where id = any($1)", [orgs]);
    await db.query("commit");
    await db.query("delete from auth.users where id = any($1)", [people]);
  });
});

describe("113: tick box, no admin available", () => {
  it("reopens now, leaves a pending request for the admin with notified_at, the 081 flow event and the audit event", async () => {
    const seen = await preview(A.w1, jobs.tick);
    expect(seen).toMatchObject({ ok: true, value: { allowed: true, is_admin: false, issued_invoices: [], record_ref: `J-113tick-${run}` } });
    const done = await reopen(A.w1, jobs.tick, "tick_box_notify");
    expect(done).toMatchObject({ ok: true, value: { status: "pending", approval_mode: "tick_box_notify", reopened: true } });
    expect((await job(jobs.tick)).finished_at).toBeNull();
    const [row] = await requests(jobs.tick);
    expect(row).toMatchObject({ status: "pending", approval_mode: "tick_box_notify", requested_by: A.w1.id, organization_id: orgA, approved_by: null });
    expect(row.notified_at).not.toBeNull();
    expect(row.reopened_at).not.toBeNull();
    expect(await sql("select 1 from public.job_flow_events where job_id = $1 and kind = 'reopen' and reason = 'Finished by mistake, still machining'", [jobs.tick])).toHaveLength(1);
    const events = await sql<{ metadata: Record<string, unknown> }>("select metadata from security_audit.audit_log where organization_id = $1 and action = 'reopen_requested' and entity_id = $2", [orgA, row.id]);
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ approval_mode: "tick_box_notify", reopened: true, source: "reopen_113" });
    expect(JSON.stringify(events[0].metadata)).not.toContain("machining");
  });

  it("refuses a short reason, an unknown mode, a quote and an admin using the tick box", async () => {
    expect(await reopen(A.w1, jobs.wait, "tick_box_notify", "too short")).toMatchObject({ ok: false, code: "22023", hint: "reason_required" });
    expect(await reopen(A.w1, jobs.wait, "whenever")).toMatchObject({ ok: false, code: "22023", hint: "mode_required" });
    expect(await call(A.w1, "public.reopen_record('quote', $1, 'Finished by mistake, still machining', 'tick_box_notify')", [jobs.wait])).toMatchObject({ ok: false, hint: "not_reopenable" });
    expect(await reopen(A.admin, jobs.wait, "tick_box_notify")).toMatchObject({ ok: false, code: "22023", hint: "admin_approves_now" });
    expect((await job(jobs.wait)).finished_at).not.toBeNull();
  });
});

describe("113: an admin is here", () => {
  it("a non-admin's request waits, unreopened, until an admin approves with their own session", async () => {
    const asked = await reopen(A.w1, jobs.wait, "admin_present", "Customer changed the drawing, rework needed");
    expect(asked).toMatchObject({ ok: true, value: { status: "pending", reopened: false } });
    expect((await job(jobs.wait)).finished_at).not.toBeNull();
    expect(await reopen(A.w1, jobs.wait, "admin_present")).toMatchObject({ ok: false, hint: "reopen_waiting" });
    const id = (asked as unknown as { value: { request_id: string } }).value.request_id;
    expect(await decide(A.w1, id, "approve")).toMatchObject({ ok: false, code: "42501", hint: "reopen_admin_only" });
    expect(await decide(A.office, id, "approve")).toMatchObject({ ok: false, code: "42501", hint: "reopen_admin_only" });
    expect((await job(jobs.wait)).finished_at).not.toBeNull();
    expect(await decide(A.admin, id, "approve")).toMatchObject({ ok: true, value: { status: "approved", reopened_now: true } });
    expect((await job(jobs.wait)).finished_at).toBeNull();
    expect((await requests(jobs.wait))[0]).toMatchObject({ status: "approved", approved_by: A.admin.id });
    expect(await decide(A.admin2, id, "reject")).toMatchObject({ ok: false, hint: "already_decided" });
  });

  it("an admin's own reopen is approved at once", async () => {
    expect(await reopen(A.admin, jobs.admin, "admin_present")).toMatchObject({ ok: true, value: { status: "approved", reopened: true } });
    expect((await job(jobs.admin)).finished_at).toBeNull();
    expect((await requests(jobs.admin))[0]).toMatchObject({ status: "approved", approved_by: A.admin.id, requested_by: A.admin.id });
  });

  it("a rejection after a tick-box reopen records the decision and does not undo the reopen", async () => {
    const [row] = await requests(jobs.tick);
    expect(await decide(A.admin, row.id, "reject", "Should have asked first")).toMatchObject({ ok: true, value: { status: "rejected", reopen_kept: true } });
    expect((await job(jobs.tick)).finished_at).toBeNull();
    expect((await requests(jobs.tick))[0]).toMatchObject({ status: "rejected", rejected_by: A.admin.id, decision_note: "Should have asked first" });
    expect(await sql("select 1 from security_audit.audit_log where organization_id = $1 and action = 'reopen_rejected' and entity_id = $2", [orgA, row.id])).toHaveLength(1);
  });

  it("nobody decides their own request", async () => {
    // A request made as workshop, by someone who is an admin by the time it is decided.
    const id = randomUUID();
    await sql(`insert into public.reopen_requests (id, organization_id, record_type, record_id, requested_by, reason, approval_mode, notified_at, status)
               values ($1, $2, 'job', $3, $4, 'Asked before promotion', 'admin_present', now(), 'pending')`, [id, orgA, jobs.other, A.admin2.id]);
    expect(await decide(A.admin2, id, "approve")).toMatchObject({ ok: false, code: "42501", hint: "own_request" });
    await sql("delete from public.reopen_requests where id = $1", [id]);
  });
});

describe("113: 081's reopen rules hold in every mode", () => {
  it("refuses someone else's finish, an invoiced job and a job gone out, leaving no row and the issued invoice unchanged", async () => {
    for (const mode of ["tick_box_notify", "admin_present"]) {
      expect(await reopen(A.w1, jobs.other, mode)).toMatchObject({ ok: false, code: "42501", hint: "reopen_not_allowed" });
      expect(await reopen(A.w1, jobs.invoiced, mode)).toMatchObject({ ok: false, code: "22023", hint: "invoice_issued" });
      expect(await reopen(A.w1, jobs.out, mode)).toMatchObject({ ok: false, code: "22023", hint: "already_despatched" });
    }
    expect(await preview(A.w1, jobs.invoiced)).toMatchObject({ ok: true, value: { allowed: false, issued_invoices: [`INV-113-${run}`], refusal_hint: "invoice_issued" } });
    for (const key of ["other", "invoiced", "out"]) {
      expect(await requests(jobs[key])).toEqual([]);
      expect((await job(jobs[key])).finished_at).not.toBeNull();
      expect(await sql("select 1 from public.job_flow_events where job_id = $1 and kind = 'reopen'", [jobs[key]])).toEqual([]);
    }
    expect((await sql<{ h: string }>("select md5(row_to_json(i)::text) as h from public.invoices i where job_id = $1", [jobs.invoiced]))[0].h).toBe(invoiceBefore);
  });

  it("a support session can't reopen", async () => {
    expect((await reopen(A.support, jobs.support, "admin_present")).ok).toBe(false);
    expect((await job(jobs.support)).finished_at).not.toBeNull();
    expect(await requests(jobs.support)).toEqual([]);
  });
});

describe("113: two companies, and no direct writes", () => {
  it("B reads none of A's requests and can't preview, reopen or decide A's; A can't reopen B's job", async () => {
    expect(await as(B.admin, async (db) => (await db.query("select id from public.reopen_requests")).rows)).toEqual([]);
    expect(await as(A.w1, async (db) => (await db.query("select id from public.reopen_requests")).rows.length)).toBeGreaterThan(0);
    const [row] = await requests(jobs.wait);
    expect(await preview(B.admin, jobs.admin)).toMatchObject({ ok: false, code: "P0002" });
    expect(await reopen(B.admin, jobs.out, "admin_present")).toMatchObject({ ok: false, code: "P0002" });
    expect(await decide(B.admin, row.id, "reject")).toMatchObject({ ok: false, code: "P0002" });
    expect(await reopen(A.admin, jobs.beta, "admin_present")).toMatchObject({ ok: false, code: "P0002" });
    expect((await job(jobs.beta)).finished_at).not.toBeNull();
    expect((await requests(jobs.wait))[0].status).toBe("approved");
  });

  it("no INSERT or UPDATE for anyone signed in (only the functions write)", async () => {
    const forged = await as(A.admin, (db) => db.query(
      `insert into public.reopen_requests (organization_id, record_type, record_id, requested_by, reason, approval_mode, status, approved_by, approved_at, reopened_at)
       values ($1, 'job', $2, $3, 'forged approval row', 'admin_present', 'approved', $3, now(), now())`, [orgA, jobs.out, A.admin.id]))
      .then(() => "allowed", (e: { code?: string }) => e.code);
    expect(forged).toBe("42501");
    const update = await as(A.admin, (db) => db.query("update public.reopen_requests set decision_note = 'x'")).then(() => "allowed", (e: { code?: string }) => e.code);
    expect(update).toBe("42501");
  });
});
