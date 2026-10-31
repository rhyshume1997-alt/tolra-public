import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const reportServerError = vi.fn(async (input: { route: string; error: Error; source?: string }) => ({ sent: false, reason: input.route ? "disabled" : "disabled" }));
const xeroReady = vi.fn();
const sweepDeps = vi.fn();
const runIntegrationSweep = vi.fn();
let admin: unknown;
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => admin }));
vi.mock("@/lib/server/error-alert", () => ({ reportServerError }));
vi.mock("@/lib/integrations/sweep", () => ({ runIntegrationSweep: (...a: unknown[]) => runIntegrationSweep(...a) }));
vi.mock("@/lib/integrations/server", () => ({
  DbError: class DbError extends Error { constructor(message: string, readonly code?: string) { super(message); } },
  xeroReady: (...a: unknown[]) => xeroReady(...a),
  sweepDeps: (...a: unknown[]) => sweepDeps(...a),
}));

const SECRET = "test-only-cron-secret-0123456789";
const withSecret = { authorization: `Bearer ${SECRET}` };
const call = async (headers: Record<string, string> = {}) => {
  const { GET } = await import("@/app/api/cron/xero-sweep/route");
  return GET(new Request("https://example.test/api/cron/xero-sweep", { headers }));
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRON_SECRET", SECRET);
  admin = { fake: true };
  xeroReady.mockReturnValue({ config: {}, key: Buffer.alloc(32) });
  sweepDeps.mockReturnValue({ deps: true });
  for (const level of ["log", "error", "warn"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});

describe("GET /api/cron/xero-sweep", () => {
  it.each([["no header", {}], ["wrong secret", { authorization: "Bearer wrong-secret-wrong-secret" }], ["secret in another header", { "x-cron-secret": SECRET }]])("401 with %s and nothing runs", async (_n, headers) => {
    expect((await call(headers)).status).toBe(401);
    expect(runIntegrationSweep).not.toHaveBeenCalled();
    expect(xeroReady).not.toHaveBeenCalled();
  });

  it("401 for every call when CRON_SECRET is not set", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call(withSecret)).status).toBe(401);
    expect(runIntegrationSweep).not.toHaveBeenCalled();
  });

  it("runs lib/integrations/sweep with the real dependencies and returns its counts only", async () => {
    runIntegrationSweep.mockResolvedValue({ companies: 2, renewed: 2, needReconnect: 0, sent: 5, failed: 1, needsCheck: 0, errors: 0 });
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ companies: 2, renewed: 2, needReconnect: 0, sent: 5, failed: 1, needsCheck: 0, errors: 0 });
    expect(sweepDeps).toHaveBeenCalledWith(admin, expect.anything());
    expect(runIntegrationSweep).toHaveBeenCalledWith({ deps: true });
  });

  it("does nothing where Xero isn't set up", async () => {
    xeroReady.mockReturnValue(null);
    const res = await call(withSecret);
    expect(await res.json()).toEqual({ skipped: "xero not configured" });
    expect(runIntegrationSweep).not.toHaveBeenCalled();
    expect(reportServerError).not.toHaveBeenCalled();
  });

  it("answers 200 skipped while the integrations tables aren't there", async () => {
    const { DbError } = await import("@/lib/integrations/server");
    runIntegrationSweep.mockRejectedValue(new DbError("x", "PGRST205"));
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "database update 084 not applied" });
  });

  it("any other failure is reported and answered 500 without detail", async () => {
    runIntegrationSweep.mockRejectedValue(new Error("token abc123 leaked"));
    const res = await call(withSecret);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("abc123");
    expect(reportServerError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(reportServerError.mock.calls[0][0].error.message)).not.toContain("abc123");
  });

  it("no service client is a reported 500", async () => {
    admin = null;
    expect((await call(withSecret)).status).toBe(500);
    expect(runIntegrationSweep).not.toHaveBeenCalled();
  });
});
