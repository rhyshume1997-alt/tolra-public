/**
 * Migration 106: company e-mail templates and the finance check's per-company switch, on the local stack.
 *
 *   - email_templates: office and admin of the company write (insert, update, delete); every member reads; another company sees and
 *     changes nothing; updated_by is stamped from the session; a row never moves company; the eight keys only; a one-line subject.
 *   - An admin without the second step (company requires it) is refused by the admin_mfa guard; a support session can't write.
 *   - ai_helper_settings.finance_check_enabled is off by default; only an admin changes it (ai_helper_set_finance_check, audited; an
 *     admin without the second step is refused when the company requires it); nobody signed in updates the table directly.
 *   - E8 send ledger: a retry with the same key writes no second history row (sent or drafted); a failed send is tried again on the
 *     same row; only office/admin of the company as themselves, or the service role; the ledger is unreadable; 200 per hour.
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), as the 101 suite does. The same checks as
 * tests/scripts/email_templates_106_proof.sql (which runs with psql on a stand-in copy).
 */
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const run = randomUUID().slice(0, 8);
let counter = 0;
type Person = { id: string; email: string; session?: string; aal?: string };
const person = (name: string): Person => ({ id: randomUUID(), email: `${name}-${(counter += 1)}.${run}@example.test` });

const orgs: string[] = [];
async function makeOrg(db: Client, label: string, requireMfa: boolean) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status, require_admin_mfa) values ($1, $2, $3, 'active', $4)",
    [id, `106 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-106-${label}-${counter}`, requireMfa]);
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
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal: p.aal ?? "aal2", email: p.email, session_id: p.session }), p.id]);
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, params)).rows);
const count = async (p: Person, text: string, params: unknown[] = []) => as(p, async (db) => (await db.query(text, params)).rowCount ?? 0);

const A = { admin: person("a-admin"), office: person("a-office"), workshop: person("a-workshop"), support: person("a-support") };
const B = { office: person("b-office") };
let orgA = "";
let orgB = "";

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    orgA = await makeOrg(db, "alpha", true);
    orgB = await makeOrg(db, "beta", false);
    await member(db, orgA, A.admin, "admin");
    await member(db, orgA, A.office, "office");
    await member(db, orgA, A.workshop, "workshop");
    await supportMember(db, orgA, A.support);
    await member(db, orgB, B.office, "office");
  });
});

afterAll(async () => {
  const people = [...Object.values(A), ...Object.values(B)].map((p) => p.id);
  await withDb(async (db) => {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    for (const t of ["security_audit.company_email_sends", "public.email_history", "public.email_templates", "public.ai_helper_settings", "security_audit.audit_log", "public.organization_members", "public.user_profiles"]) {
      await db.query(`delete from ${t} where organization_id = any($1)`, [orgs]);
    }
    await db.query("delete from security_audit.session_company where user_id = any($1)", [people]);
    await db.query("delete from security_audit.platform_admins where user_id = any($1)", [people]);
    await db.query("delete from public.organizations where id = any($1)", [orgs]);
    await db.query("commit");
    await db.query("delete from auth.users where id = any($1)", [people]);
  });
});

const insert = (p: Person, org: string, key: string, subject = "Quote {{document_number}}", body = "Hello {{customer_name}}") =>
  count(p, "insert into public.email_templates (organization_id, key, subject, body, updated_by) values ($1, $2, $3, $4, $5)", [org, key, subject, body, B.office.id]);

describe("106: email_templates", () => {
  it("office writes its own company's template; updated_by comes from the session", async () => {
    expect(await insert(A.office, orgA, "quote")).toBe(1);
    expect(await sql("select updated_by from public.email_templates where organization_id = $1 and key = 'quote'", [orgA])).toEqual([{ updated_by: A.office.id }]);
    expect(await count(A.office, "update public.email_templates set body = 'Hi {{customer_name}}' where organization_id = $1 and key = 'quote'", [orgA])).toBe(1);
  });

  it("refuses another company, moving a row, unknown keys, CR/LF subjects and duplicates", async () => {
    await expect(insert(A.office, orgB, "quote")).rejects.toMatchObject({ code: "42501" });
    await expect(count(A.office, "update public.email_templates set organization_id = $2 where organization_id = $1", [orgA, orgB])).rejects.toMatchObject({ code: "42501" });
    await expect(insert(A.office, orgA, "alert")).rejects.toMatchObject({ code: "23514" });
    await expect(insert(A.office, orgA, "invoice", "Hi\r\nBcc: x@evil.test")).rejects.toMatchObject({ code: "23514" });
    await expect(insert(A.office, orgA, "invoice", "Hi", "   ")).rejects.toMatchObject({ code: "23514" });
    await expect(insert(A.office, orgA, "quote")).rejects.toMatchObject({ code: "23505" });
  });

  it("workshop reads but writes nothing; another company sees nothing", async () => {
    expect(await count(A.workshop, "select 1 from public.email_templates")).toBe(1);
    expect(await count(A.workshop, "update public.email_templates set body = 'x' where organization_id = $1", [orgA])).toBe(0);
    expect(await count(A.workshop, "delete from public.email_templates where organization_id = $1", [orgA])).toBe(0);
    await expect(insert(A.workshop, orgA, "invoice")).rejects.toMatchObject({ code: "42501" });
    expect(await count(B.office, "select 1 from public.email_templates")).toBe(0);
    expect(await count(B.office, "delete from public.email_templates")).toBe(0);
  });

  it("a support session can't write; an admin needs the second step when the company requires it", async () => {
    await expect(insert(A.support, orgA, "invoice")).rejects.toMatchObject({ code: "42501" });
    A.admin.aal = "aal1";
    await expect(count(A.admin, "delete from public.email_templates where organization_id = $1", [orgA])).rejects.toMatchObject({ code: "42501" });
    A.admin.aal = "aal2";
    expect(await count(A.admin, "delete from public.email_templates where organization_id = $1 and key = 'quote'", [orgA])).toBe(1);
  });
});

describe("106: the finance check's per-company switch", () => {
  it("is off by default; only an admin turns it on (audited); nobody updates the table directly", async () => {
    await sql("insert into public.ai_helper_settings (organization_id) values ($1)", [orgB]);
    expect(await sql("select finance_check_enabled from public.ai_helper_settings where organization_id = $1", [orgB])).toEqual([{ finance_check_enabled: false }]);
    await as(A.admin, (db) => db.query("select public.ai_helper_set_finance_check(true)"));
    expect(await sql("select finance_check_enabled from public.ai_helper_settings where organization_id = $1", [orgA])).toEqual([{ finance_check_enabled: true }]);
    expect(await sql("select 1 from security_audit.audit_log where organization_id = $1 and action = 'ai_helper_settings_updated' and metadata ->> 'finance_check_enabled' = 'true'", [orgA])).toHaveLength(1);
    await expect(as(A.office, (db) => db.query("select public.ai_helper_set_finance_check(false)"))).rejects.toMatchObject({ code: "42501" });
    await expect(as(A.support, (db) => db.query("select public.ai_helper_set_finance_check(false)"))).rejects.toMatchObject({ code: "42501" });
    await expect(count(A.admin, "update public.ai_helper_settings set finance_check_enabled = false")).rejects.toMatchObject({ code: "42501" });
    A.admin.aal = "aal1";
    await expect(as(A.admin, (db) => db.query("select public.ai_helper_set_finance_check(false)"))).rejects.toMatchObject({ code: "42501", hint: "mfa_required" });
    A.admin.aal = "aal2";
  });
});

type Reservation = { send_id: string; history_id: string; status: string; replay: boolean };
const reserve = (p: Person | null, org: string, key: string, mode = "sending", related = "invoice", record = "rec-1") => {
  const text = "select public.reserve_company_email($1, $2, $3, 'c@example.test', 'Invoice 1', 'Body', $4, $5, $6) as v";
  const params = [org, p?.id ?? null, key, related, record, mode];
  if (p) return as(p, async (db) => (await db.query<{ v: Reservation }>(text, params)).rows[0].v);
  return withDb(async (db) => {
    await db.query("begin");
    await db.query("set local role service_role");
    const v = (await db.query<{ v: Reservation }>(text, params)).rows[0].v;
    await db.query("commit");
    return v;
  });
};
const complete = (p: Person, org: string, send: string, outcome: string) =>
  as(p, (db) => db.query("select public.complete_company_email($1, $2, $3, $4)", [org, p.id, send, outcome]));

describe("106 (E8): the company mailer's send ledger", () => {
  it("a retry with the same key is a replay: one history row; a failed send is tried again on the same row; accepted is recorded", async () => {
    const key = "a".repeat(64);
    const first = await reserve(A.office, orgA, key);
    expect(first).toMatchObject({ replay: false, status: "sending" });
    expect(await reserve(A.office, orgA, key)).toMatchObject({ replay: true, status: "sending", history_id: first.history_id });
    expect(await sql("select 1 from public.email_history where organization_id = $1 and related_to_id = 'rec-1'", [orgA])).toHaveLength(1);
    await complete(A.office, orgA, first.send_id, "failed");
    expect(await reserve(A.office, orgA, key)).toMatchObject({ replay: false, history_id: first.history_id });
    await complete(A.office, orgA, first.send_id, "accepted");
    expect(await sql("select status from public.email_history where id = $1 and sent_at is not null", [first.history_id])).toEqual([{ status: "sent_via_system" }]);
    expect(await reserve(A.office, orgA, key)).toMatchObject({ replay: true, status: "accepted" });
    await expect(complete(A.office, orgA, first.send_id, "accepted")).rejects.toMatchObject({ code: "P0002" });
  });

  it("a retried draft writes no second draft", async () => {
    const key = "b".repeat(64);
    await reserve(A.office, orgA, key, "drafted", "quote", "rec-2");
    expect(await reserve(A.office, orgA, key, "drafted", "quote", "rec-2")).toMatchObject({ replay: true, status: "drafted" });
    expect(await sql("select 1 from public.email_history where organization_id = $1 and related_to_id = 'rec-2'", [orgA])).toHaveLength(1);
  });

  it("only office/admin of the company as themselves; support, workshop, other companies and aal1 admins refused; ledger unreadable", async () => {
    const key = "c".repeat(64);
    await expect(reserve(B.office, orgA, key)).rejects.toMatchObject({ code: "42501" });
    await expect(reserve(A.workshop, orgA, key)).rejects.toMatchObject({ code: "42501" });
    await expect(reserve(A.support, orgA, key)).rejects.toMatchObject({ code: "42501" });
    A.admin.aal = "aal1";
    await expect(reserve(A.admin, orgA, key)).rejects.toMatchObject({ code: "42501" });
    A.admin.aal = "aal2";
    await expect(as(A.office, (db) => db.query("select public.reserve_company_email($1, $2, $3, 'c@example.test', 'S', 'B', 'general', null, 'sending')", [orgA, A.admin.id, key]))).rejects.toMatchObject({ code: "42501" });
    await expect(as(A.office, (db) => db.query("select count(*) from security_audit.company_email_sends"))).rejects.toMatchObject({ code: "42501" });
  });

  it("the service role reserves a system send (no person) for the company it names", async () => {
    const r = await reserve(null, orgB, "e".repeat(64), "sending", "invoice", "rec-3");
    expect(r).toMatchObject({ replay: false, status: "sending" });
    expect(await sql("select drafted_by from public.email_history where id = $1 and organization_id = $2", [r.history_id, orgB])).toEqual([{ drafted_by: null }]);
  });
});
