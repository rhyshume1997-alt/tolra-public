import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rpc = vi.fn();
const reportServerError = vi.fn(async (_input: { route: string; error: Error; source?: string }) => ({ sent: false, reason: "disabled" }));
let admin: { rpc: typeof rpc } | null;

vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => admin }));
vi.mock("@/lib/server/error-alert", () => ({ reportServerError }));

const SECRET = "test-only-cron-secret-0123456789";

const call = async (headers: Record<string, string> = {}) => {
  const { GET } = await import("@/app/api/cron/overview-snapshot/route");
  return GET(new Request("https://example.test/api/cron/overview-snapshot", { headers }));
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

describe("GET /api/cron/overview-snapshot: who may call it", () => {
  it.each([
    ["no Authorization header", {}],
    ["a wrong secret", { authorization: "Bearer wrong-secret-wrong-secret" }],
    ["the secret without Bearer", { authorization: SECRET }],
  ])("401 with %s, and nothing is written", async (_name, headers) => {
    const res = await call(headers);
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("401 when CRON_SECRET is not set (never open by default)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call(withSecret)).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/overview-snapshot: the capture", () => {
  it("captures today's figures once, with no arguments, and answers the count of companies only", async () => {
    rpc.mockResolvedValue({ data: 3, error: null });
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ companies: 3 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("capture_overview_owed");
    expect(logs).toEqual(["[cron/overview-snapshot] companies=3"]);
  });

  it.each([["PGRST202"], ["42883"]])("fails closed while 116 is not applied (%s): 200 skipped, no alert", async (code) => {
    rpc.mockResolvedValue({ data: null, error: { code, message: "Could not find the function public.capture_overview_owed" } });
    const res = await call(withSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "not configured" });
    expect(reportServerError).not.toHaveBeenCalled();
  });

  it("any other database error is a 500 and an alert naming only the code", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied for function capture_overview_owed" } });
    const res = await call(withSecret);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Snapshot failed" });
    expect(reportServerError).toHaveBeenCalledTimes(1);
    expect(reportServerError.mock.calls[0][0].error.message).toBe("Overview snapshot failed: capture 42501");
  });

  it("no service key configured, a bad answer or an exception: 500", async () => {
    admin = null;
    expect((await call(withSecret)).status).toBe(500);
    admin = { rpc };
    rpc.mockResolvedValue({ data: "3", error: null });
    expect((await call(withSecret)).status).toBe(500);
    rpc.mockRejectedValue(new TypeError("fetch failed"));
    expect((await call(withSecret)).status).toBe(500);
    expect(reportServerError).toHaveBeenCalledTimes(3);
  });
});

describe("vercel.json", () => {
  it("runs the snapshot once a day at 22:00 UTC (inside the nightly pass), which is still the same London day in winter and summer", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(config.crons).toContainEqual({ path: "/api/cron/nightly", schedule: "0 22 * * *" });
  });
});
