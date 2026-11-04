/**
 * Migration 138 on the local stack: late-payer chasing (chase steps, pauses, drafts for approval) and the payment claim.
 *
 *   - Row security: chase_steps (members read; admin and office write; workshop and viewer can't; another company sees and changes
 *     nothing), chase_pauses (admin and office only; the invoice or customer must be the company's), chase_sends (admin and office read;
 *     nobody signed in writes). The two chase functions are the service role's only.
 *   - chase_create_draft: at most once per invoice per step (also with two passes at the same moment), a step never before its day (a
 *     before-due step from its day), never for a paid / void / credited / written-off / draft invoice, a payment to confirm, no balance,
 *     an open payment claim, or while the invoice's or its customer's chasing is paused; the draft, the chase row and the audit row.
 *   - chase_record_sent: who approved it and the sent e-mail; the draft removed; audited; running it again changes nothing.
 *   - mark_payment_claimed / resolve_payment_claim: roles (office and admin; the service role marks only), another company refused, the
 *     refused states, the four columns, nobody edits them directly, the audit rows with the outcome.
 *   - The release preflight's marker 138 pins the exact bodies: a changed body, or 138 rolled back, reads "not applied".
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), as the 106 suite does; runs on the local Supabase stack and on a
 * plain PostgreSQL 16 stand-in.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend } from "../support/isolation";
import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");

const run = randomUUID().slice(0, 8);
let counter = 0;
type Person = { id: string; email: string; session?: string; aal?: string };
const person = (name: string): Person => ({ id: randomUUID(), email: `${name}-${(counter += 1)}.${run}@example.test` });

const orgs: string[] = [];
const people: string[] = [];
async function makeOrg(db: Client, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [id, `138 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-138-${label}-${counter}`]);
  orgs.push(id);
  return id;
}
async function member(db: Client, org: string, p: Person, role: string) {
  people.push(p.id);
  await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await db.query(`insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
                  values ($1, $2, $3, $4, $5, true, false)`, [p.id, p.email, `Person ${counter}`, role, org]);
  await db.query("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, $3, true)", [p.id, org, role]);
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
}

/** One API request as `p` (role authenticated with the person's claims), committed. */
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
/** One request as the service role (the cron, the server routes), committed. */
async function svc<T>(fn: (db: Client) => Promise<T>, client?: Client): Promise<T> {
  const go = async (db: Client) => {
    await db.query("begin");
    try {
      await db.query("set local role service_role");
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  };
  return client ? go(client) : withDb(go);
}
const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, params)).rows);
const rows = async (p: Person, text: string, params: unknown[] = []) => as(p, async (db) => (await db.query(text, params)).rowCount ?? 0);

const A = { admin: person("a-admin"), office: person("a-office"), workshop: person("a-workshop"), viewer: person("a-viewer") };
const B = { office: person("b-office") };
let orgA = "";
let orgB = "";
const today = async () => (await sql<{ d: string }>("select ((now() at time zone 'Europe/London')::date)::text as d"))[0].d;
const plusDays = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

async function invoice(org: string, extra: Record<string, unknown> = {}): Promise<string> {
  const values = { invoice_ref: `INV-${run}-${(counter += 1)}`, customer: "Acme Ltd", total: 120, amount_paid: 0, credited_amount: 0, refunded_amount: 0, status: "sent", due_date: plusDays(await today(), -20), payment_unverified: false, ...extra };
  const cols = Object.keys(values);
  const { rows: made } = await withDb((db) => db.query(`insert into public.invoices (organization_id, ${cols.join(", ")}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) returning id`, [org, ...Object.values(values)]));
  return made[0].id as string;
}
async function step(org: string, offset: number, tone: string): Promise<string> {
  return (await sql<{ id: string }>("insert into public.chase_steps (organization_id, offset_days, tone) values ($1, $2, $3) returning id", [org, offset, tone]))[0].id;
}
const draft = (org: string, inv: string, stepId: string, user: string | null = null, client?: Client) =>
  svc(async (db) => (await db.query("select public.chase_create_draft($1, $2, $3, 'pay@acme.test', 'Pat', 'Overdue invoice', 'Hi Acme', $4) as r", [org, inv, stepId, user])).rows[0].r as { created: boolean; reason?: string; history_id?: string; chase_id?: string }, client);

let customerA = "";
let steps: Record<string, string> = {};

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    orgA = await makeOrg(db, "alpha");
    orgB = await makeOrg(db, "beta");
    await member(db, orgA, A.admin, "admin");
    await member(db, orgA, A.office, "office");
    await member(db, orgA, A.workshop, "workshop");
    await member(db, orgA, A.viewer, "viewer");
    await member(db, orgB, B.office, "office");
    customerA = (await db.query("insert into public.customers (organization_id, name, email) values ($1, 'Acme Ltd', 'pay@acme.test') returning id", [orgA])).rows[0].id;
  });
  steps = { b3: await step(orgA, -3, "before_due"), f7: await step(orgA, 7, "friendly"), m14: await step(orgA, 14, "firm"), x30: await step(orgA, 30, "final") };
});

afterAll(async () => {
  await withDb(async (db) => {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    for (const t of ["public.chase_sends", "public.chase_pauses", "public.chase_steps", "security_audit.company_email_sends", "public.email_history", "public.invoices",
      "public.customers", "security_audit.audit_log", "public.organization_members", "public.user_profiles"]) {
      await db.query(`delete from ${t} where organization_id = any($1)`, [orgs]);
    }
    await db.query("delete from security_audit.session_company where user_id = any($1)", [people]);
    await db.query("delete from public.organizations where id = any($1)", [orgs]);
    await db.query("commit");
    await db.query("delete from auth.users where id = any($1)", [people]);
  });
});

describe("138: row security on the chase tables", () => {
  it("chase_steps: office and admin write their own company's; members read; workshop and viewer can't write; another company can't", async () => {
    expect(await rows(A.office, "insert into public.chase_steps (organization_id, offset_days, tone) values ($1, 45, 'final')", [orgA])).toBe(1);
    expect(await rows(A.admin, "update public.chase_steps set tone = 'firm' where organization_id = $1 and offset_days = 45", [orgA])).toBe(1);
    expect(await sql("select updated_by from public.chase_steps where organization_id = $1 and offset_days = 45", [orgA])).toEqual([{ updated_by: A.admin.id }]);
    for (const p of [A.workshop, A.viewer]) {
      expect(await rows(p, "select 1 from public.chase_steps")).toBe(5);
      await expect(rows(p, "insert into public.chase_steps (organization_id, offset_days, tone) values ($1, 50, 'final')", [orgA])).rejects.toMatchObject({ code: "42501" });
      expect(await rows(p, "update public.chase_steps set tone = 'final' where organization_id = $1", [orgA])).toBe(0);
      expect(await rows(p, "delete from public.chase_steps where organization_id = $1", [orgA])).toBe(0);
    }
    expect(await rows(B.office, "select 1 from public.chase_steps")).toBe(0);
    expect(await rows(B.office, "update public.chase_steps set tone = 'final' where organization_id = $1", [orgA])).toBe(0);
    await expect(rows(B.office, "insert into public.chase_steps (organization_id, offset_days, tone) values ($1, 50, 'final')", [orgA])).rejects.toMatchObject({ code: "42501" });
    await expect(rows(A.office, "update public.chase_steps set organization_id = $2 where organization_id = $1 and offset_days = 45", [orgA, orgB])).rejects.toMatchObject({ code: "42501" });
    expect(await rows(A.office, "delete from public.chase_steps where organization_id = $1 and offset_days = 45", [orgA])).toBe(1);
  });

  it("chase_steps: the tone fits the day, one step per day, at most 10", async () => {
    await expect(rows(A.office, "insert into public.chase_steps (organization_id, offset_days, tone) values ($1, -5, 'friendly')", [orgA])).rejects.toMatchObject({ code: "23514" });
    await expect(rows(A.office, "insert into public.chase_steps (organization_id, offset_days, tone) values ($1, 5, 'before_due')", [orgA])).rejects.toMatchObject({ code: "23514" });
    await expect(rows(A.office, "insert into public.chase_steps (organization_id, offset_days, tone) values ($1, 7, 'firm')", [orgA])).rejects.toMatchObject({ code: "23505" });
    await withDb(async (db) => {
      await db.query("begin");
      for (let d = 60; d < 66; d += 1) await db.query("insert into public.chase_steps (organization_id, offset_days, tone) values ($1, $2, 'final')", [orgA, d]);
      await expect(db.query("insert into public.chase_steps (organization_id, offset_days, tone) values ($1, 99, 'final')", [orgA])).rejects.toMatchObject({ code: "22023" });
      await db.query("rollback");
    });
  });

  it("chase_pauses: office and admin only, for the company's own invoice or customer", async () => {
    const inv = await invoice(orgA);
    const invB = await invoice(orgB);
    expect(await rows(A.office, "insert into public.chase_pauses (organization_id, invoice_id, reason) values ($1, $2, 'Query on delivery')", [orgA, inv])).toBe(1);
    expect(await sql("select paused_by, reason from public.chase_pauses where invoice_id = $1", [inv])).toEqual([{ paused_by: A.office.id, reason: "Query on delivery" }]);
    expect(await rows(A.admin, "select 1 from public.chase_pauses where invoice_id = $1", [inv])).toBe(1);
    for (const p of [A.workshop, A.viewer]) {
      expect(await rows(p, "select 1 from public.chase_pauses")).toBe(0);
      await expect(rows(p, "insert into public.chase_pauses (organization_id, customer_id, reason) values ($1, $2, 'x')", [orgA, customerA])).rejects.toMatchObject({ code: "42501" });
    }
    await expect(rows(A.office, "insert into public.chase_pauses (organization_id, invoice_id, reason) values ($1, $2, 'x')", [orgA, invB])).rejects.toMatchObject({ code: "42501" });
    await expect(rows(B.office, "insert into public.chase_pauses (organization_id, invoice_id, reason) values ($1, $2, 'x')", [orgA, inv])).rejects.toMatchObject({ code: "42501" });
    expect(await rows(B.office, "delete from public.chase_pauses where invoice_id = $1", [inv])).toBe(0);
    await expect(rows(A.office, "insert into public.chase_pauses (organization_id, invoice_id, customer_id, reason) values ($1, $2, $3, 'x')", [orgA, inv, customerA])).rejects.toMatchObject({ code: "23514" });
    expect(await rows(A.office, "delete from public.chase_pauses where invoice_id = $1", [inv])).toBe(1); // resume
  });

  it("chase_sends: admin and office read; nobody signed in writes; the chase functions are the service role's only", async () => {
    await expect(rows(A.admin, "insert into public.chase_sends (organization_id, invoice_id, offset_days, tone) values ($1, $2, 7, 'friendly')", [orgA, await invoice(orgA)])).rejects.toMatchObject({ code: "42501" });
    await expect(rows(A.office, "update public.chase_sends set status = 'sent'")).rejects.toMatchObject({ code: "42501" });
    await expect(as(A.office, (db) => db.query("select public.chase_create_draft($1, $2, $3, 'a@b.test', null, 's', 'b', $4)", [orgA, randomUUID(), steps.f7, A.office.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(as(A.admin, (db) => db.query("select public.chase_record_sent($1, $2, $3, $4)", [orgA, randomUUID(), randomUUID(), A.admin.id]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("138: chase_create_draft", () => {
  it("drafts once per invoice per step: the draft, the chase row and the audit row; a second call is step_done", async () => {
    const inv = await invoice(orgA);
    const first = await draft(orgA, inv, steps.f7, A.office.id);
    expect(first.created).toBe(true);
    expect(await sql("select status, related_to_type, related_to_id, drafted_by, to_email from public.email_history where id = $1", [first.history_id]))
      .toEqual([{ status: "drafted", related_to_type: "invoice", related_to_id: inv, drafted_by: A.office.id, to_email: "pay@acme.test" }]);
    expect(await sql("select step_id, offset_days, tone, status, draft_history_id, drafted_by from public.chase_sends where invoice_id = $1", [inv]))
      .toEqual([{ step_id: steps.f7, offset_days: 7, tone: "friendly", status: "drafted", draft_history_id: first.history_id, drafted_by: A.office.id }]);
    expect(await sql("select actor_user_id, metadata ->> 'tone' as tone from security_audit.audit_log where action = 'chase_drafted' and entity_id = $1", [inv])).toEqual([{ actor_user_id: A.office.id, tone: "friendly" }]);
    expect(await draft(orgA, inv, steps.f7)).toEqual({ created: false, reason: "step_done" });
    expect(await sql("select count(*)::int as n from public.email_history where related_to_id = $1", [inv])).toEqual([{ n: 1 }]);
    // Another step for the same invoice is a decision of the app's (dueChaseSteps), not refused here.
    expect((await draft(orgA, inv, steps.m14)).created).toBe(true);
  });

  it("two passes at the same moment: exactly one draft", async () => {
    const inv = await invoice(orgA);
    const backend = isolatedBackend();
    const one = new Client({ connectionString: backend.databaseUrl });
    const two = new Client({ connectionString: backend.databaseUrl });
    await Promise.all([one.connect(), two.connect()]);
    try {
      await one.query("begin");
      await one.query("set local role service_role");
      const first = (await one.query("select public.chase_create_draft($1, $2, $3, 'pay@acme.test', null, 's', 'b', null) as r", [orgA, inv, steps.f7])).rows[0].r;
      const second = draft(orgA, inv, steps.f7, null, two); // waits on the per-invoice lock
      await new Promise((resolve) => setTimeout(resolve, 300));
      await one.query("commit");
      expect(first.created).toBe(true);
      expect(await second).toEqual({ created: false, reason: "step_done" });
    } finally {
      await Promise.all([one.end(), two.end()]);
    }
    expect(await sql("select count(*)::int as n from public.chase_sends where invoice_id = $1", [inv])).toEqual([{ n: 1 }]);
  });

  it("never before the step's day; a before-due step from 3 days before the due date", async () => {
    const day = await today();
    const soon = await invoice(orgA, { due_date: plusDays(day, 4) });
    expect(await draft(orgA, soon, steps.b3)).toEqual({ created: false, reason: "not_due" });
    const nudge = await invoice(orgA, { due_date: plusDays(day, 3) });
    expect((await draft(orgA, nudge, steps.b3)).created).toBe(true);
    const early = await invoice(orgA, { due_date: plusDays(day, -6) });
    expect(await draft(orgA, early, steps.f7)).toEqual({ created: false, reason: "not_due" });
  });

  it.each([
    ["paid", { status: "paid", amount_paid: 120 }, "paid"],
    ["void", { status: "void" }, "closed"],
    ["credited", { status: "credited" }, "closed"],
    ["written off", { status: "written_off" }, "closed"],
    ["a draft", { status: "draft", invoice_ref: null }, "not_issued"],
    ["a payment to confirm", { payment_unverified: true }, "payment_unverified"],
    ["no balance (part paid, part credited, to the penny)", { total: "100.10", amount_paid: "33.37", credited_amount: "66.73" }, "no_balance"],
    ["no due date", { due_date: null }, "no_due_date"],
  ])("never for %s", async (_name, extra, reason) => {
    expect(await draft(orgA, await invoice(orgA, extra), steps.f7)).toEqual({ created: false, reason });
  });

  it("never with an open payment claim", async () => {
    const inv = await invoice(orgA);
    await as(A.office, (db) => db.query("select public.mark_payment_claimed($1, 'manual', 'Paid Friday', null)", [inv]));
    expect(await draft(orgA, inv, steps.f7)).toEqual({ created: false, reason: "payment_claimed" });
  });

  it("paused: the invoice (until a date, inclusive; an ended pause no longer counts) and the customer (by name, any case); resumed: drafts", async () => {
    const day = await today();
    const inv = await invoice(orgA);
    await sql("insert into public.chase_pauses (organization_id, invoice_id, reason, paused_until) values ($1, $2, 'Query', $3)", [orgA, inv, day]);
    expect(await draft(orgA, inv, steps.f7)).toEqual({ created: false, reason: "invoice_paused" });
    await sql("update public.chase_pauses set paused_until = $2 where invoice_id = $1", [inv, plusDays(day, -1)]);
    expect((await draft(orgA, inv, steps.f7)).created).toBe(true);

    const other = await invoice(orgA, { customer: "  ACME ltd " });
    const pause = (await sql<{ id: string }>("insert into public.chase_pauses (organization_id, customer_id, reason) values ($1, $2, 'On stop') returning id", [orgA, customerA]))[0].id;
    expect(await draft(orgA, other, steps.f7)).toEqual({ created: false, reason: "customer_paused" });
    await sql("delete from public.chase_pauses where id = $1", [pause]);
    expect((await draft(orgA, other, steps.f7)).created).toBe(true);
  });

  it("refuses another company's invoice or step, and a drafter who isn't office or admin of the company", async () => {
    await expect(draft(orgB, await invoice(orgA), steps.f7)).rejects.toMatchObject({ code: "P0002" });
    await expect(draft(orgB, await invoice(orgB), steps.f7)).rejects.toMatchObject({ code: "P0002" });
    for (const p of [A.workshop, B.office]) await expect(draft(orgA, await invoice(orgA), steps.f7, p.id)).rejects.toMatchObject({ code: "42501" });
  });
});

describe("138: chase_record_sent", () => {
  it("records who approved it and the sent e-mail, removes the draft, audits; again: nothing changes; a wrong e-mail is refused", async () => {
    const inv = await invoice(orgA);
    const made = await draft(orgA, inv, steps.f7);
    const sent = (await sql<{ id: string }>("insert into public.email_history (organization_id, to_email, subject, body, status, related_to_type, related_to_id, drafted_by) values ($1, 'pay@acme.test', 's', 'b', 'sent_via_system', 'invoice', $2, $3) returning id", [orgA, inv, A.office.id]))[0].id;
    const other = (await sql<{ id: string }>("insert into public.email_history (organization_id, to_email, subject, body, status, related_to_type, related_to_id) values ($1, 'x@acme.test', 's', 'b', 'sent_via_system', 'invoice', $2) returning id", [orgA, randomUUID()]))[0].id;
    const record = (s: string, user: string) => svc(async (db) => (await db.query("select public.chase_record_sent($1, $2, $3, $4) as r", [orgA, made.history_id, s, user])).rows[0].r);
    await expect(record(other, A.office.id)).rejects.toMatchObject({ code: "22023" });
    await expect(record(sent, A.workshop.id)).rejects.toMatchObject({ code: "42501" });
    expect(await record(sent, A.office.id)).toMatchObject({ recorded: true });
    expect(await sql("select status, approved_by, sent_history_id, draft_history_id from public.chase_sends where invoice_id = $1", [inv]))
      .toEqual([{ status: "sent", approved_by: A.office.id, sent_history_id: sent, draft_history_id: null }]);
    expect(await sql("select 1 from public.email_history where id = $1", [made.history_id])).toEqual([]);
    expect(await sql("select actor_user_id from security_audit.audit_log where action = 'chase_approved_sent' and entity_id = $1", [inv])).toEqual([{ actor_user_id: A.office.id }]);
    expect(await record(sent, A.office.id)).toMatchObject({ recorded: false, already: true });
  });
});

describe("138: the payment claim", () => {
  const mark = (p: Person, inv: string, source = "manual", evidence: string | null = "Customer says paid Friday", message: string | null = null) =>
    as(p, (db) => db.query("select public.mark_payment_claimed($1, $2, $3, $4)", [inv, source, evidence, message]));
  const resolve = (p: Person, inv: string, outcome: string) => as(p, (db) => db.query("select public.resolve_payment_claim($1, $2)", [inv, outcome]));
  const claim = async (inv: string) => (await sql("select payment_claimed_at is not null as claimed, payment_claim_source as source, payment_claim_evidence as evidence, payment_claim_message_id as message from public.invoices where id = $1", [inv]))[0];

  it("office (and admin) mark their company's invoice: the four columns and an audit row without the evidence", async () => {
    const inv = await invoice(orgA);
    await mark(A.office, inv);
    expect(await claim(inv)).toEqual({ claimed: true, source: "manual", evidence: "Customer says paid Friday", message: null });
    const audit = await sql<{ actor_user_id: string; metadata: Record<string, unknown> }>("select actor_user_id, metadata from security_audit.audit_log where action = 'payment_claimed' and entity_id = $1", [inv]);
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBe(A.office.id);
    expect(audit[0].metadata).toMatchObject({ claim_source: "manual", by: "person", evidence_length: 25, replaced: false });
    expect(JSON.stringify(audit[0].metadata)).not.toContain("Friday");
    await mark(A.admin, inv, "manual", "Remittance attached");
    expect((await claim(inv)).evidence).toBe("Remittance attached");
  });

  it("the service role (the inbox poll) marks any company's invoice, with the e-mail's message id", async () => {
    const inv = await invoice(orgB);
    await svc((db) => db.query("select public.mark_payment_claimed($1, 'email', 'We paid this today', '<abc@mail.test>')", [inv]));
    expect(await claim(inv)).toEqual({ claimed: true, source: "email", evidence: "We paid this today", message: "<abc@mail.test>" });
    expect(await sql("select actor_user_id, metadata ->> 'by' as by from security_audit.audit_log where action = 'payment_claimed' and entity_id = $1", [inv])).toEqual([{ actor_user_id: null, by: "service" }]);
  });

  it("refuses workshop and viewer, another company, a bad source, and anon", async () => {
    const inv = await invoice(orgA);
    for (const p of [A.workshop, A.viewer]) await expect(mark(p, inv)).rejects.toMatchObject({ code: "42501" });
    await expect(mark(B.office, inv)).rejects.toMatchObject({ code: "P0002" });
    await expect(mark(A.office, inv, "phone")).rejects.toMatchObject({ code: "22023" });
    await expect(withDb(async (db) => { await db.query("begin"); await db.query("set local role anon"); try { await db.query("select public.mark_payment_claimed($1, 'manual', 'x', null)", [inv]); } finally { await db.query("rollback"); } }))
      .rejects.toMatchObject({ code: "42501" });
    expect((await claim(inv)).claimed).toBe(false);
  });

  it.each([
    ["paid", { status: "paid", amount_paid: 120 }, "invoice_paid"],
    ["void", { status: "void" }, "invoice_closed"],
    ["credited", { status: "credited" }, "invoice_closed"],
    ["written off", { status: "written_off" }, "invoice_closed"],
    ["a draft", { status: "draft", invoice_ref: null }, "invoice_draft"],
  ])("refuses a %s invoice", async (_name, extra, hint) => {
    const inv = await invoice(orgA, extra);
    await expect(mark(A.office, inv)).rejects.toMatchObject({ code: "22023", hint });
    await expect(svc((db) => db.query("select public.mark_payment_claimed($1, 'email', 'x', null)", [inv]))).rejects.toMatchObject({ code: "22023", hint });
  });

  it("nobody edits the claim columns directly: not office, not the service role's REST", async () => {
    const inv = await invoice(orgA);
    await expect(rows(A.office, "update public.invoices set payment_claimed_at = now(), payment_claim_source = 'manual' where id = $1", [inv])).rejects.toMatchObject({ code: "42501" });
    await mark(A.office, inv);
    await expect(rows(A.office, "update public.invoices set payment_claimed_at = null, payment_claim_source = null, payment_claim_evidence = null where id = $1", [inv])).rejects.toMatchObject({ code: "42501" });
    await expect(svc((db) => db.query("update public.invoices set payment_claim_evidence = 'x' where id = $1", [inv]))).rejects.toMatchObject({ code: "42501" });
    expect((await claim(inv)).claimed).toBe(true);
  });

  it("resolve: office or admin of the company, 'confirmed' or 'not_received'; clears the columns; audits the outcome", async () => {
    const one = await invoice(orgA);
    const two = await invoice(orgA);
    await mark(A.office, one);
    await mark(A.office, two, "email", "Paid", "<m@x.test>");
    await expect(resolve(A.office, one, "maybe")).rejects.toMatchObject({ code: "22023" });
    for (const p of [A.workshop, A.viewer]) await expect(resolve(p, one, "confirmed")).rejects.toMatchObject({ code: "42501" });
    await expect(resolve(B.office, one, "confirmed")).rejects.toMatchObject({ code: "P0002" });
    await expect(svc((db) => db.query("select public.resolve_payment_claim($1, 'confirmed')", [one]))).rejects.toMatchObject({ code: "42501" });
    await resolve(A.office, one, "confirmed");
    await resolve(A.admin, two, "not_received");
    for (const inv of [one, two]) expect(await claim(inv)).toEqual({ claimed: false, source: null, evidence: null, message: null });
    expect(await sql("select entity_id, actor_user_id, metadata ->> 'outcome' as outcome from security_audit.audit_log where action = 'payment_claim_resolved' and entity_id = any($1) order by created_at", [[one, two]]))
      .toEqual([{ entity_id: one, actor_user_id: A.office.id, outcome: "confirmed" }, { entity_id: two, actor_user_id: A.admin.id, outcome: "not_received" }]);
    await expect(resolve(A.office, one, "confirmed")).rejects.toMatchObject({ code: "P0002", hint: "no_claim" });
  });
});

describe("138 and the release preflight: exact bodies only", () => {
  const marker = async (db: Client) => (await db.query<{ check: string; value: string }>(read("supabase/verify/release_preflight.sql"))).rows.find((r) => r.check.startsWith("marker 138 "))?.value;
  const alter = (db: Client, sig: string) => db.query(`do $d$ begin execute regexp_replace(pg_get_functiondef(to_regprocedure('${sig}')), E'\\nBEGIN\\n', E'\\nBEGIN\\n  -- an unknown version\\n'); end $d$`);
  const rolledBack = <T>(fn: (db: Client) => Promise<T>) => withDb(async (db) => { await db.query("begin"); try { return await fn(db); } finally { await db.query("rollback"); } });

  it("the verify script: every row TRUE", async () => {
    const result = await sql<{ check_name: string; ok: boolean }>(read("supabase/verify/chase_steps_138.sql"));
    expect(result).toHaveLength(12);
    expect(result.filter((r) => !r.ok)).toEqual([]);
  });

  it.each(["public.chase_create_draft(uuid,uuid,uuid,text,text,text,text,uuid)", "public.chase_record_sent(uuid,uuid,uuid,uuid)", "public.mark_payment_claimed(uuid,text,text,text)",
    "public.resolve_payment_claim(uuid,text)", "public.invoice_issue_lock()"])("applied; %s with any other body: not applied", async (sig) => {
    await rolledBack(async (db) => {
      expect(await marker(db)).toBe("applied");
      await alter(db, sig);
      expect(await marker(db)).toBe("not applied");
    });
  });

  it("rolled back: not applied, 076's invoice_issue_lock back; the release applies again", async () => {
    await rolledBack(async (db) => {
      await db.query("set local session_replication_role = replica"); // the rollback drops rows this suite made
      await db.query(unwrapped(read("supabase/release/138_chase_steps.rollback.sql")));
      expect(await marker(db)).toBe("not applied");
      expect((await db.query("select md5(regexp_replace(prosrc, '\\s', '', 'g')) as m from pg_proc where oid = to_regprocedure('public.invoice_issue_lock()')")).rows[0].m).toBe("be26a190744e6b961c9ad71366c67099");
      await db.query(unwrapped(read("supabase/release/138_chase_steps.release.sql")));
      expect(await marker(db)).toBe("applied");
    });
  });
});
