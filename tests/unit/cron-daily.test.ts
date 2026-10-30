import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const reportServerError = vi.fn(async (input: { route: string; error: Error; source?: string }) => ({ sent: false, reason: input.route ? "disabled" : "disabled" }));
const sendCompanyEmail = vi.fn();
const xeroReady = vi.fn();
const sweepDeps = vi.fn();
const runIntegrationSweep = vi.fn();
let admin: unknown;
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => admin }));
vi.mock("@/lib/server/error-alert", () => ({ reportServerError }));
vi.mock("@/lib/email/send-company-email", () => ({ sendCompanyEmail: (...args: unknown[]) => sendCompanyEmail(...args) }));
vi.mock("@/lib/integrations/sweep", () => ({ runIntegrationSweep: (...a: unknown[]) => runIntegrationSweep(...a) }));
vi.mock("@/lib/integrations/server", () => ({
  DbError: class DbError extends Error { constructor(message: string, readonly code?: string) { super(message); } },
  xeroReady: (...a: unknown[]) => xeroReady(...a),
  sweepDeps: (...a: unknown[]) => sweepDeps(...a),
}));

import { FakeDb } from "../support/fake-db";

const SECRET = "test-only-cron-secret-0123456789";
const withSecret = { authorization: `Bearer ${SECRET}` };
const call = async (headers: Record<string, string> = {}) => {
  const { GET } = await import("@/app/api/cron/daily/route");
  return GET(new Request("https://example.test/api/cron/daily", { headers }));
};
const SWEEP = { companies: 1, renewed: 1, needReconnect: 0, sent: 2, failed: 0, needsCheck: 0, errors: 0 };

const world = () => new FakeDb({
  organizations: [{ id: "a", name: "Alpha", status: "active" }],
  email_schedules: [{ id: "sa", organization_id: "a", kind: "invoice_reminder", enabled: true, frequency: "daily", weekday: null, time_of_day: "08:00", run_at: null, timezone: "Europe/London", recipients: null, last_run_at: null, updated_at: "2026-10-01T00:00:00Z" }],
  invoices: [{ id: "1", organization_id: "a", invoice_ref: "INV-1", customer: "Acme", total: 100, amount_paid: 0, credited_amount: 0, refunded_amount: 0, status: "sent", due_date: "2026-10-01", payment_unverified: false }],
  customers: [{ organization_id: "a", name: "Acme", email: "acme@a.test", contact_name: null }],
});

let logs: string[];
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T05:00:00Z")); // the daily pass, Tuesday 05:00
  admin = world();
  sendCompanyEmail.mockResolvedValue({ ok: true, mode: "sent", provider: "mock" });
  xeroReady.mockReturnValue({ config: {}, key: Buffer.alloc(32) });
  sweepDeps.mockReturnValue({ deps: true });
  runIntegrationSweep.mockResolvedValue(SWEEP);
  logs = [];
  for (const level of ["log", "error", "warn"] as const) vi.spyOn(console, level).mockImplementation((...args) => void logs.push(args.map(String).join(" ")));
});
afterEach(() => { vi.useRealTimers(); });

describe("GET /api/cron/daily: who may call it", () => {
  it.each([["no header", {}], ["a wrong secret", { authorization: "Bearer wrong-secret-wrong-secret" }], ["the secret in another header", { "x-cron-secret": SECRET }]])("401 with %s and nothing runs", async (_n, headers) => {
    expect((await call(headers)).status).toBe(401);
    expect(sendCompanyEmail).not.toHaveBeenCalled();
    expect(runIntegrationSweep).not.toHaveBeenCalled();
    expect((admin as FakeDb).log).toEqual([]);
  });
  it.each([["unset", undefined], ["empty", ""], ["too short", "short"]])("401 for every call when CRON_SECRET is %s", async (_n, value) => {
    vi.stubEnv("CRON_SECRET", value as string);
    expect((await call(withSecret)).status).toBe(401);
    expect(runIntegrationSweep).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/daily: the pass", () => {
  it("sends yesterday's 08:00 reminder (about 21 h late) and then runs the Xero sweep, returning both results", async () => {
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ emailSchedules: { schedules: 1, due: 1, ran: 1, emails: 1, drafted: 0, failed: 0, errors: 0 }, xeroSweep: SWEEP });
    expect(sendCompanyEmail).toHaveBeenCalledTimes(1);
    expect((admin as FakeDb).rows("email_schedule_runs")[0]).toMatchObject({ period_key: "2026-10-26", error: null });
  });

  it("a second call the same morning (a Vercel retry) sends nothing more", async () => {
    await call(withSecret);
    await call(withSecret);
    expect(sendCompanyEmail).toHaveBeenCalledTimes(1);
  });

  it("the next day's pass sends the next day's", async () => {
    await call(withSecret);
    vi.setSystemTime(new Date("2026-10-28T05:30:00Z"));
    await call(withSecret);
    expect(sendCompanyEmail).toHaveBeenCalledTimes(2);
    expect((admin as FakeDb).rows("email_schedule_runs").map((r) => r.period_key)).toEqual(["2026-10-26", "2026-10-27"]);
  });

  it("the e-mail pass failing does not stop the Xero sweep; the failure is reported and answered 500 after both ran", async () => {
    const db = new FakeDb();
    db.failing.email_schedules = { code: "XX000", message: "secret internal detail" };
    admin = db;
    const res = await call(withSecret);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ emailSchedules: { error: "e-mail schedules failed" }, xeroSweep: SWEEP });
    expect(JSON.stringify(body)).not.toContain("secret internal detail");
    expect(runIntegrationSweep).toHaveBeenCalledTimes(1);
    expect(reportServerError).toHaveBeenCalledTimes(1);
    expect(reportServerError.mock.calls[0][0]).toMatchObject({ route: "/api/cron/daily", source: "cron" });
  });

  it("the Xero sweep failing does not undo the e-mails; its detail is never returned or logged", async () => {
    runIntegrationSweep.mockRejectedValue(new Error("token abc123 leaked"));
    const res = await call(withSecret);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.emailSchedules).toMatchObject({ ran: 1, emails: 1 });
    expect(body.xeroSweep).toEqual({ error: "Xero sweep failed" });
    expect(JSON.stringify(body) + logs.join("\n") + JSON.stringify(reportServerError.mock.calls[0][0].error.message)).not.toContain("abc123");
    expect(sendCompanyEmail).toHaveBeenCalledTimes(1);
  });

  it("both can fail; each is reported, and the route still answers", async () => {
    admin = null;
    runIntegrationSweep.mockRejectedValue(new Error("x"));
    const res = await call(withSecret);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ emailSchedules: { error: "e-mail schedules failed" }, xeroSweep: { error: "Xero sweep failed" } });
    expect(reportServerError).toHaveBeenCalledTimes(2);
  });

  it("a failing error reporter never stops the other job or makes the route throw", async () => {
    admin = null;
    reportServerError.mockRejectedValue(new Error("alerts down"));
    const res = await call(withSecret);
    expect(res.status).toBe(500);
    expect(runIntegrationSweep).not.toHaveBeenCalled(); // admin is null: Xero's sweep also cannot run, and says so
    expect(await res.json()).toMatchObject({ emailSchedules: { error: "e-mail schedules failed" } });
  });

  it("while 108 isn't applied and Xero isn't set up, answers 200 with both reasons", async () => {
    const db = new FakeDb();
    db.failing.email_schedules = { code: "PGRST205", message: "Could not find the table" };
    admin = db;
    xeroReady.mockReturnValue(null);
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ emailSchedules: expect.objectContaining({ skipped: "database update 108 not applied" }), xeroSweep: { skipped: "xero not configured" } });
    expect(reportServerError).not.toHaveBeenCalled();
  });
});
