import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rpc = vi.fn();
const reportServerError = vi.fn(async (_input: { route: string; error: Error; source?: string }) => ({ sent: false, reason: "disabled" }));
const runEmailSchedulesPass = vi.fn();
const runXeroSweepPass = vi.fn();
const microsoftReady = vi.fn();
const runMailboxPollPass = vi.fn();
let admin: unknown;

vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => admin }));
vi.mock("@/lib/server/error-alert", () => ({ reportServerError: (...a: [{ route: string; error: Error; source?: string }]) => reportServerError(...a) }));
vi.mock("@/lib/email/schedules/pass", () => ({ runEmailSchedulesPass: (...a: unknown[]) => runEmailSchedulesPass(...a) }));
vi.mock("@/lib/integrations/xero-pass", () => ({ runXeroSweepPass: (...a: unknown[]) => runXeroSweepPass(...a) }));
vi.mock("@/lib/integrations/microsoft/client", () => ({ microsoftReady: (...a: unknown[]) => microsoftReady(...a) }));
vi.mock("@/lib/integrations/microsoft/inbox", () => ({ runMailboxPollPass: (...a: unknown[]) => runMailboxPollPass(...a) }));

const SECRET = "test-only-cron-secret-0123456789";
const auth = { authorization: `Bearer ${SECRET}` };
const get = async (route: string, headers: Record<string, string> = auth) => {
  const mod = await import(`@/app/api/cron/${route}/route`);
  return mod.GET(new Request(`https://example.test/api/cron/${route}`, { headers }));
};
const alertRoutes = () => reportServerError.mock.calls.map(([input]) => input.route);
const alertText = () => reportServerError.mock.calls.map(([input]) => input.error.message).join("\n");

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRON_SECRET", SECRET);
  reportServerError.mockResolvedValue({ sent: false, reason: "disabled" });
  admin = { rpc };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("a missing critical migration is visible: 200 stays, one alert is raised", () => {
  it.each([["PGRST202"], ["42883"]])("overview-snapshot, 116 missing (%s)", async (code) => {
    rpc.mockResolvedValue({ data: null, error: { code, message: "Could not find the function" } });
    const res = await get("overview-snapshot");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "not configured" });
    expect(alertRoutes()).toEqual(["/api/cron/overview-snapshot"]);
    expect(alertText()).toMatch(/116/);
  });

  it.each([["PGRST202"], ["42883"]])("ai-helper-purge, 133 missing (%s)", async (code) => {
    rpc.mockResolvedValue({ data: null, error: { code, message: "function missing" } });
    const res = await get("ai-helper-purge");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "not configured" });
    expect(alertRoutes()).toEqual(["/api/cron/ai-helper-purge"]);
    expect(alertText()).toMatch(/133/);
  });

  it("email-schedules, 108 missing", async () => {
    runEmailSchedulesPass.mockResolvedValue({ skipped: "database update 108 not applied", schedules: 0, due: 0, ran: 0 });
    const res = await get("email-schedules");
    expect(res.status).toBe(200);
    expect(alertRoutes()).toEqual(["/api/cron/email-schedules"]);
    expect(alertText()).toMatch(/108/);
  });

  it.each([["database update 084 not applied"], ["xero transfer switch (release 149) not in the database: nothing sent"]])("xero-sweep: %s", async (skipped) => {
    runXeroSweepPass.mockResolvedValue({ skipped });
    const res = await get("xero-sweep");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped });
    expect(alertRoutes()).toEqual(["/api/cron/xero-sweep"]);
  });

  it("mail-poll, 127 missing", async () => {
    admin = {};
    microsoftReady.mockResolvedValue({ ok: true });
    runMailboxPollPass.mockResolvedValue({ skipped: "database update 127 is not applied", companies: 0 });
    const res = await get("mail-poll");
    expect(res.status).toBe(200);
    expect(alertRoutes()).toEqual(["/api/cron/mail-poll"]);
    expect(alertText()).toMatch(/127/);
  });

  it("daily: both jobs missing their migration raise one alert each, answer stays 200", async () => {
    runEmailSchedulesPass.mockResolvedValue({ skipped: "database update 108 not applied" });
    runXeroSweepPass.mockResolvedValue({ skipped: "database update 084 not applied" });
    const res = await get("daily");
    expect(res.status).toBe(200);
    expect(alertRoutes()).toEqual(["/api/cron/daily", "/api/cron/daily"]);
    expect(alertText()).toMatch(/108/);
    expect(alertText()).toMatch(/084/);
  });

  it("nightly: the missing 116 and 133 each alert through their own route, answer stays 200", async () => {
    rpc.mockImplementation(async (name: string) => name === "site_network_ip_purge" ? { data: 0, error: null } : { data: null, error: { code: "PGRST202", message: "missing" } });
    (admin as { from?: unknown }).from = () => ({ select: () => ({ order: async () => ({ data: [{ id: "o1" }], error: null }) }) });
    const res = await get("nightly");
    expect(res.status).toBe(200);
    expect(alertRoutes().sort()).toEqual(["/api/cron/ai-helper-purge", "/api/cron/overview-snapshot"]);
  });

  it("the alert text is fixed and carries no secret, header or id", async () => {
    runEmailSchedulesPass.mockResolvedValue({ skipped: "database update 108 not applied" });
    await get("email-schedules");
    expect(alertText()).not.toContain(SECRET);
    expect(alertText()).not.toMatch(/bearer|authorization/i);
  });

  it("an alert that throws or rejects never changes the answer", async () => {
    reportServerError.mockRejectedValue(new Error("resend down"));
    runEmailSchedulesPass.mockResolvedValue({ skipped: "database update 108 not applied" });
    expect((await get("email-schedules")).status).toBe(200);
  });
});

describe("non-critical and not-configured skips are unchanged: no alert", () => {
  it("xero-sweep 'xero not configured' is still a quiet 200", async () => {
    runXeroSweepPass.mockResolvedValue({ skipped: "xero not configured" });
    expect((await get("xero-sweep")).status).toBe(200);
    expect(reportServerError).not.toHaveBeenCalled();
  });

  it("mail-poll 'Microsoft 365 is not set up' is still a quiet 200", async () => {
    admin = {};
    microsoftReady.mockResolvedValue(null);
    const res = await get("mail-poll");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "Microsoft 365 is not set up on this server" });
    expect(reportServerError).not.toHaveBeenCalled();
  });

  it("a normal run raises nothing", async () => {
    rpc.mockResolvedValue({ data: 2, error: null });
    expect((await get("overview-snapshot")).status).toBe(200);
    runEmailSchedulesPass.mockResolvedValue({ schedules: 1, due: 0, ran: 0 });
    expect((await get("email-schedules")).status).toBe(200);
    expect(reportServerError).not.toHaveBeenCalled();
  });
});

describe("CRON_SECRET missing or short: a quiet 401, no work, no alert", () => {
  it.each([[""], ["short-secret"], ["fifteen-chars-x"]])("secret %j refuses even the correct bearer", async (secret) => {
    vi.stubEnv("CRON_SECRET", secret);
    for (const route of ["daily", "nightly", "xero-sweep", "email-schedules", "overview-snapshot", "ai-helper-purge", "mail-poll", "ip-purge"]) {
      const res = await get(route, { authorization: `Bearer ${secret || "x"}` });
      expect(res.status, route).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(runEmailSchedulesPass).not.toHaveBeenCalled();
    expect(runXeroSweepPass).not.toHaveBeenCalled();
    expect(reportServerError).not.toHaveBeenCalled(); // so a missing/short CRON_SECRET on production is NOT announced by the app
  });

  it("an unset CRON_SECRET is the same", async () => {
    vi.stubEnv("CRON_SECRET", undefined as unknown as string);
    expect((await get("daily")).status).toBe(401);
    expect(reportServerError).not.toHaveBeenCalled();
  });
});
