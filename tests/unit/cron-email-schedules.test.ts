import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const reportServerError = vi.fn(async (input: { route: string; error: Error; source?: string }) => ({ sent: false, reason: input.route ? "disabled" : "disabled" }));
const sendCompanyEmail = vi.fn();
let admin: unknown;
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => admin }));
vi.mock("@/lib/server/error-alert", () => ({ reportServerError }));
vi.mock("@/lib/email/send-company-email", () => ({ sendCompanyEmail: (...args: unknown[]) => sendCompanyEmail(...args) }));

import { FakeDb } from "../support/fake-db";

const SECRET = "test-only-cron-secret-0123456789";
const withSecret = { authorization: `Bearer ${SECRET}` };
const call = async (headers: Record<string, string> = {}) => {
  const { GET } = await import("@/app/api/cron/email-schedules/route");
  return GET(new Request("https://example.test/api/cron/email-schedules", { headers }));
};

let logs: string[];
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T09:05:00Z")); // Monday, five past nine, London (GMT)
  sendCompanyEmail.mockResolvedValue({ ok: true, mode: "sent", provider: "mock" });
  rpcFails = () => false;
  logs = [];
  for (const level of ["log", "error", "warn"] as const) vi.spyOn(console, level).mockImplementation((...args) => void logs.push(args.map(String).join(" ")));
});
afterEach(() => { vi.useRealTimers(); });

const invoice = (id: string, org: string, extra: Record<string, unknown> = {}) => ({
  id, organization_id: org, invoice_ref: `INV-${id}`, customer: "Acme", total: 100, amount_paid: 0, credited_amount: 0, refunded_amount: 0, status: "sent", due_date: "2026-10-01", payment_unverified: false, ...extra,
});
/** 138: the scheduled reminders only DRAFT, through public.chase_create_draft (here a stand-in that records the draft once per step). */
type ChaseDb = FakeDb & { rpc: ReturnType<typeof vi.fn> };
let rpcFails: (args: Record<string, unknown>) => boolean = () => false;
const withRpc = (db: FakeDb): ChaseDb => Object.assign(db, {
  rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name !== "chase_create_draft") return { data: null, error: { code: "PGRST202" } };
    if (rpcFails(args)) return { data: null, error: { code: "XX000", message: `failed for ${String(args.p_to)}` } };
    if (db.rows("chase_sends").some((r) => r.invoice_id === args.p_invoice && r.step_id === args.p_step)) return { data: { created: false, reason: "step_done" }, error: null };
    const history = `h-${String(args.p_invoice)}`;
    db.rows("chase_sends").push({ organization_id: args.p_org, invoice_id: args.p_invoice, step_id: args.p_step, offset_days: 7, draft_history_id: history });
    db.rows("email_history").push({ id: history, organization_id: args.p_org, to_email: args.p_to, status: "drafted" });
    return { data: { created: true, history_id: history }, error: null };
  }),
});
const world = () => withRpc(new FakeDb({
  organizations: [{ id: "a", name: "Alpha", status: "active" }, { id: "b", name: "Beta", status: "active" }, { id: "c", name: "Gamma", status: "paused" }],
  email_schedules: [
    { id: "sa", organization_id: "a", kind: "invoice_reminder", enabled: true, frequency: "daily", weekday: null, time_of_day: "08:00", run_at: null, timezone: "Europe/London", recipients: null, last_run_at: null, updated_at: "2026-10-01T00:00:00Z" },
    { id: "sb", organization_id: "b", kind: "invoice_reminder", enabled: true, frequency: "daily", weekday: null, time_of_day: "08:00", run_at: null, timezone: "Europe/London", recipients: null, last_run_at: null, updated_at: "2026-10-01T00:00:00Z" },
    { id: "sc", organization_id: "c", kind: "invoice_reminder", enabled: true, frequency: "daily", weekday: null, time_of_day: "08:00", run_at: null, timezone: "Europe/London", recipients: null, last_run_at: null, updated_at: "2026-10-01T00:00:00Z" },
    { id: "sd", organization_id: "a", kind: "timesheet", enabled: false, frequency: "weekly", weekday: 1, time_of_day: "09:00", run_at: null, timezone: "Europe/London", recipients: null, last_run_at: null, updated_at: "2026-10-01T00:00:00Z" },
  ],
  invoices: [invoice("1", "a"), invoice("2", "b"), invoice("3", "c")],
  customers: [{ id: "ca", organization_id: "a", name: "Acme", email: "acme@a.test", contact_name: null }, { id: "cb", organization_id: "b", name: "Acme", email: "acme@b.test", contact_name: null }, { id: "cc", organization_id: "c", name: "Acme", email: "acme@c.test", contact_name: null }],
  chase_steps: [{ id: "a7", organization_id: "a", offset_days: 7, tone: "friendly" }, { id: "b7", organization_id: "b", offset_days: 7, tone: "friendly" }, { id: "c7", organization_id: "c", offset_days: 7, tone: "friendly" }],
  chase_pauses: [], chase_sends: [], email_history: [], jobs: [], purchase_orders: [], email_templates: [],
}));

describe("GET /api/cron/email-schedules: who may call it", () => {
  it.each([
    ["no Authorization header", {}],
    ["a wrong secret", { authorization: "Bearer wrong-secret-wrong-secret" }],
    ["a prefix of the secret", { authorization: `Bearer ${SECRET.slice(0, -1)}` }],
    ["the secret without Bearer", { authorization: SECRET }],
    ["the secret in another header", { "x-cron-secret": SECRET }],
  ])("401 with %s, and nothing is read or sent", async (_name, headers) => {
    admin = world();
    const res = await call(headers);
    expect(res.status).toBe(401);
    expect((admin as FakeDb).log).toEqual([]);
    expect(sendCompanyEmail).not.toHaveBeenCalled();
    expect(JSON.stringify(await res.json())).not.toContain(SECRET);
  });

  it.each([["unset", undefined], ["empty", ""], ["too short", "short"]])("401 for every call when CRON_SECRET is %s (never open by default)", async (_name, value) => {
    admin = world();
    vi.stubEnv("CRON_SECRET", value as string);
    for (const headers of [withSecret, { authorization: "Bearer " }, {}]) expect((await call(headers)).status).toBe(401);
    expect(sendCompanyEmail).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/email-schedules: the run", () => {
  it("drafts (never sends) the due reminders of active companies only, and a second call later drafts nothing more", async () => {
    const db = world();
    admin = db;
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ schedules: 2, due: 2, ran: 2, emails: 0, drafted: 2, failed: 0, errors: 0 });
    expect(sendCompanyEmail).not.toHaveBeenCalled();
    expect(db.rpc.mock.calls.map((c) => [c[1].p_org, c[1].p_to, c[1].p_user])).toEqual([["a", "acme@a.test", null], ["b", "acme@b.test", null]]);
    expect(db.rows("email_history").map((r) => [r.organization_id, r.status])).toEqual([["a", "drafted"], ["b", "drafted"]]);
    expect(db.rows("email_schedule_runs").map((r) => [r.schedule_id, r.period_key, r.sent_count, r.error])).toEqual([["sa", "2026-10-26", 0, null], ["sb", "2026-10-26", 0, null]]);
    expect(db.rows("email_schedules").find((r) => r.id === "sa")!.last_run_at).toBe("2026-10-26T09:05:00.000Z");

    vi.setSystemTime(new Date("2026-10-26T09:20:00Z"));
    expect(await (await call(withSecret)).json()).toMatchObject({ due: 2, ran: 0, emails: 0, drafted: 0 });
    // The next day's period: the 7-day step is already drafted for each invoice, so nothing new.
    vi.setSystemTime(new Date("2026-10-27T09:05:00Z"));
    expect(await (await call(withSecret)).json()).toMatchObject({ due: 2, ran: 2, emails: 0, drafted: 0 });
    expect(db.rows("chase_sends")).toHaveLength(2);
    expect(sendCompanyEmail).not.toHaveBeenCalled();
  });

  it("at 07:30 the schedule's previous slot (yesterday 08:00, 23.5 h ago) is still inside the catch-up window", async () => {
    admin = world();
    vi.setSystemTime(new Date("2026-10-26T07:30:00Z"));
    const body = await (await call(withSecret)).json();
    expect(body.ran).toBe(2);
    expect((admin as FakeDb).rows("email_schedule_runs").every((r) => r.period_key === "2026-10-25")).toBe(true);
  });

  it("one company's failure never stops the others and never makes the route throw", async () => {
    const db = world();
    admin = db;
    rpcFails = (args) => args.p_org === "a";
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ran: 2, emails: 0, drafted: 1, failed: 1 });
    expect(db.rows("email_schedule_runs").find((r) => r.schedule_id === "sa")!.error).toBe("1 chase draft not made (XX000)");
    expect(db.rows("email_schedule_runs").find((r) => r.schedule_id === "sb")!.error).toBeNull();
    expect(logs.join("\n")).not.toContain("acme@a.test");
  });

  it("a failed draft is tried again on a later call, and only what is left is drafted", async () => {
    const db = world();
    admin = db;
    let first = true;
    rpcFails = (args) => { if (args.p_org === "a" && first) { first = false; return true; } return false; };
    await call(withSecret);
    expect(db.rows("chase_sends").map((r) => r.invoice_id)).toEqual(["2"]);
    vi.setSystemTime(new Date("2026-10-26T09:20:00Z"));
    expect(await (await call(withSecret)).json()).toMatchObject({ ran: 1, emails: 0, drafted: 1 });
    expect(db.rows("chase_sends").map((r) => r.invoice_id).sort()).toEqual(["1", "2"]);
    expect(sendCompanyEmail).not.toHaveBeenCalled();
  });

  it("answers 200 skipped while migration 108 is not applied", async () => {
    const db = new FakeDb();
    db.failing.email_schedules = { code: "PGRST205", message: "Could not find the table 'public.email_schedules' in the schema cache" };
    admin = db;
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: "database update 108 not applied", ran: 0 });
    expect(sendCompanyEmail).not.toHaveBeenCalled();
    expect(reportServerError).toHaveBeenCalledTimes(1); // sm-a: a missing critical migration is alerted once, the 200 is kept
  });

  it("does nothing, quietly, until a schedule is enabled", async () => {
    const db = world();
    db.tables.email_schedules.forEach((r) => { r.enabled = false; });
    admin = db;
    expect(await (await call(withSecret)).json()).toMatchObject({ schedules: 0, ran: 0, emails: 0 });
    expect(sendCompanyEmail).not.toHaveBeenCalled();
  });

  it("a read failure (not a missing table) is reported and answered 500 with no detail", async () => {
    const db = new FakeDb();
    db.failing.email_schedules = { code: "XX000", message: "secret internal detail" };
    admin = db;
    const res = await call(withSecret);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret internal detail");
    expect(reportServerError).toHaveBeenCalledTimes(1);
    expect(reportServerError.mock.calls[0][0]).toMatchObject({ route: "/api/cron/email-schedules", source: "cron" });
  });

  it("no service client is a reported 500", async () => {
    admin = null;
    expect((await call(withSecret)).status).toBe(500);
    expect(reportServerError).toHaveBeenCalledTimes(1);
  });
});
