/**
 * E2: the overdue-invoice chasing rules of the EXISTING chase code, proved on a disposable loopback PostgreSQL with all migrations,
 * the 138 release and the real SQL functions. The app code under test is the real one (lib/email/chase/run.ts, lib/email/schedules/*,
 * app/api/chase/run, app/api/chase/approve, lib/email/chase/approve.ts, lib/email/send-company-email.ts); only three things are stood in:
 *   - the supabase-js client: tests/support/e2-pg-client.ts runs the same queries as real SQL, as service_role / authenticated with
 *     the person's claims (row security and function grants are the database's own);
 *   - the session lookup of requireProfile (the routes are called in-process with the office person's database session);
 *   - the provider transport: the Resend client is replaced by a recorder, so no provider is ever called. All addresses are .invalid.
 *
 *   R1 never chased: paid, credited, fully credited, disputed (a pause), paused, draft, void, written off, cancelled, payment to
 *      confirm, open payment claim: by the scheduled pass body and by POST /api/chase/run.
 *   R2 part paid / part credited are chased with the correct outstanding balance in the draft.
 *   R3 only drafts: nothing e-mailed, no provider call, until a person approves.
 *   R4 each step once per invoice: reruns, a retry after a failure (before and after the commit), two passes at once; an uncertain
 *      send is not re-sent and is visible.
 *   R5 missing provider keys fail safe with an honest status.
 *   R6 audit rows for the draft, the approval, the send and the failure.
 */
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: { admin: null as unknown, user: null as unknown, organizationId: "", userId: "", support: false, adminCalls: 0 },
  transport: { calls: [] as Array<{ to: string[]; subject: string; text: string }>, outcome: "accepted" as "accepted" | "failed" | "unknown", throws: false },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => { h.state.adminCalls += 1; return h.state.admin; } }));
vi.mock("@/lib/server/error-alert", () => ({ reportServerError: async () => ({ sent: false, reason: "disabled" }) }));
vi.mock("@/lib/server/auth", () => {
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return {
    sameOrigin: () => true,
    forbiddenOrigin: () => json({ error: "Forbidden" }, 403),
    jsonError: (error: string, status: number) => json({ error }, status),
    isErrorResponse: (value: unknown) => value instanceof Response,
    readJson: async (request: Request) => ({ ok: true as const, data: await request.json() }),
    requireProfile: async () => ({ supabase: h.state.user, user: { id: h.state.userId }, profile: { organization_id: h.state.organizationId }, session: h.state.support ? { support: true } : null }),
  };
});
// The real selection of the provider and the real ledger; only the Resend transport is a recorder (no provider is ever called).
vi.mock("@/lib/email/send-company-email", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/email/send-company-email")>();
  const inject = (deps: object = {}) => ({
    getToken: async () => null,
    providers: {
      resend: () => ({
        name: "resend" as const,
        send: async (email: { to: string[]; subject: string; text: string }) => {
          h.transport.calls.push({ to: email.to, subject: email.subject, text: email.text });
          if (h.transport.throws) throw new Error("network down");
          return h.transport.outcome === "accepted" ? { outcome: "accepted" as const, providerMessageId: "msg-stub-1", detail: "stub" }
            : { outcome: h.transport.outcome, detail: "stub" };
        },
      }),
    },
    ...deps,
  });
  return {
    ...real,
    selectProvider: (org: string, deps?: object) => real.selectProvider(org, inject(deps)),
    sendCompanyEmail: (input: Parameters<typeof real.sendCompanyEmail>[0], deps?: object) => real.sendCompanyEmail(input, inject(deps)),
  };
});

import { StoreError } from "@/lib/email/schedules/store";
import { runInvoiceReminders } from "@/lib/email/schedules/reminders";
import type { EmailScheduleRow } from "@/lib/email/schedules/store";

import { closeE2Pool, e2Pool, pgClient } from "../support/e2-pg-client";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";
import { verifyBackendIdentity } from "../support/fixtures";

const run = randomUUID().slice(0, 8);
let counter = 0;
const evidence = (label: string, value: unknown) => console.log(`E2-EVIDENCE ${label} ${JSON.stringify(value)}`);

const sql = async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) => (await e2Pool().query(text, params)).rows as T[];
const plusDays = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const dbToday = async () => (await sql<{ d: string }>("select ((now() at time zone 'Europe/London')::date)::text as d"))[0].d;

type Person = { id: string; email: string; session: string };
const orgs: string[] = [];
const people: string[] = [];

async function makeOrg(label: string) {
  const id = randomUUID();
  counter += 1;
  await sql("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [id, `E2 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-e2-${label}-${counter}`]);
  orgs.push(id);
  return id;
}
async function makePerson(org: string, name: string, role: string): Promise<Person> {
  counter += 1;
  const p = { id: randomUUID(), email: `${name}-${counter}.${run}@e2.invalid`, session: randomUUID() };
  people.push(p.id);
  await sql("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await sql("insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, $3, $4, $5, true, false)", [p.id, p.email, `Person ${counter}`, role, org]);
  await sql("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, $3, true)", [p.id, org, role]);
  await sql("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await sql("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
  return p;
}
const claimsOf = (p: Person) => ({ sub: p.id, role: "authenticated", aud: "authenticated", aal: "aal2", email: p.email, session_id: p.session });

type World = { org: string; office: Person; admin: Person; steps: Record<"b3" | "f7" | "m14" | "x30", string>; today: string };
async function world(label: string, stepOffsets = true): Promise<World> {
  const org = await makeOrg(label);
  const office = await makePerson(org, "office", "office");
  const admin = await makePerson(org, "admin", "admin");
  const steps = {} as World["steps"];
  if (stepOffsets) {
    for (const [k, off, tone] of [["b3", -3, "before_due"], ["f7", 7, "friendly"], ["m14", 14, "firm"], ["x30", 30, "final"]] as const) {
      steps[k] = (await sql<{ id: string }>("insert into public.chase_steps (organization_id, offset_days, tone) values ($1, $2, $3) returning id", [org, off, tone]))[0].id;
    }
  }
  return { org, office, admin, steps, today: await dbToday() };
}
async function customer(w: World, name: string) {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@${run}.invalid`;
  const id = (await sql<{ id: string }>("insert into public.customers (organization_id, name, email) values ($1, $2, $3) returning id", [w.org, name, email]))[0].id;
  return { id, name, email };
}
async function invoice(w: World, cust: string, extra: Record<string, unknown> = {}) {
  counter += 1;
  const values: Record<string, unknown> = { invoice_ref: `INV-${run}-${counter}`, customer: cust, total: 120, amount_paid: 0, credited_amount: 0, refunded_amount: 0, status: "sent", due_date: plusDays(w.today, -20), payment_unverified: false, ...extra };
  const cols = Object.keys(values);
  return (await sql<{ id: string }>(`insert into public.invoices (organization_id, ${cols.join(", ")}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) returning id`, [w.org, ...Object.values(values)]))[0].id;
}
const drafts = (invoiceId: string) => sql<{ status: string; body: string; subject: string; to_email: string; drafted_by: string | null }>("select status, body, subject, to_email, drafted_by from public.email_history where related_to_id = $1 order by drafted_at, id", [invoiceId]);
const chaseRows = (invoiceId: string) => sql<{ step_id: string; status: string; offset_days: number }>("select step_id, status, offset_days from public.chase_sends where invoice_id = $1", [invoiceId]);
const audit = (invoiceId: string) => sql<{ action: string; actor_user_id: string | null; metadata: Record<string, unknown> }>("select action, actor_user_id, metadata from security_audit.audit_log where entity_id = $1 and action like 'chase_%' order by created_at, id", [invoiceId]);
const allDrafts = async (org: string) => (await sql<{ n: number }>("select count(*)::int as n from public.email_history where organization_id = $1", [org]))[0].n;

function actAs(w: World, opts: { admin?: boolean } = {}) {
  const counting = (client: ReturnType<typeof pgClient>) => ({
    from: (t: string) => { h.state.adminCalls += 1; return client.from(t); },
    rpc: (f: string, a?: Record<string, unknown>) => { h.state.adminCalls += 1; return client.rpc(f, a); },
  });
  const who = opts.admin ? w.admin : w.office;
  h.state.admin = counting(pgClient({ role: "service_role" }));
  h.state.user = pgClient({ role: "authenticated", claims: claimsOf(who) });
  h.state.organizationId = w.org;
  h.state.userId = who.id;
  h.state.support = false;
  h.state.adminCalls = 0;
}

const routeRun = async (w: World) => {
  actAs(w);
  const { POST } = await import("@/app/api/chase/run/route");
  const res = await POST(new Request("http://localhost/api/chase/run", { method: "POST" }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const routeApprove = async (w: World, draftId: string, edit?: { subject: string; body: string }) => {
  actAs(w);
  const row = (await sql<{ subject: string; body: string; to_email: string }>("select subject, body, to_email from public.email_history where id = $1", [draftId]))[0];
  const { POST } = await import("@/app/api/chase/approve/route");
  const res = await POST(new Request("http://localhost/api/chase/approve", { method: "POST", body: JSON.stringify({ history_id: draftId, expected_to: row.to_email, expected_subject: edit?.subject ?? row.subject, expected_body: edit?.body ?? row.body }) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
/** The scheduled pass's body for one company (what the cron runs per schedule), through the real runInvoiceReminders. */
const passRun = async (w: World, deps: Parameters<typeof runInvoiceReminders>[4] = {}) => {
  actAs(w);
  const schedule = { id: randomUUID(), organization_id: w.org, kind: "invoice_reminder", enabled: true, frequency: "daily", weekday: null, time_of_day: "08:00", run_at: null, timezone: "Europe/London", recipients: null, last_run_at: null } as EmailScheduleRow;
  return runInvoiceReminders(h.state.admin as never, schedule, { at: new Date(), periodKey: "x" }, new Date(), deps);
};

beforeAll(async () => {
  const identity = await verifyBackendIdentity();
  evidence("database", { host: identity.database.host, port: identity.database.port, name: identity.database.name, version: identity.database.serverVersion, organizations: identity.organizations });
  const loopback = await sql<{ a: string; p: number; n: string }>("select host(inet_server_addr()) as a, inet_server_port() as p, current_database() as n");
  // The client connects to loopback (asserted below); inside the Supabase container the server sees its own private address.
  expect(loopback[0].a).toMatch(/^(127\.0\.0\.1|::1|(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.).*)$/);
  expect(["127.0.0.1", "localhost"]).toContain(identity.database.host);
});
beforeEach(() => {
  h.transport.calls.length = 0;
  h.transport.outcome = "accepted";
  h.transport.throws = false;
  vi.stubEnv("RESEND_API_KEY", "re_e2_invalid_key");
  vi.stubEnv("EMAIL_FROM", "Tolra <noreply@sender.invalid>");
  vi.stubEnv("EMAIL_PROVIDER", "");
  vi.stubEnv("VERCEL_ENV", "");
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => {
  const db = await e2Pool().connect();
  try {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    await db.query("delete from public.email_schedule_runs where schedule_id in (select id from public.email_schedules where organization_id = any($1))", [orgs]);
    for (const t of ["public.email_schedules", "public.chase_sends", "public.chase_pauses", "public.chase_steps", "security_audit.company_email_sends", "public.email_history", "public.invoices",
      "public.customers", "security_audit.audit_log", "public.organization_members", "public.user_profiles"]) {
      await db.query(`delete from ${t} where organization_id = any($1)`, [orgs]);
    }
    await db.query("delete from security_audit.session_company where user_id = any($1)", [people]);
    await db.query("delete from public.organizations where id = any($1)", [orgs]);
    await db.query("commit");
    await db.query("delete from auth.users where id = any($1)", [people]);
  } finally {
    db.release();
    await closeE2Pool();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe.each([["the scheduled pass (runInvoiceReminders)", "pass"], ["POST /api/chase/run", "route"]] as const)("R1 never chased, via %s", (_name, via) => {
  it("paid, credited, fully credited, disputed, paused, draft, void, written off, cancelled, payment to confirm, payment claimed: no draft; the owed invoices are drafted", async () => {
    const w = await world(`r1-${via}`);
    const make = async (kind: string, extra: Record<string, unknown> = {}) => {
      const c = await customer(w, `Cust ${kind}`);
      return { kind, id: await invoice(w, c.name, extra), customer: c };
    };
    const owed = [await make("owed-control"), await make("owed-partial", { status: "partial", amount_paid: 50 })];
    const never = [
      await make("paid", { status: "paid", amount_paid: 120 }),
      await make("credited-status", { status: "credited" }),
      await make("fully-credited", { credited_amount: 120 }),
      await make("over-credited", { credited_amount: 130 }),
      await make("paid-plus-credited-to-nil", { amount_paid: 70, credited_amount: 50 }),
      await make("draft", { status: "draft", invoice_ref: null }),
      await make("void", { status: "void" }),
      await make("voided", { status: "voided" }),
      await make("written-off", { status: "written_off" }),
      await make("cancelled", { status: "cancelled" }),
      await make("payment-to-confirm", { payment_unverified: true }),
      await make("not-yet-due", { due_date: plusDays(w.today, 10) }),
      await make("no-due-date", { due_date: null }),
      await make("claimed-paid"),
      await make("disputed-invoice-pause"),
      await make("disputed-customer-pause"),
      await make("paused-until-future"),
    ];
    // An open payment claim, made by the office person the way the app does (database function, row security on).
    const claimed = never.find((n) => n.kind === "claimed-paid")!;
    expect((await pgClient({ role: "authenticated", claims: claimsOf(w.office) }).rpc("mark_payment_claimed", { p_invoice: claimed.id, p_source: "manual", p_evidence: "Customer says paid", p_message_id: null })).error).toBeNull();
    // "Disputed": the app has no disputed status; a dispute is a chase pause with a reason (invoice, or the whole customer).
    const byKind = (k: string) => never.find((n) => n.kind === k)!;
    await sql("insert into public.chase_pauses (organization_id, invoice_id, reason) values ($1, $2, 'Disputed: customer queries the work')", [w.org, byKind("disputed-invoice-pause").id]);
    await sql("insert into public.chase_pauses (organization_id, customer_id, reason) values ($1, $2, 'Disputed: on stop')", [w.org, byKind("disputed-customer-pause").customer.id]);
    await sql("insert into public.chase_pauses (organization_id, invoice_id, reason, paused_until) values ($1, $2, 'Promised payment', $3)", [w.org, byKind("paused-until-future").id, plusDays(w.today, 5)]);

    const before = { total: (await sql("select id, total, amount_paid, credited_amount, status from public.invoices where organization_id = $1 order by id", [w.org])) };
    const result = via === "route" ? await routeRun(w) : { status: 200, json: await passRun(w) as unknown as Record<string, unknown> };
    evidence(`R1 ${via} result`, result.json);
    expect(result.status).toBe(200);
    expect(result.json.drafted).toBe(2);
    expect(result.json.failed).toBe(0);
    expect(result.json.sent ?? 0).toBe(0);
    for (const n of never) {
      expect(await chaseRows(n.id), `${n.kind} must not be chased`).toEqual([]);
      expect(await drafts(n.id), `${n.kind} must have no draft`).toEqual([]);
      expect(await audit(n.id), `${n.kind} must have no chase audit`).toEqual([]);
    }
    for (const o of owed) {
      expect((await chaseRows(o.id)).map((r) => r.status), `${o.kind} is chased`).toEqual(["drafted"]);
      expect((await drafts(o.id)).map((r) => r.to_email)).toEqual([o.customer.email]);
    }
    expect(await allDrafts(w.org)).toBe(2);
    // The money rows are not touched by chasing.
    expect(await sql("select id, total, amount_paid, credited_amount, status from public.invoices where organization_id = $1 order by id", [w.org])).toEqual(before.total);
    const reasons = (result.json.reasons ?? {}) as Record<string, number>;
    if (via === "route") expect(reasons).toMatchObject({ invoice_paused: 2, customer_paused: 1 });
  });
});

describe("R2 part paid and part credited: the draft states the outstanding balance", () => {
  it.each([
    ["part paid", { status: "partial", total: 120, amount_paid: 50 }, "£70.00"],
    ["part credited", { total: 120, credited_amount: 30 }, "£90.00"],
    ["part paid and part credited", { status: "partial", total: 100.1, amount_paid: 33.37, credited_amount: 20 }, "£46.73"],
    ["paid in pence", { status: "partial", total: 1000, amount_paid: 0.01 }, "£999.99"],
    ["refunded back on", { status: "partial", total: 120, amount_paid: 120, refunded_amount: 40 }, "£40.00"],
  ] as const)("%s", async (name, extra, balanceText) => {
    const w = await world(`r2-${name.replace(/\W+/g, "")}`);
    const c = await customer(w, "Balance Co");
    const inv = await invoice(w, c.name, extra);
    const before = await sql("select total, amount_paid, credited_amount, refunded_amount from public.invoices where id = $1", [inv]);
    const result = await routeRun(w);
    expect(result.json).toMatchObject({ drafted: 1, failed: 0 });
    const [d] = await drafts(inv);
    evidence(`R2 ${name}`, { balanceText, subject: d.subject, bodyLines: d.body.split("\n").filter((l) => /£/.test(l)) });
    expect(d.body).toContain(balanceText);
    const face = `£${Number(extra.total).toLocaleString("en-GB", { minimumFractionDigits: 2 })}`;
    if (balanceText !== face) expect(d.body, "the face total must not be presented as what is owed").not.toContain(face);
    expect(await sql("select total, amount_paid, credited_amount, refunded_amount from public.invoices where id = $1", [inv])).toEqual(before);
  });
});

describe("R3 drafts only: nothing is e-mailed before a person approves", () => {
  it("a pass with a configured provider makes drafts and calls no provider and no network; approval sends exactly once to the customer", async () => {
    const w = await world("r3");
    const c = await customer(w, "Draft Co");
    const inv = await invoice(w, c.name);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const passed = await passRun(w);
    evidence("R3 pass result", passed);
    expect(passed).toMatchObject({ sent: 0, drafted: 1, failed: 0 });
    expect(h.transport.calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await sql("select status from public.email_history where related_to_id = $1", [inv])).toEqual([{ status: "drafted" }]);
    expect(await sql("select count(*)::int as n from security_audit.company_email_sends where organization_id = $1", [w.org])).toEqual([{ n: 0 }]);
    expect(await sql("select count(*)::int as n from public.email_history where organization_id = $1 and status in ('sent_via_system','sending','sent_manually')", [w.org])).toEqual([{ n: 0 }]);

    const [draft] = await sql<{ id: string }>("select id from public.email_history where related_to_id = $1", [inv]);
    const approved = await routeApprove(w, draft.id);
    evidence("R3 approve result", approved);
    expect(approved.status).toBe(200);
    expect(approved.json).toMatchObject({ status: "sent", recorded: true });
    expect(h.transport.calls).toHaveLength(1);
    expect(h.transport.calls[0].to).toEqual([c.email]);
    expect(await chaseRows(inv)).toMatchObject([{ status: "sent" }]);
    fetchSpy.mockRestore();
  });

  it("the route /api/chase/run never sends either: even with a provider configured the transport is untouched", async () => {
    const w = await world("r3b");
    const c = await customer(w, "Route Co");
    await invoice(w, c.name);
    const result = await routeRun(w);
    expect(result.json).toMatchObject({ drafted: 1 });
    expect(h.transport.calls).toEqual([]);
  });
});

describe("R4 each step at most once per invoice", () => {
  it("reruns (pass, pass, route) make no more drafts; the unique (invoice, step) holds in the database", async () => {
    const w = await world("r4a");
    const c = await customer(w, "Rerun Co");
    const ids = [await invoice(w, c.name), await invoice(w, c.name, { due_date: plusDays(w.today, -35) }), await invoice(w, c.name, { due_date: plusDays(w.today, -8) })];
    const first = await passRun(w);
    const second = await passRun(w);
    const third = (await routeRun(w)).json;
    evidence("R4 reruns", { first, second, third });
    expect(first.drafted).toBe(3);
    expect(second.drafted).toBe(0);
    expect(third.drafted).toBe(0);
    // 20 days late -> 14-day step; 35 days -> the 30-day final only (not 7, 14 and 30); 8 days -> the 7-day step.
    const steps = await Promise.all(ids.map(async (id) => (await chaseRows(id)).map((r) => r.offset_days)));
    expect(steps).toEqual([[14], [30], [7]]);
    expect(await sql("select invoice_id, step_id, count(*)::int as n from public.chase_sends where organization_id = $1 group by 1, 2 having count(*) > 1", [w.org])).toEqual([]);
    expect(await allDrafts(w.org)).toBe(3);
  });

  it("a later day: the next step is drafted once and the earlier step is not repeated (history from the database)", async () => {
    const w = await world("r4b");
    const c = await customer(w, "Escalate Co");
    const inv = await invoice(w, c.name, { due_date: plusDays(w.today, -8) }); // the 7-day step
    expect((await passRun(w)).drafted).toBe(1);
    await sql("update public.invoices set due_date = $2 where id = $1", [inv, plusDays(w.today, -15)]); // two weeks later: the 14-day step
    expect((await passRun(w)).drafted).toBe(1);
    expect((await passRun(w)).drafted).toBe(0);
    expect((await chaseRows(inv)).map((r) => r.offset_days).sort((a, b) => a - b)).toEqual([7, 14]);
  });

  it("a failure BEFORE the draft is committed: the retry drafts exactly the missing one", async () => {
    const w = await world("r4c");
    const c = await customer(w, "Retry Co");
    const ids = [await invoice(w, c.name), await invoice(w, c.name), await invoice(w, c.name)];
    let n = 0;
    const flaky = async (admin: Parameters<NonNullable<NonNullable<Parameters<typeof runInvoiceReminders>[4]>["createDraft"]>>[0], args: Parameters<NonNullable<NonNullable<Parameters<typeof runInvoiceReminders>[4]>["createDraft"]>>[1]) => {
      n += 1;
      if (n === 2) throw new StoreError("create chase draft", "57014");
      const { data, error } = await (admin as unknown as ReturnType<typeof pgClient>).rpc("chase_create_draft", { p_org: args.organizationId, p_invoice: args.invoiceId, p_step: args.stepId, p_to: args.to, p_to_name: args.toName, p_subject: args.subject, p_body: args.body, p_user: args.userId });
      if (error) throw new StoreError("create chase draft", error.code);
      const a = data as { created?: boolean; history_id?: string; reason?: string };
      return a.created ? { created: true as const, history_id: a.history_id as string } : { created: false as const, reason: a.reason ?? "unknown" };
    };
    const first = await passRun(w, { createDraft: flaky });
    evidence("R4 failed pass", first);
    expect(first).toMatchObject({ drafted: 2, failed: 1, sent: 0 });
    expect(first.error).toContain("1 chase draft not made");
    expect(first.retryable).toBe(true);
    const retry = await passRun(w);
    expect(retry.drafted).toBe(1);
    for (const id of ids) expect(await drafts(id)).toHaveLength(1);
    expect(await allDrafts(w.org)).toBe(3);
  });

  it("a failure AFTER the draft was committed (the answer is lost): the retry makes no duplicate", async () => {
    const w = await world("r4d");
    const c = await customer(w, "Lost Answer Co");
    const inv = await invoice(w, c.name);
    const lost = async (admin: unknown, args: { organizationId: string; invoiceId: string; stepId: string; to: string; toName: string | null; subject: string; body: string; userId: string | null }) => {
      await (admin as ReturnType<typeof pgClient>).rpc("chase_create_draft", { p_org: args.organizationId, p_invoice: args.invoiceId, p_step: args.stepId, p_to: args.to, p_to_name: args.toName, p_subject: args.subject, p_body: args.body, p_user: args.userId });
      throw new StoreError("create chase draft", "08006");
    };
    const first = await passRun(w, { createDraft: lost as never });
    expect(first).toMatchObject({ drafted: 0, failed: 1 });
    expect(await drafts(inv)).toHaveLength(1); // it was made
    const retry = await passRun(w);
    evidence("R4 retry after lost answer", retry);
    expect(retry).toMatchObject({ drafted: 0, failed: 0 });
    expect(await drafts(inv)).toHaveLength(1);
    expect(await chaseRows(inv)).toHaveLength(1);
  });

  it("two passes at the same moment (the button and the schedule): one draft per invoice", async () => {
    const w = await world("r4e");
    const c = await customer(w, "Race Co");
    const ids = await Promise.all([1, 2, 3, 4].map(() => invoice(w, c.name)));
    const [a, b] = await Promise.all([passRun(w), routeRun(w)]);
    evidence("R4 concurrent", { pass: a, route: b.json });
    expect((a.drafted) + (b.json.drafted as number)).toBe(4);
    for (const id of ids) expect(await drafts(id)).toHaveLength(1);
    expect(await sql("select invoice_id, step_id, count(*)::int as n from public.chase_sends where organization_id = $1 group by 1, 2 having count(*) > 1", [w.org])).toEqual([]);
  });

  it("a discarded draft is not made again by the next pass (the step is used once)", async () => {
    const w = await world("r4f");
    const c = await customer(w, "Skip Co");
    const inv = await invoice(w, c.name);
    expect((await passRun(w)).drafted).toBe(1);
    await sql("delete from public.email_history where related_to_id = $1", [inv]);
    expect((await passRun(w)).drafted).toBe(0);
    expect(await drafts(inv)).toEqual([]);
  });

  it("an uncertain send (provider error after the claim) is not sent again, not drafted again, and shows as Needs checking", async () => {
    const w = await world("r4g");
    const c = await customer(w, "Unsure Co");
    const inv = await invoice(w, c.name);
    await passRun(w);
    const [draft] = await sql<{ id: string }>("select id from public.email_history where related_to_id = $1", [inv]);
    h.transport.outcome = "unknown";
    const first = await routeApprove(w, draft.id);
    evidence("R4 uncertain first approve", first);
    expect(first.status).toBe(502);
    expect(String(first.json.error)).toMatch(/needs checking/i);
    expect(h.transport.calls).toHaveLength(1);
    expect(await sql("select status from public.email_history where id = $1", [draft.id])).toEqual([{ status: "unknown" }]);
    expect(await sql("select status from security_audit.company_email_sends where organization_id = $1", [w.org])).toEqual([{ status: "unknown" }]);
    // Every retry is refused; the provider is not called again; the next pass does not draft a replacement; the chase stays unsent.
    for (let i = 0; i < 3; i += 1) expect((await routeApprove(w, draft.id)).status).toBe(409);
    expect(h.transport.calls).toHaveLength(1);
    expect((await passRun(w)).drafted).toBe(0);
    expect(await chaseRows(inv)).toMatchObject([{ status: "drafted" }]);
    // Two history rows, both "Needs checking": the draft that was claimed, and the mailer ledger's own row for the attempt (an observation, not a rule).
    expect((await drafts(inv)).map((r) => r.status)).toEqual(["unknown", "unknown"]);
  });

  it("a provider that throws is the same: needs checking, never sent again automatically", async () => {
    const w = await world("r4h");
    const c = await customer(w, "Throw Co");
    const inv = await invoice(w, c.name);
    await passRun(w);
    const [draft] = await sql<{ id: string }>("select id from public.email_history where related_to_id = $1", [inv]);
    h.transport.throws = true;
    const first = await routeApprove(w, draft.id);
    expect(first.status).toBe(502);
    expect(await sql("select status from public.email_history where id = $1", [draft.id])).toEqual([{ status: "unknown" }]);
    h.transport.throws = false;
    expect((await routeApprove(w, draft.id)).status).toBe(409);
    expect(h.transport.calls).toHaveLength(1);
  });

  it("a definite provider refusal releases the draft for a person to retry; the retry is the person's click, with the same reviewed text", async () => {
    const w = await world("r4i");
    const c = await customer(w, "Refused Co");
    const inv = await invoice(w, c.name);
    await passRun(w);
    const [draft] = await sql<{ id: string }>("select id from public.email_history where related_to_id = $1", [inv]);
    h.transport.outcome = "failed";
    const failed = await routeApprove(w, draft.id);
    expect(failed.status).toBe(502);
    expect(await sql("select status from public.email_history where id = $1", [draft.id])).toEqual([{ status: "drafted" }]);
    expect(await chaseRows(inv)).toMatchObject([{ status: "drafted" }]);
    expect((await passRun(w)).drafted).toBe(0); // the pass does not retry it
    expect(h.transport.calls).toHaveLength(1);
  });
});

describe("R5 missing provider keys fail safe", () => {
  const setup = async (label: string) => {
    const w = await world(label);
    const c = await customer(w, "Keys Co");
    const inv = await invoice(w, c.name);
    await passRun(w);
    const [draft] = await sql<{ id: string }>("select id from public.email_history where related_to_id = $1", [inv]);
    const snapshot = async () => ({
      history: await sql("select id, status, subject, body, to_email from public.email_history where organization_id = $1 order by id", [w.org]),
      chase: await sql("select id, status, sent_history_id, approved_by from public.chase_sends where organization_id = $1 order by id", [w.org]),
      ledger: await sql("select count(*)::int as n from security_audit.company_email_sends where organization_id = $1", [w.org]),
      audit: await sql("select action from security_audit.audit_log where organization_id = $1 and action like 'chase_%' order by action", [w.org]),
    });
    return { w, inv, draft, snapshot };
  };

  it.each([
    ["no keys at all", {}],
    ["key without a sender", { RESEND_API_KEY: "re_e2_invalid_key", EMAIL_FROM: "" }],
    ["sender without a key", { RESEND_API_KEY: "", EMAIL_FROM: "Tolra <noreply@sender.invalid>" }],
    ["blank key", { RESEND_API_KEY: "   ", EMAIL_FROM: "Tolra <noreply@sender.invalid>" }],
  ] as const)("%s: 409 no_provider, nothing sent, nothing written, the draft stays", async (_n, env) => {
    const { w, draft, snapshot } = await setup(`r5-${_n.replace(/\W+/g, "")}`);
    vi.stubEnv("RESEND_API_KEY", ""); vi.stubEnv("EMAIL_FROM", "");
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const before = await snapshot();
    const res = await routeApprove(w, draft.id);
    evidence(`R5 ${_n}`, res);
    expect(res.status).toBe(409);
    expect(res.json.status).toBe("no_provider");
    expect(String(res.json.error)).toMatch(/isn't set up/);
    expect(h.transport.calls).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("EMAIL_PROVIDER=mock on a deployment is refused: 503, nothing sent, nothing written", async () => {
    const { w, draft, snapshot } = await setup("r5-mock");
    vi.stubEnv("EMAIL_PROVIDER", "mock"); vi.stubEnv("VERCEL_ENV", "production");
    const before = await snapshot();
    const res = await routeApprove(w, draft.id);
    expect(res.status).toBe(503);
    expect(res.json.status).toBe("refused");
    expect(h.transport.calls).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("the scheduled pass needs no provider keys: with none set it still drafts, and says sent 0", async () => {
    const w = await world("r5-pass");
    const c = await customer(w, "No Keys Co");
    const inv = await invoice(w, c.name);
    vi.stubEnv("RESEND_API_KEY", ""); vi.stubEnv("EMAIL_FROM", "");
    expect(await passRun(w)).toMatchObject({ sent: 0, drafted: 1, failed: 0, error: null });
    expect(await drafts(inv)).toMatchObject([{ status: "drafted" }]);
  });

  it("no service client: /api/chase/run answers 503 and drafts nothing; the pass body cannot run", async () => {
    const w = await world("r5-noservice");
    const c = await customer(w, "No Service Co");
    await invoice(w, c.name);
    actAs(w);
    h.state.admin = null;
    const { POST } = await import("@/app/api/chase/run/route");
    const res = await POST(new Request("http://localhost/api/chase/run", { method: "POST" }));
    expect(res.status).toBe(503);
    expect(await allDrafts(w.org)).toBe(0);
  });

  it("a support session cannot chase or approve", async () => {
    const w = await world("r5-support");
    const c = await customer(w, "Support Co");
    await invoice(w, c.name);
    actAs(w);
    h.state.support = true;
    const { POST } = await import("@/app/api/chase/run/route");
    const res = await POST(new Request("http://localhost/api/chase/run", { method: "POST" }));
    expect(res.status).toBe(403);
    expect(await allDrafts(w.org)).toBe(0);
  });
});

describe("R6 audit rows for the draft, the approval, the send and the failure", () => {
  it("draft by the schedule, draft by a person, the approval and the send; each audited with who and what", async () => {
    const w = await world("r6a");
    const c = await customer(w, "Audit Co");
    const byPass = await invoice(w, c.name);
    await passRun(w);
    const byPerson = await invoice(w, c.name);
    await routeRun(w);
    const draftA = (await audit(byPass));
    const draftB = (await audit(byPerson));
    evidence("R6 draft audit", { byPass: draftA, byPerson: draftB });
    expect(draftA).toMatchObject([{ action: "chase_drafted", actor_user_id: null, metadata: { by: "schedule", tone: "firm", offset_days: 14 } }]);
    expect(draftB).toMatchObject([{ action: "chase_drafted", actor_user_id: w.office.id, metadata: { by: "person" } }]);

    const [draft] = await sql<{ id: string }>("select id from public.email_history where related_to_id = $1", [byPass]);
    const sent = await routeApprove(w, draft.id, undefined);
    expect(sent.status).toBe(200);
    const trail = await audit(byPass);
    evidence("R6 approval audit", trail);
    expect(trail.map((a) => a.action)).toEqual(["chase_drafted", "chase_approved_sent"]);
    expect(trail[1]).toMatchObject({ actor_user_id: w.office.id, metadata: { source: "chase_138" } });
    // The send itself: the ledger row (accepted) and the history row of the sent e-mail.
    expect(await sql("select status from security_audit.company_email_sends where organization_id = $1", [w.org])).toEqual([{ status: "accepted" }]);
    const chase = await sql<{ status: string; approved_by: string; sent_history_id: string }>("select status, approved_by, sent_history_id from public.chase_sends where invoice_id = $1", [byPass]);
    expect(chase).toMatchObject([{ status: "sent", approved_by: w.office.id }]);
    expect(await sql("select status, to_email from public.email_history where id = $1", [chase[0].sent_history_id])).toEqual([{ status: "sent_via_system", to_email: c.email }]);
  });

  it("failures: a refused send and an uncertain send leave a ledger row and a history status; what audit rows exist is recorded", async () => {
    const w = await world("r6b");
    const c = await customer(w, "Fail Audit Co");
    const refused = await invoice(w, c.name);
    const unsure = await invoice(w, c.name);
    await passRun(w);
    const draftOf = async (inv: string) => (await sql<{ id: string }>("select id from public.email_history where related_to_id = $1 and status = 'drafted'", [inv]))[0].id;
    const ids = { refused: await draftOf(refused), unsure: await draftOf(unsure) };
    h.transport.outcome = "failed";
    expect((await routeApprove(w, ids.refused)).status).toBe(502);
    h.transport.outcome = "unknown";
    expect((await routeApprove(w, ids.unsure)).status).toBe(502);
    const ledger = await sql("select status from security_audit.company_email_sends where organization_id = $1 order by status", [w.org]);
    const everything = await sql<{ action: string; entity_table: string }>("select action, entity_table from security_audit.audit_log where organization_id = $1 and (entity_id = any($2) or metadata::text like any($3)) order by created_at, id", [w.org, [refused, unsure], [`%${refused}%`, `%${unsure}%`]]);
    const emailAudit = await sql<{ action: string }>("select action from security_audit.audit_log where organization_id = $1 and entity_table = 'email_history' order by created_at, id", [w.org]);
    evidence("R6 failure trail", { ledger, chaseAudit: everything.map((a) => a.action), emailHistoryAudit: emailAudit.map((a) => a.action) });
    expect(ledger).toEqual([{ status: "failed" }, { status: "unknown" }]);
    expect(await sql("select status from public.email_history where id = any($1) order by status", [[ids.refused, ids.unsure]])).toEqual([{ status: "drafted" }, { status: "unknown" }]);
    // Nothing is recorded as sent or approved for either.
    expect((await audit(refused)).map((a) => a.action)).toEqual(["chase_drafted"]);
    expect((await audit(unsure)).map((a) => a.action)).toEqual(["chase_drafted"]);
  });
});
