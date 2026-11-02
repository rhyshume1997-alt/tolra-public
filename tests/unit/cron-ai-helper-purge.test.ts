/**
 * E9 Q6: the nightly AI helper retention purge (app/api/cron/ai-helper-purge, migration 133's ai_helper_purge_requests, service role).
 * Who may call it, the batching, fails closed while 133 is missing, counts only. The deletion itself (12 months, every company, the
 * newer rows kept, one audit row per company) is proved on the database: tests/db/ai-helper-pre-enable-133.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rpc = vi.fn();
const reportServerError = vi.fn(async (_input: { route: string; error: Error; source?: string }) => ({ sent: false, reason: "disabled" }));
let admin: { rpc: typeof rpc } | null;

vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => admin }));
vi.mock("@/lib/server/error-alert", () => ({ reportServerError }));

const SECRET = "test-only-cron-secret-0123456789";
const call = async (headers: Record<string, string> = {}) => {
  const { GET } = await import("@/app/api/cron/ai-helper-purge/route");
  return GET(new Request("https://example.test/api/cron/ai-helper-purge", { headers }));
};
const withSecret = { authorization: `Bearer ${SECRET}` };

let logs: string[];
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRON_SECRET", SECRET);
  admin = { rpc };
  logs = [];
  for (const level of ["log", "error", "warn"] as const) vi.spyOn(console, level).mockImplementation((...args) => void logs.push(args.map(String).join(" ")));
});

describe("GET /api/cron/ai-helper-purge", () => {
  it.each([
    ["no Authorization header", {}],
    ["a wrong secret", { authorization: "Bearer wrong-secret-wrong-secret" }],
    ["the secret without Bearer", { authorization: SECRET }],
  ])("401 with %s, and nothing is deleted", async (_name, headers) => {
    expect((await call(headers)).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("401 when CRON_SECRET is not set (never open by default)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call(withSecret)).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls the purge in batches of 1,000 until a short batch, and answers the count only", async () => {
    rpc.mockResolvedValueOnce({ data: 1000, error: null }).mockResolvedValueOnce({ data: 1000, error: null }).mockResolvedValueOnce({ data: 7, error: null });
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 2007, capped: false });
    expect(rpc.mock.calls).toEqual([["ai_helper_purge_requests", { p_limit: 1000 }], ["ai_helper_purge_requests", { p_limit: 1000 }], ["ai_helper_purge_requests", { p_limit: 1000 }]]);
    expect(logs).toContain("[cron/ai-helper-purge] removed=2007");
  });

  it("stops after 50 full batches (the next run carries on)", async () => {
    rpc.mockResolvedValue({ data: 1000, error: null });
    const res = await call(withSecret);
    expect(await res.json()).toEqual({ removed: 50_000, capped: true });
    expect(rpc).toHaveBeenCalledTimes(50);
  });

  it.each([["PGRST202"], ["42883"]])("skipped, not an error, while 133 is not applied (%s): nothing deleted, no alert", async (code) => {
    rpc.mockResolvedValue({ data: null, error: { code, message: "function missing" } });
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "not configured" });
    expect(reportServerError).not.toHaveBeenCalled();
  });

  it("any other failure is a 500 and an alert, with the count so far", async () => {
    rpc.mockResolvedValueOnce({ data: 1000, error: null }).mockResolvedValueOnce({ data: null, error: { code: "57014" } });
    const res = await call(withSecret);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Purge failed", removed: 1000 });
    expect(reportServerError).toHaveBeenCalledTimes(1);
    expect(reportServerError.mock.calls[0][0]).toMatchObject({ route: "/api/cron/ai-helper-purge", source: "cron" });
  });

  it("no service client: 500 and an alert, nothing called", async () => {
    admin = null;
    expect((await call(withSecret)).status).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
    expect(reportServerError).toHaveBeenCalledTimes(1);
  });
});
