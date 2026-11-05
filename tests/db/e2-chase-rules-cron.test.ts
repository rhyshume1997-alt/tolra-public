/**
 * E2 requirement 7: the scheduled pass runs with no browser session. The real route handlers app/api/cron/daily and
 * app/api/cron/email-schedules are called in-process (GET with `Authorization: Bearer CRON_SECRET`, no cookies, no user) against the
 * disposable loopback database with seeded overdue invoices; the drafts and the result JSON are shown. A call without the secret gets
 * 401 and reads nothing (the service client is never even created). Stood in: the supabase-js client (tests/support/e2-pg-client.ts, real
 * SQL as service_role). No provider exists on this path; the transport is also stubbed and must stay untouched. Addresses are .invalid.
 */
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ admin: null as unknown, created: 0, queries: 0, absent: false }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => { h.created += 1; return h.absent ? null : h.admin; } }));
vi.mock("@/lib/server/error-alert", () => ({ reportServerError: async () => ({ sent: false, reason: "disabled" }) }));

import { closeE2Pool, e2Pool, pgClient } from "../support/e2-pg-client";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";
import { verifyBackendIdentity } from "../support/fixtures";

const run = randomUUID().slice(0, 8);
const SECRET = "e2-cron-secret-0123456789-invalid";
let counter = 0;
const evidence = (label: string, value: unknown) => console.log(`E2-EVIDENCE ${label} ${JSON.stringify(value)}`);
const sql = async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) => (await e2Pool().query(text, params)).rows as T[];
const plusDays = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const orgs: string[] = [];

async function seed(label: string) {
  const org = randomUUID();
  counter += 1;
  await sql("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [org, `E2 cron ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-e2c-${label}-${counter}`]);
  orgs.push(org);
  for (const [off, tone] of [[-3, "before_due"], [7, "friendly"], [14, "firm"], [30, "final"]] as const) await sql("insert into public.chase_steps (organization_id, offset_days, tone) values ($1, $2, $3)", [org, off, tone]);
  const today = (await sql<{ d: string }>("select ((now() at time zone 'Europe/London')::date)::text as d"))[0].d;
  const inv: Record<string, string> = {};
  const add = async (kind: string, extra: Record<string, unknown>) => {
    counter += 1;
    const email = `${kind}@${run}.invalid`;
    await sql("insert into public.customers (organization_id, name, email) values ($1, $2, $3)", [org, `Cust ${kind}`, email]);
    const v: Record<string, unknown> = { invoice_ref: `INV-${run}-${counter}`, customer: `Cust ${kind}`, total: 120, amount_paid: 0, credited_amount: 0, refunded_amount: 0, status: "sent", due_date: plusDays(today, -20), payment_unverified: false, ...extra };
    const cols = Object.keys(v);
    inv[kind] = (await sql<{ id: string }>(`insert into public.invoices (organization_id, ${cols.join(", ")}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) returning id`, [org, ...Object.values(v)]))[0].id;
  };
  await add("owed-20-days", {});
  await add("owed-35-days", { due_date: plusDays(today, -35) });
  await add("owed-partly-paid", { status: "partial", amount_paid: 50, due_date: plusDays(today, -8) });
  await add("paid", { status: "paid", amount_paid: 120 });
  await add("fully-credited", { credited_amount: 120 });
  await add("void", { status: "void" });
  await add("paused", {});
  await sql("insert into public.chase_pauses (organization_id, invoice_id, reason) values ($1, $2, 'Disputed')", [org, inv.paused]);
  // The company's reminder schedule: daily, 00:01 London, on since three days ago (so today's 00:01 occurrence is due).
  const sched = (await sql<{ id: string }>("insert into public.email_schedules (organization_id, kind, enabled, frequency, time_of_day, timezone) values ($1, 'invoice_reminder', true, 'daily', '00:01', 'Europe/London') returning id", [org]))[0].id;
  const db = await e2Pool().connect();
  try { await db.query("begin"); await db.query("set local session_replication_role = replica"); await db.query("update public.email_schedules set updated_at = now() - interval '3 days' where id = $1", [sched]); await db.query("commit"); } finally { db.release(); }
  return { org, inv, sched, today };
}
const draftsOf = (org: string) => sql<{ invoice_ref: string; status: string; drafted_by: string | null; to_email: string; subject: string; amounts: string[] }>(
  `select i.invoice_ref, h.status, h.drafted_by, h.to_email, h.subject, array(select m[1] from regexp_matches(h.body, '(£[0-9,]+\.[0-9]{2})', 'g') m) as amounts
     from public.email_history h join public.invoices i on i.id::text = h.related_to_id where h.organization_id = $1 order by i.invoice_ref`, [org]);
const call = async (route: "daily" | "email-schedules", headers: Record<string, string> = {}) => {
  const { GET } = route === "daily" ? await import("@/app/api/cron/daily/route") : await import("@/app/api/cron/email-schedules/route");
  const res = await GET(new Request(`https://cron.invalid/api/cron/${route}`, { headers }));
  return { status: res.status, json: await res.json() as Record<string, any> };
};
const withSecret = { authorization: `Bearer ${SECRET}` };

beforeAll(async () => {
  const id = await verifyBackendIdentity();
  expect(["127.0.0.1", "localhost"]).toContain(id.database.host);
  evidence("database", { host: id.database.host, port: id.database.port, name: id.database.name, version: id.database.serverVersion });
  const counting = (c: ReturnType<typeof pgClient>) => ({ from: (t: string) => { h.queries += 1; return c.from(t); }, rpc: (f: string, a?: Record<string, unknown>) => { h.queries += 1; return c.rpc(f, a); } });
  h.admin = counting(pgClient({ role: "service_role" }));
});
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.created = 0; h.queries = 0; h.absent = false;
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("RESEND_API_KEY", "re_e2_invalid_key");
  vi.stubEnv("EMAIL_FROM", "Tolra <noreply@sender.invalid>");
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(async () => { fetchSpy.mockRestore(); vi.unstubAllEnvs(); await sql("update public.email_schedules set enabled = false where organization_id = any($1)", [orgs]); });
afterAll(async () => {
  const db = await e2Pool().connect();
  try {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    await db.query("delete from public.email_schedule_runs where schedule_id in (select id from public.email_schedules where organization_id = any($1))", [orgs]);
    for (const t of ["public.email_schedules", "public.chase_sends", "public.chase_pauses", "public.chase_steps", "public.email_history", "public.invoices", "public.customers", "security_audit.audit_log"]) await db.query(`delete from ${t} where organization_id = any($1)`, [orgs]);
    await db.query("delete from public.organizations where id = any($1)", [orgs]);
    await db.query("commit");
  } finally { db.release(); await closeE2Pool(); }
});

describe("R7 the cron handlers, in-process, no browser session", () => {
  it("without the secret: 401, nothing read (no service client, no query), nothing drafted", async () => {
    const w = await seed("noauth");
    const bad: Array<[string, Record<string, string>]> = [
      ["no header", {}],
      ["wrong secret", { authorization: "Bearer not-the-secret-0123456789" }],
      ["not a bearer", { authorization: SECRET }],
      ["cookie only (a browser session is not a cron call)", { cookie: "sb-access-token=abc" }],
    ];
    for (const route of ["daily", "email-schedules"] as const) {
      for (const [name, headers] of bad) {
        const res = await call(route, headers);
        expect(res, `${route} ${name}`).toEqual({ status: 401, json: { error: "Unauthorized" } });
      }
      for (const secret of [undefined, "", "short"]) {
        vi.stubEnv("CRON_SECRET", secret as string);
        const res = await call(route, secret ? { authorization: `Bearer ${secret}` } : withSecret);
        expect(res.status, `${route} CRON_SECRET=${JSON.stringify(secret)}`).toBe(401);
      }
      vi.stubEnv("CRON_SECRET", SECRET);
    }
    evidence("R7 401", { status: 401, body: { error: "Unauthorized" }, serviceClientsCreated: h.created, queries: h.queries });
    expect(h.created).toBe(0);
    expect(h.queries).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await draftsOf(w.org)).toEqual([]);
    expect(await sql("select count(*)::int as n from public.chase_sends where organization_id = $1", [w.org])).toEqual([{ n: 0 }]);
    expect(await sql("select count(*)::int as n from public.email_schedule_runs where schedule_id = $1", [w.sched])).toEqual([{ n: 0 }]);
    await sql("update public.email_schedules set enabled = false where id = $1", [w.sched]);
  });

  it("GET /api/cron/daily with the secret: drafts for the owed invoices only, the result JSON, a second call drafts nothing more", async () => {
    const w = await seed("daily");
    const first = await call("daily", withSecret);
    evidence("R7 daily first call", first);
    expect(first.status).toBe(200);
    expect(first.json.emailSchedules).toMatchObject({ schedules: 1, due: 1, ran: 1, emails: 0, drafted: 3, failed: 0, errors: 0 });
    expect(first.json.xeroSweep).toEqual({ skipped: "xero not configured" });
    const made = await draftsOf(w.org);
    evidence("R7 drafts the pass created", made);
    expect(made.map((d) => d.status)).toEqual(["drafted", "drafted", "drafted"]);
    expect(made.every((d) => d.drafted_by === null)).toBe(true);
    const byRef = new Map(made.map((d) => [d.invoice_ref, d]));
    const ids = Object.entries(w.inv);
    for (const [kind, id] of ids) {
      const ref = (await sql<{ invoice_ref: string }>("select invoice_ref from public.invoices where id = $1", [id]))[0].invoice_ref;
      expect(byRef.has(ref), `${kind}`).toBe(kind.startsWith("owed-"));
    }
    const partly = made.find((d) => d.to_email.startsWith("owed-partly-paid"))!;
    expect(partly.amounts).toContain("£70.00"); // the part-paid one: its balance, not its total
    expect(partly.amounts).not.toContain("£120.00");
    expect(await sql("select actor_user_id, metadata ->> 'by' as by from security_audit.audit_log where organization_id = $1 and action = 'chase_drafted'", [w.org])).toEqual([{ actor_user_id: null, by: "schedule" }, { actor_user_id: null, by: "schedule" }, { actor_user_id: null, by: "schedule" }]);
    expect(await sql("select sent_count, error from public.email_schedule_runs where schedule_id = $1", [w.sched])).toEqual([{ sent_count: 0, error: null }]);
    expect(await sql("select count(*)::int as n from public.email_history where organization_id = $1 and status <> 'drafted'", [w.org])).toEqual([{ n: 0 }]);
    expect(await sql("select count(*)::int as n from security_audit.company_email_sends where organization_id = $1", [w.org])).toEqual([{ n: 0 }]);
    expect(fetchSpy).not.toHaveBeenCalled();

    const second = await call("daily", withSecret);
    evidence("R7 daily second call", second);
    expect(second.status).toBe(200);
    expect(second.json.emailSchedules).toMatchObject({ due: 1, ran: 0, drafted: 0 });
    expect(await draftsOf(w.org)).toHaveLength(3);
    await sql("update public.email_schedules set enabled = false where id = $1", [w.sched]);
  });

  it("GET /api/cron/email-schedules with the secret does the same on its own", async () => {
    const w = await seed("sched");
    const res = await call("email-schedules", withSecret);
    evidence("R7 email-schedules call", res);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ schedules: 1, due: 1, ran: 1, emails: 0, drafted: 3, failed: 0 });
    expect(await draftsOf(w.org)).toHaveLength(3);
    await sql("update public.email_schedules set enabled = false where id = $1", [w.sched]);
  });

  it("no service key on the server: daily answers 500 with both jobs reported, and drafts nothing", async () => {
    const w = await seed("nokey");
    h.absent = true;
    const res = await call("daily", withSecret);
    evidence("R7 no service client", res);
    expect(res.status).toBe(500);
    expect(res.json.emailSchedules).toEqual({ error: "e-mail schedules failed" });
    expect(await draftsOf(w.org)).toEqual([]);
    h.absent = false;
    await sql("update public.email_schedules set enabled = false where id = $1", [w.sched]);
  });

  it("a schedule that is switched off is not run by the cron", async () => {
    const w = await seed("off");
    await sql("update public.email_schedules set enabled = false where id = $1", [w.sched]);
    const res = await call("daily", withSecret);
    expect(res.json.emailSchedules).toMatchObject({ schedules: 0, drafted: 0 });
    expect(await draftsOf(w.org)).toEqual([]);
  });
});
