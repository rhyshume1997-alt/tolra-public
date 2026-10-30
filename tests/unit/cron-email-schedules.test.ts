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
  logs = [];
  for (const level of ["log", "error", "warn"] as const) vi.spyOn(console, level).mockImplementation((...args) => void logs.push(args.map(String).join(" ")));
});
afterEach(() => { vi.useRealTimers(); });

const invoice = (id: string, org: string, extra: Record<string, unknown> = {}) => ({
  id, organization_id: org, invoice_ref: `INV-${id}`, customer: "Acme", total: 100, amount_paid: 0, credited_amount: 0, refunded_amount: 0, status: "sent", due_date: "2026-10-01", payment_unverified: false, ...extra,
});
const world = () => new FakeDb({
  organizations: [{ id: "a", name: "Alpha", status: "active" }, { id: "b", name: "Beta", status: "active" }, { id: "c", name: "Gamma", status: "paused" }],
  email_schedules: [
    { id: "sa", organization_id: "a", kind: "invoice_reminder", enabled: true, frequency: "daily", weekday: null, time_of_day: "08:00", run_at: null, timezone: "Europe/London", recipients: null, last_run_at: null, updated_at: "2026-10-01T00:00:00Z" },
    { id: "sb", organization_id: "b", kind: "invoice_reminder", enabled: true, frequency: "daily", weekday: null, time_of_day: "08:00", run_at: null, timezone: "Europe/London", recipients: null, last_run_at: null, updated_at: "2026-10-01T00:00:00Z" },
    { id: "sc", organization_id: "c", kind: "invoice_reminder", enabled: true, frequency: "daily", weekday: null, time_of_day: "08:00", run_at: null, timezone: "Europe/London", recipients: null, last_run_at: null, updated_at: "2026-10-01T00:00:00Z" },
    { id: "sd", organization_id: "a", kind: "timesheet", enabled: false, frequency: "weekly", weekday: 1, time_of_day: "09:00", run_at: null, timezone: "Europe/London", recipients: null, last_run_at: null, updated_at: "2026-10-01T00:00:00Z" },
  ],
  invoices: [invoice("1", "a"), invoice("2", "b"), invoice("3", "c")],
  customers: [{ organization_id: "a", name: "Acme", email: "acme@a.test", contact_name: null }, { organization_id: "b", name: "Acme", email: "acme@b.test", contact_name: null }, { organization_id: "c", name: "Acme", email: "acme@c.test", contact_name: null }],
});

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
  it("sends the due reminders of active companies only, and a second call a minute later sends nothing more", async () => {
    const db = world();
    admin = db;
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ schedules: 2, due: 2, ran: 2, emails: 2, drafted: 0, failed: 0, errors: 0 });
    expect(sendCompanyEmail.mock.calls.map((c) => c[0].to)).toEqual([["acme@a.test"], ["acme@b.test"]]);
    expect(sendCompanyEmail.mock.calls.map((c) => c[0].organizationId)).toEqual(["a", "b"]);
    expect(db.rows("email_schedule_runs").map((r) => [r.schedule_id, r.period_key, r.sent_count, r.error])).toEqual([["sa", "2026-10-26", 1, null], ["sb", "2026-10-26", 1, null]]);
    expect(db.rows("email_schedules").find((r) => r.id === "sa")!.last_run_at).toBe("2026-10-26T09:05:00.000Z");

    vi.setSystemTime(new Date("2026-10-26T09:20:00Z"));
    expect(await (await call(withSecret)).json()).toMatchObject({ due: 2, ran: 0, emails: 0 });
    expect(sendCompanyEmail).toHaveBeenCalledTimes(2);
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
    sendCompanyEmail.mockImplementation(async (input: { organizationId: string }) => {
      if (input.organizationId === "a") throw new Error("mailer exploded for a@a.test");
      return { ok: true, mode: "sent", provider: "mock" };
    });
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ran: 2, emails: 1, failed: 1 });
    expect(db.rows("email_schedule_runs").find((r) => r.schedule_id === "sa")!.error).toBe("1 reminder not sent (unexpected)");
    expect(db.rows("email_schedule_runs").find((r) => r.schedule_id === "sb")!.error).toBeNull();
    expect(logs.join("\n")).not.toContain("a@a.test");
  });

  it("a failed reminder is tried again on a later call, and only what is left is sent", async () => {
    const db = world();
    admin = db;
    sendCompanyEmail.mockResolvedValueOnce({ ok: false, error: "nope", code: "provider_error" });
    await call(withSecret);
    expect(db.rows("invoice_reminder_sends").map((r) => r.invoice_id)).toEqual(["2"]); // company a's claim was given back
    vi.setSystemTime(new Date("2026-10-26T09:20:00Z"));
    expect(await (await call(withSecret)).json()).toMatchObject({ ran: 1, emails: 1 });
    expect(sendCompanyEmail).toHaveBeenCalledTimes(3);
    expect(db.rows("invoice_reminder_sends").map((r) => r.invoice_id).sort()).toEqual(["1", "2"]);
  });

  it("answers 200 skipped while migration 108 is not applied", async () => {
    const db = new FakeDb();
    db.failing.email_schedules = { code: "PGRST205", message: "Could not find the table 'public.email_schedules' in the schema cache" };
    admin = db;
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: "database update 108 not applied", ran: 0 });
    expect(sendCompanyEmail).not.toHaveBeenCalled();
    expect(reportServerError).not.toHaveBeenCalled();
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
